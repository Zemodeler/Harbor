import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { GitFileChange } from '../shared/api';
import { parseChanges, parseWorktrees } from './gitView';
import { gitEnv, runProcess, type RunResult, type Runner } from './proc';
import { CREDENTIAL_PATHSPECS, reviewable } from './review';

export interface Worktree { path: string; branch: string; baseCommit: string }

/** Outcome of one git call that keeps "failed" and "timed out" apart, for callers where a timeout must not look like a result. */
export interface GitResult { ok: boolean; timedOut: boolean; code: number | null; stdout: string; stderr: string; truncated?: boolean }

/** Long operations (worktree add on a big repo, checkpoint of a big tree) get far more than the 60 s default. */
export const LONG_GIT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_GIT_TIMEOUT_MS = 60_000;
/** Largest binary patch kept in memory. */
const MAX_PATCH_CHARS = 16 * 1024 * 1024;

/**
 * Absolute path with symlinks and Windows 8.3 short names (C:\Users\RUNNER~1) expanded, so the same folder compares equal
 * however it was spelled (git reports the long form, os.tmpdir() may report the short one). A path that does not exist yet
 * is canonicalised through its nearest existing parent.
 */
function canonicalPath(p: string): string {
  const abs = resolve(p);
  let head = abs, tail = '';
  for (let i = 0; i < 64; i++) {
    try { return tail ? join(realpathSync.native(head), tail) : realpathSync.native(head); } catch {
      const parent = dirname(head);
      if (parent === head) return abs;
      tail = tail ? join(basename(head), tail) : basename(head);
      head = parent;
    }
  }
  return abs;
}
/** Canonical, slash-normalised, lower-case form for path-prefix guards (Windows paths are case-insensitive). */
const guardPath = (p: string): string => canonicalPath(p).split(String.fromCharCode(92)).join('/').replace(/\/+$/, '').toLowerCase();
/** Whether `path` is strictly inside `root` after resolving both (so `..` segments cannot slip through). */
export const isInside = (path: string, root: string): boolean => guardPath(path).startsWith(guardPath(root) + '/');

/** Why a remote URL is refused, or undefined when it is an https or ssh URL without embedded credentials. */
export function remoteUrlProblem(url: string): string | undefined {
  const u = typeof url === 'string' ? url.trim() : '';
  if (!u || u.length > 500 || /[\s\0]/.test(u)) return 'Enter the repository URL without spaces.';
  if (u.startsWith('-')) return 'A remote URL cannot start with a dash.';
  if (/^https:\/\//i.test(u)) {
    if (/^https:\/\/[^/]*@/i.test(u)) return 'Do not put a user name or password in the URL; git and gh sign in on their own.';
    return /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/\S+$/i.test(u) ? undefined : 'Enter a full https URL such as https://github.com/owner/name.git.';
  }
  if (/^ssh:\/\//i.test(u)) return /^ssh:\/\/(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+(?::\d+)?\/\S+$/i.test(u) ? undefined : 'Enter a full ssh URL such as ssh://git@github.com/owner/name.git.';
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s:]\S*$/.test(u)) return undefined; // scp-like: git@github.com:owner/name.git
  return 'Only https and ssh remotes are supported (not file:, ext:: or local paths).';
}

/** Arguments Harbor never gives git push: anything that rewrites or deletes remote history, or pushes more than one named branch. */
const FORBIDDEN_PUSH_FLAGS = /^(?:--force(?:-with-lease|-if-includes)?(?:=.*)?|-f|--mirror|--delete|-d|--prune|--all|--tags|--follow-tags|--receive-pack.*|--exec.*|\+.*)$/i;

/** The `git push` argv, or an Error when anything here could force, delete or mirror. Pure, so a test can pin it. */
export function pushArgs(remote: string, branch: string, o: { setUpstream?: boolean; extra?: string[] } = {}): string[] {
  if (!remote || remote.startsWith('-') || !branch || branch.startsWith('-') || branch.startsWith('+') || /[:\s]/.test(branch)) throw new Error('Refusing to push: the remote or branch name is not a plain name.');
  for (const a of [remote, branch, ...(o.extra ?? [])]) if (FORBIDDEN_PUSH_FLAGS.test(a)) throw new Error(`Refusing to push with "${a}": Harbor never forces, deletes or mirrors.`);
  // Fully qualified source and destination, so a tag of the same name can never be pushed instead.
  return ['push', ...(o.setUpstream ? ['--set-upstream'] : []), ...(o.extra ?? []), '--', remote, `refs/heads/${branch}:refs/heads/${branch}`];
}

