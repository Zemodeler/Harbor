import type { Chunk, CliAdapter, RunOptions } from './types';
import { RATE_LIMIT_RE } from './types';
import { streamLines } from './stream';

/**
 * Codex headless adapter (`codex exec --json`, JSONL events on stdout).
 * NOT VERIFIED against a real install in this environment (codex was not installed when written):
 * flags and event shapes come from the public CLI docs. Run `npm run smoke -- codex` to verify.
 * Prompt is read from stdin via the `-` argument.
 */
export function codexArgs(o: RunOptions): string[] {
  const a = ['exec'];
  if (o.resumeId) a.push('resume', o.resumeId);
  a.push('--json', '--skip-git-repo-check', '-s', o.permission === 'edit' ? 'workspace-write' : 'read-only');
  if (o.model && o.model !== 'default') a.push('-m', o.model);
  a.push('-c', `model_reasoning_effort=${o.effort}`);
  a.push('-');
  return a;
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
    out.push({ kind: 'usage', inputTokens: j.usage?.input_tokens, outputTokens: j.usage?.output_tokens });
    out.push({ kind: 'done', ok: true });
  } else if (t === 'turn.failed' || t === 'error') {
    const msg = String(j.error?.message ?? j.message ?? 'codex error');
    out.push({ kind: 'done', ok: false, error: msg, rateLimited: RATE_LIMIT_RE.test(msg) });
  }
  return out;
}

export class CodexAdapter implements CliAdapter {
  id = 'codex';
  constructor(private exe: string) {}

  async *run(prompt: string, o: RunOptions): AsyncGenerator<Chunk> {
    // Codex has no append-system-prompt flag; role instructions are prepended to the prompt.
    const full = o.systemPrompt ? `${o.systemPrompt}\n\n---\n\n${prompt}` : prompt;
    let done = false, last = '';
    const gen = streamLines(this.exe, codexArgs(o), { cwd: o.cwd, input: full, signal: o.signal });
    let res = await gen.next();
    while (!res.done) {
      if (res.value.stream === 'stdout') for (const c of parseCodexLine(res.value.line)) {
        if (c.kind === 'text') last = c.text;
        if (c.kind === 'done') { done = true; yield { ...c, text: c.text ?? last }; } else yield c;
      }
      res = await gen.next();
    }
    if (!done) {
      const r = res.value;
      const reason = r.aborted ? 'stopped' : r.spawnError ?? (r.stderr.trim().slice(-500) || `exited with code ${r.code}`);
      yield { kind: 'done', ok: false, error: reason, rateLimited: RATE_LIMIT_RE.test(r.stderr) };
    }
  }
}
