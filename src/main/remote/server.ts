import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { HarborEvent, PendingPermission, RemoteScope, RemoteTokenInfo } from '../../shared/api';
import { INVOKE_METHODS } from '../../shared/ipc';
import { validateInvoke } from '../ipcValidate';
import { AuthLimiter, hostAllowed, originAllowed, type RemoteConfig } from './guard';
import { remoteCallRefusal, scopeAllows } from './scopes';
import type { RemoteTokens } from './tokens';
import { acceptKey, encodeFrame, FrameDecoder, isValidKey, OP } from './ws';

/** What the server needs from the service: the contract methods by name, the event stream and the pending permissions. */
export interface RemoteTarget {
  onEvent(cb: (e: HarborEvent) => void): () => void;
  listPendingPermissions(): Promise<PendingPermission[]>;
}

export interface RemoteServerOptions {
  service: RemoteTarget;
  tokens: RemoteTokens;
  config: RemoteConfig;
  log?: (message: string) => void;
  limiter?: AuthLimiter;
}

export interface RemoteServer { readonly port: number; readonly url: string; close(): Promise<void> }

/** `send` carries up to six 10 MB images as base64; nothing else needs more than a little text. */
const MAX_BODY_FULL = 96 * 1024 * 1024;
const MAX_BODY = 1024 * 1024;
/** A client that stops reading is dropped instead of buffering events without bound. */
const MAX_PENDING_WRITE = 16 * 1024 * 1024;

const INVOKE = new Set<string>(INVOKE_METHODS);

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers['authorization'];
  if (typeof h !== 'string') return undefined;
  const m = /^Bearer ([A-Za-z0-9_-]{1,200})$/.exec(h);
  return m?.[1];
}

