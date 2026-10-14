import type { McpServerDraft, McpTestResult } from '../../shared/api';
import { streamLines } from '../adapters/stream';
import { customEnv } from '../clis/custom';
import { maskSecrets } from './registry';

/**
 * "Test" for one MCP server (Settings > MCP servers): an MCP `initialize`, the `notifications/initialized` notice and `tools/list`,
 * then the server is stopped. Nothing is kept. The JSON-RPC messages follow the MCP specification (2025-06-18 revision): stdio =
 * newline-delimited JSON on stdin/stdout; streamable HTTP = a POST per message answered with JSON or an SSE stream, the session in
 * `Mcp-Session-Id`; legacy SSE = a GET event stream whose `endpoint` event names where to POST. Checked here only against the fake
 * servers in tests, not against real servers.
 *
 * A stdio test runs an arbitrary program: the service asks for the user's confirmation of the exact command first (like a custom
 * CLI's dry run). It runs as one argv (never a shell string; .cmd shims go through proc.ts quoting), in a temp folder, with the
 * allowlisted environment plus the server's own env, and is killed (process tree) when done or after the timeout.
 */

export const PROBE_TIMEOUT_MS = 20_000;
const MAX_TOOLS = 200;
const MAX_BODY = 1024 * 1024;
const PROTOCOL = '2025-06-18';

export interface McpFetchResponse { ok: boolean; status: number; headers: { get(name: string): string | null }; body?: ReadableStream<Uint8Array> | null; text(): Promise<string> }
export type McpFetch = (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<McpFetchResponse>;

export interface ProbeDeps {
  /** Folder the stdio server starts in (a neutral temp folder, never a project). */
  cwd: string;
  /** Absolute path of the program for `command` (bare names are looked up on PATH by the caller), or undefined when not found. */
  resolveCommand: (command: string) => string | undefined;
  env?: NodeJS.ProcessEnv;
  fetch?: McpFetch;
  timeoutMs?: number;
  clientVersion?: string;
  now?: () => number;
}

const rpc = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id, method, params });
const initRequest = (version?: string) => rpc(1, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'harbor', version: version ?? '0' } });
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

interface Answer { result?: Record<string, unknown>; error?: string }
const answerOf = (msg: unknown, id: number): Answer | undefined => {
  if (!msg || typeof msg !== 'object') return undefined;
  const m = msg as { id?: unknown; result?: unknown; error?: { message?: unknown; code?: unknown } };
  if (m.id !== id) return undefined;
  if (m.error) return { error: `the server answered with an error${typeof m.error.message === 'string' ? `: ${m.error.message.slice(0, 300)}` : ''}` };
  return { result: m.result && typeof m.result === 'object' ? m.result as Record<string, unknown> : {} };
};

/** The fields of an initialize result and a tools/list result the test reports. */
function summarize(init: Record<string, unknown>, tools: Record<string, unknown> | undefined): Pick<McpTestResult, 'serverName' | 'serverVersion' | 'protocolVersion' | 'tools'> {
  const info = init['serverInfo'] as { name?: unknown; version?: unknown } | undefined;
  const list = Array.isArray(tools?.['tools']) ? (tools!['tools'] as unknown[]) : [];
  return {
    ...(typeof info?.name === 'string' ? { serverName: info.name.slice(0, 200) } : {}),
    ...(typeof info?.version === 'string' ? { serverVersion: info.version.slice(0, 100) } : {}),
    ...(typeof init['protocolVersion'] === 'string' ? { protocolVersion: init['protocolVersion'].slice(0, 40) } : {}),
    tools: list.slice(0, MAX_TOOLS).flatMap((t) => (t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string' ? [(t as { name: string }).name.slice(0, 200)] : []))
  };
}

export async function probeMcpServer(s: McpServerDraft, d: ProbeDeps): Promise<McpTestResult> {
  const now = d.now ?? Date.now, t0 = now();
  const done = (r: Omit<McpTestResult, 'transport' | 'durationMs'>): McpTestResult => {
    const out: McpTestResult = { ...r, transport: s.transport, durationMs: Math.max(0, now() - t0) };
    if (out.error) out.error = maskSecrets(out.error, [s]);
    if (out.stderr) out.stderr = maskSecrets(out.stderr, [s]);
    return out;
  };
  try {
    return done(s.transport === 'stdio' ? await probeStdio(s, d) : await probeHttp(s, d));
  } catch (e) {
    return done({ ok: false, error: String((e as Error).message ?? e) });
  }
}

async function probeStdio(s: McpServerDraft, d: ProbeDeps): Promise<Omit<McpTestResult, 'transport' | 'durationMs'>> {
  const exe = d.resolveCommand(s.command ?? '');
  if (!exe) return { ok: false, error: `${s.command} was not found (looked on PATH and as a path).` };
  const ctl = new AbortController();
  const timeoutMs = d.timeoutMs ?? PROBE_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  let sink: { write(x: string): void; end(): void } | undefined;
  let init: Record<string, unknown> | undefined, tools: Record<string, unknown> | undefined, error: string | undefined;
  const send = (m: unknown) => sink?.write(`${JSON.stringify(m)}\n`);
  const gen = streamLines(exe, s.args ?? [], {
    cwd: d.cwd, input: `${JSON.stringify(initRequest(d.clientVersion))}\n`, signal: ctl.signal, env: customEnv(d.env ?? process.env, s.env),
    interactive: (x) => { sink = x; }, forceResolveMs: 3000
  });
  let res = await gen.next();
  try {
    while (!res.done) {
      if (res.value.stream === 'stdout' && !ctl.signal.aborted) {
        let msg: unknown;
        try { msg = JSON.parse(res.value.line); } catch { msg = undefined; }
        const a1 = !init ? answerOf(msg, 1) : undefined;
        if (a1?.error) { error = a1.error; ctl.abort(); }
        else if (a1?.result) { init = a1.result; send(INITIALIZED); send(rpc(2, 'tools/list')); }
        const a2 = init ? answerOf(msg, 2) : undefined;
        if (a2) { if (a2.result) tools = a2.result; else error = a2.error; sink?.end(); ctl.abort(); }
      }
      res = await gen.next();
    }
  } finally { clearTimeout(timer); }
  const r = res.value;
  const stderr = r.stderr.trim().slice(-2000) || undefined;
  if (init && tools) return { ok: true, ...summarize(init, tools), ...(stderr ? { stderr } : {}) };
  if (init && !error) error = timedOut ? `the server did not list its tools within ${Math.round(timeoutMs / 1000)} s` : 'the server stopped before listing its tools';
  if (!error) error = r.spawnError ?? (timedOut ? `no MCP answer within ${Math.round(timeoutMs / 1000)} s` : `the program exited${r.code !== null ? ` with code ${r.code}` : ''} without an MCP answer`);
  return { ok: false, error, ...(init ? summarize(init, undefined) : {}), ...(stderr ? { stderr } : {}) };
}

/** Reads `data:` payloads of an SSE stream as events. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '', event = 'message', data: string[] = [], total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY) throw new Error('the server sent more than 1 MB');
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line) { if (data.length) yield { event, data: data.join('\n') }; event = 'message'; data = []; }
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (data.length) yield { event, data: data.join('\n') };
  } finally { try { await reader.cancel(); } catch { /* closed */ } }
}

