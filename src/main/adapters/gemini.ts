import type { Chunk, CliAdapter, RunOptions } from './types';
import { RATE_LIMIT_RE } from './types';
import { streamLines, type AdapterProcessOptions, type StreamedLine, type StreamResult } from './stream';

/**
 * Gemini CLI adapter (`gemini`, google-gemini/gemini-cli). Prompt on stdin, never argv; chunks out; exactly one `done`.
 *
 * VERIFICATION STATUS (written 2026-10-21 on a machine where the CLI is NOT installed: `gemini --version` and `gemini --help`
 * could not be run, so NOTHING below was checked against a real binary, and no model call or sign-in was made). Run
 * `gemini --help` and `npm run smoke -- gemini` once the CLI is installed and correct this list. The flags come from the public
 * Gemini CLI documentation as remembered, not from this machine:
 *   UNVERIFIED  `--output-format stream-json`  newline-delimited events (init, message, tool_use, tool_result, error, result)
 *   UNVERIFIED  `-m, --model <id>`             model id; omitted for 'default'
 *   UNVERIFIED  `--approval-mode <default|auto_edit|yolo>`  read-only -> default, edit -> auto_edit, full -> yolo
 *   UNVERIFIED  `--include-directories <dirs>` extra folders (writable/readable dirs), comma separated
 *   UNVERIFIED  prompt on stdin with no `-p`: the CLI runs non-interactively when stdin is piped
 *   UNVERIFIED  event shapes: init{session_id}, message{role,content}, tool_use{tool_name}, result{status,stats}
 *   NOT USED    `--resume` (selects by "latest" or index, not a stable id), `--sandbox`, `--yolo` (approval-mode replaces it)
 * Not supported here (options ignored): resume (every run is a fresh session; Harbor prepends its own handoff), images, lean
 * concierge runs, host tool-permission prompts, MCP, leadAllowlist, allowedCommands. In `default` approval mode a headless run
 * cannot get approval for a write, which is the only read-only guard; Harbor's worktrees and post-turn git check remain the
 * containment. Auth: no non-interactive status command is verified, so the state stays 'unknown' until a run reports a login
 * failure (watchAuth in service.ts). Harbor never reads the CLI's credential files.
 */


export function geminiArgs(o: RunOptions): string[] {
  const args = ['--output-format', 'stream-json'];
  if (o.model && o.model !== 'default') args.push('--model', o.model);
  args.push('--approval-mode', o.permission === 'full' ? 'yolo' : o.permission === 'edit' ? 'auto_edit' : 'default');
  const dirs = [...new Set([...(o.writableDirs ?? []), ...(o.readableDirs ?? [])])].filter((d) => d && !d.includes(','));
  if (dirs.length) args.push('--include-directories', dirs.join(','));
  return args;
}

/** Terminal-mode arguments (adapters/terminal.ts): only the model; no output format, approval mode or folders are assumed. */
export const geminiTerminalArgs = (o: RunOptions): string[] => (o.model && o.model !== 'default' ? ['--model', o.model] : []);

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** Pure: what one stream-json line means. Lines that are not JSON objects are ignored. */
export function parseGeminiLine(line: string): { chunks: Chunk[]; done?: boolean; error?: string } {
  let j: Record<string, unknown>;
  try {
    const p: unknown = JSON.parse(line);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { chunks: [] };
    j = p as Record<string, unknown>;
  } catch { return { chunks: [] }; }
  const chunks: Chunk[] = [];
  switch (j['type']) {
    case 'init': {
      const id = str(j['session_id']);
      if (id && id.length <= 200) chunks.push({ kind: 'session', id: id.trim() });
      break;
    }
    case 'message': {
      const text = str(j['content']);
      if (j['role'] === 'assistant' && text) chunks.push({ kind: 'text', text });
      break;
    }
    case 'tool_use': {
      const name = str(j['tool_name']) ?? str(j['name']);
      if (name) chunks.push({ kind: 'tool', text: name });
      break;
    }
    case 'error': {
      const m = str(j['message']) ?? str(j['error']);
      return { chunks, error: (m ?? 'Gemini reported an error').slice(0, 2000) };
    }
    case 'result': {
      const s = (j['stats'] && typeof j['stats'] === 'object' ? j['stats'] : {}) as Record<string, unknown>;
      const input = num(s['input_tokens']), output = num(s['output_tokens']);
      if (input !== undefined || output !== undefined) chunks.push({ kind: 'usage', ...(input !== undefined ? { inputTokens: input } : {}), ...(output !== undefined ? { outputTokens: output } : {}) });
      const failed = j['status'] !== undefined && j['status'] !== 'success';
      const e = j['error'] && typeof j['error'] === 'object' ? str((j['error'] as Record<string, unknown>)['message']) : str(j['error']);
      return { chunks, done: true, ...(failed ? { error: (e ?? `Gemini ended with status ${String(j['status'])}`).slice(0, 2000) } : {}) };
    }
  }
  return { chunks };
}

