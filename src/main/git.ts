import { existsSync, lstatSync, mkdirSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { GitFileChange } from '../shared/api';
import { parseChanges, parseWorktrees } from './gitView';
import { runProcess, type Runner } from './proc';
import { reviewable } from './review';

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

  /** Create an isolated worktree on a new branch harbor/<slug>, rooted at `from` (default: the repo's current HEAD). */
  async createWorktree(repo: string, worktreesRoot: string, projectKey: string, title: string, uniq: string, from?: string): Promise<Worktree> {
    const slug = `${slugify(title)}-${uniq.slice(0, 6)}`;
    const branch = `harbor/${slug}`;
    const dir = join(worktreesRoot, projectKey);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, slug);
    const base = from ?? await this.head(repo);
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

  /** Committed changes between two commits, with credential files marked hidden (as in the Git view). */
  async changes(repo: string, from: string, to: string): Promise<GitFileChange[]> {
    const [ns, num] = await Promise.all([
      this.git(repo, ['diff', '--name-status', '-z', '-M', from, to, '--']),
      this.git(repo, ['diff', '--numstat', '-z', '-M', from, to, '--'])
    ]);
    if (ns.code !== 0) throw new Error(`git diff failed: ${(ns.stderr || ns.stdout).trim().split(/\r?\n/)[0] ?? ''}`);
    const files = parseChanges(ns.stdout, num.code === 0 ? num.stdout : '');
    for (const f of files) if (!reviewable(f.path) || (f.oldPath && !reviewable(f.oldPath))) f.hidden = true;
    return files;
  }

  // ---- integration. Writes only ever happen in a harbor/* worktree, or as a fast-forward of the user's branch.

  /** The branch checked out in `repo`, or undefined on a detached HEAD. */
  async currentBranch(repo: string): Promise<string | undefined> {
    const r = await this.git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  }

  /** Head commit of an existing local branch (refs/heads/<name> only), or undefined. */
  async branchHead(repo: string, name: string): Promise<string | undefined> {
    if (!name || name.startsWith('-')) return undefined;
    const r = await this.git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  }

  async isAncestor(cwd: string, ancestor: string, of: string): Promise<boolean> {
    return (await this.git(cwd, ['merge-base', '--is-ancestor', ancestor, of])).code === 0;
  }

  /** True when tracked files have uncommitted changes (untracked files do not count; git refuses to overwrite them anyway). */
  async isDirty(cwd: string): Promise<boolean> {
    const r = await this.git(cwd, ['status', '--porcelain', '--untracked-files=no']);
    return r.code !== 0 || !!r.stdout.trim();
  }

  /** Worktree path that has `branch` checked out, if any. */
  async worktreeOf(repo: string, branch: string): Promise<string | undefined> {
    const r = await this.git(repo, ['worktree', 'list', '--porcelain']);
    if (r.code !== 0) return undefined;
    return parseWorktrees(r.stdout).find((w) => w.branch === branch)?.path;
  }

  private async onHarborBranch(cwd: string): Promise<boolean> {
    return (await this.currentBranch(cwd))?.startsWith('harbor/') ?? false;
  }

  /** Merge one commit (a SHA, never a branch name, so a moving branch cannot slip in) into a harbor/* worktree. */
  async merge(worktree: string, commit: string): Promise<{ ok: boolean; output: string }> {
    if (!(await this.onHarborBranch(worktree))) throw new Error('Refusing to merge outside a harbor/* branch.');
    const r = await this.git(worktree, ['-c', 'user.name=Harbor', '-c', 'user.email=harbor@localhost', 'merge', '--no-ff', '--no-edit', commit]);
    return { ok: r.code === 0, output: `${r.stdout}\n${r.stderr}`.trim() };
  }

  async unmergedPaths(worktree: string): Promise<string[]> {
    const r = await this.git(worktree, ['diff', '--name-only', '--diff-filter=U']);
    return r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
  }

  /** Abort an in-progress merge, only in a harbor/* worktree. No-op when no merge is in progress. */
  async abortMerge(worktree: string): Promise<void> {
    if (!(await this.onHarborBranch(worktree))) throw new Error('Refusing to abort a merge outside a harbor/* branch.');
    const m = await this.git(worktree, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
    if (m.code === 0) await this.git(worktree, ['merge', '--abort']);
  }

  /**
   * Move `branch` from `expected` to `to` only as a fast-forward. Checked out in `repo`: `merge --ff-only`. Otherwise a
   * compare-and-swap ref update, which fails if the branch moved. Never forces.
   */
  async fastForward(repo: string, branch: string, expected: string, to: string): Promise<void> {
    if (!(await this.isAncestor(repo, expected, to))) throw new Error('Not a fast-forward.');
    if ((await this.currentBranch(repo)) === branch) {
      const r = await this.git(repo, ['merge', '--ff-only', to]);
      if (r.code !== 0) throw new Error(`git merge --ff-only failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? ''}`);
      return;
    }
    const r = await this.git(repo, ['update-ref', `refs/heads/${branch}`, to, expected]);
    if (r.code !== 0) throw new Error(`git update-ref failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? ''}`);
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
