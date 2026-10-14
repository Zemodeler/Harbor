import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerDraft } from '../../shared/api';

/**
 * Per-CLI output of Harbor's MCP registry (plan section 5). Pure apart from the temp file helper at the end.
 *
 * Claude Code: a generated file passed with `--mcp-config <file>`. VERIFIED against claude.exe 2.1.295: `--mcp-config <configs...>`
 * ("Load MCP servers from JSON files or strings") and `--strict-mcp-config` ("Only use MCP servers from --mcp-config, ignoring all
 * other MCP configurations") are in `claude --help`; the file shape `{"mcpServers":{"<name>":{...}}}` and the server shapes
 * `{type?:"stdio",command,args,env}`, `{type:"sse",url,headers}`, `{type:"http",url,headers}` and the name rule `[A-Za-z0-9_-]+` were
 * read from the binary's own config schema (no model run). Tools are named `mcp__<server>__<tool>`; the allow rule `mcp__<server>`
 * (every tool of that server) is Claude Code's documented rule form, NOT verified against a live run.
 *
 * Codex: `-c mcp_servers.<name>.<key>=<TOML>` overrides. VERIFIED: `codex exec --help` (codex-cli 0.162.0-alpha.17.2) documents
 * `-c key=value` as a dotted path whose value is parsed as TOML; the keys `command`, `args`, `env`, `url`, `http_headers` exist in the
 * binary's `RawMcpServerConfig`, and `codex mcp add` offers stdio (`-- <command>`, `--env`) and streamable HTTP (`--url`) only, so
 * sse servers are not given to Codex. NOT verified: a live run with servers added only through `-c` (no config.toml entry), and how
 * `codex exec` treats an MCP tool call that would need an approval (it has no channel to ask Harbor; see planMcpRun).
 * Values are TOML literal strings ('...'): no escapes and no double quotes, which proc.ts refuses for .cmd shims, so a value holding
 * `'`, `"`, `%` or a line break cannot be passed and that server is skipped for Codex with a note. Env values travel in argv: other
 * processes of the same Windows user can read a command line; Harbor never logs argv.
 *
 * Custom CLIs: the same file as Claude, through the descriptor's `run.mcp.args` (`{mcpConfigFile}`).
 */

export type McpTarget = 'claude' | 'codex' | 'custom' | 'none';
/** What one run gets. `strict` (Claude only): add --strict-mcp-config, so the CLI's own MCP configuration is not loaded. */
export interface McpRun { servers: McpServerDraft[]; strict?: boolean }

/** `{"mcpServers": ...}` in Claude Code's shape (also what custom CLIs get). Env and headers only when set. */
export function mcpConfigJson(servers: readonly McpServerDraft[]): { mcpServers: Record<string, Record<string, unknown>> } {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const s of servers) {
    mcpServers[s.name] = s.transport === 'stdio'
      ? { type: 'stdio', command: s.command, args: s.args ?? [], ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}) }
      : { type: s.transport, url: s.url, ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}) };
  }
  return { mcpServers };
}

