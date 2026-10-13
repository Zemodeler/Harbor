import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Git } from './git';

/**
 * The loop guard's view of an edit helper's progress: a fingerprint of its worktree. It changes when a commit lands, a file is
 * added/removed, or a tracked file's content changes (`git diff HEAD`, so an edit in place that keeps `--shortstat` equal still counts).
 * Untracked files are fingerprinted by name, size and mtime only: their CONTENT is never read (it could be a .env or other secret).
 * READ-ONLY git only (rev-parse, status, diff) with --no-optional-locks so it never takes the index lock the helper's own git
 * commands need. Any failure returns undefined: no information, never a loop verdict.
 */
export type ProgressProbe = (cwd: string) => Promise<string | undefined>;

/** Probe at most this often while a helper runs. */
export const PROBE_INTERVAL_MS = 2 * 60_000;
/** Untracked files looked at (stat only) at most. */
const MAX_UNTRACKED = 200;
const PROBE_GIT_TIMEOUT_MS = 20_000;

export function gitProgressProbe(git: Pick<Git, 'exec'>): ProgressProbe {
  return async (cwd) => {
    try {
      const ro = (args: string[]) => git.exec(cwd, ['--no-optional-locks', ...args], PROBE_GIT_TIMEOUT_MS);
      const [head, status, diff] = await Promise.all([ro(['rev-parse', 'HEAD']), ro(['status', '--porcelain', '-z']), ro(['diff', 'HEAD', '--no-ext-diff', '--no-color'])]);
      if (!head.ok || !status.ok || !diff.ok || diff.truncated) return undefined;
      const h = createHash('sha256').update(head.stdout).update('\0').update(status.stdout).update('\0').update(diff.stdout);
      // Untracked files are not in the diff: their names, sizes and modification times are part of the fingerprint (bounded; never their content).
      const untracked = status.stdout.split('\0').filter((e) => e.startsWith('?? ')).map((e) => e.slice(3)).slice(0, MAX_UNTRACKED);
      for (const f of untracked) {
        const p = join(cwd, f);
        const s = await stat(p).catch(() => undefined);
        if (!s?.isFile()) continue;
        h.update(`\0${f}:${s.size}:${Math.round(s.mtimeMs)}`);
      }
      return h.digest('hex');
    } catch { return undefined; }
  };
}
