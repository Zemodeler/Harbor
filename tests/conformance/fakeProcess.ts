import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ProcessLauncher } from '../../src/main/adapters/stream';

/**
 * Fake child processes for driving CLI adapters without any real CLI (or any process at all). An adapter built with a
 * `FakeLauncher` gets a scripted child: the behaviour writes stdout/stderr and chooses the exit code; kills are recorded.
 */

/** What a behaviour can do with its fake process. */
export interface FakeProc {
  exe: string;
  argv: string[];
  opts: SpawnOptions;
  /** Everything written to stdin so far. */
  stdin(): string;
  /** Resolves with the whole stdin once the adapter ends it. */
  stdinEnded: Promise<string>;
  /** Resolves with stdin up to its first newline (controlled-mode Claude keeps stdin open, so do not wait for the end). */
  firstStdinLine: Promise<string>;
  /** One stdout line (a newline is added). */
  out(line: string): void;
  /** Raw stdout bytes: no newline added (partial lines, split UTF-8, CRLF). */
  write(data: string | Buffer): void;
  /** Raw stderr. */
  err(data: string): void;
  /** End the process with this exit code (null = killed by a signal). Idempotent. */
  exit(code: number | null): void;
  /** Resolves when the launcher is asked to kill this process. */
  killed: Promise<void>;
  wasKilled(): boolean;
  exited(): boolean;
}

export type FakeBehavior = (p: FakeProc) => void | Promise<void>;

export interface FakeLauncherOptions {
  /** The kill is recorded but the process keeps running (tests the abandon-after-grace path). */
  ignoreKill?: boolean;
  /** `spawn` throws synchronously, like spawnCli with an unsafe argument for a .cmd shim. */
  spawnThrows?: string;
  /** The child emits 'error' (like ENOENT) instead of running. */
  spawnError?: string;
}

/** Yields to the event loop so streams deliver what was written. */
export const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

export class FakeLauncher implements ProcessLauncher {
  readonly procs: FakeProc[] = [];
  private byChild = new Map<ChildProcess, FakeProc & { kill(): void }>();
  constructor(private behavior: FakeBehavior, private o: FakeLauncherOptions = {}) {}

  get last(): FakeProc | undefined { return this.procs.at(-1); }

  spawn(exe: string, args: string[], opts: SpawnOptions): ChildProcess {
    if (this.o.spawnThrows) throw new Error(this.o.spawnThrows);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new PassThrough(), stderr = new PassThrough();
    let input = '', exited = false, killed = false;
    let endStdin!: (s: string) => void, firstLine!: (s: string) => void, onKill!: () => void;
    const stdinEnded = new Promise<string>((r) => { endStdin = r; });
    const firstStdinLine = new Promise<string>((r) => { firstLine = r; });
    const killedP = new Promise<void>((r) => { onKill = r; });
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        input += String(chunk);
        const i = input.indexOf('\n');
        if (i >= 0) firstLine(input.slice(0, i));
        cb();
      },
      final(cb) { firstLine(input); endStdin(input); cb(); }
    });
    Object.assign(child, { stdout, stderr, stdin, pid: undefined, exitCode: null, signalCode: null, kill: () => true });

    const exit = (code: number | null) => {
      if (exited) return;
      exited = true;
      void (async () => {
        const ends = [once(stdout, 'end'), once(stderr, 'end')];
        stdout.end(); stderr.end();
        await Promise.all(ends);
        child['exitCode'] = code;
        child['signalCode'] = code === null ? 'SIGTERM' : null;
        await tick();
        child.emit('close', code);
      })();
    };
    const proc: FakeProc & { kill(): void } = {
      exe, argv: [...args], opts,
      stdin: () => input, stdinEnded, firstStdinLine,
      out: (line) => { if (!exited) stdout.write(`${line}\n`); },
      write: (d) => { if (!exited) stdout.write(d); },
      err: (d) => { if (!exited) stderr.write(d); },
      exit,
      killed: killedP,
      wasKilled: () => killed,
      exited: () => exited,
      kill: () => { killed = true; onKill(); if (!this.o.ignoreKill) exit(null); }
    };
    this.procs.push(proc);
    this.byChild.set(child as unknown as ChildProcess, proc);

    if (this.o.spawnError) {
      const msg = this.o.spawnError;
      process.nextTick(() => { child.emit('error', new Error(msg)); });
      return child as unknown as ChildProcess;
    }
    // Start on the next tick, after the adapter has attached its listeners, as a real process would.
    setImmediate(() => {
      Promise.resolve()
        .then(() => this.behavior(proc))
        .catch((e) => { proc.err(`fake behaviour threw: ${String(e)}\n`); proc.exit(97); });
    });
    return child as unknown as ChildProcess;
  }

  kill(child: ChildProcess): void { this.byChild.get(child)?.kill(); }
}

/** A behaviour that prints these stdout lines (and optional stderr) and exits. */
export const script = (lines: string[], o: { stderr?: string[]; exit?: number | null; waitStdin?: boolean } = {}): FakeBehavior => async (p) => {
  if (o.waitStdin) await p.firstStdinLine;
  for (const e of o.stderr ?? []) p.err(`${e}\n`);
  for (const l of lines) p.out(l);
  p.exit(o.exit === undefined ? 0 : o.exit);
};

/** A behaviour that prints these lines and then runs until it is killed. */
export const hang = (lines: string[]): FakeBehavior => async (p) => {
  for (const l of lines) p.out(l);
  await p.killed;
};
