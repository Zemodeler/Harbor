import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import type { HarborEvent, RemoteScope } from '../../shared/api';
import { isLoopbackHost } from './guard';
import { acceptKey, encodeFrame, FrameDecoder, newKey, OP } from './ws';

export interface RemoteClientOptions {
  url: string;
  token: string;
  /** Needed to send the token over plain http to anything but a loopback address (the owner's tunnel encrypts instead). */
  allowPlainHttp?: boolean;
  /** Extra TLS options, e.g. a self-signed server certificate as `ca`. */
  ca?: string | Buffer;
}

export class RemoteError extends Error { constructor(readonly status: number, message: string) { super(message); } }

/** Client for the remote API (used by the `harbor` CLI and tests). The token travels only in the Authorization header. */
export class RemoteClient {
  private base: URL;
  constructor(private opts: RemoteClientOptions) {
    this.base = new URL(opts.url);
    if (this.base.protocol !== 'http:' && this.base.protocol !== 'https:') throw new Error('The Harbor URL must start with http:// or https://.');
    if (this.base.protocol === 'http:' && !isLoopbackHost(this.base.hostname) && !opts.allowPlainHttp) {
      throw new Error(`Refusing to send the token in clear text to ${this.base.hostname}. Use https, or set HARBOR_ALLOW_PLAIN_HTTP=1 if a tunnel already encrypts the connection.`);
    }
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(opts.token)) throw new Error('The token is malformed.');
  }

  private options(path: string, method: string, headers: Record<string, string | number>): RequestOptions & { ca?: string | Buffer } {
    return {
      protocol: this.base.protocol, hostname: this.base.hostname, port: this.base.port || undefined, path, method,
      headers: { Authorization: `Bearer ${this.opts.token}`, ...headers }, ...(this.opts.ca ? { ca: this.opts.ca } : {})
    };
  }

  private requestJson(path: string, method: string, body?: unknown): Promise<unknown> {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = (this.base.protocol === 'https:' ? httpsRequest : httpRequest)(this.options(path, method, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}));
    return new Promise((resolve, reject) => {
      req.on('error', reject);
      req.on('response', (res: IncomingMessage) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => {
          let parsed: unknown = {};
          try { parsed = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { /* not JSON */ }
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve(parsed);
          else reject(new RemoteError(status, (parsed as { error?: string }).error ?? `HTTP ${status}`));
        });
      });
      req.end(data);
    });
  }

  async whoami(): Promise<{ id: string; name: string; scope: RemoteScope }> {
    return await this.requestJson('/v1/whoami', 'GET') as { id: string; name: string; scope: RemoteScope };
  }

  async invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    const r = await this.requestJson(`/v1/invoke/${encodeURIComponent(method)}`, 'POST', { args }) as { result?: T };
    return r.result as T;
  }

  /** Opens the event stream. `opened` resolves once the server accepted it (events from then on are delivered). */
  watch(onEvent: (e: HarborEvent) => void): { opened: Promise<void>; closed: Promise<void>; close(): void } {
    const key = newKey();
    const req = (this.base.protocol === 'https:' ? httpsRequest : httpRequest)(this.options('/v1/events', 'GET', {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': 13, 'Sec-WebSocket-Key': key
    }));
    let socket: Duplex | undefined;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => { resolveClosed = r; });
    const opened = new Promise<void>((resolve, reject) => {
      req.on('error', (e) => { reject(e); resolveClosed(); });
      req.on('response', (res: IncomingMessage) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => {
          let msg = `HTTP ${res.statusCode}`;
          try { msg = (JSON.parse(Buffer.concat(parts).toString('utf8')) as { error?: string }).error ?? msg; } catch { /* keep */ }
          reject(new RemoteError(res.statusCode ?? 0, msg));
          resolveClosed();
        });
      });
      req.on('upgrade', (res: IncomingMessage, s: Duplex, head: Buffer) => {
        if (res.headers['sec-websocket-accept'] !== acceptKey(key)) { s.destroy(); reject(new Error('The server did not complete the WebSocket handshake.')); resolveClosed(); return; }
        socket = s;
        const decoder = new FrameDecoder(false, 128 * 1024 * 1024, true);
        const onData = (chunk: Buffer): void => {
          try {
            for (const f of decoder.push(chunk)) {
              if (f.opcode === OP.text) { try { onEvent(JSON.parse(f.payload.toString('utf8')) as HarborEvent); } catch { /* skip a malformed event */ } }
              else if (f.opcode === OP.ping) s.write(encodeFrame(OP.pong, f.payload, true));
              else if (f.opcode === OP.close) s.end();
            }
          } catch { s.destroy(); }
        };
        s.on('data', onData);
        s.on('close', () => resolveClosed());
        s.on('error', () => resolveClosed());
        if (head.length) onData(head);
        resolve();
      });
      req.end();
    });
    return {
      opened, closed,
      close: () => {
        if (socket) { try { socket.end(encodeFrame(OP.close, Buffer.from([0x03, 0xe8]), true)); } catch { /* gone */ } setTimeout(() => socket?.destroy(), 500).unref?.(); }
        else req.destroy();
      }
    };
  }
}
