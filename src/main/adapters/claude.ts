import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Chunk, CliAdapter, RunOptions } from './types';
import { RATE_LIMIT_RE } from './types';
import { streamLines, type StreamedLine, type StreamResult } from './stream';

/**
 * Claude Code headless adapter. Flags verified against `claude --help` (2.1.293):
 * -p, --output-format stream-json (needs --verbose), --model, --effort, --resume,
 * --permission-mode, --allowedTools, --disallowedTools, --append-system-prompt.
 * The prompt goes through stdin so it never touches the command line.
 */
export function claudeArgs(o: RunOptions, systemPromptFile?: string): string[] {
  const a = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (o.model && o.model !== 'default') a.push('--model', o.model);
  a.push('--effort', o.effort);
  if (o.resumeId) a.push('--resume', o.resumeId);
  if (o.permission === 'edit') {
    a.push('--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(git *)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)');
  } else {
    a.push('--permission-mode', 'plan');
  }
  // Subagents must not spawn agents (docs/project-agents.md): block native delegation tools.
  a.push('--disallowedTools', 'Task', 'Agent');
  // Role text is long and multi-line: pass it by file so it works through .cmd shims too.
  if (systemPromptFile) a.push('--append-system-prompt-file', systemPromptFile);
  return a;
}

/** Parse one stream-json line into zero or more chunks. Pure; unknown shapes are ignored. */
export function parseClaudeLine(line: string): Chunk[] {
  let j: any;
  try { j = JSON.parse(line); } catch { return []; }
  const out: Chunk[] = [];
  if (j.type === 'system' && j.subtype === 'init' && j.session_id) out.push({ kind: 'session', id: j.session_id });
  else if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
    for (const c of j.message.content) {
      if (c.type === 'text' && c.text) out.push({ kind: 'text', text: c.text });
      else if (c.type === 'tool_use') out.push({ kind: 'tool', text: `${c.name} ${summarizeInput(c.input)}`.trim() });
    }
  } else if (j.type === 'result') {
    if (j.session_id) out.push({ kind: 'session', id: j.session_id });
    out.push({ kind: 'usage', inputTokens: j.usage?.input_tokens, outputTokens: j.usage?.output_tokens, costUsd: j.total_cost_usd });
    const err = j.is_error || (j.subtype && j.subtype !== 'success');
    const text = typeof j.result === 'string' ? j.result : undefined;
    out.push({ kind: 'done', ok: !err, text, error: err ? text || String(j.subtype) : undefined, rateLimited: err && RATE_LIMIT_RE.test(text ?? '') });
  }
  return out;
}

function summarizeInput(i: any): string {
  if (!i || typeof i !== 'object') return '';
  const v = i.file_path ?? i.command ?? i.pattern ?? i.path ?? '';
  return String(v).slice(0, 120);
}

export class ClaudeAdapter implements CliAdapter {
  id = 'claude';
  constructor(private exe: string) {}

  async *run(prompt: string, o: RunOptions): AsyncGenerator<Chunk> {
    let done = false;
    let spFile: string | undefined;
    if (o.systemPrompt) {
      spFile = join(tmpdir(), `harbor-sp-${randomUUID()}.txt`);
      writeFileSync(spFile, o.systemPrompt);
    }
    let res: IteratorResult<StreamedLine, StreamResult>;
    const gen = streamLines(this.exe, claudeArgs(o, spFile), { cwd: o.cwd, input: prompt, signal: o.signal });
    try {
      res = await gen.next();
      while (!res.done) {
        if (res.value.stream === 'stdout') for (const c of parseClaudeLine(res.value.line)) { if (c.kind === 'done') done = true; yield c; }
        res = await gen.next();
      }
    } finally {
      if (spFile) try { unlinkSync(spFile); } catch { /* already gone */ }
    }
    if (!done) {
      const r = res.value;
      const reason = r.aborted ? 'stopped' : r.spawnError ?? (r.stderr.trim().slice(-500) || `exited with code ${r.code}`);
      yield { kind: 'done', ok: false, error: reason, rateLimited: RATE_LIMIT_RE.test(r.stderr) };
    }
  }
}
