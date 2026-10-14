import type { Chunk, CliAdapter, RunOptions } from './types';
import { RATE_LIMIT_RE } from './types';
import { streamLines } from './stream';
import { isEmittableEffort } from '../clis/effort';
import { codexMcpArgs, codexMcpPlan } from '../mcp/materialize';

/**
 * Codex headless adapter (`codex exec --json`, JSONL events on stdout).
 * Verified against codex-cli 0.160.0: run, session id capture and event shapes. `exec resume` rejects `-s`,
 * so the sandbox is set with `-c sandbox_mode=...` for both modes.
 * Prompt is read from stdin via the `-` argument.
 * `-i/--image <FILE>...` is listed by `codex exec --help` and `codex exec resume --help` of codex-cli 0.162.0-alpha.17.2 (checked for
 * screenshots; no model run). NOT VERIFIED: `-c approval_policy=never` and `sandbox_mode=danger-full-access` for auto mode.
 * Config values are passed WITHOUT embedded double quotes: Codex parses `-c key=value` as TOML and falls back to the raw string,
 * and a `"` would be rejected by the .cmd shim quoting in proc.ts (that bug silently routed every Codex run to Claude).
 * Paths in arrays use TOML literal strings ('...'), which also need no double quotes.
 * Effort: `model_reasoning_effort` gets the per-model native value (clis/effort.ts) when the orchestrator passes one, else Harbor's
 * low/medium/high. codex-cli 0.162 lists xhigh, max and ultra for some models; Harbor never emits them (guarded here as well).
 * NOT VERIFIED: whether `codex exec` accepts xhigh/max through `-c model_reasoning_effort` (never sent today). `ultra` is excluded
 * on purpose: it turns on automatic task delegation, and helpers never spawn agents.
 * Mid-run token counts: `codex exec --json` was not seen to emit usage before `turn.completed`, so a stopped Codex run records
 * duration and model but no tokens (marked partial). Not verified against a long run.
 * MCP (`mcp`): Harbor's servers are added as `-c mcp_servers.<name>...` overrides (mcp/materialize.ts has what was verified). Codex
 * cannot ask Harbor about a tool call, so planMcpRun gives it only servers the user allowed without asking. Servers in the user's
 * own ~/.codex/config.toml still load: Codex has no flag like Claude's --strict-mcp-config (none found in `codex exec --help`).
 */
