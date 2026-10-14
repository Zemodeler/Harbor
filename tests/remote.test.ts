import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarborEvent, PendingPermission, RemoteScope } from '../src/shared/api';
import { INVOKE_METHODS } from '../src/shared/ipc';
import { EventBus } from '../src/main/events';
import { validateInvoke } from '../src/main/ipcValidate';
import { acquireInstanceLock } from '../src/main/instanceLock';
import { redactSecrets } from '../src/main/logger';
import { createHarborService } from '../src/main/service';
import { RemoteClient, RemoteError } from '../src/main/remote/client';
import { describeEvent, loadToken, runCli, type CliIo } from '../src/main/remote/cli';
import { AuthLimiter, hostAllowed, isLoopbackHost, resolveRemoteConfig, type RemoteConfig } from '../src/main/remote/guard';
import { METHOD_SCOPE, scopeAllows } from '../src/main/remote/scopes';
import { startRemoteServer, type RemoteServer } from '../src/main/remote/server';
import { RemoteTokens } from '../src/main/remote/tokens';
import { encodeFrame, FrameDecoder, newKey, OP } from '../src/main/remote/ws';
import { runHeadless, startHeadless } from '../src/main/headless';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'harbor-remote-'));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function fakeService(pending: PendingPermission[] = []) {
  const bus = new EventBus();
  const svc = Object.fromEntries(INVOKE_METHODS.map((m) => [m, vi.fn(async () => ({ ok: m }))])) as Record<string, ReturnType<typeof vi.fn>>;
  svc['listPendingPermissions'] = vi.fn(async () => pending);
  return { svc, bus, service: { ...svc, onEvent: (cb: (e: HarborEvent) => void) => bus.on(cb), listPendingPermissions: svc['listPendingPermissions'] as unknown as () => Promise<PendingPermission[]> } };
}

async function setup(opts: { allowFullScope?: boolean; pending?: PendingPermission[]; limiter?: AuthLimiter } = {}) {
  const f = fakeService(opts.pending);
  const tokens = new RemoteTokens();
  const config: RemoteConfig = { ...resolveRemoteConfig({ port: 0 }), allowFullScope: opts.allowFullScope ?? true };
  const server = await startRemoteServer({ service: f.service, tokens, config, limiter: opts.limiter });
  cleanups.push(() => server.close());
  const token = (scope: RemoteScope) => tokens.create(`device-${scope}`, scope).token;
  const client = (scope: RemoteScope) => new RemoteClient({ url: server.url, token: token(scope) });
  return { ...f, tokens, server, token, client };
}

