import type { GitCommit } from '../shared/api';

/**
 * One row of the commit graph. `before`/`after` hold, per lane, the commit hash that lane is waiting
 * for above and below this row (null = free lane). Lanes are never compacted, so a lane keeps its
 * column (and colour) for as long as its branch line runs.
 */
export interface GraphRow { lane: number; before: (string | null)[]; after: (string | null)[]; parentLanes: number[] }

/** Lays out commits given newest first in topological order (as `getGitLog` returns them). */
export function layoutGraph(commits: GitCommit[]): { rows: GraphRow[]; width: number } {
  let lanes: (string | null)[] = [];
  let width = 1;
  const free = (list: (string | null)[], skip = -1) => { const i = list.findIndex((h, j) => h === null && j !== skip); return i < 0 ? list.length : i; };
  const rows = commits.map(c => {
    const before = [...lanes];
    let lane = lanes.indexOf(c.hash);
    if (lane < 0) lane = free(lanes);   // a branch tip: no line comes in from above
    const after = lanes.map(h => h === c.hash ? null : h);
    while (after.length <= lane) after.push(null);
    const parentLanes = c.parents.map((p, i) => {
      const existing = after.indexOf(p);
      if (existing >= 0) return existing;   // another line already leads to this parent: join it
      const slot = i === 0 ? lane : free(after, lane);
      after[slot] = p;
      return slot;
    });
    while (after.length && after[after.length - 1] === null) after.pop();
    width = Math.max(width, before.length, after.length, lane + 1);
    lanes = after;
    return { lane, before, after, parentLanes };
  });
  return { rows, width };
}
