import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CustomCliDescriptor } from '../../shared/api';
import { customEnv, expandArgs, matchesDone, parseDoneTest, parseJsonPath, readJsonPath, type SlotValues } from '../clis/custom';
import { CappedText } from '../proc';
import type { Chunk, CliAdapter, RunOptions } from './types';
import { RATE_LIMIT_RE } from './types';
import { streamLines, type StreamedLine } from './stream';

/**
 * One adapter for any CLI described by a CustomCliDescriptor (clis/custom.ts). It knows no CLI: every flag comes from the
 * descriptor the user wrote and checked with the dry run. The prompt goes on stdin (or a temp file the descriptor names), never in
 * argv; arguments are expanded one argv element each, so values cannot inject arguments; .cmd shims go through proc.ts quoting.
 * Always ends with exactly one `done` chunk; aborting kills the process tree (streamLines).
 * Text output: stdout is the answer. It streams as one `text` chunk per paragraph, and the exit code decides success.
 * JSONL output: each line is matched against the descriptor's paths; lines that are not JSON are ignored.
 * Not supported for custom CLIs (the options are ignored): host tool-permission prompts, lean concierge runs, writable extra dirs,
 * allowed-command lists and git-write denial. Harbor's worktrees and the post-turn git check remain the containment.
 */
export interface GenericAdapterOptions {
  /** Base environment (default process.env); only the allowlist reaches the CLI. */
  env?: NodeJS.ProcessEnv;
  /** Folder for prompt files (default the OS temp folder). */
  tmpDir?: string;
  /** Sees every raw output line (the dry run shows them). */
  onLine?: (l: StreamedLine) => void;
}

/** Most text kept for the final answer of a text-mode run. */
const MAX_ANSWER = 4 * 1024 * 1024;

