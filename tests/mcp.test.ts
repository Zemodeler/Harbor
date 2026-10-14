import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { McpServerDraft } from '../src/shared/api';
import { ClaudeAdapter, claudeArgs } from '../src/main/adapters/claude';
import { codexArgs } from '../src/main/adapters/codex';
import { FakeAdapter } from '../src/main/adapters/fake';
import { GenericAdapter, genericArgs } from '../src/main/adapters/generic';
import type { Chunk, RunOptions, ToolPermissionRequest } from '../src/main/adapters/types';
import { featuresOf, validateDescriptor } from '../src/main/clis/custom';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { validateInvoke } from '../src/main/ipcValidate';
import { discoverCliMcpServers } from '../src/main/mcp/discover';
import { codexMcpArgs, codexMcpPlan, codexProblem, mcpConfigJson, planMcpRun, unattendedRules, writeMcpConfig } from '../src/main/mcp/materialize';
import { probeMcpServer, type McpFetch } from '../src/main/mcp/probe';
import { MCP_SERVERS_FILE, McpRegistry, maskSecrets, validateMcpServer } from '../src/main/mcp/registry';
import { createHarborService } from '../src/main/service';
import { normalizeSettingsPatch } from '../src/main/store';
import { readZip } from '../src/main/skills/zip';
import { ONE_CODEX_MODEL } from './fixtures/catalogs';

const dirs: string[] = [];
const tmp = (prefix = 'harbor-mcp-t-') => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const SECRET = 'sk-test-SECRETVALUE-0123456789abcdef';
const HEADER_SECRET = 'Bearer HEADERSECRET-abcdefghijklmnop';
const docs: McpServerDraft = { name: 'docs', transport: 'stdio', command: 'npx', args: ['-y', '@acme/docs-mcp', '--root', 'C:\\Data Files'], env: { DOCS_TOKEN: SECRET } };
const remote: McpServerDraft = { name: 'remote', transport: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: HEADER_SECRET } };
const legacy: McpServerDraft = { name: 'legacy', transport: 'sse', url: 'https://old.example.com/sse' };
const trusted: McpServerDraft = { name: 'trusted', transport: 'stdio', command: 'C:\\Tools\\trusted.exe', allowUnattended: true };
const base: RunOptions = { cwd: process.cwd(), model: 'default', effort: 'low', permission: 'edit' };

// ================================================================== registry

describe('MCP registry: validation', () => {
  it('accepts stdio, http and sse servers and drops unknown fields', () => {
    expect(validateMcpServer({ ...docs, extra: 1 }).server).toEqual(docs);
    expect(validateMcpServer(remote).server).toEqual(remote);
    expect(validateMcpServer({ ...legacy, allowUnattended: false }).server).toEqual(legacy);
    expect(validateMcpServer(trusted).server).toEqual(trusted);
  });

  it('lists every problem and never repeats a value', () => {
    const bad = validateMcpServer({ name: 'has space', transport: 'stdio', command: `"${SECRET}"`, args: ['ok', `x\n${SECRET}`], env: { PATH: SECRET, 'bad key': SECRET, OK: `${SECRET}\n` }, url: SECRET });
    expect(bad.server).toBeUndefined();
    const text = bad.problems.join('\n');
    expect(text).toMatch(/name must be/);
    expect(text).toMatch(/command must be a program name/);
    expect(text).toMatch(/args: every argument/);
    expect(text).toMatch(/env: PATH cannot be set/);
    expect(text).toMatch(/env: "bad key" is not a valid variable name/);
    expect(text).toMatch(/env.OK must be text on one line/);
    expect(text).toMatch(/url is only for http and sse/);
    expect(text).not.toContain(SECRET);
    expect(validateMcpServer({ name: 'x', transport: 'http', url: 'file:///C:/x', env: { A: 'b' } }).problems.join(' ')).toMatch(/url must be an http.*env is only for stdio/);
    expect(validateMcpServer({ name: 'x', transport: 'ws', url: 'https://a' }).problems).toEqual(['transport must be stdio, http or sse.']);
    expect(validateMcpServer({ name: 'x', transport: 'stdio', command: 'relative\\tool.exe' }).problems.join(' ')).toMatch(/absolute path/);
  });
});