const CODEX_UNSAFE = /['"%\0\r\n]/;
const lit = (v: string) => `'${v}'`;
const table = (o: Record<string, string>) => `{${Object.entries(o).map(([k, v]) => `${k}=${lit(v)}`).join(',')}}`;

/** Why this server cannot be handed to Codex, or undefined. Never names a value. */
export function codexProblem(s: McpServerDraft): string | undefined {
  if (s.transport === 'sse') return 'Codex supports stdio and streamable HTTP servers, not SSE';
  const values = [s.command ?? '', ...(s.args ?? []), s.url ?? '', ...Object.values(s.env ?? {}), ...Object.values(s.headers ?? {})];
  if (values.some((v) => CODEX_UNSAFE.test(v))) return 'a value contains a quote, % or a line break, which Harbor cannot pass to Codex';
  return undefined;
}

/** `-c` overrides for Codex; servers with a codexProblem are left out (planMcpRun already reported them). */
export function codexMcpArgs(servers: readonly McpServerDraft[]): string[] {
  const a: string[] = [];
  for (const s of servers) {
    if (codexProblem(s)) continue;
    const key = `mcp_servers.${s.name}`;
    if (s.transport === 'stdio') {
      a.push('-c', `${key}.command=${lit(s.command!)}`);
      if (s.args?.length) a.push('-c', `${key}.args=[${s.args.map(lit).join(',')}]`);
      if (s.env && Object.keys(s.env).length) a.push('-c', `${key}.env=${table(s.env)}`);
    } else {
      a.push('-c', `${key}.url=${lit(s.url!)}`);
      if (s.headers && Object.keys(s.headers).length) a.push('-c', `${key}.http_headers=${table(s.headers)}`);
    }
  }
  return a;
}

/** Claude allow rules for servers whose tools may run without asking. */
export const unattendedRules = (run: McpRun | undefined): string[] => (run?.servers ?? []).filter((s) => s.allowUnattended).map((s) => `mcp__${s.name}`);

export interface McpPlanInput {
  servers: readonly McpServerDraft[];
  cliName: string;
  target: McpTarget;
  permission: 'read-only' | 'edit' | 'full';
  /** The run can ask the user about each tool call (Claude edit runs with Harbor's permission channel). */
  hostAsks: boolean;
  /** Settings.claudeOwnMcp: Claude may also load its own MCP configuration (never in auto mode). */
  claudeOwnMcp?: boolean;
}

/**
 * Which of a project's enabled servers one run gets, and the notes for its run details (names only, never values):
 * - a CLI without MCP support in Harbor gets none;
 * - read-only runs (planners, reviewers, plan mode) get none: Harbor cannot keep an MCP tool read-only;
 * - a server needs either a run that asks the user about every tool call (only Claude edit runs, through the tool permission
 *   channel) or the user's "allow without asking" (allowUnattended). So Codex, custom CLIs and Claude in auto mode get only those;
 * - Codex skips servers it cannot be given (SSE, unpassable characters).
 * Claude runs are strict (only Harbor's servers) unless the user allowed Claude's own servers, and always in auto mode, where
 * Harbor could not stop those servers' tools from running unasked.
 */
export function planMcpRun(i: McpPlanInput): { run?: McpRun; notes: string[] } {
  const notes: string[] = [];
  const strict = i.target === 'claude' ? !i.claudeOwnMcp || i.permission === 'full' : undefined;
  const base: McpRun | undefined = i.target === 'claude' ? { servers: [], strict } : undefined;
  if (i.target === 'claude' && i.claudeOwnMcp && i.permission === 'full') notes.push('MCP: Claude Code\'s own MCP servers are off in auto mode (their tools would run without asking).');
  const names = (l: readonly McpServerDraft[]) => l.map((s) => s.name).join(', ');
  if (!i.servers.length) return { run: base, notes };
  if (i.target === 'none') return { run: base, notes: [...notes, `MCP: ${i.cliName} has no MCP support in Harbor; not given: ${names(i.servers)}.`] };
  if (i.permission === 'read-only') return { run: base, notes: [...notes, `MCP: read-only runs get no MCP servers (Harbor cannot keep an MCP tool read-only); not given: ${names(i.servers)}.`] };
  const given: McpServerDraft[] = [], needAsk: McpServerDraft[] = [], unusable: string[] = [];
  for (const s of i.servers) {
    if (!i.hostAsks && !s.allowUnattended) { needAsk.push(s); continue; }
    const problem = i.target === 'codex' ? codexProblem(s) : undefined;
    if (problem) unusable.push(`${s.name} (${problem})`); else given.push(s);
  }
  if (given.length) notes.push(`MCP servers: ${names(given)}${i.hostAsks && given.some((s) => !s.allowUnattended) ? ' (each tool call asks you unless a project rule allows it)' : ''}.`);
  if (needAsk.length) {
    const why = i.target === 'claude' ? (i.permission === 'full' ? 'auto mode does not ask' : 'this run cannot ask') : `${i.cliName} cannot ask Harbor`;
    notes.push(`MCP: not given ${names(needAsk)}: each tool call needs your yes and ${why}. Allow a server without asking to use it here.`);
  }
  if (unusable.length) notes.push(`MCP: not given to ${i.cliName}: ${unusable.join('; ')}.`);
  if (i.target === 'claude') return { run: { servers: given, strict }, notes };
  return { run: given.length ? { servers: given } : undefined, notes };
}

/**
 * Writes the per-run config file in its own new folder under the OS temp folder (outside every project), readable by the user only
 * where the OS supports modes. `cleanup` removes the folder; adapters call it in `finally`, so it runs after success, failure and abort.
 */
export function writeMcpConfig(servers: readonly McpServerDraft[], base = tmpdir()): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(base, 'harbor-mcp-'));
  const file = join(dir, 'mcp.json');
  try { writeFileSync(file, JSON.stringify(mcpConfigJson(servers), null, 2), { mode: 0o600 }); }
  catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
  return { file, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}
