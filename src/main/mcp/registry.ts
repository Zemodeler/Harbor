import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { McpServer, McpServerDraft, McpTransport } from '../../shared/api';
import { ENV_KEY_RE, ENV_LOCKED } from '../clis/custom';
import { cliPathProblem } from '../clis/discovery';

/**
 * Harbor's MCP registry (plan section 5): one list of servers, written out per CLI by materialize.ts. It lives only in the data
 * folder (mcp-servers.json), never in a project. Env and header values are stored as plain text (owner decision); they are never
 * exported (bundles use an allowlist that does not include this file), never put in diagnostics or logs, and never echoed in a
 * problem message or run details: every message here names a field or a key, never a value.
 */

export const MCP_SERVERS_FILE = 'mcp-servers.json';
export const MAX_MCP_SERVERS = 50;
export const TRANSPORTS: readonly McpTransport[] = ['stdio', 'http', 'sse'];
/** Claude Code accepts only these characters in a server name, and Codex needs a bare TOML key: the same rule fits both. */
export const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A bare command resolved on PATH by the CLI (npx, uvx, node, docker...). Anything else must be an absolute path. */
const BARE_COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const LINE_BREAK = /[\0\r\n]/;
const MAX_ARGS = 64, MAX_PAIRS = 32, MAX_VALUE = 4096, MAX_ARG = 2000, MAX_URL = 2000;

/** What the file keeps per server beyond the draft: the global default and per-project choices. */
export interface StoredMcpServer extends McpServerDraft { defaultEnabled?: boolean; projects?: Record<string, boolean>; updated?: number; /** Mod id this server was imported from. */ fromMod?: string }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Checks a draft and returns a clean copy (unknown fields dropped), or every problem. Messages never contain a value. */
export function validateMcpServer(raw: unknown): { server?: McpServerDraft; problems: string[] } {
  const problems: string[] = [];
  const p = (s: string) => { problems.push(s); };
  if (!isObj(raw)) return { problems: ['The MCP server must be an object.'] };
  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : raw['name'];
  if (typeof name !== 'string' || !MCP_NAME_RE.test(name)) p('name must be 1-64 letters, digits, dashes or underscores.');
  const transport = raw['transport'];
  if (!TRANSPORTS.includes(transport as McpTransport)) p('transport must be stdio, http or sse.');
  const out: McpServerDraft = { name: name as string, transport: transport as McpTransport };

  const pairs = (key: 'env' | 'headers', keyRe: RegExp, what: string): Record<string, string> | undefined => {
    const v = raw[key];
    if (v === undefined || v === null) return undefined;
    if (!isObj(v) || Object.keys(v).length > MAX_PAIRS) { p(`${key} must map at most ${MAX_PAIRS} ${what} names to text.`); return undefined; }
    const o: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) {
      if (!keyRe.test(k)) p(`${key}: "${k.slice(0, 64)}" is not a valid ${what} name.`);
      else if (key === 'env' && ENV_LOCKED.has(k.toLowerCase())) p(`env: ${k} cannot be set for an MCP server.`);
      else if (typeof val !== 'string' || val.length > MAX_VALUE || LINE_BREAK.test(val)) p(`${key}.${k} must be text on one line of at most ${MAX_VALUE} characters.`);
      else o[k] = val;
    }
    return Object.keys(o).length ? o : undefined;
  };

  if (transport === 'stdio') {
    const command = typeof raw['command'] === 'string' ? raw['command'].trim() : raw['command'];
    if (typeof command !== 'string' || !command) p('command is required for a stdio server.');
    else if (!BARE_COMMAND_RE.test(command) && cliPathProblem(command)) p('command must be a program name found on PATH (like npx) or an absolute path, without quotes, % or line breaks.');
    else out.command = command;
    const args = raw['args'];
    if (args !== undefined && args !== null) {
      if (!Array.isArray(args) || args.length > MAX_ARGS) p(`args must be a list of at most ${MAX_ARGS} arguments.`);
      else if (args.some((a) => typeof a !== 'string' || a.length > MAX_ARG || LINE_BREAK.test(a))) p(`args: every argument must be text on one line of at most ${MAX_ARG} characters.`);
      else if (args.length) out.args = args as string[];
    }
    const env = pairs('env', ENV_KEY_RE, 'variable');
    if (env) out.env = env;
    if (raw['url'] !== undefined && raw['url'] !== '') p('url is only for http and sse servers.');
    if (isObj(raw['headers']) && Object.keys(raw['headers']).length) p('headers are only for http and sse servers.');
  } else if (transport === 'http' || transport === 'sse') {
    const url = typeof raw['url'] === 'string' ? raw['url'].trim() : raw['url'];
    let ok = false;
    if (typeof url === 'string' && url.length <= MAX_URL && !/[\s\0]/.test(url)) {
      try { const u = new URL(url); ok = u.protocol === 'https:' || u.protocol === 'http:'; } catch { /* not a URL */ }
    }
    if (!ok) p(`url must be an http:// or https:// address of at most ${MAX_URL} characters.`);
    else out.url = url as string;
    const headers = pairs('headers', HEADER_RE, 'header');
    if (headers) out.headers = headers;
    if (raw['command'] !== undefined && raw['command'] !== '') p('command is only for stdio servers.');
    if (Array.isArray(raw['args']) && raw['args'].length) p('args are only for stdio servers.');
    if (isObj(raw['env']) && Object.keys(raw['env']).length) p('env is only for stdio servers (use headers for an http or sse server).');
  }
  if (raw['allowUnattended'] !== undefined) {
    if (typeof raw['allowUnattended'] !== 'boolean') p('allowUnattended must be true or false.');
    else if (raw['allowUnattended']) out.allowUnattended = true;
  }
  return problems.length ? { problems } : { server: out, problems };
}