describe('MCP registry: storage and per-project choices', () => {
  it('saves to the data folder, enables per project with a global default, renames keeping choices, removes', () => {
    const file = join(tmp(), MCP_SERVERS_FILE);
    const r = new McpRegistry(file, () => 1000);
    r.save(docs); r.save(remote);
    expect(r.list().map((s) => [s.name, s.enabled, s.defaultEnabled])).toEqual([['docs', false, false], ['remote', false, false]]);
    r.setEnabled('docs', true, 'p1');
    r.setEnabled('remote', true);
    expect(r.list('p1').map((s) => s.enabled)).toEqual([true, true]);
    expect(r.list('p2').map((s) => s.enabled)).toEqual([false, true]);
    r.setEnabled('remote', false, 'p2');
    expect(r.enabledFor('p2')).toEqual([]);
    expect(r.enabledFor('p1')).toEqual([docs, remote]);
    // Plain text in the data folder (owner decision), reloaded as saved.
    expect(readFileSync(file, 'utf8')).toContain(SECRET);
    const again = new McpRegistry(file);
    expect(again.list('p1').map((s) => s.enabled)).toEqual([true, true]);
    again.save({ ...docs, name: 'docs2' }, 'docs');
    expect(again.list('p1').find((s) => s.name === 'docs2')!.enabled).toBe(true);
    expect(() => again.save({ ...remote, name: 'DOCS2' })).toThrow(/already exists/);
    expect(() => again.save(docs, 'missing')).toThrow(/no MCP server with that name/);
    again.setEnabled('docs2', null, 'p1');
    expect(again.list('p1').find((s) => s.name === 'docs2')!.enabled).toBe(false);
    again.remove('docs2');
    expect(new McpRegistry(file).list().map((s) => s.name)).toEqual(['remote']);
  });

  it('a damaged entry is dropped with a warning that holds no value', () => {
    const file = join(tmp(), MCP_SERVERS_FILE);
    writeFileSync(file, JSON.stringify({ servers: [docs, { name: 'bad', transport: 'stdio', command: 'npx', env: { PATH: SECRET } }, { ...docs }] }));
    const r = new McpRegistry(file);
    expect(r.list().map((s) => s.name)).toEqual(['docs']);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.join(' ')).not.toContain(SECRET);
  });

  it('masks entered values in text', () => {
    expect(maskSecrets(`token=${SECRET}; auth: ${HEADER_SECRET}`, [docs, remote])).toBe('token=[redacted]; auth: [redacted]');
  });
});

// ================================================================== materializers

