import { existsSync, lstatSync, mkdirSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess, type Runner } from './proc';

export interface Worktree { path: string; branch: string; baseCommit: string }

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'task';

/**
 * Git operations Harbor performs. Destructive operations (worktree remove, branch delete) only ever
 * target paths/branches that Harbor itself created (the `harbor/` branch prefix under the Harbor data dir).
 */
export class Git {
  constructor(private run: Runner = runProcess) {}

  private async git(cwd: string, args: string[]) {
    return this.run('git', args, { cwd, timeoutMs: 60000 });
  }

  async isRepoWithCommits(path: string): Promise<boolean> {
    const r = await this.git(path, ['rev-parse', '--verify', 'HEAD']);
    return r.code === 0;
  }

  async head(path: string): Promise<string | undefined> {
    const r = await this.git(path, ['rev-parse', 'HEAD']);
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  /** Create an isolated worktree on a new branch harbor/<slug>, rooted at the repo's current HEAD. */
  async createWorktree(repo: string, worktreesRoot: string, projectKey: string, title: string, uniq: string): Promise<Worktree> {
    const slug = `${slugify(title)}-${uniq.slice(0, 6)}`;
    const branch = `harbor/${slug}`;
    const dir = join(worktreesRoot, projectKey);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, slug);
    const base = await this.head(repo);
    if (!base) throw new Error('Repository has no commits; cannot create a worktree.');
    const r = await this.git(repo, ['worktree', 'add', '-b', branch, path, base]);
    if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return { path, branch, baseCommit: base };
  }

  /** Commit anything left uncommitted inside a Harbor worktree so the work is never lost. */
  async checkpoint(worktree: string, message: string): Promise<{ committed: boolean; head?: string }> {
    const st = await this.git(worktree, ['status', '--porcelain']);
    if (st.code !== 0) return { committed: false };
    if (st.stdout.trim()) {
      await this.git(worktree, ['add', '-A']);
      const c = await this.git(worktree, ['-c', 'user.name=Harbor', '-c', 'user.email=harbor@localhost', 'commit', '-m', message]);
      if (c.code !== 0) return { committed: false, head: await this.head(worktree) };
      return { committed: true, head: await this.head(worktree) };
    }
    return { committed: false, head: await this.head(worktree) };
  }

  /** Short diff summary between a base commit and the worktree HEAD. */
  async diffStat(worktree: string, base: string): Promise<string> {
    const r = await this.git(worktree, ['diff', '--stat', `${base}..HEAD`]);
    return r.code === 0 ? r.stdout.trim() : '';
  }

  async changedFiles(worktree: string, base: string): Promise<string[]> {
    const r = await this.git(worktree, ['diff', '--name-only', `${base}..HEAD`]);
    return r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
  }

  /** Remove a worktree that Harbor created. Refuses anything outside the given Harbor root. */
  async removeWorktree(repo: string, worktreesRoot: string, path: string, branch?: string): Promise<void> {
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    if (!norm(path).startsWith(norm(worktreesRoot) + '/')) throw new Error('Refusing to remove a path outside Harbor worktrees.');
    this.unlinkDependencies(path); // never let git recurse through the node_modules junction into the real folder
    await this.git(repo, ['worktree', 'remove', '--force', path]);
    if (branch?.startsWith('harbor/')) await this.git(repo, ['branch', '-D', branch]);
  }

  /**
   * Give a worktree the main checkout's installed dependencies via a junction, so agents can run tests
   * without reinstalling. Only when node_modules is git-ignored (otherwise a checkpoint commit could
   * sweep it in). Returns true when linked.
   */
  async linkDependencies(repo: string, worktree: string): Promise<boolean> {
    const src = join(repo, 'node_modules'), dst = join(worktree, 'node_modules');
    if (!existsSync(src) || existsSync(dst)) return false;
    const ignored = await this.git(worktree, ['check-ignore', '-q', 'node_modules/']);
    if (ignored.code !== 0) return false;
    try { symlinkSync(src, dst, 'junction'); return true; } catch { return false; }
  }

  private unlinkDependencies(worktree: string): void {
    const dst = join(worktree, 'node_modules');
    try {
      if (!lstatSync(dst).isSymbolicLink()) return;
      try { rmdirSync(dst); } catch { unlinkSync(dst); } // removes the link only, not its target
    } catch { /* not present */ }
  }
}
