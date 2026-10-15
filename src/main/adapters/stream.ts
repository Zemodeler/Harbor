import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { CappedText, killTree, spawnCli, spawnErrorMessage } from '../proc';

/**
 * Longest line held back while waiting for a newline. A JSONL event longer than this is cut into pieces that no longer parse, so
 * it must hold the biggest single event a CLI prints: Claude's final `result` line carries the whole answer and an assistant
 * message carries whole files written by a tool (1 MB cut real-sized answers and turned a finished run into a failure).
 */
export const MAX_PARTIAL_LINE = 8 * 1024 * 1024;

/**
 * How a CLI process is started and stopped. Injected so adapters can be driven by fake child processes in tests
 * (tests/conformance); production uses `realLauncher` (proc.ts: .cmd shim handling, PID tracking, tree kill).
 */
export interface ProcessLauncher {
  spawn(exe: string, args: string[], opts: SpawnOptions): ChildProcess;
  kill(child: ChildProcess): void;
}
export const realLauncher: ProcessLauncher = { spawn: spawnCli, kill: killTree };

/** Process options every CLI adapter accepts besides its executable. */
export interface AdapterProcessOptions {
  launcher?: ProcessLauncher;
  /** Sees every raw output line (transcript recording in scripts/smoke.ts, the custom-CLI dry run). */
  onLine?: (l: StreamedLine) => void;
  /** Grace period after an abort before a process that ignores the kill is abandoned (default FORCE_RESOLVE_MS). */
  forceResolveMs?: number;
}

export interface StreamedLine { stream: 'stdout' | 'stderr'; line: string }
/** `leaked`: the process did not exit within the grace period after an abort; its PID stays recorded so the next start's orphan sweep kills it. */
export interface StreamResult { code: number | null; aborted: boolean; stderr: string; spawnError?: string; leaked?: boolean }

/** After an abort the stream is given this long to see the process exit before it is abandoned. */
export const FORCE_RESOLVE_MS = 10_000;

/** Write side of a child's stdin kept open for a conversation (control protocols). Writes after `end` are dropped. */
export interface StdinSink { write(data: string): void; end(): void }

/**
 * Spawn a CLI, feed `input` on stdin, and yield output lines as they arrive.
 * The generator's return value is the exit summary. Aborting kills the whole process tree.
 * With `interactive`, stdin is NOT ended after `input`: the hook gets a sink and the caller ends it.
 */
export async function* streamLines(
  exe: string, args: string[],
  opts: { cwd: string; input: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; interactive?: (stdin: StdinSink) => void; forceResolveMs?: number; launcher?: ProcessLauncher }
): AsyncGenerator<StreamedLine, StreamResult> {
  const launcher = opts.launcher ?? realLauncher;
  const queue: StreamedLine[] = [];
  let wake: (() => void) | undefined;
  let closed = false, aborted = false, leaked = false, code: number | null = null, spawnError: string | undefined;
  let leakTimer: NodeJS.Timeout | undefined;
  const stderrAll = new CappedText(256 * 1024);
  const poke = () => { wake?.(); wake = undefined; };

  let child: ChildProcess;
  try {
    child = launcher.spawn(exe, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return { code: null, aborted: false, stderr: '', spawnError: String(e) };
  }

  const pump = (stream: 'stdout' | 'stderr', src: NodeJS.ReadableStream | null) => {
    let buf = '';
    src?.setEncoding?.('utf8');
    src?.on('data', (d: string) => {
      if (stream === 'stderr') stderrAll.push(d);
      // Search only the new data: rescanning a long held-back line on every chunk is quadratic.
      let from = buf.length;
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n', from)) >= 0) {
        queue.push({ stream, line: buf.slice(0, i).replace(/\r$/, '') });
        buf = buf.slice(i + 1);
        from = 0;
      }
      // A newline-free flood must not grow without bound: flush an oversized partial line in pieces.
      while (buf.length > MAX_PARTIAL_LINE) { queue.push({ stream, line: buf.slice(0, MAX_PARTIAL_LINE) }); buf = buf.slice(MAX_PARTIAL_LINE); }
      poke();
    });
    src?.on('end', () => { if (buf) queue.push({ stream, line: buf }); buf = ''; poke(); });
  };
  pump('stdout', child.stdout);
  pump('stderr', child.stderr);

  child.on('error', (e) => { spawnError = spawnErrorMessage(e, exe, opts.cwd); closed = true; poke(); });
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

  const onAbort = () => {
    aborted = true;
    launcher.kill(child);
    // A process that survives the kill must not hold the run (and its queue slot) forever.
    if (!leakTimer) {
      leakTimer = setTimeout(() => { if (!closed) { leaked = true; closed = true; poke(); } }, opts.forceResolveMs ?? FORCE_RESOLVE_MS);
      leakTimer.unref?.();
    }
  };
  if (opts.signal?.aborted) onAbort(); else opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (closed) { await new Promise((r) => setImmediate(r)); if (!queue.length) break; continue; }
      await new Promise<void>((r) => { wake = r; });
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    if (leakTimer) clearTimeout(leakTimer);
    if (!closed) launcher.kill(child);
  }
  return { code, aborted, stderr: stderrAll.toString(), spawnError, ...(leaked ? { leaked } : {}) };
}