export async function startRemoteServer(opts: RemoteServerOptions): Promise<RemoteServer> {
  const { service, tokens, config } = opts;
  const log = opts.log ?? (() => undefined);
  const limiter = opts.limiter ?? new AuthLimiter();
  const sockets = new Set<Duplex>();
  const streams = new Map<Duplex, string>();

  /** Host, Origin and token, in that order; the same gate for plain requests and the WebSocket handshake. */
  const admit = (req: IncomingMessage): RemoteTokenInfo => {
    if (!hostAllowed(req.headers.host, config)) throw new HttpError(403, 'Host not allowed.');
    if (!originAllowed(req.headers.origin)) throw new HttpError(403, 'Browser requests are not accepted.');
    const address = req.socket.remoteAddress ?? '?';
    if (limiter.blocked(address)) throw new HttpError(429, 'Too many failed attempts; try again later.');
    const info = tokens.verify(bearer(req));
    if (!info) { limiter.fail(address); log(`remote: rejected a request without a valid token from ${address}`); throw new HttpError(401, 'A valid token is required.'); }
    if (info.scope === 'full' && !config.allowFullScope) throw new HttpError(403, 'Full-scope remote access is turned off in Harbor settings.');
    return info;
  };

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {})
    });
    res.end(data);
  };

  const readBody = (req: IncomingMessage, limit: number): Promise<string> => new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { reject(new HttpError(413, 'Request too large.')); return; }
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large.')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });

  const invoke = async (method: string, req: IncomingMessage, scope: RemoteScope): Promise<unknown> => {
    if (!INVOKE.has(method)) throw new HttpError(404, 'Unknown method.');
    if (!scopeAllows(scope, method)) throw new HttpError(403, `This token's scope (${scope}) does not allow ${method}.`);
    const type = req.headers['content-type'] ?? '';
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) throw new HttpError(415, 'Send application/json.');
    let parsed: unknown;
    try { parsed = JSON.parse(await readBody(req, scope === 'full' ? MAX_BODY_FULL : MAX_BODY)); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'The body must be JSON.'); }
    const args = (parsed as { args?: unknown } | null)?.args ?? [];
    if (!Array.isArray(args) || args.length > 8) throw new HttpError(400, 'args must be a list.');
    // The IPC path's shape checks, unchanged: the remote path is never looser than the desktop window.
    try { validateInvoke(method, args); } catch (e) { throw new HttpError(400, (e as Error).message); }
    const refusal = await remoteCallRefusal(method, args, scope, () => service.listPendingPermissions());
    if (refusal) throw new HttpError(403, refusal);
    const fn = (service as unknown as Record<string, unknown>)[method];
    if (typeof fn !== 'function') throw new HttpError(404, 'Unknown method.');
    try { return await (fn as (...a: unknown[]) => Promise<unknown>).apply(service, args); } catch (e) { throw new HttpError(500, e instanceof Error ? e.message : 'The request failed.'); }
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      try {
        const info = admit(req);
        const path = (req.url ?? '').split('?')[0]!;
        if (req.method === 'GET' && path === '/v1/whoami') { send(res, 200, { id: info.id, name: info.name, scope: info.scope }); return; }
        const m = /^\/v1\/invoke\/([A-Za-z]{1,64})$/.exec(path);
        if (m && req.method === 'POST') {
          const result = await invoke(m[1]!, req, info.scope);
          log(`remote: ${info.name} ${m[1]} ok`);
          send(res, 200, result === undefined ? {} : { result });
          return;
        }
        if (path === '/v1/events') throw new HttpError(426, 'Open /v1/events as a WebSocket.');
        throw new HttpError(404, 'Not found.');
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        if (status !== 401) log(`remote: ${req.method} ${(req.url ?? '').slice(0, 80)} -> ${status}`);
        if (!res.headersSent) send(res, status, { error: e instanceof Error ? e.message : 'The request failed.' });
      }
    })();
  };

  const refuseUpgrade = (socket: Duplex, status: number, message: string): void => {
    const reason = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests' }[status] ?? 'Error';
    const body = JSON.stringify({ error: message });
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${status === 401 ? 'WWW-Authenticate: Bearer\r\n' : ''}\r\n${body}`);
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex): void => {
    let info: RemoteTokenInfo;
    try {
      info = admit(req);
      if ((req.url ?? '').split('?')[0] !== '/v1/events' || req.method !== 'GET') throw new HttpError(404, 'Not found.');
      if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || !isValidKey(req.headers['sec-websocket-key'])) throw new HttpError(400, 'Not a WebSocket handshake.');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 400;
      if (status !== 401) log(`remote: event stream refused (${status})`);
      refuseUpgrade(socket, status, e instanceof Error ? e.message : 'Refused.');
      return;
    }
    const key = req.headers['sec-websocket-key'] as string;
    sockets.add(socket);
    streams.set(socket, info.id);
    let closed = false;
    const close = (code: number): void => {
      if (closed) return;
      closed = true;
      const payload = Buffer.alloc(2); payload.writeUInt16BE(code, 0);
      try { socket.end(encodeFrame(OP.close, payload, false)); } catch { /* already gone */ }
      setTimeout(() => socket.destroy(), 1_000).unref?.();
    };
    // Subscribed before the 101 is written, so a client that saw the handshake succeed misses nothing after it.
    const off = service.onEvent((e) => {
      if (closed) return;
      if (!tokens.has(info.id)) { close(1008); return; }
      if (socket.writableLength > MAX_PENDING_WRITE) { log(`remote: ${info.name} event stream dropped (not reading)`); close(1008); return; }
      socket.write(encodeFrame(OP.text, Buffer.from(JSON.stringify(e)), false));
    });
    const decoder = new FrameDecoder(true, 125, false);
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const f of decoder.push(chunk)) {
          if (f.opcode === OP.close) close(1000);
          else if (f.opcode === OP.ping) socket.write(encodeFrame(OP.pong, f.payload, false));
        }
      } catch { close(1002); }
    });
    const cleanup = (): void => { closed = true; off(); sockets.delete(socket); streams.delete(socket); };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    log(`remote: ${info.name} opened the event stream`);
  };

  const server: Server = config.tls
    ? createHttpsServer({ cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile), minVersion: 'TLSv1.2' }, onRequest)
    : createHttpServer(onRequest);
  server.requestTimeout = 120_000;
  server.headersTimeout = 20_000;
  server.on('upgrade', onUpgrade);
  server.on('connection', (s: Socket) => { s.on('error', () => undefined); });
  const offRevoke = tokens.onRevoke((id) => {
    for (const [s, tokenId] of streams) if (tokenId === id) { s.end(encodeFrame(OP.close, Buffer.from([0x03, 0xf0]), false)); setTimeout(() => s.destroy(), 1_000).unref?.(); }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
  });
  const port = (server.address() as AddressInfo).port;
  const shownHost = config.host.includes(':') ? `[${config.host}]` : config.host;
  const url = `${config.tls ? 'https' : 'http'}://${shownHost}:${port}`;
  log(`remote: listening on ${url}`);
  return {
    port, url,
    close: () => new Promise<void>((resolve) => {
      offRevoke();
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
      server.closeAllConnections();
    })
  };
}