export function codexArgs(o: RunOptions): string[] {
  const a = ['exec'];
  if (o.resumeId) a.push('resume', o.resumeId);
  // `-i/--image` takes a list, so each use must be followed by another flag (never by the `-` prompt argument).
  for (const img of o.images ?? []) a.push('--image', img);
  const sandbox = o.permission === 'full' ? 'danger-full-access' : o.permission === 'edit' ? 'workspace-write' : 'read-only';
  a.push('--json', '--skip-git-repo-check', '-c', `sandbox_mode=${sandbox}`);
  if (o.permission === 'full') a.push('-c', 'approval_policy=never');
  const roots = (o.writableDirs ?? []).filter((d) => d && !/[\r\n\0'%"]/.test(d));
  if (roots.length && o.permission === 'edit') a.push('-c', `sandbox_workspace_write.writable_roots=[${roots.map((d) => `'${d}'`).join(',')}]`);
  if (o.model && o.model !== 'default') a.push('-m', o.model);
  a.push('-c', `model_reasoning_effort=${isEmittableEffort(o.nativeEffort) ? o.nativeEffort : o.effort}`);
  if (o.mcp?.servers.length) a.push(...codexMcpArgs(o.mcp.servers));
  a.push('-');
  return a;
}

/** Message of a non-terminal `error` event, kept so a run that then dies without turn.completed can report it. */
export function codexErrorMessage(line: string): string | undefined {
  try { const j = JSON.parse(line); return j?.type === 'error' ? String(j.message ?? j.error?.message ?? 'codex error') : undefined; } catch { return undefined; }
}

/** Parse one JSONL event. Pure; unknown shapes are ignored. */
export function parseCodexLine(line: string): Chunk[] {
  let j: any;
  try { j = JSON.parse(line); } catch { return []; }
  const out: Chunk[] = [];
  const t = j.type as string | undefined;
  if (t === 'thread.started' && j.thread_id) out.push({ kind: 'session', id: j.thread_id });
  else if (t === 'item.completed' && j.item) {
    const it = j.item;
    if (it.type === 'agent_message' && it.text) out.push({ kind: 'text', text: it.text });
    else if (it.type === 'command_execution') out.push({ kind: 'tool', text: String(it.command ?? '').slice(0, 120) });
    else if (it.type === 'file_change') out.push({ kind: 'tool', text: 'file change' });
  } else if (t === 'turn.completed') {
    // Codex's input count includes the cached part (its session logs show cached_input_tokens <= input_tokens, ~97% of it on a long
    // thread): split it so cache reads are weighed as such (calibration.billableKTok), as Claude's are.
    const u = j.usage ?? {};
    const cached = typeof u.cached_input_tokens === 'number' ? u.cached_input_tokens : undefined;
    const input = typeof u.input_tokens === 'number' ? (cached !== undefined ? Math.max(0, u.input_tokens - cached) : u.input_tokens) : undefined;
    out.push({ kind: 'usage', inputTokens: input, outputTokens: u.output_tokens, ...(cached !== undefined ? { cacheReadTokens: cached } : {}) });
    out.push({ kind: 'done', ok: true });
  } else if (t === 'turn.failed') {
    // A bare `error` event is often a transient notice (reconnecting, stream retry); only turn.failed ends the run.
    const msg = String(j.error?.message ?? j.message ?? 'codex error');
    out.push({ kind: 'done', ok: false, error: msg, rateLimited: RATE_LIMIT_RE.test(msg) });
  }
  return out;
}

export class CodexAdapter implements CliAdapter {
  id = 'codex';
  constructor(private exe: string) {}

  async *run(prompt: string, o: RunOptions): AsyncGenerator<Chunk> {
    // Codex has no append-system-prompt flag; role instructions are prepended to the prompt. Only on the first run: a resumed thread
    // already holds them in its history, and repeating several KB on every turn is billed again as input each time.
    const full = o.systemPrompt && !o.resumeId ? `${o.systemPrompt}\n\n---\n\n${prompt}` : prompt;
    let done = false, last = '', lastError: string | undefined;
    // MCP secrets ride in the environment, not in argv (see mcp/materialize.ts).
    const mcpEnv = o.mcp?.servers.length ? codexMcpPlan(o.mcp.servers).env : undefined;
    const gen = streamLines(this.exe, codexArgs(o), { cwd: o.cwd, input: full, signal: o.signal, ...(mcpEnv ? { env: { ...process.env, ...mcpEnv } } : {}) });
    let res = await gen.next();
    while (!res.done) {
      if (res.value.stream === 'stdout') {
        lastError = codexErrorMessage(res.value.line) ?? lastError;
        for (const c of parseCodexLine(res.value.line)) {
          if (done) continue; // exactly one terminal chunk
          if (c.kind === 'text') last = c.text;
          if (c.kind === 'done') { done = true; yield { ...c, text: c.text ?? last }; } else yield c;
        }
      }
      res = await gen.next();
    }
    if (!done) {
      const r = res.value;
      const reason = r.aborted ? 'stopped' : r.spawnError ?? (r.stderr.trim().slice(-500) || lastError || `exited with code ${r.code}`);
      yield { kind: 'done', ok: false, error: reason, rateLimited: RATE_LIMIT_RE.test(r.stderr) || RATE_LIMIT_RE.test(lastError ?? ''), exitCode: r.aborted || r.spawnError || lastError ? null : r.code };
    }
  }
}