describe('materializers produce the verified shapes', () => {
  it('Claude / custom CLIs: {"mcpServers": ...} with stdio, http and sse entries', () => {
    expect(mcpConfigJson([docs, remote, legacy, trusted])).toEqual({
      mcpServers: {
        docs: { type: 'stdio', command: 'npx', args: ['-y', '@acme/docs-mcp', '--root', 'C:\\Data Files'], env: { DOCS_TOKEN: SECRET } },
        remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: HEADER_SECRET } },
        legacy: { type: 'sse', url: 'https://old.example.com/sse' },
        trusted: { type: 'stdio', command: 'C:\\Tools\\trusted.exe', args: [] }
      }
    });
  });

  it('Codex: -c mcp_servers overrides with TOML literal strings; SSE and unpassable values are skipped', () => {
    expect(codexMcpArgs([docs, remote, legacy])).toEqual([
      '-c', "mcp_servers.docs.command='npx'",
      '-c', "mcp_servers.docs.args=['-y','@acme/docs-mcp','--root','C:\\Data Files']",
      '-c', "mcp_servers.docs.env_vars=['DOCS_TOKEN']",
      '-c', "mcp_servers.remote.url='https://mcp.example.com/mcp'",
      '-c', "mcp_servers.remote.env_http_headers={Authorization='HARBOR_MCP_0'}"
    ]);
    // Codex cannot ask, so only a server the owner allowed to run unattended gets its tool calls approved (live-verified key).
    expect(codexMcpArgs([docs])).not.toContain("mcp_servers.docs.default_tools_approval_mode='approve'");
    expect(codexMcpArgs([{ ...docs, allowUnattended: true }])).toContain("mcp_servers.docs.default_tools_approval_mode='approve'");
    // Secrets travel in the environment, never in argv.
    const plan = codexMcpPlan([docs, remote]);
    expect(plan.env).toEqual({ DOCS_TOKEN: SECRET, HARBOR_MCP_0: HEADER_SECRET });
    expect(plan.args.join(' ')).not.toContain(SECRET);
    expect(plan.args.join(' ')).not.toContain(HEADER_SECRET);
    // The same variable with two different values cannot share one environment: the later server is left out.
    expect(codexMcpPlan([docs, { ...docs, name: 'docs2', env: { DOCS_TOKEN: 'other' } }]).skipped).toEqual(['docs2']);
    expect(codexProblem(legacy)).toMatch(/not SSE/);
    expect(codexProblem({ ...docs, args: ["it's"] })).toMatch(/quote/);
    expect(codexProblem({ ...docs, env: { 'A B': 'x' } })).toMatch(/name/);
    expect(codexProblem({ ...remote, url: 'https://a.example.com/x%20y' })).toMatch(/%/);
    expect(codexMcpArgs([{ ...docs, args: ['say "hi"'] }])).toEqual([]);
    // No value can carry a double quote or % into argv (proc.ts refuses them for .cmd shims).
    for (const a of codexMcpArgs([docs, remote])) expect(a).not.toMatch(/["%]/);
  });

  it('Claude args: --mcp-config file, --strict-mcp-config, and allow rules only for servers allowed without asking', () => {
    const run = { servers: [docs, trusted], strict: true };
    const a = claudeArgs({ ...base, mcp: run, onToolPermission: async () => ({ allow: true }) }, undefined, 'C:\\T\\mcp.json');
    expect(a.slice(a.indexOf('--mcp-config'), a.indexOf('--mcp-config') + 3)).toEqual(['--mcp-config', 'C:\\T\\mcp.json', '--strict-mcp-config']);
    const allowed = a.slice(a.indexOf('--allowedTools') + 1, a.indexOf('--disallowedTools'));
    expect(allowed).toContain('mcp__trusted');
    expect(allowed).not.toContain('mcp__docs');
    expect(a).toContain('--permission-prompt-tool');
    expect(unattendedRules(run)).toEqual(['mcp__trusted']);
    // Strict alone (no Harbor servers): Claude's own servers stay out.
    const strictOnly = claudeArgs({ ...base, mcp: { servers: [], strict: true } });
    expect(strictOnly).toContain('--strict-mcp-config');
    expect(strictOnly).not.toContain('--mcp-config');
    // No MCP option: unchanged from before.
    expect(claudeArgs(base)).not.toContain('--strict-mcp-config');
    // The concierge stays lean whatever it is handed.
    const lean = claudeArgs({ ...base, lean: true, mcp: run }, undefined, 'C:\\T\\mcp.json');
    expect(lean).not.toContain('--mcp-config');
    expect(lean.filter((x) => x === '--strict-mcp-config')).toHaveLength(1);
  });

  it('Codex args carry the overrides before the stdin marker', () => {
    const a = codexArgs({ ...base, mcp: { servers: [trusted] } });
    expect(a.slice(-5)).toEqual(['-c', "mcp_servers.trusted.command='C:\\Tools\\trusted.exe'", '-c', "mcp_servers.trusted.default_tools_approval_mode='approve'", '-']);
    expect(codexArgs(base).join(' ')).not.toContain('mcp_servers');
  });

  it('custom CLIs: run.mcp with {mcpConfigFile} turns features.mcp on and expands in the {mcpArgs} slot', () => {
    const v = validateDescriptor({ id: 'mycli', name: 'My', exe: 'C:\\t\\m.exe', run: { args: ['--print', '{mcpArgs}', '--json'], mcp: { args: ['--mcp', '{mcpConfigFile}'] } } }, { otherIds: [], isFile: () => true });
    expect(v.problems).toEqual([]);
    expect(featuresOf(v.descriptor!).mcp).toBe(true);
    expect(genericArgs(v.descriptor!, base, undefined, 'C:\\T x\\mcp.json')).toEqual(['--print', '--mcp', 'C:\\T x\\mcp.json', '--json']);
    expect(genericArgs(v.descriptor!, base)).toEqual(['--print', '--json']);
    expect(validateDescriptor({ id: 'mycli', name: 'My', exe: 'C:\\t\\m.exe', run: { args: [], mcp: { args: ['--mcp'] } } }, { otherIds: [], isFile: () => true }).problems.join(' ')).toMatch(/must contain \{mcpConfigFile\}/);
    expect(validateDescriptor({ id: 'mycli', name: 'My', exe: 'C:\\t\\m.exe', run: { args: ['{mcpConfigFile}'] } }, { otherIds: [], isFile: () => true }).problems.join(' ')).toMatch(/placeholder \{mcpConfigFile\}/);
    expect(featuresOf(validateDescriptor({ id: 'mycli', name: 'My', exe: 'C:\\t\\m.exe', run: { args: [] } }, { otherIds: [], isFile: () => true }).descriptor!).mcp).toBe(false);
  });
});