/** Every secret-like value of a server (env and header values), longest first: what must never appear in output Harbor shows or logs. */
export function secretValues(s: Pick<McpServerDraft, 'env' | 'headers'>): string[] {
  return [...Object.values(s.env ?? {}), ...Object.values(s.headers ?? {})].filter((v) => v.length >= 3).sort((a, b) => b.length - a.length);
}

/** Replaces every secret value of `servers` in `text`. */
export function maskSecrets(text: string, servers: ReadonlyArray<Pick<McpServerDraft, 'env' | 'headers'>>): string {
  let out = text;
  for (const v of servers.flatMap(secretValues)) out = out.split(v).join('[redacted]');
  return out;
}

const draftOf = (s: StoredMcpServer): McpServerDraft => {
  const { defaultEnabled: _d, projects: _p, updated: _u, fromMod: _m, ...draft } = s;
  return structuredClone(draft);
};

/**
 * The registry itself: in memory, saved atomically to `file` when there is one (tests run without). Loading drops invalid entries
 * with a warning that names the entry and the problem only.
 */
export class McpRegistry {
  private servers: StoredMcpServer[] = [];
  readonly warnings: string[] = [];

  constructor(private file?: string, private now: () => number = Date.now) { this.load(); }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    let j: unknown;
    try { j = JSON.parse(readFileSync(this.file, 'utf8')); } catch { this.warnings.push(`${MCP_SERVERS_FILE} is not valid JSON; no MCP server is loaded.`); return; }
    const list = isObj(j) && Array.isArray(j['servers']) ? j['servers'] : undefined;
    if (!list) { this.warnings.push(`${MCP_SERVERS_FILE} must be { "servers": [...] }; no MCP server is loaded.`); return; }
    for (const [i, raw] of list.slice(0, MAX_MCP_SERVERS).entries()) {
      const v = validateMcpServer(raw);
      if (!v.server) { this.warnings.push(`${MCP_SERVERS_FILE} entry ${i + 1} dropped: ${v.problems.join(' ')}`); continue; }
      if (this.servers.some((s) => s.name.toLowerCase() === v.server!.name.toLowerCase())) { this.warnings.push(`${MCP_SERVERS_FILE} entry ${i + 1} dropped: the name is used twice.`); continue; }
      const r = raw as Record<string, unknown>;
      const projects: Record<string, boolean> = {};
      if (isObj(r['projects'])) for (const [id, on] of Object.entries(r['projects'])) if (typeof on === 'boolean') projects[id] = on;
      this.servers.push({ ...v.server, ...(typeof r['fromMod'] === 'string' ? { fromMod: r['fromMod'].slice(0, 200) } : {}), ...(r['defaultEnabled'] === true ? { defaultEnabled: true } : {}), ...(Object.keys(projects).length ? { projects } : {}), ...(typeof r['updated'] === 'number' ? { updated: r['updated'] } : {}) });
    }
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, servers: this.servers }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private find(name: unknown): StoredMcpServer | undefined {
    return typeof name === 'string' ? this.servers.find((s) => s.name.toLowerCase() === name.trim().toLowerCase()) : undefined;
  }

  private resolve(s: StoredMcpServer, projectId?: string): McpServer {
    const def = s.defaultEnabled === true;
    const enabled = projectId !== undefined ? s.projects?.[projectId] ?? def : def;
    return { ...draftOf(s), enabled, defaultEnabled: def, ...(s.updated !== undefined ? { updated: s.updated } : {}), ...(s.fromMod ? { fromMod: s.fromMod } : {}) };
  }

  list(projectId?: string): McpServer[] { return this.servers.map((s) => this.resolve(s, projectId)); }

  /** The drafts enabled for one project, in registry order: what a run of that project may get. */
  enabledFor(projectId: string): McpServerDraft[] { return this.servers.filter((s) => this.resolve(s, projectId).enabled).map(draftOf); }

  /** Adds a server, or replaces `previousName` (a rename keeps the default and the project choices). Throws with every problem. */
  save(raw: unknown, previousName?: string): McpServerDraft {
    const v = validateMcpServer(raw);
    if (!v.server) throw new Error(`This MCP server cannot be saved:\n- ${v.problems.join('\n- ')}`);
    const prev = previousName !== undefined ? this.find(previousName) : undefined;
    if (previousName !== undefined && !prev) throw new Error('There is no MCP server with that name to replace.');
    const clash = this.find(v.server.name);
    if (clash && clash !== prev) throw new Error(`An MCP server named ${v.server.name} already exists.`);
    if (!prev && this.servers.length >= MAX_MCP_SERVERS) throw new Error(`At most ${MAX_MCP_SERVERS} MCP servers can be added.`);
    const next: StoredMcpServer = { ...v.server, ...(prev?.fromMod ? { fromMod: prev.fromMod } : {}), ...(prev?.defaultEnabled ? { defaultEnabled: true } : {}), ...(prev?.projects ? { projects: prev.projects } : {}), updated: this.now() };
    this.servers = prev ? this.servers.map((s) => (s === prev ? next : s)) : [...this.servers, next];
    this.persist();
    return draftOf(next);
  }

  /**
   * Adds a server that came from a mod, switched off. The same server again (same transport, URL and headers) is left as it is;
   * a different server under the same name is a clash and is not touched.
   */
  importFromMod(raw: unknown, modId: string): 'added' | 'same' | 'clash' {
    const v = validateMcpServer(raw);
    if (!v.server) throw new Error(`This MCP server cannot be imported:\n- ${v.problems.join('\n- ')}`);
    const have = this.find(v.server.name);
    if (have) return have.fromMod === modId && have.transport === v.server.transport && have.url === v.server.url && JSON.stringify(have.headers ?? {}) === JSON.stringify(v.server.headers ?? {}) ? 'same' : 'clash';
    if (this.servers.length >= MAX_MCP_SERVERS) throw new Error(`At most ${MAX_MCP_SERVERS} MCP servers can be added.`);
    this.servers = [...this.servers, { ...v.server, fromMod: modId, updated: this.now() }];
    this.persist();
    return 'added';
  }

  remove(name: string): void {
    const s = this.find(name);
    if (!s) return;
    this.servers = this.servers.filter((x) => x !== s);
    this.persist();
  }

  setEnabled(name: string, enabled: boolean | null, projectId?: string): void {
    const s = this.find(name);
    if (!s) throw new Error('That MCP server is no longer in the registry.');
    if (enabled !== null && typeof enabled !== 'boolean') throw new Error('enabled must be true, false or null.');
    let next: StoredMcpServer;
    if (projectId === undefined) {
      const { defaultEnabled: _d, ...rest } = s;
      next = enabled ? { ...rest, defaultEnabled: true } : rest;
    } else {
      const projects = { ...(s.projects ?? {}) };
      if (enabled === null) delete projects[projectId]; else projects[projectId] = enabled;
      const { projects: _p, ...rest } = s;
      next = Object.keys(projects).length ? { ...rest, projects } : rest;
    }
    this.servers = this.servers.map((x) => (x === s ? next : x));
    this.persist();
  }
}