/** A push failure in words the owner can act on. */
export function explainPushFailure(stderr: string): string {
  const t = stderr || '';
  if (/protected branch|GH006|GH013|push declined/i.test(t)) return 'The remote refuses direct pushes to this branch (it is protected). Push a harbor/* branch and open a pull request instead.';
  if (/terminal prompts disabled|could not read (?:username|password)|authentication failed|invalid username or password|permission denied \(publickey\)|\b403\b|access denied/i.test(t)) return 'Not signed in to the remote. Sign in with git (for example `gh auth login`, or push once from a terminal so Git Credential Manager can store the login), then try again.';
  if (/non-fast-forward|fetch first|updates were rejected/i.test(t)) return 'The remote has commits this branch does not. Merge or rebase them into the branch first (Harbor never force-pushes), then push again.';
  if (/no configured push destination|does not appear to be a git repository|no such remote|repository not found|could not resolve host|unable to access/i.test(t)) return 'The remote repository could not be reached. Check that it exists, the URL is right and you are online.';
  return `git push failed: ${t.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ') || 'no details'}`;
}

/** A Harbor worktree as the retention policy sees it. `lastActivity` is epoch ms. */
export interface WorktreeEntry { path: string; branch?: string; lastActivity: number; applied?: boolean; merged?: boolean; active?: boolean }

/**
 * Worktrees that may be garbage collected: only harbor/* branches under Harbor's own root, never one still in use, and
 * only when their work landed (applied or merged) or they have been idle longer than `maxAgeDays`. Pure; the caller removes.
 */
export function staleWorktrees(entries: readonly WorktreeEntry[], root: string, now: number, maxAgeDays = 14): WorktreeEntry[] {
  const maxAge = maxAgeDays * 86_400_000;
  return entries.filter((e) =>
    !e.active && !!e.branch?.startsWith('harbor/') && isInside(e.path, root) &&
    (!!e.applied || !!e.merged || now - e.lastActivity > maxAge));
}

/** Result of a checkpoint. `excluded` lists credential-looking files that were left out of the commit. */
export interface CheckpointResult { committed: boolean; head?: string; excluded?: string[]; timedOut?: boolean; error?: string }