describe('which servers a run gets (planMcpRun)', () => {
  const all = [docs, remote, legacy, trusted];
  const plan = (o: Partial<Parameters<typeof planMcpRun>[0]>) => planMcpRun({ servers: all, cliName: 'X', target: 'claude', permission: 'edit', hostAsks: true, ...o });
  const names = (r: ReturnType<typeof planMcpRun>) => r.run?.servers.map((s) => s.name);

  it('Claude edit runs that ask: every server, strict', () => {
    const r = plan({});
    expect(names(r)).toEqual(['docs', 'remote', 'legacy', 'trusted']);
    expect(r.run!.strict).toBe(true);
    expect(r.notes.join(' ')).toMatch(/MCP servers: docs, remote, legacy, trusted \(each tool call asks you/);
  });

  it('runs that cannot ask (Claude auto mode, Codex, custom CLIs) get only servers allowed without asking', () => {
    const auto = plan({ permission: 'full', hostAsks: false, claudeOwnMcp: true });
    expect(names(auto)).toEqual(['trusted']);
    expect(auto.run!.strict).toBe(true); // Claude's own servers are off in auto mode even when allowed elsewhere
    expect(auto.notes.join(' ')).toMatch(/auto mode does not ask/);
    expect(auto.notes.join(' ')).toMatch(/own MCP servers are off in auto mode/);
    const codex = plan({ target: 'codex', cliName: 'Codex', hostAsks: false, servers: [...all, { ...legacy, name: 'legacy2', allowUnattended: true }] });
    expect(names(codex)).toEqual(['trusted']);
    expect(codex.run!.strict).toBeUndefined();
    expect(codex.notes.join(' ')).toMatch(/Codex cannot ask Harbor/);
    expect(codex.notes.join(' ')).toMatch(/legacy2 \(Codex supports stdio and streamable HTTP/);
    expect(names(plan({ target: 'custom', hostAsks: false }))).toEqual(['trusted']);
    expect(plan({ target: 'custom', hostAsks: false, servers: [docs] }).run).toBeUndefined();
  });

  it('read-only runs and CLIs without MCP support get none, with a note; no servers means no note', () => {
    const ro = plan({ permission: 'read-only' });
    expect(ro.run).toEqual({ servers: [], strict: true });
    expect(ro.notes.join(' ')).toMatch(/read-only runs get no MCP servers/);
    const none = plan({ target: 'none', cliName: 'Gemini CLI' });
    expect(none.run).toBeUndefined();
    expect(none.notes).toEqual(['MCP: Gemini CLI has no MCP support in Harbor; not given: docs, remote, legacy, trusted.']);
    expect(plan({ servers: [] })).toEqual({ run: { servers: [], strict: true }, notes: [] });
    expect(plan({ servers: [], claudeOwnMcp: true }).run).toEqual({ servers: [], strict: false });
  });

  it('notes never hold a value', () => {
    for (const r of [plan({}), plan({ target: 'codex', hostAsks: false }), plan({ permission: 'read-only' }), plan({ target: 'none' })]) {
      const t = r.notes.join(' ');
      expect(t).not.toContain(SECRET);
      expect(t).not.toContain('HEADERSECRET');
      expect(t).not.toContain('npx');
    }
  });
});

// ================================================================== temp config files

describe('the per-run config file is removed after the run', () => {
  const SCRIPT = resolve(__dirname, 'fixtures', 'fakeCli.cjs');
  const desc = (mode: string) => ({ id: 'fake', name: 'Fake CLI', exe: process.execPath, run: { args: [SCRIPT, '--mode', mode], mcp: { args: ['--mcp-config', '{mcpConfigFile}'] } } });
  const collect = async (a: GenericAdapter, o: Partial<RunOptions> = {}) => { const cs: Chunk[] = []; for await (const c of a.run('p', { ...base, mcp: { servers: [docs] }, ...o })) cs.push(c); return cs; };

  it('writeMcpConfig: own folder outside the project, cleanup removes it', () => {
    const root = tmp();
    const w = writeMcpConfig([docs], root);
    expect(w.file.startsWith(root)).toBe(true);
    expect(JSON.parse(readFileSync(w.file, 'utf8'))).toEqual(mcpConfigJson([docs]));
    w.cleanup();
    expect(readdirSync(root)).toEqual([]);
  });

  it('custom CLI: the file exists during the run and is gone after success, failure and abort', async () => {
    const root = tmp();
    const ok = await collect(new GenericAdapter(desc('echo'), { tmpDir: root }));
    const done = ok.at(-1) as Extract<Chunk, { kind: 'done' }>;
    expect(JSON.parse(done.text!).mcp).toEqual(mcpConfigJson([docs]));
    expect(readdirSync(root)).toEqual([]);
    expect((await collect(new GenericAdapter(desc('fail'), { tmpDir: root }))).at(-1)).toMatchObject({ kind: 'done', ok: false });
    expect(readdirSync(root)).toEqual([]);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 500);
    expect((await collect(new GenericAdapter(desc('forever'), { tmpDir: root }), { signal: ctl.signal })).at(-1)).toMatchObject({ kind: 'done', ok: false, error: 'stopped' });
    expect(readdirSync(root)).toEqual([]);
    // Without run.mcp nothing is written.
    await collect(new GenericAdapter({ ...desc('echo'), run: { args: [SCRIPT, '--mode', 'echo'] } }, { tmpDir: root }));
    expect(readdirSync(root)).toEqual([]);
  }, 20000);

  describe('Claude (fake CLI): the file is read during the run, MCP tool calls use the permission channel, then it is removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor fakeclaude mcp '));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const script = resolve(__dirname, 'fixtures', 'fakeClaude.cjs');
    let exe: string;
    if (process.platform === 'win32') { exe = join(dir, 'claude.cmd'); writeFileSync(exe, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`); }
    else { exe = join(dir, 'claude'); writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`); chmodSync(exe, 0o755); }
    const adapter = new ClaudeAdapter(exe);
    const mcpDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('harbor-mcp-') && !n.startsWith('harbor-mcp-t-'));

    it('success', async () => {
      const seen: ToolPermissionRequest[] = [];
      const chunks: Chunk[] = [];
      for await (const c of adapter.run('mcp', { ...base, cwd: dir, mcp: { servers: [docs], strict: true }, onToolPermission: async (r) => { seen.push(r); return { allow: true }; } })) chunks.push(c);
      const done = chunks.at(-1) as Extract<Chunk, { kind: 'done' }>;
      expect(done.ok).toBe(true);
      const report = JSON.parse(done.text!) as { argv: string[]; mcp: unknown; responses: Array<{ response: { behavior: string } }> };
      expect(report.mcp).toEqual(mcpConfigJson([docs]));
      expect(report.argv).toContain('--strict-mcp-config');
      expect(seen.map((r) => r.tool)).toEqual(['mcp__docs__search']);
      expect(report.responses[0]!.response.behavior).toBe('allow');
      const file = report.argv[report.argv.indexOf('--mcp-config') + 1]!;
      expect(existsSync(file)).toBe(false);
      // The prompt and the secret are never on the command line for Claude.
      expect(report.argv.join(' ')).not.toContain(SECRET);
    }, 20000);

    it('failure and abort', async () => {
      const before = mcpDirs();
      const fail: Chunk[] = [];
      for await (const c of adapter.run('noresult', { ...base, cwd: dir, mcp: { servers: [docs] }, onToolPermission: async () => ({ allow: true }) })) fail.push(c);
      expect(fail.at(-1)).toMatchObject({ kind: 'done', ok: false });
      const ctl = new AbortController();
      const hang: Chunk[] = [];
      setTimeout(() => ctl.abort(), 800);
      for await (const c of adapter.run('hang', { ...base, cwd: dir, signal: ctl.signal, mcp: { servers: [docs] }, onToolPermission: () => new Promise(() => {}) })) hang.push(c);
      expect(hang.at(-1)).toMatchObject({ kind: 'done', ok: false });
      expect(mcpDirs()).toEqual(before);
    }, 30000);
  });
});

