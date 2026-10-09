import type { ChildProcess } from 'node:child_process';
import { killTree, spawnCli } from '../proc';

export interface StreamedLine { stream: 'stdout' | 'stderr'; line: string }
export interface StreamResult { code: number | null; aborted: boolean; stderr: string; spawnError?: string }

/** Write side of a child's stdin kept open for a conversation (control protocols). Writes after `end` are dropped. */
export interface StdinSink { write(data: string): void; end(): void }

/**
 * Spawn a CLI, feed `input` on stdin, and yield output lines as they arrive.
 * The generator's return value is the exit summary. Aborting kills the whole process tree.
 * With `interactive`, stdin is NOT ended after `input`: the hook gets a sink and the caller ends it.
 */
export async function* streamLines(
  exe: string, args: string[],
  opts: { cwd: string; input: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; interactive?: (stdin: StdinSink) => void }
): AsyncGenerator<StreamedLine, StreamResult> {
  const queue: StreamedLine[] = [];
  let wake: (() => void) | undefined;
  let closed = false, aborted = false, code: number | null = null, spawnError: string | undefined;
  let stderrAll = '';
  const poke = () => { wake?.(); wake = undefined; };

  let child: ChildProcess;
  try {
    child = spawnCli(exe, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return { code: null, aborted: false, stderr: '', spawnError: String(e) };
  }

  const pump = (stream: 'stdout' | 'stderr', src: NodeJS.ReadableStream | null) => {
    let buf = '';
    src?.setEncoding?.('utf8');
    src?.on('data', (d: string) => {
      if (stream === 'stderr') stderrAll += d;
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        queue.push({ stream, line: buf.slice(0, i).replace(/\r$/, '') });
        buf = buf.slice(i + 1);
      }
      poke();
    });
    src?.on('end', () => { if (buf) queue.push({ stream, line: buf }); buf = ''; poke(); });
  };
  pump('stdout', child.stdout);
  pump('stderr', child.stderr);

  child.on('error', (e) => { spawnError = e.message; closed = true; poke(); });
  child.on('close', (c) => { code = c; closed = true; poke(); });
  child.stdin?.on('error', () => {});
  if (opts.interactive) {
    const stdin = child.stdin;
    let ended = false;
    const open = () => !ended && !!stdin && !stdin.destroyed && stdin.writable;
    if (opts.input && open()) stdin!.write(opts.input);
    opts.interactive({
      write: (d) => { if (open()) stdin!.write(d); },
      end: () => { if (open()) stdin!.end(); ended = true; }
    });
  } else child.stdin?.end(opts.input);

  const onAbort = () => { aborted = true; killTree(child); };
  if (opts.signal?.aborted) onAbort(); else opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (closed) { await new Promise((r) => setImmediate(r)); if (!queue.length) break; continue; }
      await new Promise<void>((r) => { wake = r; });
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    if (!closed) killTree(child);
  }
  return { code, aborted, stderr: stderrAll, spawnError };
}