function raw(server: RemoteServer, path: string, headers: Record<string, string>, method = 'GET', body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.port, path, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** A WebSocket handshake with arbitrary headers; resolves with the status (101 = accepted). */
function handshake(server: RemoteServer, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.port, path: '/v1/events', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': newKey(), ...headers } });
    req.on('upgrade', (_res, socket) => { socket.destroy(); resolve(101); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

const status = async (p: Promise<unknown>): Promise<number> => { try { await p; return 200; } catch (e) { return e instanceof RemoteError ? e.status : -1; } };

describe('remote tokens', () => {
  it('stores only a hash, shows the token once, verifies and revokes', () => {
    const dir = tempDir();
    const file = join(dir, 'remote-tokens.json');
    const tokens = new RemoteTokens(file, () => 1000);
    const { token, info } = tokens.create('phone', 'read-only');
    expect(token).toMatch(/^hbt_[A-Za-z0-9_-]{40,}$/);
    const disk = readFileSync(file, 'utf8');
    expect(disk).not.toContain(token);
    expect(disk).not.toContain(token.slice(4));
    expect(tokens.list()).toEqual([{ id: info.id, name: 'phone', scope: 'read-only', created: 1000 }]);
    expect(JSON.stringify(tokens.list())).not.toContain('hash');
    expect(tokens.verify(token)?.id).toBe(info.id);
    expect(tokens.verify(`${token}x`)).toBeUndefined();
    expect(tokens.verify(undefined)).toBeUndefined();
    expect(new RemoteTokens(file).verify(token)?.id).toBe(info.id);   // survives a restart
    tokens.revoke(info.id);
    expect(tokens.verify(token)).toBeUndefined();
    expect(new RemoteTokens(file).list()).toEqual([]);
  });

  it('rejects bad names and scopes, and redacts tokens in logs', () => {
    const tokens = new RemoteTokens();
    expect(() => tokens.create('', 'read-only')).toThrow();
    expect(() => tokens.create('a\nb', 'read-only')).toThrow();
    expect(() => tokens.create('x', 'admin' as RemoteScope)).toThrow(/Scope/);
    const { token } = tokens.create('x', 'full');
    expect(redactSecrets(`got ${token} here`)).toBe('got [redacted] here');
  });

  it('service: full scope needs allowFullScope; token methods are validated like other IPC calls', async () => {
    const s = createHarborService({ discover: async () => [] });
    cleanups.push(() => s.shutdown());
    await expect(s.createRemoteToken('laptop', 'full')).rejects.toThrow(/Full remote access is off/);
    const created = await s.createRemoteToken('laptop', 'answer-permissions');
    expect((await s.listRemoteTokens()).map((t) => t.id)).toEqual([created.info.id]);
    await s.setSettings({ remote: { allowFullScope: true } });
    await expect(s.createRemoteToken('laptop2', 'full')).resolves.toBeTruthy();
    await s.revokeRemoteToken(created.info.id);
    expect((await s.listRemoteTokens()).map((t) => t.scope)).toEqual(['full']);
    expect(() => validateInvoke('createRemoteToken', ['x', 'root'])).toThrow(/Invalid request/);
    expect(() => validateInvoke('createRemoteToken', ['', 'full'])).toThrow(/Invalid request/);
    expect(() => validateInvoke('revokeRemoteToken', [7])).toThrow(/Invalid request/);
    await expect(s.setSettings({ remote: { port: 'x' as unknown as number } })).rejects.toThrow(/remote.port/);
  });
});

describe('remote scope table', () => {
  it('classifies exactly the contract methods, and denies anything else', () => {
    expect(Object.keys(METHOD_SCOPE).sort()).toEqual([...INVOKE_METHODS].sort());
    for (const m of ['onEvent', 'constructor', '__proto__', 'toString', 'shutdown', 'whenIdle']) {
      for (const s of ['read-only', 'answer-permissions', 'full'] as const) expect(scopeAllows(s, m)).toBe(false);
    }
    for (const m of ['createRemoteToken', 'listRemoteTokens', 'revokeRemoteToken', 'openLogin', 'addProject', 'openWorkspace']) expect(scopeAllows('full', m)).toBe(false);
    expect(scopeAllows('read-only', 'listMessages')).toBe(true);
    expect(scopeAllows('read-only', 'answerPermission')).toBe(false);
    expect(scopeAllows('answer-permissions', 'answerPermission')).toBe(true);
    expect(scopeAllows('answer-permissions', 'send')).toBe(false);
    expect(scopeAllows('full', 'send')).toBe(true);
  });
});

describe('remote config', () => {
  it('binds loopback by default and refuses an off-box bind without TLS or an acknowledgement', () => {
    expect(resolveRemoteConfig({}).host).toBe('127.0.0.1');
    expect(isLoopbackHost('127.0.0.1') && isLoopbackHost('::1') && !isLoopbackHost('localhost') && !isLoopbackHost('0.0.0.0')).toBe(true);
    expect(() => resolveRemoteConfig({ host: '0.0.0.0' })).toThrow(/without TLS/);
    expect(() => resolveRemoteConfig({ host: '100.64.1.2' })).toThrow(/without TLS/);
    expect(resolveRemoteConfig({ host: '0.0.0.0', allowPlainHttp: true }).host).toBe('0.0.0.0');
    expect(resolveRemoteConfig({ host: '0.0.0.0', tlsCertFile: 'c.pem', tlsKeyFile: 'k.pem' }).tls).toEqual({ certFile: 'c.pem', keyFile: 'k.pem' });
    expect(() => resolveRemoteConfig({ tlsCertFile: 'c.pem' })).toThrow(/go together/);
    expect(resolveRemoteConfig({}).allowFullScope).toBe(false);
  });

  it('accepts only loopback names, the bind address and allowed hosts in Host', () => {
    const cfg = resolveRemoteConfig({ host: '0.0.0.0', allowPlainHttp: true, allowedHosts: ['pc.tailnet.ts.net'] });
    expect(hostAllowed('127.0.0.1:47821', cfg)).toBe(true);
    expect(hostAllowed('localhost:1', cfg)).toBe(true);
    expect(hostAllowed('[::1]:1', cfg)).toBe(true);
    expect(hostAllowed('PC.tailnet.ts.net', cfg)).toBe(true);
    expect(hostAllowed('evil.example:47821', cfg)).toBe(false);
    expect(hostAllowed('0.0.0.0', cfg)).toBe(false);
    expect(hostAllowed(undefined, cfg)).toBe(false);
    expect(hostAllowed('a b', cfg)).toBe(false);
  });

  it('the client refuses to send a token in clear text off-box', () => {
    expect(() => new RemoteClient({ url: 'http://192.168.1.5:47821', token: 'hbt_x' })).toThrow(/clear text/);
    expect(() => new RemoteClient({ url: 'http://192.168.1.5:47821', token: 'hbt_x', allowPlainHttp: true })).not.toThrow();
    expect(() => new RemoteClient({ url: 'https://pc.example:47821', token: 'hbt_x' })).not.toThrow();
  });
});

describe('remote server: auth', () => {
  it('rejects missing and wrong tokens, and accepts a valid one', async () => {
    const s = await setup();
    expect((await raw(s.server, '/v1/whoami', {})).status).toBe(401);
    expect((await raw(s.server, '/v1/whoami', { Authorization: 'Bearer hbt_nope' })).status).toBe(401);
    expect((await raw(s.server, '/v1/whoami', { Authorization: 'Basic abc' })).status).toBe(401);
    const me = await s.client('read-only').whoami();
    expect(me.scope).toBe('read-only');
    expect(JSON.stringify(me)).not.toContain('hbt_');
  });

  it('rate-limits failed attempts', async () => {
    let now = 0;
    const s = await setup({ limiter: new AuthLimiter(3, 100, 60_000, () => now) });
    const good = s.token('read-only');
    for (let i = 0; i < 3; i++) expect((await raw(s.server, '/v1/whoami', { Authorization: 'Bearer bad' })).status).toBe(401);
    expect((await raw(s.server, '/v1/whoami', { Authorization: `Bearer ${good}` })).status).toBe(429);
    now = 61_000;
    expect((await raw(s.server, '/v1/whoami', { Authorization: `Bearer ${good}` })).status).toBe(200);
  });

  it('refuses full-scope tokens while full scope is off', async () => {
    const s = await setup({ allowFullScope: false });
    expect(await status(s.client('full').whoami())).toBe(403);
    expect(await status(s.client('read-only').whoami())).toBe(200);
  });

  it('stops using a revoked token', async () => {
    const s = await setup();
    const { token, info } = s.tokens.create('tablet', 'read-only');
    const c = new RemoteClient({ url: s.server.url, token });
    expect(await status(c.invoke('listProjects'))).toBe(200);
    s.tokens.revoke(info.id);
    expect(await status(c.invoke('listProjects'))).toBe(401);
  });
});

describe('remote server: scope enforcement', () => {
  it('read-only reads but changes nothing', async () => {
    const s = await setup();
    const c = s.client('read-only');
    expect(await c.invoke('listProjects')).toEqual({ ok: 'listProjects' });
    for (const [m, args] of [['send', ['c1', 'hi']], ['answerPermission', ['r1', true]], ['answerQuestion', ['q1', 'yes']], ['setSettings', [{}]], ['stopAgent', ['a1']]] as const) {
      expect(await status(c.invoke(m, ...args))).toBe(403);
      expect(s.svc[m]).not.toHaveBeenCalled();
    }
  });

  it('answer-permissions answers tool requests and questions, never a free reset or "always"', async () => {
    const pending: PendingPermission[] = [
      { type: 'permission', requestId: 'tool1', kind: 'tool', prompt: 'Run npm test?', tool: 'Bash', alwaysAllow: true },
      { type: 'permission', requestId: 'reset1', kind: 'freeReset', prompt: 'Use the free reset?' }
    ];
    const s = await setup({ pending });
    const c = s.client('answer-permissions');
    expect(await status(c.invoke('answerPermission', 'tool1', true))).toBe(200);
    expect(s.svc['answerPermission']).toHaveBeenCalledWith('tool1', true);
    expect(await status(c.invoke('answerPermission', 'reset1', true))).toBe(403);
    expect(await status(c.invoke('answerPermission', 'reset1', false))).toBe(403);
    expect(await status(c.invoke('answerPermission', 'tool1', true, { always: true }))).toBe(403);
    expect(await status(c.invoke('answerPermission', 'unknown', true))).toBe(403);
    expect(s.svc['answerPermission']).toHaveBeenCalledTimes(1);
    expect(await status(c.invoke('answerQuestion', 'q1', 'yes'))).toBe(200);
    expect(await status(c.invoke('send', 'c1', 'hi'))).toBe(403);
    // Even full scope never answers a free reset.
    expect(await status(s.client('full').invoke('answerPermission', 'reset1', true))).toBe(403);
    expect(await status(s.client('full').invoke('answerPermission', 'tool1', true, { always: true }))).toBe(200);
  });

  it('full scope works but never reaches desktop-only methods or remote settings', async () => {
    const s = await setup();
    const c = s.client('full');
    expect(await status(c.invoke('send', 'c1', 'hi'))).toBe(200);
    expect(s.svc['send']).toHaveBeenCalledWith('c1', 'hi');
    for (const m of ['createRemoteToken', 'listRemoteTokens', 'revokeRemoteToken', 'openLogin', 'addProject', 'openProjectFolder', 'openWorkspace', 'exportDiagnostics']) {
      expect(await status(c.invoke(m))).toBe(403);
      expect(s.svc[m]).not.toHaveBeenCalled();
    }
    expect(await status(c.invoke('setSettings', { remote: { allowFullScope: true } }))).toBe(403);
    expect(await status(c.invoke('setSettings', { concurrencyLimit: 2 }))).toBe(200);
    expect(await status(c.invoke('onEvent'))).toBe(404);
    expect(await status(c.invoke('constructor'))).toBe(404);
  });

  it('refuses non-JSON bodies (no simple cross-site form posts) and oversized ones', async () => {
    const s = await setup();
    const auth = { Authorization: `Bearer ${s.token('full')}` };
    expect((await raw(s.server, '/v1/invoke/listProjects', { ...auth, 'Content-Type': 'text/plain' }, 'POST', '{"args":[]}')).status).toBe(415);
    expect((await raw(s.server, '/v1/invoke/listProjects', { ...auth, 'Content-Type': 'application/json' }, 'POST', 'nope')).status).toBe(400);
    const ro = { Authorization: `Bearer ${s.token('read-only')}`, 'Content-Type': 'application/json' };
    expect((await raw(s.server, '/v1/invoke/listProjects', ro, 'POST', JSON.stringify({ args: ['x'.repeat(2 * 1024 * 1024)] }))).status).toBe(413);
  });
});

describe('remote server: validation parity with IPC', () => {
  // The same malformed calls tests/ipcValidate.test.ts sends over IPC.
  const rejected: Array<[string, unknown[]]> = [
    ['send', [42, 'hi']], ['send', ['c1', 7]], ['send', ['c1', 'x'.repeat(200_001)]], ['send', ['c1', 'hi', 'img']], ['send', ['c1', 'hi', [{ name: 'a' }]]],
    ['send', ['c1', 'hi', Array.from({ length: 7 }, () => ({ name: 'a.png', mime: 'image/png', dataBase64: 'AA==' }))]],
    ['answerQuestion', ['', 'yes']], ['answerQuestion', ['r1', { a: 1 }]], ['answerQuestion', ['r1', 'x'.repeat(20_001)]],
    ['setAgentPriority', ['a1', '5']], ['setAgentPriority', ['a1', 1.5]], ['setAgentPriority', [{}, 1]],
    ['integrateBranches', ['p1', []]], ['integrateBranches', ['p1', 'a1']], ['integrateBranches', ['p1', ['a1'], 'x\ny']],
    ['setConversationDeadline', ['c1', -1]], ['openWorkspace', ['p1', 'shell']], ['answerPermission', ['r1', 'yes']]
  ];
  it.each(rejected)('%s with malformed arguments is refused by both paths before the service runs', async (m, args) => {
    expect(() => validateInvoke(m, args)).toThrow(/Invalid request to/);
    const s = await setup();
    const code = await status(s.client('full').invoke(m, ...args));
    expect(code).toBe(scopeAllows('full', m) ? 400 : 403);
    expect(s.svc[m]).not.toHaveBeenCalled();
  });
});

describe('remote server: origin and host checks', () => {
  it('refuses any browser Origin and foreign Host, for requests and the WebSocket', async () => {
    const s = await setup();
    const auth = { Authorization: `Bearer ${s.token('read-only')}` };
    expect((await raw(s.server, '/v1/whoami', { ...auth, Origin: 'https://evil.example' })).status).toBe(403);
    expect((await raw(s.server, '/v1/whoami', { ...auth, Origin: 'null' })).status).toBe(403);
    expect((await raw(s.server, '/v1/whoami', { ...auth, Host: 'evil.example:47821' })).status).toBe(403);
    const pre = await raw(s.server, '/v1/invoke/listProjects', { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }, 'OPTIONS');
    expect(pre.status).toBe(403);
    expect(await handshake(s.server, { ...auth, Origin: 'http://127.0.0.1' })).toBe(403);
    expect(await handshake(s.server, { ...auth, Host: 'rebound.example' })).toBe(403);
    expect(await handshake(s.server, {})).toBe(401);
    expect(await handshake(s.server, auth)).toBe(101);
  });

  it('never sends CORS headers', async () => {
    const s = await setup();
    const res = await new Promise<Record<string, unknown>>((resolve) => {
      request({ hostname: '127.0.0.1', port: s.server.port, path: '/v1/whoami', headers: { Authorization: `Bearer ${s.token('read-only')}` } }, (r) => { r.resume(); resolve(r.headers); }).end();
    });
    expect(Object.keys(res).filter((k) => k.startsWith('access-control'))).toEqual([]);
  });
});

describe('remote server: event stream', () => {
  it('streams events to a read-only token and closes when the token is revoked', async () => {
    const s = await setup();
    const { token, info } = s.tokens.create('watcher', 'read-only');
    const got: HarborEvent[] = [];
    const w = new RemoteClient({ url: s.server.url, token }).watch((e) => got.push(e));
    await w.opened;
    const big = 'x'.repeat(70_000);   // forces the 64-bit length form
    s.bus.emit({ type: 'usage', windows: [] });
    s.bus.emit({ type: 'messageDelta', messageId: 'm1', conversationId: 'c1', text: big });
    await vi.waitFor(() => expect(got).toHaveLength(2));
    expect(got[0]).toEqual({ type: 'usage', windows: [] });
    expect((got[1] as { text: string }).text).toBe(big);
    s.tokens.revoke(info.id);
    await w.closed;
  });

  it('refuses the stream to bad tokens and drops a client that sends data frames', async () => {
    const s = await setup();
    const w = new RemoteClient({ url: s.server.url, token: 'hbt_wrong' }).watch(() => undefined);
    await expect(w.opened).rejects.toMatchObject({ status: 401 });
    const ok = new RemoteClient({ url: s.server.url, token: s.token('read-only') }).watch(() => undefined);
    await ok.opened;
    ok.close();
    await ok.closed;
  });

  it('frame decoder: server side requires masked control frames only', () => {
    const server = new FrameDecoder(true, 125, false);
    expect(() => server.push(encodeFrame(OP.ping, Buffer.from('a'), false))).toThrow(/masked/);
    expect(() => new FrameDecoder(true, 125, false).push(encodeFrame(OP.text, Buffer.from('a'), true))).toThrow(/opcode/);
    expect(() => new FrameDecoder(true, 125, false).push(Buffer.from([0x89, 0xfe, 0, 200]))).toThrow(/too large/);
    const frames = new FrameDecoder(true, 125, false).push(Buffer.concat([encodeFrame(OP.ping, Buffer.from('hi'), true), encodeFrame(OP.ping, Buffer.from('yo'), true)]));
    expect(frames.map((f) => f.payload.toString())).toEqual(['hi', 'yo']);
  });
});

describe('harbor CLI', () => {
  const io = (env: Record<string, string>, extra: Partial<CliIo> = {}) => {
    const out: string[] = [], err: string[] = [];
    return { out, err, io: { env, out: (l: string) => out.push(l), err: (l: string) => err.push(l), ...extra } as CliIo };
  };

  it('never takes a token from argv and reads one from env or a user-only file', () => {
    expect(loadToken({ ...io({ HARBOR_TOKEN: ' hbt_env ' }).io })).toBe('hbt_env');
    const file = io({ HARBOR_TOKEN_FILE: '/t' }, { platform: 'linux', readFile: () => 'hbt_file\n', fileMode: () => 0o100600 }).io;
    expect(loadToken(file)).toBe('hbt_file');
    const open = io({ HARBOR_TOKEN_FILE: '/t' }, { platform: 'linux', readFile: () => 'hbt_file', fileMode: () => 0o100644 }).io;
    expect(() => loadToken(open)).toThrow(/other users/);
    expect(() => loadToken(io({ HARBOR_TOKEN_FILE: '/missing' }, { readFile: () => { throw new Error('ENOENT'); } }).io)).toThrow(/No token/);
  });

  it('refuses --token on the command line', async () => {
    const t = io({ HARBOR_TOKEN: 'hbt_x' });
    expect(await runCli(['status', '--token', 'hbt_secret'], t.io)).toBe(2);
    expect(t.err.join()).toMatch(/never accepted on the command line/);
  });

  it('status, projects and answer work against the server', async () => {
    const pending: PendingPermission[] = [{ type: 'permission', requestId: 'tool1', kind: 'tool', prompt: 'Run it?' }];
    const s = await setup({ pending });
    s.svc['listClis']!.mockResolvedValue([{ id: 'claude', name: 'Claude', installed: true, signedIn: true, models: [] }]);
    s.svc['getUsage']!.mockResolvedValue([]);
    s.svc['listProjects']!.mockResolvedValue([{ id: 'p1', name: 'App', path: 'C:/app', lastOpened: 0 }]);
    const env = { HARBOR_URL: s.server.url, HARBOR_TOKEN: s.token('answer-permissions') };
    const a = io(env);
    expect(await runCli(['status'], a.io)).toBe(0);
    expect(a.out.join('\n')).toMatch(/answer-permissions[\s\S]*claude[\s\S]*waiting permission requests: 1/);
    const b = io(env);
    expect(await runCli(['projects'], b.io)).toBe(0);
    expect(b.out).toEqual(['p1\tApp\tC:/app']);
    const c = io(env);
    expect(await runCli(['answer', 'tool1', 'yes'], c.io)).toBe(0);
    expect(s.svc['answerPermission']).toHaveBeenCalledWith('tool1', true);
    const d = io(env);
    expect(await runCli(['answer', 'q9', 'use', 'the', 'second'], d.io)).toBe(0);
    expect(s.svc['answerQuestion']).toHaveBeenCalledWith('q9', 'use the second');
    const e = io(env);
    expect(await runCli(['send', 'c1', 'hello'], e.io)).toBe(1);
    expect(e.err.join()).toMatch(/does not allow send/);
    expect(describeEvent({ type: 'permission', requestId: 'r', kind: 'freeReset', prompt: 'p' })).toMatch(/answer in the app/);
  });
});

describe('headless', () => {
  it('runs the service with the remote API and holds the data folder against a second instance', async () => {
    const dir = tempDir();
    const service = createHarborService({ discover: async () => [] });
    const running = await startHeadless({ dataDir: dir, port: 0, service, logger: { file: '', log() {}, info() {}, warn() {}, error() {} } });
    cleanups.push(() => running.stop());
    expect(running.server?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const { token } = await service.createRemoteToken('cli', 'read-only');
    expect(await new RemoteClient({ url: running.server!.url, token }).invoke('listProjects')).toEqual([]);
    await expect(startHeadless({ dataDir: dir, port: 0, service: createHarborService({ discover: async () => [] }) })).rejects.toThrow(/already using/);
    expect(acquireInstanceLock(dir, 'headless', () => true, process.pid + 1).ok).toBe(false);
    const r = await runHeadless(['token', 'list', '--data-dir', dir], { out: () => undefined, err: () => undefined });
    expect(r).toBe(1);   // offline token commands refuse while Harbor runs
  });

  it('creates a token offline and prints it once', async () => {
    const dir = tempDir();
    const out: string[] = [], err: string[] = [];
    const sink = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    expect(await runHeadless(['token', 'create', 'phone', 'read-only', '--data-dir', dir], sink)).toBe(0);
    expect(out[0]).toMatch(/^hbt_/);
    expect(readFileSync(join(dir, 'remote-tokens.json'), 'utf8')).not.toContain(out[0]!);
    expect(await runHeadless(['token', 'create', 'pc', 'full', '--data-dir', dir], sink)).toBe(1);
    expect(err.join()).toMatch(/Full remote access is off/);
  });

  it('instance lock: refuses while the holder lives, takes over a stale one', () => {
    const dir = tempDir();
    const a = acquireInstanceLock(dir, 'desktop', () => true, 111);
    expect(a.ok).toBe(true);
    const b = acquireInstanceLock(dir, 'headless', () => true, 222);
    expect(b.ok).toBe(false);
    const c = acquireInstanceLock(dir, 'headless', () => false, 333);
    expect(c.ok).toBe(true);
    if (a.ok) a.release();   // not the holder any more: leaves c's lock alone
    expect(acquireInstanceLock(dir, 'headless', () => true, 444).ok).toBe(false);
  });
});