// ================================================================== service and orchestrator

describe('MCP servers through the service', () => {
  it('saves, lists per project, survives a restart; IPC shapes are checked', async () => {
    const data = tmp(), project = tmp();
    let svc = createHarborService({ dataDir: data, discover: async () => [] });
    const p = (await svc.addProject(project))!;
    expect(await svc.saveMcpServer!(docs, { projectId: p.id })).toEqual([expect.objectContaining({ name: 'docs', enabled: false })]);
    await expect(svc.saveMcpServer!({ ...docs, env: { PATH: SECRET } })).rejects.toThrow(/PATH cannot be set/);
    expect(String(await svc.saveMcpServer!({ ...docs, env: { PATH: SECRET } }).catch((e: Error) => e.message))).not.toContain(SECRET);
    expect((await svc.setMcpServerEnabled!('docs', true, p.id)).map((s) => s.enabled)).toEqual([true]);
    expect((await svc.listMcpServers!()).map((s) => s.enabled)).toEqual([false]);
    await svc.shutdown();
    svc = createHarborService({ dataDir: data, discover: async () => [] });
    expect((await svc.listMcpServers!(p.id)).map((s) => [s.name, s.enabled])).toEqual([['docs', true]]);
    expect(await svc.removeMcpServer!('docs')).toEqual([]);
    await svc.shutdown();
    expect(() => validateInvoke('saveMcpServer', [docs, { previousName: 'docs' }])).not.toThrow();
    expect(() => validateInvoke('saveMcpServer', ['x'])).toThrow(/server must be an object/);
    expect(() => validateInvoke('setMcpServerEnabled', ['docs', 'yes'])).toThrow(/enabled must be/);
    expect(() => validateInvoke('testMcpServer', [docs, { confirmCommand: 'a\nb' }])).toThrow(/confirmCommand/);
    expect(() => validateInvoke('removeMcpServer', ['', {}])).toThrow(/server name/);
    expect(() => validateInvoke('listMcpServers', [5])).toThrow(/project id/);
  });

  it('env values never reach a bundle or the diagnostics', async () => {
    const data = tmp(), project = tmp(), out = tmp();
    // A damaged entry holding a secret too: its load warning goes to the journal and diagnostics, without the value.
    writeFileSync(join(data, MCP_SERVERS_FILE), JSON.stringify({ servers: [{ name: 'broken', transport: 'stdio', command: 'npx', env: { PATH: SECRET } }] }));
    const svc = createHarborService({ dataDir: data, discover: async () => [], pickBundleSave: async () => join(out, 'b.harbor.zip') });
    const p = (await svc.addProject(project))!;
    await svc.saveMcpServer!(docs); await svc.saveMcpServer!(remote);
    await svc.setMcpServerEnabled!('docs', true, p.id);
    const [conv] = await svc.listConversations(p.id);
    svc.store.addMessage({ id: 'm1', conversationId: conv!.id, role: 'user', text: 'hello', time: Date.now() });
    const pv = await svc.previewBundleExport(p.id, { settings: true, toolRules: true, skillChoices: true, conversations: [conv!.id] });
    expect(pv.excluded.join(' ')).toMatch(/MCP servers/);
    const r = (await svc.exportBundle(pv.token, { keepSecrets: true }))!;
    const text = readZip(readFileSync(r.path), { maxEntries: 1000, maxFileBytes: 1 << 24, maxTotalBytes: 1 << 26, maxArchiveBytes: 1 << 26 }).map((f) => `${f.path}\n${f.data.toString('utf8')}`).join('\n');
    for (const v of [SECRET, 'HEADERSECRET', 'mcp-servers', 'DOCS_TOKEN']) expect(text).not.toContain(v);
    const diag = await svc.exportDiagnostics();
    expect(diag).toContain('mcp-servers.json entry 1 dropped');
    for (const v of [SECRET, 'HEADERSECRET', 'DOCS_TOKEN']) expect(diag).not.toContain(v);
    await svc.shutdown();
  });

  const fakeCli = (id: string): ResolvedCli => ({ id, name: id === 'codex' ? 'Codex' : 'Claude Code', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: `/fake/${id}` });
  const say = (text: string): Chunk[] => [{ kind: 'text', text }];

  async function run(cli: 'claude' | 'codex') {
    const data = tmp(), project = tmp();
    const calls: RunOptions[] = [];
    let leadTurns = 0;
    const fake = new FakeAdapter(cli, (_p, opts) => {
      calls.push(opts);
      if (opts.systemPrompt?.includes('front desk')) return say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }));
      if (opts.systemPrompt?.includes('LEAD agent') && leadTurns++ === 0) return say(`Looking.\nHARBOR_DELEGATE: ${JSON.stringify({ ref: 'r1', title: 'Survey the files', role: 'other', access: 'read', instructions: 'List the files in the project and report.', complexity: 'low', needs: ['code'] })}`);
      return say('done\nHARBOR_RESULT: {"outcome":"done","summary":"ok","checks":[]}');
    });
    const svc = createHarborService({ dataDir: data, discover: async () => [fakeCli(cli)], adapterFor: (id) => (id === cli ? fake : undefined), worktreesRoot: join(tmp(), 'wt'), catalog: ONE_CODEX_MODEL });
    const p = (await svc.addProject(project))!;
    for (const s of [docs, trusted, remote]) await svc.saveMcpServer!(s);
    await svc.setMcpServerEnabled!('docs', true, p.id);
    await svc.setMcpServerEnabled!('trusted', true, p.id);
    const [conv] = await svc.listConversations(p.id);
    await svc.send(conv!.id, 'please look at the project files and summarise them');
    await svc.whenIdle(15000);
    const messages = await svc.listMessages(conv!.id);
    await svc.shutdown();
    const lead = calls.filter((o) => o.systemPrompt?.includes('LEAD agent'));
    const helpers = calls.filter((o) => !o.systemPrompt?.includes('front desk') && !o.systemPrompt?.includes('LEAD agent'));
    const concierge = calls.filter((o) => o.systemPrompt?.includes('front desk'));
    return { lead, helpers, concierge, messages };
  }

  it('Claude: the lead (edit, asks) gets the project\'s enabled servers, strict; read-only helpers and the concierge get none', async () => {
    const { lead, helpers, concierge, messages } = await run('claude');
    expect(lead.length).toBeGreaterThan(0);
    for (const o of lead) { expect(o.permission).toBe('edit'); expect(o.onToolPermission).toBeDefined(); expect(o.mcp).toEqual({ servers: [docs, trusted], strict: true }); }
    expect(helpers.length).toBeGreaterThan(0);
    for (const o of helpers) { expect(o.permission).toBe('read-only'); expect(o.mcp).toEqual({ servers: [], strict: true }); }
    for (const o of concierge) expect(o.mcp).toBeUndefined();
    const reasons = messages.map((m) => m.details?.reason ?? '').join('\n');
    expect(reasons).toContain('• MCP servers: docs, trusted');
    expect(reasons).not.toContain(SECRET);
  }, 30000);

  it('Codex: only servers allowed without asking, with a note naming the rest', async () => {
    const { lead, messages } = await run('codex');
    for (const o of lead) expect(o.mcp).toEqual({ servers: [trusted] });
    const reasons = messages.map((m) => m.details?.reason ?? '').join('\n');
    expect(reasons).toMatch(/MCP: not given docs: each tool call needs your yes and Codex cannot ask Harbor/);
  }, 30000);
});

