import type { Id } from '../shared/api';
import type { FileLock } from './types';
import { normPath } from './store';

export const WHOLE_PROJECT = '*';

export interface LockConflict { file: string; holder: Id }
export interface AcquireResult { ok: boolean; conflicts: LockConflict[] }

/**
 * Whole-file write ownership per project (docs/agent-collaboration.md). A lock on '*' means the holder
 * edits the shared checkout directly, which excludes every other writer. Locks are only released by an
 * explicit call after the owner's process has stopped; nothing is granted by timeout.
 */
export class LockTable {
  constructor(private get: () => FileLock[], private set: (l: FileLock[]) => void) {}

  private holders(projectId: Id): FileLock[] { return this.get().filter((l) => l.projectId === projectId); }

  check(projectId: Id, agentId: Id, files: string[]): LockConflict[] {
    const wanted = files.map(normFile);
    const out: LockConflict[] = [];
    for (const l of this.holders(projectId)) {
      if (l.agentId === agentId) continue;
      for (const f of wanted) {
        if (l.file === WHOLE_PROJECT || f === WHOLE_PROJECT || pathsOverlap(l.file, f)) out.push({ file: f === WHOLE_PROJECT ? l.file : f, holder: l.agentId });
      }
    }
    return dedupe(out);
  }

  /** All-or-nothing acquire. Files already held by the same agent are fine. */
  acquire(projectId: Id, agentId: Id, files: string[]): AcquireResult {
    const conflicts = this.check(projectId, agentId, files);
    if (conflicts.length) return { ok: false, conflicts };
    const have = new Set(this.holders(projectId).filter((l) => l.agentId === agentId).map((l) => l.file));
    const add = files.map(normFile).filter((f) => !have.has(f)).map((file) => ({ projectId, file, agentId, since: Date.now() }));
    this.set([...this.get(), ...add]);
    return { ok: true, conflicts: [] };
  }

  release(agentId: Id): FileLock[] {
    const released = this.get().filter((l) => l.agentId === agentId);
    if (released.length) this.set(this.get().filter((l) => l.agentId !== agentId));
    return released;
  }

  /** Hand every lock from one agent to another (acknowledged handoff). The caller verifies the old owner stopped. */
  transfer(projectId: Id, from: Id, to: Id, file: string): boolean {
    const f = normFile(file);
    const l = this.get().find((x) => x.projectId === projectId && x.agentId === from && x.file === f);
    if (!l) return false;
    l.agentId = to; l.since = Date.now();
    this.set([...this.get()]);
    return true;
  }

  heldBy(agentId: Id): string[] { return this.get().filter((l) => l.agentId === agentId).map((l) => l.file); }
  list(projectId: Id): FileLock[] { return this.holders(projectId); }
}

export const normFile = (f: string): string => {
  if (f === WHOLE_PROJECT) return f;
  const n = normPath(f).replace(/^\.\//, '').replace(/\/+$/, '');
  return n === '.' || n === '' ? WHOLE_PROJECT : n;
};

/** Claims overlap when equal or one is a directory prefix of the other (`src` covers `src/a.ts`), same rule as the outside-claim check. */
export function pathsOverlap(a: string, b: string): boolean {
  const x = normFile(a), y = normFile(b);
  if (x === WHOLE_PROJECT || y === WHOLE_PROJECT || x === y) return true;
  return y.startsWith(x + '/') || x.startsWith(y + '/');
}

/**
 * Whether a helper must take file locks at all. A helper that edits inside its own git worktree cannot collide with anyone
 * before integration, so it needs neither a whole-project lock nor file locks; only writers in the shared checkout do.
 */
export function needsLock(h: { worktree?: string; canEdit: boolean }): boolean {
  return h.canEdit && !h.worktree;
}

function dedupe(c: LockConflict[]): LockConflict[] {
  const seen = new Set<string>();
  return c.filter((x) => { const k = `${x.file}|${x.holder}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
