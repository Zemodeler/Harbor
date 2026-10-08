import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { killTree } from './proc';
import type { CheckRun } from './types';

/** Runs one check command in a directory. Injected so tests never spawn real builds. */
export type CheckRunner = (cmd: string, cwd: string, signal?: AbortSignal) => Promise<Omit<CheckRun, 'cmd'>>;

export const CHECKS_FILE = join('.harbor', 'checks.json');
const TIMEOUT_MS = 15 * 60_000;
const OUTPUT_TAIL = 4000;

/**
 * The checks Harbor runs after an edit helper, from `.harbor/checks.json` ({"checks": ["npm test", ...]}).
 * Read from the main checkout, never the helper's worktree: a helper must not be able to weaken its own checks.
 */
export function loadChecks(projectPath: string): string[] {
  const file = join(projectPath, CHECKS_FILE);
  if (!existsSync(file)) return [];
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { checks?: unknown };
    return Array.isArray(j.checks) ? j.checks.filter((c): c is string => typeof c === 'string' && !!c.trim()).slice(0, 10) : [];
  } catch { return []; }
}

/** Commands come from the project's own config file, so they run through the shell like a developer would type them. */
export const runShellCheck: CheckRunner = (cmd, cwd, signal) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    let output = '', timedOut = false, settled = false;
    const child = spawn(cmd, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (d: Buffer) => { output = (output + d.toString()).slice(-OUTPUT_TAIL); };
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ ok: exitCode === 0 && !timedOut, exitCode, timedOut: timedOut || undefined, durationMs: Date.now() - t0, output: output.trim() });
    };
    const onAbort = () => killTree(child);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort);
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (e) => { output += `\n${e.message}`; finish(null); });
    child.on('close', (code) => finish(code));
  });