// ================================================================== test button

describe('testMcpServer', () => {
  const FAKE = resolve(__dirname, 'fixtures', 'fakeMcp.cjs');
  const server = (extra: string[] = [], env: Record<string, string> = { FAKE_TOKEN: SECRET }): McpServerDraft => ({ name: 'fake', transport: 'stdio', command: process.execPath, args: [FAKE, ...extra], env });

  it('needs the exact command confirmed, then runs initialize + tools/list with only the allowlist plus its env', async () => {
    const svc = createHarborService({ discover: async () => [], mcpTestTimeoutMs: 8000 });
    await expect(svc.testMcpServer!(server())).rejects.toThrow(/Confirm that Harbor may run/);
    await expect(svc.testMcpServer!(server(), { confirmCommand: 'node' })).rejects.toThrow(/Confirm/);
    process.env['SECRET_FROM_HARBOR'] = 'x';
    try {
      const r = await svc.testMcpServer!(server(), { confirmCommand: process.execPath });
      expect(r).toMatchObject({ ok: true, transport: 'stdio', serverName: 'fake-mcp', serverVersion: '1.2.3', protocolVersion: '2025-06-18', tools: ['search', 'token_seen', 'clean_env'] });
      expect(r.stderr).toContain('token=[redacted]');
      expect(JSON.stringify(r)).not.toContain(SECRET);
    } finally { delete process.env['SECRET_FROM_HARBOR']; }
    await svc.shutdown();
  }, 20000);

  it('reports a refusal, silence (timeout) and a missing program', async () => {
    const svc = createHarborService({ discover: async () => [], mcpTestTimeoutMs: 1500 });
    expect(await svc.testMcpServer!(server(['--error']), { confirmCommand: process.execPath })).toMatchObject({ ok: false, error: expect.stringMatching(/error: not today/) });
    expect(await svc.testMcpServer!(server(['--silent']), { confirmCommand: process.execPath })).toMatchObject({ ok: false, error: expect.stringMatching(/no MCP answer within 2 s/) });
    const missing = join(tmp(), 'nope.exe');
    expect(await svc.testMcpServer!({ name: 'x', transport: 'stdio', command: missing }, { confirmCommand: missing })).toMatchObject({ ok: false, error: expect.stringMatching(/was not found/) });
    await expect(svc.testMcpServer!({ name: 'x', transport: 'stdio', command: 'a b' }, { confirmCommand: 'a b' })).rejects.toThrow(/cannot be tested/);
    await svc.shutdown();
  }, 20000);

  it('streamable HTTP: JSON and SSE answers, the session header, entered headers sent and masked', async () => {
    const seen: Array<{ method: string; headers: Record<string, string>; body?: string }> = [];
    const respond = (status: number, body: string, headers: Record<string, string> = {}) => ({ ok: status < 300, status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, body: new Response(body).body, text: async () => body });
    const fetchFn: McpFetch = async (_url, init) => {
      seen.push({ method: init.method, headers: init.headers, body: init.body });
      const m = JSON.parse(init.body ?? '{}');
      if (m.method === 'initialize') return respond(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'web', version: '9' } } }), { 'content-type': 'application/json', 'mcp-session-id': 'S1' });
      if (m.method === 'notifications/initialized') return respond(202, '');
      return respond(200, `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'fetch' }] } })}\n\n`, { 'content-type': 'text/event-stream' });
    };
    const r = await probeMcpServer(remote, { cwd: tmp(), resolveCommand: () => undefined, fetch: fetchFn, timeoutMs: 3000 });
    expect(r).toMatchObject({ ok: true, serverName: 'web', tools: ['fetch'] });
    expect(seen.map((s) => s.headers['Authorization'])).toEqual([HEADER_SECRET, HEADER_SECRET, HEADER_SECRET]);
    expect(seen[1]!.headers['Mcp-Session-Id']).toBe('S1');
    const fail = await probeMcpServer(remote, { cwd: tmp(), resolveCommand: () => undefined, fetch: async () => { throw new Error(`refused ${HEADER_SECRET}`); }, timeoutMs: 3000 });
    expect(fail.ok).toBe(false);
    expect(fail.error).not.toContain('HEADERSECRET');
  });
});

