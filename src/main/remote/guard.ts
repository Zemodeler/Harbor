import type { RemoteSettings } from '../../shared/api';

export const DEFAULT_REMOTE_PORT = 47821;
export const DEFAULT_REMOTE_HOST = '127.0.0.1';

export interface RemoteConfig {
  host: string;
  port: number;
  tls?: { certFile: string; keyFile: string };
  allowFullScope: boolean;
  /** Host header names accepted besides the loopback names and a specific bind address. */
  allowedHosts: string[];
}

/** Literal loopback addresses only: a name such as "localhost" could resolve elsewhere, so it is treated as off-box. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * Settings (plus command-line overrides) to a server config, or a thrown refusal. Off-box binds carry bearer tokens, so they
 * need TLS, or an explicit acknowledgement that the transport is protected some other way (a Tailscale or SSH tunnel).
 */
export function resolveRemoteConfig(s: RemoteSettings = {}): RemoteConfig {
  const host = (s.host ?? DEFAULT_REMOTE_HOST).trim();
  if (!host || host.length > 255 || /[\s/\\]/.test(host)) throw new Error('remote.host must be an IP address or host name.');
  const port = s.port ?? DEFAULT_REMOTE_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('remote.port must be a port number (0 picks a free one).');
  const hasCert = !!s.tlsCertFile, hasKey = !!s.tlsKeyFile;
  if (hasCert !== hasKey) throw new Error('remote.tlsCertFile and remote.tlsKeyFile go together.');
  const tls = hasCert ? { certFile: s.tlsCertFile!, keyFile: s.tlsKeyFile! } : undefined;
  if (!isLoopbackHost(host) && !tls && s.allowPlainHttp !== true) {
    throw new Error(`Refusing to listen on ${host} without TLS: tokens would cross the network in clear text. Set remote.tlsCertFile and remote.tlsKeyFile, or set remote.allowPlainHttp to true if a tunnel (Tailscale, SSH) already encrypts the traffic.`);
  }
  const allowedHosts = (s.allowedHosts ?? []).filter((h): h is string => typeof h === 'string' && !!h.trim()).map((h) => h.trim().toLowerCase());
  return { host, port, tls, allowFullScope: s.allowFullScope === true, allowedHosts };
}

/** Validation for Settings.remote (store.ts calls it from normalizeSettingsPatch). */
export function normalizeRemoteSettings(v: unknown): RemoteSettings | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('remote must be an object.');
  const o = v as Record<string, unknown>;
  const out: RemoteSettings = {};
  for (const k of ['enabled', 'allowFullScope', 'allowPlainHttp'] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== 'boolean') throw new Error(`remote.${k} must be true or false.`);
    out[k] = o[k] as boolean;
  }
  for (const k of ['host', 'tlsCertFile', 'tlsKeyFile'] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== 'string' || (o[k] as string).length > 1024 || /[\0\r\n]/.test(o[k] as string)) throw new Error(`remote.${k} must be text.`);
    if ((o[k] as string).trim()) out[k] = (o[k] as string).trim();
  }
  if (o['port'] !== undefined) {
    if (typeof o['port'] !== 'number' || !Number.isInteger(o['port']) || o['port'] < 0 || o['port'] > 65535) throw new Error('remote.port must be a port number.');
    out.port = o['port'];
  }
  if (o['allowedHosts'] !== undefined) {
    if (!Array.isArray(o['allowedHosts']) || o['allowedHosts'].length > 20 || !o['allowedHosts'].every((h) => typeof h === 'string' && h.length <= 255 && /^[A-Za-z0-9.:[\]-]+$/.test(h))) throw new Error('remote.allowedHosts must be a list of host names.');
    out.allowedHosts = o['allowedHosts'] as string[];
  }
  return out;
}

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '::1'];

/** The name part of a Host header (port and IPv6 brackets removed), lowercased; undefined when malformed. */
export function hostName(header: string | undefined): string | undefined {
  if (!header || header.length > 300) return undefined;
  const h = header.trim().toLowerCase();
  const v6 = /^\[([0-9a-f:.]+)\](?::\d+)?$/.exec(h);
  if (v6) return v6[1];
  const m = /^([a-z0-9.-]+)(?::\d+)?$/.exec(h);
  return m?.[1];
}

/**
 * DNS rebinding: a hostile page whose name was re-pointed at 127.0.0.1 still sends its own name in Host. Only loopback names,
 * the specific bind address and the owner's allowedHosts are accepted.
 */
export function hostAllowed(header: string | undefined, cfg: RemoteConfig): boolean {
  const name = hostName(header);
  if (!name) return false;
  if (LOOPBACK_NAMES.includes(name) || /^127(?:\.\d{1,3}){3}$/.test(name)) return true;
  const bind = cfg.host.replace(/^\[|\]$/g, '').toLowerCase();
  if (name === bind && bind !== '0.0.0.0' && bind !== '::') return true;
  return cfg.allowedHosts.includes(name);
}

/**
 * Browsers send Origin on every WebSocket handshake and every cross-origin fetch; the clients this API is for (the `harbor`
 * CLI, scripts) send none. So any Origin is refused: no web page can call the API, and there is no CORS to configure.
 */
export function originAllowed(origin: string | string[] | undefined): boolean { return origin === undefined; }

/**
 * Failed-auth limiter. Tokens are 256 random bits, so this is about noise and log spam more than guessing. Behind a tunnel
 * every client looks like 127.0.0.1, so there is also a global cap.
 */
export class AuthLimiter {
  private failures = new Map<string, number[]>();
  private all: number[] = [];
  constructor(private perAddress = 10, private global = 100, private windowMs = 60_000, private now: () => number = Date.now) {}

  blocked(address: string): boolean {
    const t = this.now();
    this.all = this.all.filter((x) => t - x < this.windowMs);
    const mine = (this.failures.get(address) ?? []).filter((x) => t - x < this.windowMs);
    if (mine.length) this.failures.set(address, mine); else this.failures.delete(address);
    return mine.length >= this.perAddress || this.all.length >= this.global;
  }

  fail(address: string): void {
    const t = this.now();
    this.all.push(t);
    this.failures.set(address, [...(this.failures.get(address) ?? []), t]);
    if (this.failures.size > 10_000) this.failures.clear(); // bound memory; the global cap still holds
  }
}
