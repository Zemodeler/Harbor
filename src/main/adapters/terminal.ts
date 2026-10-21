import type { Chunk, CliAdapter, RunOptions } from './types';
import { RATE_LIMIT_RE } from './types';
import { CappedText } from '../proc';
import { streamLines, type AdapterProcessOptions } from './stream';

/**
 * Baseline terminal adapter for a CLI with no structured output. It runs the CLI once, feeds the prompt on stdin (never argv) and
 * treats stdout as the answer. Used only when the owner turns terminal mode on for that CLI (Settings.cliOverrides[cli].terminal);
 * Harbor never picks it on its own.
 *
 * LIMITATIONS (TERMINAL_LIMITATIONS, also shown in the CLI's Settings note):
 *  - no resume: every run is a new session; Harbor's handoff text carries the context
 *  - no streaming deltas: the answer arrives as one `text` chunk when the process exits
 *  - no tool-permission control: Harbor cannot enforce read-only or answer tool prompts; `permission` is ignored, so edit-capable
 *    work relies on Harbor's worktree and post-turn git check alone
 *  - no usage figures, images, MCP or session id; rate limits are recognised only by matching error text
 * Exit code 0 is success; anything else fails with the stderr tail.
 */
export const TERMINAL_LIMITATIONS = [
  'no resume (every run starts a fresh session)',
  'no streaming (the answer arrives when the run ends)',
  'no tool-permission control (read-only cannot be enforced)',
  'no usage figures or images'
] as const;

const MAX_ANSWER = 4 * 1024 * 1024;

export interface TerminalAdapterOptions extends AdapterProcessOptions {
  /** Arguments for the run; the prompt is never one of them. Default: none. */
  args?: (o: RunOptions) => string[];
  env?: NodeJS.ProcessEnv;
  /** Display name for errors. */
  name?: string;
}

export class TerminalAdapter implements CliAdapter {
  constructor(readonly id: string, private exe: string, private opts: TerminalAdapterOptions = {}) {}

  async *run(prompt: string, o: RunOptions): AsyncGenerator<Chunk> {
    let ended = false;
    try {
      for await (const c of this.stream(prompt, o)) {
        if (ended) continue;
        if (c.kind === 'done') ended = true;
        yield c;
      }
    } catch (e) {
      if (!ended) yield { kind: 'done', ok: false, error: `Harbor could not run ${this.opts.name ?? this.id}: ${String((e as Error).message ?? e)}`, exitCode: null };
    }
  }

  private async *stream(prompt: string, o: RunOptions): AsyncGenerator<Chunk> {
    const full = o.systemPrompt ? `${o.systemPrompt}\n\n---\n\n${prompt}` : prompt;
    const gen = streamLines(this.exe, this.opts.args?.(o) ?? [], { cwd: o.cwd, input: full, signal: o.signal, env: this.opts.env, launcher: this.opts.launcher, forceResolveMs: this.opts.forceResolveMs });
    const answer = new CappedText(MAX_ANSWER);
    let res = await gen.next();
    try {
      while (!res.done) {
        this.opts.onLine?.(res.value);
        if (res.value.stream === 'stdout') answer.push(`${res.value.line}\n`);
        res = await gen.next();
      }
    } finally {
      await gen.return(undefined as never).catch(() => undefined);
    }
    const r = res.value, text = answer.toString().trim(), tail = r.stderr.trim().slice(-500);
    if (r.aborted) { yield { kind: 'done', ok: false, error: 'stopped', exitCode: null }; return; }
    if (r.spawnError) { yield { kind: 'done', ok: false, error: r.spawnError, exitCode: null }; return; }
    if (r.code !== 0) { yield { kind: 'done', ok: false, text, error: tail || `exited with code ${r.code}`, rateLimited: RATE_LIMIT_RE.test(r.stderr), exitCode: r.code }; return; }
    if (text) yield { kind: 'text', text };
    yield { kind: 'done', ok: true, text };
  }
}