// ================================================================== discovery and settings

describe('the CLIs\' own MCP servers (read-only)', () => {
  it('lists names and kinds only, never commands, URLs or values', () => {
    const home = tmp(), codexHome = join(home, '.codex'), project = tmp();
    mkdirSync(codexHome);
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: HEADER_SECRET } }, files: { command: 'npx', args: ['x'], env: { K: SECRET } } }, projects: { [project.replace(/\\/g, '/')]: { mcpServers: { local1: { command: 'uvx' } } } } }));
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { type: 'sse', url: 'https://x.example.com' } } }));
    writeFileSync(join(codexHome, 'config.toml'), `model = "x"\n\n[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y"]\n\n[mcp_servers.context7.env]\nKEY = "${SECRET}"\n\n[mcp_servers."web-api"]\nurl = "https://y.example.com"\n`);
    const found = discoverCliMcpServers({ home, codexHome }, project);
    expect(found.map((s) => [s.source, s.scope, s.name, s.transport])).toEqual([
      ['claude', 'user', 'github', 'http'], ['claude', 'user', 'files', 'stdio'], ['claude', 'local', 'local1', 'stdio'], ['claude', 'project', 'shared', 'sse'],
      ['codex', 'user', 'context7', 'stdio'], ['codex', 'user', 'web-api', 'http']
    ]);
    const text = JSON.stringify(found);
    for (const v of [SECRET, 'HEADERSECRET', 'npx', 'api.example.com']) expect(text).not.toContain(v);
    expect(found[0]!.where).toBe('~\\.claude.json'.replace(/\\/g, process.platform === 'win32' ? '\\' : '/'));
    expect(discoverCliMcpServers({}, undefined)).toEqual([]);
  });

  it('claudeOwnMcp must be a boolean', () => {
    expect(normalizeSettingsPatch({ claudeOwnMcp: true }).claudeOwnMcp).toBe(true);
    expect(() => normalizeSettingsPatch({ claudeOwnMcp: 'yes' as never })).toThrow('claudeOwnMcp must be a boolean.');
  });
});
