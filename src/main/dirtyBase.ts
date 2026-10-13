/**
 * Uncommitted work in the user's project folder versus an edit helper's file claim. PURE (the orchestrator runs git status).
 *
 * Edit helpers start from the committed HEAD in their own worktree. In a real run the folder held many uncommitted edits, helpers
 * worked on stale code, and a "port the preserved work" cycle followed. When a helper's claim overlaps uncommitted (or untracked)
 * files it is held and the lead decides: commit first, narrow the claim, or run it read-only.
 */

/** The arguments to run in the project folder: v2 lines start with a type letter, so trimmed output still parses. */
export const STATUS_ARGS = ['status', '--porcelain=v2', '--untracked-files=all'];

const unquote = (p: string): string => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1).replace(/\\(.)/g, '$1') : p).replace(/\\/g, '/');

/**
 * Paths from `git status --porcelain=v2`, relative to the repository root, forward slashes: changed tracked files (both sides of a
 * rename) and untracked files. Ignored files are left out.
 */
export function parseStatusV2(stdout: string): { tracked: string[]; untracked: string[] } {
  const tracked = new Set<string>(), untracked = new Set<string>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimStart();
    const f = line.split(' ');
    if (f[0] === '1' && f.length >= 9) tracked.add(unquote(f.slice(8).join(' ')));
    else if (f[0] === '2' && f.length >= 10) for (const p of f.slice(9).join(' ').split('\t')) { if (p) tracked.add(unquote(p)); }
    else if (f[0] === 'u' && f.length >= 11) tracked.add(unquote(f.slice(10).join(' ')));
    else if (f[0] === '?' && line.length > 2) untracked.add(unquote(line.slice(2)));
  }
  return { tracked: [...tracked], untracked: [...untracked] };
}

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();

/** Keeps the paths inside the project's folder of the repository (`prefix`, '' for the root) and makes them project-relative. */
export function underPrefix(paths: readonly string[], prefix: string): string[] {
  const p = norm(prefix);
  if (!p) return [...paths];
  return paths.filter((x) => norm(x).startsWith(`${p}/`)).map((x) => x.replace(/\\/g, '/').slice(p.length + 1));
}

/** Whether a claimed file or directory covers a path (case-insensitive: Windows paths). */
export function claimCovers(claim: string, path: string): boolean {
  const c = norm(claim), p = norm(path);
  return !c || c === '.' || p === c || p.startsWith(`${c}/`);
}

/** Dirty paths a claim overlaps. No claim means the whole project, so every dirty path overlaps. */
export function dirtyOverlap(claims: readonly string[], dirty: readonly string[]): string[] {
  if (!claims.length) return [...dirty];
  return dirty.filter((d) => claims.some((c) => claimCovers(c, d) || claimCovers(d, c)));
}