const parse = (t: string): unknown => { try { return JSON.parse(t); } catch { return undefined; } };

async function probeHttp(s: McpServerDraft, d: ProbeDeps): Promise<Omit<McpTestResult, 'transport' | 'durationMs'>> {
  if (!d.fetch) return { ok: false, error: 'Testing an HTTP server is available in the desktop app.' };
  const fetchFn = d.fetch;
  const ctl = new AbortController();
  const timeoutMs = d.timeoutMs ?? PROBE_TIMEOUT_MS;
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const url = s.url!;
  const base = { ...(s.headers ?? {}) };
  const why = (e: unknown) => (ctl.signal.aborted ? `no MCP answer within ${Math.round(timeoutMs / 1000)} s` : `the request failed: ${String((e as Error).message ?? e).slice(0, 300)}`);
  try {
    if (s.transport === 'http') {
      let session: string | undefined;
      const post = async (msg: unknown, id?: number): Promise<Answer | undefined> => {
        const res = await fetchFn(url, { method: 'POST', signal: ctl.signal, body: JSON.stringify(msg), headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': PROTOCOL } : {}), ...base } });
        session = res.headers.get('mcp-session-id') ?? session;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (id === undefined) return undefined;
        if ((res.headers.get('content-type') ?? '').includes('text/event-stream') && res.body) {
          for await (const ev of sseEvents(res.body)) { const a = answerOf(parse(ev.data), id); if (a) return a; }
          return undefined;
        }
        const text = await res.text();
        if (text.length > MAX_BODY) throw new Error('the server sent more than 1 MB');
        return answerOf(parse(text), id);
      };
      const a1 = await post(initRequest(d.clientVersion), 1);
      if (!a1) return { ok: false, error: 'the server did not answer initialize with an MCP result' };
      if (a1.error) return { ok: false, error: a1.error };
      await post(INITIALIZED);
      const a2 = await post(rpc(2, 'tools/list'), 2);
      if (!a2?.result) return { ok: false, error: a2?.error ?? 'the server did not list its tools', ...summarize(a1.result!, undefined) };
      return { ok: true, ...summarize(a1.result!, a2.result) };
    }
    // Legacy HTTP+SSE: answers arrive on the GET stream, requests go to the endpoint it names.
    const res = await fetchFn(url, { method: 'GET', signal: ctl.signal, headers: { Accept: 'text/event-stream', ...base } });
    if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` };
    let endpoint: string | undefined, init: Record<string, unknown> | undefined;
    const post = async (msg: unknown) => {
      const r = await fetchFn(endpoint!, { method: 'POST', signal: ctl.signal, body: JSON.stringify(msg), headers: { 'Content-Type': 'application/json', ...base } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    };
    for await (const ev of sseEvents(res.body)) {
      if (!endpoint && ev.event === 'endpoint') {
        const target = new URL(ev.data.trim(), url);
        // The endpoint must stay on the server the user named: headers (maybe a token) are sent there.
        if (target.origin !== new URL(url).origin) return { ok: false, error: 'the server named an endpoint on another host' };
        endpoint = target.toString();
        await post(initRequest(d.clientVersion));
        continue;
      }
      const msg = parse(ev.data);
      const a1 = !init ? answerOf(msg, 1) : undefined;
      if (a1?.error) return { ok: false, error: a1.error };
      if (a1?.result) { init = a1.result; await post(INITIALIZED); await post(rpc(2, 'tools/list')); continue; }
      const a2 = init ? answerOf(msg, 2) : undefined;
      if (a2) return a2.result ? { ok: true, ...summarize(init!, a2.result) } : { ok: false, error: a2.error, ...summarize(init!, undefined) };
    }
    return { ok: false, error: endpoint ? 'the event stream ended without an MCP answer' : 'the server sent no endpoint event' };
  } catch (e) {
    return { ok: false, error: why(e) };
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}
