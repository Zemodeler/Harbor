import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string; /** Output exceeded the cap; the middle was dropped (head and tail kept). */ truncated?: boolean }

/** Injectable process runner so discovery/adapters can be tested without real CLIs. */
export type Runner = (exe: string, args: string[], opts?: { cwd?: string; timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv; /** Per-stream cap in chars (default 16M). */ maxOutput?: number }) => Promise<RunResult>;

// Inside double quotes cmd.exe treats & | < > ^ ( ) * literally; only %VAR% expansion, quotes and line breaks are unsafe.
// An empty argument is safe and meaningful (`--tools ""` disables all tools); it is passed as `""`.
const SAFE_ARG = /^[^"%\r\n\0]*$/;

export function isShellScript(exe: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
}

/** Quote one argument for cmd.exe. Only used for .cmd/.bat shims; prompts go through stdin, never argv. */
export function quoteWinArg(a: string): string {
  if (!SAFE_ARG.test(a)) throw new Error(`Unsafe argument for shell launch: ${JSON.stringify(a)}`);
  return `"${a}"`;
}

/** A process Harbor started, recorded so a later run can recognise it as its own orphan. */
export interface TrackedProcess {
  pid: number;
  /** Process name without extension, lowercase (`cmd` for .cmd shims). */
  name: string;
  /** Spawn time, epoch ms. */
  started: number;
  /** Harbor instance that spawned this process; absent on legacy records. */
  owner?: ProcessOwner;
}

export interface ProcessOwner { pid: number; started: number }
const processOwner: ProcessOwner = { pid: process.pid, started: Date.now() - process.uptime() * 1000 };

/** Told about every CLI spawn; the orchestrator persists these so orphans survive a Harbor crash. */
export interface SpawnObserver { spawned(p: TrackedProcess): void; exited(pid: number, started: number): void }
let observer: SpawnObserver | undefined;
export function setSpawnObserver(o: SpawnObserver | undefined): void { observer = o; }

const procName = (exe: string): string =>
  isShellScript(exe) ? 'cmd' : (exe.split(/[\\/]/).pop() ?? exe).replace(/\.[a-z0-9]+$/i, '').toLowerCase();

/** Spawn a CLI, handling Windows .cmd shims (which Node refuses to spawn without a shell). */
export function spawnCli(exe: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  let child: ChildProcess;
  if (isShellScript(exe)) {
    const line = [exe, ...args].map(quoteWinArg).join(' ');
    child = spawn(line, { ...opts, shell: true, windowsHide: true }); // node wraps this in cmd.exe /d /s /c "..."
  } else child = spawn(exe, args, { ...opts, windowsHide: true });
  const pid = child.pid;
  if (pid && observer) {
    const o = observer;
    const started = Date.now();
    o.spawned({ pid, name: procName(exe), started, owner: { ...processOwner } });
    child.once('close', () => o.exited(pid, started));
    child.once('error', () => o.exited(pid, started));
  }
  return child;
}

/** What is needed to find and kill a leftover process; injected so tests never touch real processes. */
export interface ProcessKiller {
  /** Name (no extension, lowercase) and start time (epoch ms) of a live process, or undefined when no such process exists. */
  inspect(pid: number): Promise<{ name: string; started: number } | undefined>;
  kill(pid: number): Promise<void>;
  /** Injectable Harbor-owner liveness check, including its start time to guard PID reuse. */
  ownerAlive?(owner: ProcessOwner): Promise<boolean>;
}

/** Allowed gap between our Date.now() at spawn and the OS start time of the process. */
export const START_TOLERANCE_MS = 10_000;

/** A recorded PID is only ours if the live process has the same name and started when we spawned it (guards against PID reuse). */
export function matchesTracked(t: TrackedProcess, live: { name: string; started: number } | undefined): boolean {
  return !!live && live.name === t.name && Math.abs(live.started - t.started) <= START_TOLERANCE_MS;
}

export async function isOwnerAlive(owner: ProcessOwner): Promise<boolean> {
  try { process.kill(owner.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  const live = await systemKiller.inspect(owner.pid);
  // If inspection is unavailable, keep the process belonging to a live PID safe.
  return !live || Math.abs(live.started - owner.started) <= START_TOLERANCE_MS;
}

/** Keep live owners' records; legacy entries retain the original orphan-recovery policy. */
export async function reapTrackedProcesses(
  entries: readonly TrackedProcess[],
  store: { untrackProcess(pid: number, started: number): void },
  killer: ProcessKiller
): Promise<{ killed: number[]; skipped: number[] }> {
  const out: { killed: number[]; skipped: number[] } = { killed: [], skipped: [] };
  for (const entry of entries) {
    try {
      if (entry.owner && await (killer.ownerAlive ?? isOwnerAlive)(entry.owner)) {
        out.skipped.push(entry.pid);
        continue;
      }
      store.untrackProcess(entry.pid, entry.started);
      if (matchesTracked(entry, await killer.inspect(entry.pid))) {
        await killer.kill(entry.pid);
        out.killed.push(entry.pid);
      } else out.skipped.push(entry.pid);
    } catch { out.skipped.push(entry.pid); }
  }
  return out;
}

export const systemKiller: ProcessKiller = {
  inspect: (pid) => new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) return resolve(undefined);
    const win = process.platform === 'win32';
    const [exe, args] = win
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.ProcessName.ToLower() + '|' + ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() }`]] as const
      : ['ps', ['-o', 'comm=,lstart=', '-p', String(pid)]] as const;
    let out = '';
    const c = spawn(exe, [...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    c.stdout?.on('data', (d) => (out += d));
    c.on('error', () => resolve(undefined));
    c.on('close', () => {
      const line = out.trim();
      if (win) {
        const m = /^(.+)\|(\d+)$/.exec(line);
        return resolve(m ? { name: m[1]!, started: Number(m[2]) } : undefined);
      }
      const m = /^(\S+)\s+(.+)$/.exec(line);
      const t = m ? Date.parse(m[2]!) : NaN;
      resolve(m && !Number.isNaN(t) ? { name: (m[1]!.split('/').pop() ?? m[1]!).toLowerCase(), started: t } : undefined);
    });
  }),
  kill: (pid) => new Promise((resolve) => {
    if (process.platform === 'win32') {
      const c = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      c.on('error', () => resolve());
      c.on('close', () => resolve());
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
      resolve();
    }
  })
};

export const DEFAULT_MAX_OUTPUT = 16 * 1024 * 1024;

/** Keeps the first and last halves of a stream once it exceeds `max` chars, so one runaway process cannot exhaust memory. */
export class CappedText {
  private head = ''; private tail = ''; private total = 0;
  truncated = false;
  constructor(private max = DEFAULT_MAX_OUTPUT) {}
  private get half(): number { return Math.max(1, Math.floor(this.max / 2)); }
  push(d: string): void {
    this.total += d.length;
    if (!this.truncated) {
      this.head += d;
      if (this.head.length <= this.max) return;
      this.truncated = true;
      this.tail = this.head.slice(this.half);
      this.head = this.head.slice(0, this.half);
    } else this.tail += d;
    if (this.tail.length > this.half * 2) this.tail = this.tail.slice(-this.half);
  }
  toString(): string {
    if (!this.truncated) return this.head;
    const tail = this.tail.slice(-this.half);
    return `${this.head}
[... ${Math.max(0, this.total - this.head.length - tail.length)} characters truncated ...]
${tail}`;
  }
}

export const runProcess: Runner = (exe, args, opts = {}) =>
  new Promise((resolve) => {
    const out = new CappedText(opts.maxOutput), err = new CappedText(opts.maxOutput);
    let timedOut = false, settled = false;
    const done = (r: { code: number | null; timedOut: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      const truncated = out.truncated || err.truncated;
      resolve({ ...r, stdout: out.toString(), stderr: err.toString(), ...(truncated ? { truncated } : {}) });
    };
    let child: ChildProcess;
    try {
      child = spawnCli(exe, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return done({ code: null, timedOut, error: String(e) });
    }
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; killTree(child); }, opts.timeoutMs) : undefined;
    child.stdout?.on('data', (d) => out.push(String(d)));
    child.stderr?.on('data', (d) => err.push(String(d)));
    child.on('error', (e) => { clearTimeout(timer); done({ code: null, timedOut, error: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); done({ code, timedOut }); });
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.input ?? '');
  });

/** Kill a process and its children (Windows needs taskkill for the tree). */
export function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const fallback = () => { if (child.exitCode === null && child.signalCode === null) { try { child.kill(); } catch { /* already gone */ } } };
    // 128 = taskkill found no such process (already gone). Any other failure (access denied, taskkill missing) falls back to
    // killing the direct child, which at least ends the CLI itself.
    const k = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    k.on('error', fallback);
    k.on('close', (code) => { if (code !== 0 && code !== 128) fallback(); });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
}

/**
 * Environment for git children: Windows long paths and the untracked cache for this process only, passed through
 * GIT_CONFIG_COUNT/KEY/VALUE (git 2.31+, ignored by older git) so the user's own config is never edited and argument lists stay unchanged.
 */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const n = Math.max(0, Number.parseInt(base.GIT_CONFIG_COUNT ?? '0', 10) || 0);
  return {
    ...base,
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: 'core.longpaths', [`GIT_CONFIG_VALUE_${n}`]: 'true',
    [`GIT_CONFIG_KEY_${n + 1}`]: 'core.untrackedCache', [`GIT_CONFIG_VALUE_${n + 1}`]: 'true'
  };
}