/** Paths from `status --porcelain -z` (a rename carries its old path as an extra token, which is skipped). */
export function statusPaths(out: string): string[] {
  const t = out.split('\0'), paths: string[] = [];
  for (let i = 0; i < t.length; i++) {
    const e = t[i];
    if (!e || e.length < 4) continue;
    paths.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C' || e[1] === 'R' || e[1] === 'C') i++;
  }
  return paths;
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'task';

/** The branch `createWorktree` uses for this title and id, so a retry can find what an earlier attempt created. */
export const harborBranchFor = (title: string, uniq: string): string => `harbor/${slugify(title)}-${uniq.slice(0, 6)}`;

/**
 * Git operations Harbor performs. Destructive operations (worktree remove, branch delete) only ever
 * target paths/branches that Harbor itself created (the `harbor/` branch prefix under the Harbor data dir).
 */
export class Git {
  /**
   * `caseInsensitiveRefs`: on Windows, loose refs live on a case-insensitive file system, so `refs/heads/Main` reaches the
   * file of `main`. Branch names typed by the user are resolved to the ref's real spelling and compared without case there.
   */
  constructor(private run: Runner = runProcess, private caseInsensitiveRefs = process.platform === 'win32') {}

  /** Whether two branch names name the same ref on this platform. */
  sameBranch(a: string | undefined, b: string | undefined): boolean {
    if (a === undefined || b === undefined) return false;
    return this.caseInsensitiveRefs ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  private async git(cwd: string, args: string[], timeoutMs = DEFAULT_GIT_TIMEOUT_MS, maxOutput?: number): Promise<RunResult> {
    return this.run('git', args, { cwd, timeoutMs, env: gitEnv(), ...(maxOutput ? { maxOutput } : {}) });
  }

  /** Like the private runner, but with a result that says whether git timed out. */
  async exec(cwd: string, args: string[], timeoutMs = DEFAULT_GIT_TIMEOUT_MS): Promise<GitResult> {
    const r = await this.git(cwd, args, timeoutMs);
    return { ok: r.code === 0 && !r.timedOut, timedOut: r.timedOut, code: r.code, stdout: r.stdout, stderr: r.stderr, ...(r.truncated ? { truncated: true } : {}) };
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
    // Only what this call creates is cleaned up on failure: a pre-existing path or branch is never touched.
    const pathExisted = existsSync(path), branchExisted = !!(await this.branchHead(repo, branch));
    const r = await this.git(repo, ['worktree', 'add', '-b', branch, path, base], LONG_GIT_TIMEOUT_MS);
    if (r.code !== 0 || r.timedOut) {
      await this.cleanupPartialWorktree(repo, worktreesRoot, path, branch, pathExisted, branchExisted);
      throw new Error(r.timedOut ? 'git worktree add timed out; the partial worktree was cleaned up.' : `git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return { path, branch, baseCommit: base };
  }

  private async cleanupPartialWorktree(repo: string, worktreesRoot: string, path: string, branch: string, pathExisted: boolean, branchExisted: boolean): Promise<void> {
    try {
      if (!pathExisted && isInside(path, worktreesRoot) && existsSync(path)) {
        this.unlinkDependencies(path);
        rmSync(path, { recursive: true, force: true, maxRetries: 3 });
      }
      await this.git(repo, ['worktree', 'prune']);
      if (!branchExisted && branch.startsWith('harbor/') && (await this.branchHead(repo, branch))) await this.git(repo, ['branch', '-D', branch]);
    } catch { /* best effort: the original error is what the caller needs to see */ }
  }

  /** Path of `path` inside its repository root, as a relative folder ('' at the root, or when git cannot say). For a project that is a subfolder of a repo. */
  async showPrefix(path: string): Promise<string> {
    const r = await this.git(path, ['rev-parse', '--show-prefix']);
    return r.code === 0 ? r.stdout.trim().replace(/\/+$/, '') : '';
  }

  /**
   * The worktree of an existing harbor/* branch at its canonical path under Harbor's root: found when already checked out,
   * attached when the directory is gone (a retry, or after garbage collection). Never touches a directory that is not a
   * registered worktree, and never creates or resets a branch. Undefined when it cannot be reused.
   */
  async reuseWorktree(repo: string, worktreesRoot: string, projectKey: string, branch: string): Promise<Worktree | undefined> {
    if (!branch.startsWith('harbor/')) return undefined;
    const head = await this.branchHead(repo, branch);
    if (!head) return undefined;
    const path = join(worktreesRoot, projectKey, branch.slice('harbor/'.length));
    if (!isInside(path, worktreesRoot)) return undefined;
    const base = async (): Promise<string> => {
      const r = await this.git(repo, ['merge-base', 'HEAD', branch]);
      return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : head;
    };
    const where = await this.worktreeOf(repo, branch);
    // Report the spelling this worktree was created with when git names the same folder (long vs 8.3 short name), so the
    // path stored on the agent keeps comparing equal.
    if (where) return isInside(where, worktreesRoot) && existsSync(where) ? { path: guardPath(where) === guardPath(path) ? path : resolve(where), branch, baseCommit: await base() } : undefined;
    await this.git(repo, ['worktree', 'prune']);
    if (existsSync(path)) return undefined; // a directory Harbor does not know as a worktree is not ours to reuse
    mkdirSync(join(worktreesRoot, projectKey), { recursive: true });
    const r = await this.git(repo, ['worktree', 'add', path, branch], LONG_GIT_TIMEOUT_MS);
    if (r.code !== 0 || r.timedOut) { await this.git(repo, ['worktree', 'prune']); return undefined; }
    return { path, branch, baseCommit: await base() };
  }

  /** `git worktree prune`: forgets worktree records whose directory is gone. Never deletes a live checkout. */
  async pruneWorktrees(repo: string): Promise<boolean> {
    return (await this.exec(repo, ['worktree', 'prune'])).ok;
  }

  /**
   * Directories a sandboxed run inside `worktree` must be able to write for `git add/commit` to work: the worktree's own git
   * dir and the common dir (objects, refs). Pass as `RunOptions.writableDirs`. Empty when git cannot say.
   */
  async worktreeWritableDirs(worktree: string): Promise<string[]> {
    const [a, b] = await Promise.all([this.git(worktree, ['rev-parse', '--git-dir']), this.git(worktree, ['rev-parse', '--git-common-dir'])]);
    return [...new Set([a, b].filter((r) => r.code === 0 && r.stdout.trim()).map((r) => resolve(worktree, r.stdout.trim())))];
  }

  /** Commit anything left uncommitted inside a Harbor worktree so the work is never lost. Credential-looking files are left out and listed. */
  async checkpoint(worktree: string, message: string): Promise<CheckpointResult> {
    const st = await this.git(worktree, ['status', '--porcelain', '-z', '--untracked-files=all'], LONG_GIT_TIMEOUT_MS);
    if (st.timedOut) return { committed: false, timedOut: true, error: 'git status timed out' };
    if (st.code !== 0) return { committed: false };
    if (!st.stdout.trim()) return { committed: false, head: await this.head(worktree) };
    const excluded = statusPaths(st.stdout).filter((p) => !reviewable(p));
    const ex = excluded.length ? { excluded } : {};
    const add = await this.git(worktree, ['add', '-A', '--', '.', ...CREDENTIAL_PATHSPECS], LONG_GIT_TIMEOUT_MS);
    if (add.code !== 0 || add.timedOut) {
      return { committed: false, head: await this.head(worktree), ...ex, ...(add.timedOut ? { timedOut: true } : {}), error: add.timedOut ? 'git add timed out' : `git add failed: ${(add.stderr || add.stdout).trim().split(/\r?\n/)[0] ?? ''}` };
    }
    const c = await this.git(worktree, ['-c', 'user.name=Harbor', '-c', 'user.email=harbor@localhost', 'commit', '-m', message], LONG_GIT_TIMEOUT_MS);
    if (c.code !== 0 || c.timedOut) return { committed: false, head: await this.head(worktree), ...ex, ...(c.timedOut ? { timedOut: true, error: 'git commit timed out' } : {}) };
    return { committed: true, head: await this.head(worktree), ...ex };
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

  // ---- integration and rollback. Writes only ever happen in a harbor/* worktree, or as a fast-forward of the user's branch.

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

  /**
   * The real spelling of an existing local branch: an exact match, else (case-insensitive platforms only) the single branch
   * that differs in case alone. Undefined when nothing (or more than one branch) matches.
   */
  async resolveBranch(repo: string, name: string): Promise<string | undefined> {
    if (!name || name.startsWith('-')) return undefined;
    const r = await this.git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
    if (r.code !== 0) return undefined;
    const all = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (all.includes(name)) return name;
    if (!this.caseInsensitiveRefs) return undefined;
    const matches = all.filter((b) => b.toLowerCase() === name.toLowerCase());
    return matches.length === 1 ? matches[0] : undefined;
  }

  async isAncestor(cwd: string, ancestor: string, of: string): Promise<boolean> {
    return (await this.git(cwd, ['merge-base', '--is-ancestor', ancestor, of])).code === 0;
  }

  /** True when tracked files have uncommitted changes (untracked files do not count; git refuses to overwrite them anyway). */
  async isDirty(cwd: string): Promise<boolean> {
    return (await this.isDirtyDetailed(cwd)).dirty;
  }

  /** `dirty` is also true when git failed or timed out (refusing is the safe reading); `timedOut` / `failed` say why. */
  async isDirtyDetailed(cwd: string): Promise<{ dirty: boolean; timedOut: boolean; failed: boolean }> {
    const r = await this.git(cwd, ['status', '--porcelain', '--untracked-files=no']);
    const failed = r.code !== 0 && !r.timedOut;
    return { dirty: r.timedOut || failed || !!r.stdout.trim(), timedOut: r.timedOut, failed };
  }

  /** Worktree path that has `branch` checked out, if any. */
  async worktreeOf(repo: string, branch: string): Promise<string | undefined> {
    const r = await this.git(repo, ['worktree', 'list', '--porcelain']);
    if (r.code !== 0) return undefined;
    return parseWorktrees(r.stdout).find((w) => this.sameBranch(w.branch, branch))?.path;
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

  /** Revert one merge commit (by SHA, mainline = its target-side parent) in a harbor/* worktree, as a new commit. */
  async revertMerge(worktree: string, merge: string): Promise<{ ok: boolean; output: string }> {
    if (!(await this.onHarborBranch(worktree))) throw new Error('Refusing to revert outside a harbor/* branch.');
    const r = await this.git(worktree, ['-c', 'user.name=Harbor', '-c', 'user.email=harbor@localhost', 'revert', '-m', '1', '--no-edit', merge]);
    return { ok: r.code === 0, output: `${r.stdout}\n${r.stderr}`.trim() };
  }

  /** Abort an in-progress revert, only in a harbor/* worktree. No-op when no revert is in progress. */
  async abortRevert(worktree: string): Promise<void> {
    if (!(await this.onHarborBranch(worktree))) throw new Error('Refusing to abort a revert outside a harbor/* branch.');
    const m = await this.git(worktree, ['rev-parse', '--verify', '--quiet', 'REVERT_HEAD']);
    if (m.code === 0) await this.git(worktree, ['revert', '--abort']);
  }

  /**
   * Reset Harbor's own branch, checked out in its own worktree under `worktreesRoot`, to `commit` (a fresh start on a new
   * base). Refuses any other branch or path.
   */
  async resetHarborWorktree(worktreesRoot: string, worktree: string, branch: string, commit: string): Promise<void> {
    if (!isInside(worktree, worktreesRoot)) throw new Error('Refusing to reset a path outside Harbor worktrees.');
    const current = await this.currentBranch(worktree);
    if (!branch.startsWith('harbor/') || current !== branch) throw new Error('Refusing to reset outside the Harbor branch of this worktree.');
    const r = await this.git(worktree, ['reset', '--hard', '--quiet', commit]);
    if (r.code !== 0) throw new Error(`git reset failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? ''}`);
  }

  /**
   * Move `branch` from `expected` to `to` only as a fast-forward. Checked out in `repo`: `merge --ff-only`, after checking
   * HEAD is still `expected`. Otherwise a compare-and-swap ref update, which fails if the branch moved. Never forces.
   * `beforeWrite` runs right before the write and may throw to cancel it.
   */
  async fastForward(repo: string, branch: string, expected: string, to: string, beforeWrite?: () => void): Promise<void> {
    if (!(await this.isAncestor(repo, expected, to))) throw new Error('Not a fast-forward.');
    if (this.sameBranch(await this.currentBranch(repo), branch)) {
      if ((await this.head(repo)) !== expected) throw new Error(`${branch} moved; nothing was changed.`);
      beforeWrite?.();
      const r = await this.git(repo, ['merge', '--ff-only', to]);
      if (r.code !== 0) throw new Error(`git merge --ff-only failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? ''}`);
      return;
    }
    beforeWrite?.();
    const r = await this.git(repo, ['update-ref', `refs/heads/${branch}`, to, expected]);
    if (r.code !== 0) throw new Error(`git update-ref failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? ''}`);
  }

  // ---- rollback records and preview. Read-only except for unreferenced objects (merge-tree, commit-tree): no ref, index or file changes.

  /** Binary diff `base..head`, run in `cwd`, with the given paths excluded (credential files). Undefined when git fails or the patch is over the size cap. */
  async diffBinary(cwd: string, base: string, head: string, exclude: string[] = []): Promise<string | undefined> {
    return (await this.diffBinaryCapped(cwd, base, head, exclude)).patch;
  }

  /**
   * Same diff with a size bound: past `maxChars` the patch is dropped (never held in memory beyond the cap) and only the file
   * list is returned, so callers can record what changed without a replayable patch.
   */
  async diffBinaryCapped(cwd: string, base: string, head: string, exclude: string[] = [], maxChars = MAX_PATCH_CHARS): Promise<{ patch?: string; truncated: boolean; files: string[]; failed?: boolean }> {
    const spec = [':(top)', ...exclude.map((p) => `:(top,exclude,literal)${p}`)];
    const r = await this.git(cwd, ['diff', '--binary', '--no-ext-diff', '--no-textconv', base, head, '--', ...spec], LONG_GIT_TIMEOUT_MS, maxChars);
    if (r.code !== 0 || r.timedOut) return { truncated: false, files: [], failed: true };
    if (!r.truncated) return { patch: r.stdout, truncated: false, files: [] };
    const names = await this.git(cwd, ['diff', '--name-only', '-z', base, head, '--', ...spec], LONG_GIT_TIMEOUT_MS, 4 * 1024 * 1024);
    return { truncated: true, files: names.code === 0 ? names.stdout.split('\0').filter(Boolean) : [] };
  }

  /**
   * The text diff the secret scan reads (secretScan.scanDiff): `from..to`, or from their merge-base with `mergeBase`, no context,
   * renames as renames, binary files as one line, credential files INCLUDED (they are exactly what the scan looks for). Bounded:
   * past `maxChars` the scan is told it saw only part of the change.
   */
  async diffForScan(cwd: string, from: string, to: string, o: { mergeBase?: boolean; maxChars?: number } = {}): Promise<{ diff: string; truncated: boolean; failed: boolean }> {
    const range = o.mergeBase ? [`${from}...${to}`] : [from, to];
    const r = await this.git(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', '-M', '--diff-filter=ACMR', ...range, '--'], LONG_GIT_TIMEOUT_MS, o.maxChars ?? MAX_PATCH_CHARS);
    if (r.code !== 0 && !r.truncated) return { diff: '', truncated: false, failed: true };
    return { diff: r.stdout, truncated: !!r.truncated, failed: !!r.timedOut };
  }

  /** Merge commits reachable from `head` but not from any of `exclude`, newest first (topological), with their parents. */
  async mergeCommits(repo: string, head: string, exclude: string[]): Promise<Array<{ commit: string; parents: string[] }>> {
    const r = await this.git(repo, ['rev-list', '--merges', '--parents', '--topo-order', head, ...exclude.map((x) => `^${x}`)]);
    if (r.code !== 0) return [];
    return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => { const [commit, ...parents] = l.trim().split(/\s+/); return { commit: commit!, parents }; });
  }

  async parents(repo: string, commit: string): Promise<string[]> {
    const r = await this.git(repo, ['rev-list', '--parents', '-n', '1', commit]);
    return r.code === 0 ? r.stdout.trim().split(/\s+/).slice(1) : [];
  }

  /**
   * In-memory three-way merge (`git merge-tree --write-tree`): writes only objects, never a ref or the working tree.
   * `unsupported` covers git versions without --write-tree/--merge-base and any other failure.
   */
  async mergeTree(repo: string, base: string, ours: string, theirs: string): Promise<{ status: 'clean'; tree: string } | { status: 'conflict'; paths: string[] } | { status: 'unsupported'; message: string }> {
    const r = await this.git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', `--merge-base=${base}`, ours, theirs]);
    const [tree, ...rest] = r.stdout.split('\0');
    if (r.code === 0 && tree?.trim()) return { status: 'clean', tree: tree.trim() };
    if (r.code === 1) return { status: 'conflict', paths: [...new Set(rest.filter(Boolean))] };
    return { status: 'unsupported', message: (r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? `exit ${r.code}` };
  }

  /** An unreferenced commit object for `tree` on top of `parent` (used to chain simulated reverts). */
  async commitTree(repo: string, tree: string, parent: string, message: string): Promise<string | undefined> {
    const r = await this.git(repo, ['-c', 'user.name=Harbor', '-c', 'user.email=harbor@localhost', 'commit-tree', tree, '-p', parent, '-m', message]);
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  }

  /** Non-merge commits reachable from `head` and not from `exclude` that touch any of `paths`, newest first. */
  async commitsTouching(repo: string, head: string, exclude: string[], paths: string[], limit = 50): Promise<Array<{ hash: string; subject: string; files: string[] }>> {
    if (!paths.length) return [];
    const r = await this.git(repo, ['-c', 'core.quotepath=off', 'log', '--no-merges', '--format=%x1e%H%x1f%s', '--name-only', '-n', String(limit), head, ...exclude.map((x) => `^${x}`), '--', ...paths.map((p) => `:(top,literal)${p}`)]);
    if (r.code !== 0) return [];
    return r.stdout.split('\x1e').filter((b) => b.trim()).map((b) => {
      const [first, ...files] = b.split(/\r?\n/);
      const [hash, subject] = (first ?? '').split('\x1f');
      return { hash: (hash ?? '').trim(), subject: subject ?? '', files: files.map((f) => f.trim()).filter(Boolean) };
    }).filter((c) => c.hash);
  }

  /** Local branches under `prefix` (e.g. `harbor/`) that contain `commit`. */
  async branchesContaining(repo: string, commit: string, prefix = ''): Promise<string[]> {
    const r = await this.git(repo, ['for-each-ref', '--contains', commit, '--format=%(refname:short)', `refs/heads/${prefix}`]);
    return r.code === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  }

  // ---- project lifecycle and publish (0.1.47)

  /** `git init -b <branch>` in an existing folder. */
  async init(path: string, defaultBranch = 'main'): Promise<void> {
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(defaultBranch) || defaultBranch.startsWith('-')) throw new Error('Not a usable branch name.');
    const r = await this.git(path, ['init', '-b', defaultBranch]);
    if (r.code !== 0) throw new Error(`git init failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? ''}`);
  }

  /**
   * Stage everything and make the first commit with the owner's git identity; when none is configured a neutral Harbor one is
   * used and `fallbackIdentity` says so (the caller turns that into a warning).
   */
  async initialCommit(path: string, message: string): Promise<{ ok: boolean; head?: string; fallbackIdentity: boolean; error?: string }> {
    const [name, email] = await Promise.all([this.git(path, ['config', 'user.name']), this.git(path, ['config', 'user.email'])]);
    const fallbackIdentity = !name.stdout.trim() || !email.stdout.trim();
    const add = await this.git(path, ['add', '-A'], LONG_GIT_TIMEOUT_MS);
    if (add.code !== 0) return { ok: false, fallbackIdentity, error: `git add failed: ${(add.stderr || add.stdout).trim().split(/\r?\n/)[0] ?? ''}` };
    const ident = fallbackIdentity ? ['-c', 'user.name=Harbor', '-c', 'user.email=harbor@localhost'] : [];
    const c = await this.git(path, [...ident, 'commit', '-m', message], LONG_GIT_TIMEOUT_MS);
    if (c.code !== 0) return { ok: false, fallbackIdentity, error: `git commit failed: ${(c.stderr || c.stdout).trim().split(/\r?\n/)[0] ?? ''}` };
    return { ok: true, head: await this.head(path), fallbackIdentity };
  }

  /** URL of a remote, or undefined when there is none. */
  async remoteUrl(repo: string, name = 'origin'): Promise<string | undefined> {
    if (!name || name.startsWith('-')) return undefined;
    const r = await this.git(repo, ['remote', 'get-url', name]);
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  }

  /** Add `origin`, or with `replace` change it. The URL is validated and passed as its own argument after `--`. */
  async setRemote(repo: string, url: string, o: { replace?: boolean } = {}): Promise<void> {
    const problem = remoteUrlProblem(url);
    if (problem) throw new Error(problem);
    const had = await this.remoteUrl(repo);
    if (had && !o.replace) throw new Error('This project already has a remote (origin). Replace it only on purpose.');
    const r = await this.git(repo, had ? ['remote', 'set-url', '--', 'origin', url.trim()] : ['remote', 'add', '--', 'origin', url.trim()]);
    if (r.code !== 0) throw new Error(`git remote failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? ''}`);
  }

  /** The repository's default branch: origin/HEAD, else main or master when one exists, else the current branch. */
  async defaultBranch(repo: string): Promise<string | undefined> {
    const o = await this.git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (o.code === 0 && o.stdout.trim().startsWith('origin/')) return o.stdout.trim().slice('origin/'.length);
    for (const b of ['main', 'master']) if (await this.branchHead(repo, b)) return b;
    return this.currentBranch(repo);
  }

  /** Commits of `branch` its upstream lacks (ahead) and the reverse (behind). Without an upstream: ahead = commits on no remote branch at all. */
  async aheadBehind(repo: string, branch: string): Promise<{ upstream?: string; ahead: number; behind: number }> {
    const u = await this.git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`]);
    const upstream = u.code === 0 ? u.stdout.trim() || undefined : undefined;
    if (upstream) {
      const r = await this.git(repo, ['rev-list', '--left-right', '--count', `refs/heads/${branch}...${upstream}`]);
      const [a, b] = r.code === 0 ? r.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      return { upstream, ahead: a || 0, behind: b || 0 };
    }
    return { ahead: (await this.unpushedCommits(repo, branch)).length, behind: 0 };
  }

  /** Commits on `branch` that no remote-tracking branch has (newest first): what would exist nowhere else. */
  async unpushedCommits(repo: string, branch: string, limit = 200): Promise<{ hash: string; subject: string }[]> {
    const r = await this.git(repo, ['log', '--format=%H%x1f%s', '-n', String(limit), `refs/heads/${branch}`, '--not', '--remotes']);
    return this.parseCommitList(r);
  }

  /** The commits a push of `branch` would send, oldest first: those its upstream lacks, or all that no remote has. */
  async commitsToPush(repo: string, branch: string, upstream?: string): Promise<{ hash: string; subject: string }[]> {
    const r = await this.git(repo, ['log', '--reverse', '--format=%H%x1f%s', '-n', '200', `refs/heads/${branch}`, '--not', ...(upstream ? [upstream] : ['--remotes'])]);
    return this.parseCommitList(r);
  }

  private parseCommitList(r: RunResult): { hash: string; subject: string }[] {
    if (r.code !== 0) return [];
    return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => { const [hash, subject] = l.split('\x1f'); return { hash: hash ?? '', subject: subject ?? '' }; });
  }

  /**
   * Plain `git push` of one local branch. Never `--force`, `--force-with-lease`, `--mirror` or `--delete` (pushArgs refuses them)
   * and never any other ref. A failure is mapped to a cause the owner can act on.
   */
  async push(repo: string, remote: string, branch: string, o: { setUpstream?: boolean } = {}): Promise<{ ok: boolean; output: string }> {
    const r = await this.git(repo, pushArgs(remote, branch, o), LONG_GIT_TIMEOUT_MS);
    if (r.timedOut) return { ok: false, output: 'git push timed out. Check the connection and try again.' };
    const out = `${r.stdout}\n${r.stderr}`.trim();
    return r.code === 0 ? { ok: true, output: out } : { ok: false, output: explainPushFailure(out) };
  }

  /**
   * Delete a local harbor/* branch. Refuses every other name and a branch checked out in a worktree. `-d` (merged only) unless
   * `force`, which the caller sets only after the preview showed unmerged commits and the owner confirmed.
   */
  async deleteBranch(repo: string, name: string, o: { force?: boolean } = {}): Promise<boolean> {
    if (!name.startsWith('harbor/') || /[\s:~^?*[\\]/.test(name) || name.includes('..')) throw new Error('Refusing to delete a branch that is not a harbor/* branch.');
    if (!(await this.branchHead(repo, name))) return false;
    if (await this.worktreeOf(repo, name)) throw new Error(`Refusing to delete ${name}: it is checked out in a worktree.`);
    return (await this.git(repo, ['branch', o.force ? '-D' : '-d', '--', name])).code === 0;
  }

  /** Local harbor/* branches, whether each is merged into the default branch, and how many commits exist on no remote. */
  async harborBranches(repo: string): Promise<{ name: string; merged: boolean; unpushed: number }[]> {
    const r = await this.git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/harbor/']);
    if (r.code !== 0) return [];
    const base = await this.defaultBranch(repo);
    const out: { name: string; merged: boolean; unpushed: number }[] = [];
    for (const name of r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      out.push({ name, merged: base ? await this.isAncestor(repo, `refs/heads/${name}`, `refs/heads/${base}`) : false, unpushed: (await this.unpushedCommits(repo, name)).length });
    }
    return out;
  }

  /** Commits on `branch` that `base` lacks (what a worktree's work would lose if discarded). */
  async commitsNotIn(repo: string, branch: string, base: string): Promise<number> {
    const r = await this.git(repo, ['rev-list', '--count', `refs/heads/${branch}`, '--not', `refs/heads/${base}`]);
    return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
  }

  async hasRemotes(repo: string): Promise<boolean> {
    const r = await this.git(repo, ['remote']);
    return r.code === 0 && !!r.stdout.trim();
  }

  /** Changed or untracked paths exist (a clean folder has none). A git failure counts as dirty. */
  async hasLocalChanges(cwd: string): Promise<boolean> {
    const r = await this.git(cwd, ['status', '--porcelain']);
    return r.code !== 0 || !!r.stdout.trim();
  }

  /** Registered worktrees of the repository (path and branch), the main checkout first. */
  async listWorktrees(repo: string): Promise<{ path: string; branch?: string; prunable?: boolean }[]> {
    const r = await this.git(repo, ['worktree', 'list', '--porcelain']);
    return r.code === 0 ? parseWorktrees(r.stdout).map((w) => ({ path: w.path, ...(w.branch ? { branch: w.branch } : {}), ...(w.prunable ? { prunable: true } : {}) })) : [];
  }

  /** Remove a worktree that Harbor created. Refuses anything outside the given Harbor root. */
  async removeWorktree(repo: string, worktreesRoot: string, path: string, branch?: string): Promise<void> {
    if (!isInside(path, worktreesRoot)) throw new Error('Refusing to remove a path outside Harbor worktrees.');
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