export class GeminiAdapter implements CliAdapter {
  readonly id = 'gemini';
  constructor(private exe: string, private opts: AdapterProcessOptions & { env?: NodeJS.ProcessEnv } = {}) {}

  async *run(prompt: string, o: RunOptions): AsyncGenerator<Chunk> {
    let ended = false;
    try {
      for await (const c of this.stream(prompt, o)) {
        if (ended) continue;
        if (c.kind === 'done') ended = true;
        yield c;
      }
    } catch (e) {
      if (!ended) yield { kind: 'done', ok: false, error: `Harbor could not run Gemini CLI: ${String((e as Error).message ?? e)}`, exitCode: null };
    }
  }

  private async *stream(prompt: string, o: RunOptions): AsyncGenerator<Chunk> {
    // No system-prompt flag is assumed: the role contract is prepended (a Gemini session is never resumed).
    const full = o.systemPrompt ? `${o.systemPrompt}\n\n---\n\n${prompt}` : prompt;
    const gen = streamLines(this.exe, geminiArgs(o), { cwd: o.cwd, input: full, signal: o.signal, env: this.opts.env, launcher: this.opts.launcher, forceResolveMs: this.opts.forceResolveMs });
    const texts: string[] = [];
    let sawDone = false, error: string | undefined, session: string | undefined;
    let res: IteratorResult<StreamedLine, StreamResult>;
    try {
      res = await gen.next();
      while (!res.done) {
        const l = res.value;
        this.opts.onLine?.(l);
        if (l.stream === 'stdout' && !sawDone) {
          const p = parseGeminiLine(l.line);
          if (p.error) error = p.error;
          if (p.done) sawDone = true;
          for (const c of p.chunks) {
            if (c.kind === 'session') { if (c.id === session) continue; session = c.id; }
            if (c.kind === 'text') texts.push(c.text);
            yield c;
          }
        }
        res = await gen.next();
      }
    } finally {
      await gen.return(undefined as never).catch(() => undefined);
    }
    const r = res.value;
    const text = texts.join('').trim();
    const tail = r.stderr.trim().slice(-500);
    const limited = RATE_LIMIT_RE.test(r.stderr) || RATE_LIMIT_RE.test(error ?? '');
    if (r.aborted) { yield { kind: 'done', ok: false, error: 'stopped', exitCode: null }; return; }
    if (r.spawnError) { yield { kind: 'done', ok: false, error: r.spawnError, exitCode: null }; return; }
    if (r.code !== 0) { yield { kind: 'done', ok: false, text, error: error ?? (tail || `exited with code ${r.code}`), rateLimited: limited, exitCode: r.code }; return; }
    if (error) { yield { kind: 'done', ok: false, text, error, rateLimited: limited, exitCode: 0 }; return; }
    if (!sawDone) { yield { kind: 'done', ok: false, text, error: 'Gemini CLI ended without its final result event (the stream-json shape is unverified; run npm run smoke -- gemini).', exitCode: 0 }; return; }
    yield { kind: 'done', ok: true, text };
  }
}
