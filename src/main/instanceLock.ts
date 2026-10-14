import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One Harbor per data folder. Electron's single-instance lock only sees other Electron instances; the headless service and
 * the desktop app would otherwise both write state.json and run agents on the same worktrees.
 */
export type InstanceKind = 'desktop' | 'headless';
export type LockResult = { ok: true; release(): void } | { ok: false; refusal: string };

const defaultAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Locks this process holds: a second start in the same process (same pid in the file) is refused too. */
const held = new Map<string, number>();

export function acquireInstanceLock(dataDir: string, kind: InstanceKind, isAlive: (pid: number) => boolean = defaultAlive, pid = process.pid): LockResult {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'harbor.lock');
  if (held.get(file) === pid) return { ok: false, refusal: `This process is already using ${dataDir}.` };
  const mine = JSON.stringify({ pid, kind, started: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, mine, { flag: 'wx' });
      held.set(file, pid);
      return { ok: true, release: () => { if (held.get(file) === pid) held.delete(file); try { if ((JSON.parse(readFileSync(file, 'utf8')) as { pid?: number }).pid === pid) rmSync(file, { force: true }); } catch { /* gone */ } } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let other: { pid?: unknown; kind?: unknown } = {};
    try { other = JSON.parse(readFileSync(file, 'utf8')) as typeof other; } catch { /* unreadable: treat as stale */ }
    if (typeof other.pid === 'number' && other.pid !== pid && isAlive(other.pid)) {
      const what = other.kind === 'headless' ? 'The headless Harbor service' : 'The Harbor app';
      return { ok: false, refusal: `${what} (process ${other.pid}) is already using ${dataDir}. Stop it first. If no Harbor is running, delete ${file}.` };
    }
    rmSync(file, { force: true }); // stale: its process is gone
  }
  return { ok: false, refusal: `Could not take the instance lock in ${dataDir}.` };
}