export function genericArgs(d: CustomCliDescriptor, o: RunOptions, promptFile?: string): string[] {
  const vars = { model: o.model === 'default' ? '' : o.model, effort: o.nativeEffort ?? o.effort, cwd: o.cwd, promptFile };
  const slots: SlotValues = {
    resumeArgs: o.resumeId && d.run.resume ? expandArgs(d.run.resume.args, { ...vars, sessionId: o.resumeId }) : [],
    effortArgs: d.run.effort?.[o.effort] ?? [],
    permissionArgs: d.run.permissions?.[o.permission] ?? [],
    imageArgs: d.run.image ? (o.images ?? []).flatMap((p) => d.run.image!.args.map((a) => a.split('{path}').join(p))) : [],
    // Folders of enabled skills outside the working folder (skills/delivery.ts); without run.readDir small skills are inlined instead.
    readDirArgs: d.run.readDir ? (o.readableDirs ?? []).flatMap((p) => d.run.readDir!.args.map((a) => a.split('{path}').join(p))) : []
  };
  return expandArgs(d.run.args, vars, slots);
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Pure: what one JSONL line means under the descriptor's map. */
export function parseGenericLine(d: CustomCliDescriptor, line: string): { chunks: Chunk[]; done?: boolean; error?: string } {
  const map = d.run.output?.map ?? {};
  let j: unknown;
  try { j = JSON.parse(line); } catch { return { chunks: [] }; }
  if (!j || typeof j !== 'object') return { chunks: [] };
  const at = (p?: string) => { const segs = p ? parseJsonPath(p) : undefined; return segs ? readJsonPath(j, segs) : undefined; };
  const chunks: Chunk[] = [];
  const session = at(map.session);
  if (typeof session === 'string' && session.trim() && session.length <= 200) chunks.push({ kind: 'session', id: session.trim() });
  const text = at(map.text);
  if (typeof text === 'string' && text) chunks.push({ kind: 'text', text });
  const input = num(at(map.usage?.input)), output = num(at(map.usage?.output));
  if (input !== undefined || output !== undefined) chunks.push({ kind: 'usage', ...(input !== undefined ? { inputTokens: input } : {}), ...(output !== undefined ? { outputTokens: output } : {}) });
  const err = at(map.error);
  const error = typeof err === 'string' && err.trim() ? err.trim().slice(0, 2000) : err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string' ? String((err as { message: string }).message).slice(0, 2000) : undefined;
  const test = map.done ? parseDoneTest(map.done) : undefined;
  return { chunks, ...(test && matchesDone(j, test) ? { done: true } : {}), ...(error ? { error } : {}) };
}

export class GenericAdapter implements CliAdapter {
  readonly id: string;
  constructor(private d: CustomCliDescriptor, private opts: GenericAdapterOptions = {}) { this.id = d.id; }

  async *run(prompt: string, o: RunOptions): AsyncGenerator<Chunk> {
    const d = this.d;
    // No system-prompt flag is assumed: role instructions are prepended on a session's first run (as for Codex).
    const full = o.systemPrompt && !o.resumeId ? `${o.systemPrompt}\n\n---\n\n${prompt}` : prompt;
    let promptFile: string | undefined, ended = false;
    try {
      if (d.run.prompt === 'file') {
        promptFile = join(this.opts.tmpDir ?? tmpdir(), `harbor-prompt-${randomUUID()}.txt`);
        writeFileSync(promptFile, full, { mode: 0o600 });
      }
      for await (const c of this.stream(full, o, promptFile)) {
        if (ended) continue; // exactly one terminal chunk
        if (c.kind === 'done') ended = true;
        yield c;
      }
    } catch (e) {
      if (!ended) yield { kind: 'done', ok: false, error: `Harbor could not run ${d.name}: ${String((e as Error).message ?? e)}`, exitCode: null };
    } finally {
      if (promptFile) try { rmSync(promptFile, { force: true }); } catch { /* best effort */ }
    }
  }

  private async *stream(full: string, o: RunOptions, promptFile: string | undefined): AsyncGenerator<Chunk> {
    const d = this.d, jsonl = d.run.output?.format === 'jsonl';
    const gen = streamLines(d.exe, genericArgs(d, o, promptFile), {
      cwd: o.cwd, input: d.run.prompt === 'file' ? '' : full, signal: o.signal, env: customEnv(this.opts.env ?? process.env, d.run.env)
    });
    const answer = new CappedText(MAX_ANSWER);
    const texts: string[] = [];
    let paragraph: string[] = [];
    let sawDone = false, mappedError: string | undefined, sessionId: string | undefined;
    const flush = (): Chunk[] => {
      const t = paragraph.join('\n').trim();
      paragraph = [];
      return t ? [{ kind: 'text', text: t }] : [];
    };
    let res = await gen.next();
    while (!res.done) {
      const l = res.value;
      this.opts.onLine?.(l);
      if (l.stream === 'stdout') {
        if (!jsonl) {
          answer.push(`${l.line}\n`);
          if (l.line.trim()) paragraph.push(l.line); else yield* flush();
        } else {
          const p = parseGenericLine(d, l.line);
          if (p.error) mappedError = p.error;
          if (p.done) sawDone = true;
          for (const c of p.chunks) {
            if (c.kind === 'session') { if (c.id === sessionId) continue; sessionId = c.id; }
            if (c.kind === 'text') texts.push(c.text);
            yield c;
          }
        }
      }
      res = await gen.next();
    }
    if (!jsonl) yield* flush();
    const r = res.value;
    const text = (jsonl ? texts.join('\n\n') : answer.toString()).trim();
    const stderrTail = r.stderr.trim().slice(-500);
    if (r.aborted) { yield { kind: 'done', ok: false, error: 'stopped', exitCode: null }; return; }
    if (r.spawnError) { yield { kind: 'done', ok: false, error: r.spawnError, exitCode: null }; return; }
    const limited = RATE_LIMIT_RE.test(r.stderr) || RATE_LIMIT_RE.test(mappedError ?? '');
    if (r.code !== 0) { yield { kind: 'done', ok: false, text, error: mappedError ?? (stderrTail || `exited with code ${r.code}`), rateLimited: limited, exitCode: r.code }; return; }
    if (mappedError && (sawDone || !d.run.output?.map?.done)) { yield { kind: 'done', ok: false, text, error: mappedError, rateLimited: limited, exitCode: 0 }; return; }
    // A jsonl CLI whose final event never came: report it, with the exit code, so Harbor can tell a clean finish from a cut-off.
    if (jsonl && d.run.output?.map?.done && !sawDone) { yield { kind: 'done', ok: false, text, error: `${d.name} ended without the final event the descriptor names (${d.run.output.map.done}).`, exitCode: 0 }; return; }
    yield { kind: 'done', ok: true, text };
  }
}
