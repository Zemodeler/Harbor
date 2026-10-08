import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }

/** Injectable process runner so discovery/adapters can be tested without real CLIs. */
export type Runner = (exe: string, args: string[], opts?: { cwd?: string; timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv }) => Promise<RunResult>;

// Inside double quotes cmd.exe treats & | < > ^ ( ) * literally; only %VAR% expansion, quotes and line breaks are unsafe.
const SAFE_ARG = /^[^"%\r\n\0]+$/;

export function isShellScript(exe: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
}

/** Quote one argument for cmd.exe. Only used for .cmd/.bat shims; prompts go through stdin, never argv. */
export function quoteWinArg(a: string): string {
  if (!SAFE_ARG.test(a)) throw new Error(`Unsafe argument for shell launch: ${JSON.stringify(a)}`);
  return `"${a}"`;
}

/** Spawn a CLI, handling Windows .cmd shims (which Node refuses to spawn without a shell). */
export function spawnCli(exe: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  if (isShellScript(exe)) {
    const line = [exe, ...args].map(quoteWinArg).join(' ');
    return spawn(line, { ...opts, shell: true, windowsHide: true }); // node wraps this in cmd.exe /d /s /c "..."
  }
  return spawn(exe, args, { ...opts, windowsHide: true });
}

export const runProcess: Runner = (exe, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false, settled = false;
    const done = (r: RunResult) => { if (!settled) { settled = true; resolve(r); } };
    let child: ChildProcess;
    try {
      child = spawnCli(exe, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return done({ code: null, stdout, stderr, timedOut, error: String(e) });
    }
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; killTree(child); }, opts.timeoutMs) : undefined;
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (e) => { clearTimeout(timer); done({ code: null, stdout, stderr, timedOut, error: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); done({ code, stdout, stderr, timedOut }); });
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.input ?? '');
  });

/** Kill a process and its children (Windows needs taskkill for the tree). */
export function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
}
