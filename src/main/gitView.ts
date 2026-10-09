import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { AgentState, GitBranch, GitCommit, GitFileChange, GitOverview, GitTarget, GitWorktree, Id } from '../shared/api';
import { runProcess, type Runner } from './proc';
import { reviewable } from './review';
import { normPath } from './store';

/**
 * Read-only Git queries behind the renderer's Git view. Nothing here writes to the repository.
 * Branch names and commits coming from the renderer are only used after they were matched against
 * what git itself reports, so they can never be read as options or arbitrary revisions.
 */

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const PREVIEW_LIMIT = 200000;
const MAX_CHANGES = 2000;

export interface BranchOwner { id: Id; title: string; state: AgentState; branch?: string; created: number }

// ---- pure parsers (tested without git) ----

/** `for-each-ref refs/heads --format=%(refname)%1f%(objectname)%1f%(HEAD)%1f%(upstream:short)%1f%(committerdate:unix)%1f%(contents:subject)` */
export function parseBranches(out: string): GitBranch[] {
  return out.split(/\r?\n/).filter(Boolean).map(line => {
    const [ref = '', head = '', mark = '', upstream = '', time = '0', ...subject] = line.split('\x1f');
    const b: GitBranch = { name: ref.replace(/^refs\/heads\//, ''), head, subject: subject.join('\x1f'), updated: Number(time) * 1000 };
    if (mark === '*') b.current = true;
    if (upstream) b.upstream = upstream;
    return b;
  });
}

/** `worktree list --porcelain`: blocks separated by blank lines; the first block is the main worktree. */
export function parseWorktrees(out: string): Array<{ path: string; head: string; branch?: string; prunable?: boolean }> {
  return out.split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/)).filter(lines => lines[0]?.startsWith('worktree ')).map(lines => {
    const w: { path: string; head: string; branch?: string; prunable?: boolean } = { path: lines[0]!.slice(9), head: '' };
    for (const l of lines.slice(1)) {
      if (l.startsWith('HEAD ')) w.head = l.slice(5);
      else if (l.startsWith('branch ')) w.branch = l.slice(7).replace(/^refs\/heads\//, '');
      else if (l.startsWith('prunable')) w.prunable = true;
    }
    return w;
  });
}

/** `log --format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1e` */
export function parseLog(out: string): GitCommit[] {
  return out.split('\x1e').map(r => r.replace(/^\r?\n/, '')).filter(Boolean).map(r => {
    const [hash = '', parents = '', author = '', time = '0', refs = '', ...subject] = r.split('\x1f');
    return { hash, parents: parents.split(' ').filter(Boolean), author, time: Number(time) * 1000, refs: refs.split(', ').filter(Boolean), subject: subject.join('\x1f').trimEnd() };
  });
}

const STATUS: Record<string, GitFileChange['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'modified' };

/** Combines `diff --name-status -z -M` and `diff --numstat -z -M` output. Binary files have no line counts. */
export function parseChanges(nameStatus: string, numstat: string): GitFileChange[] {
  const files: GitFileChange[] = [];
  const ns = nameStatus.split('\0');
  for (let i = 0; i < ns.length; i++) {
    const code = ns[i];
    if (!code) continue;
    const letter = code[0]!;
    if (letter === 'R' || letter === 'C') {
      const oldPath = ns[++i] ?? '', path = ns[++i] ?? '';
      files.push(letter === 'R' ? { path, oldPath, status: 'renamed' } : { path, status: 'added' });
    } else files.push({ path: ns[++i] ?? '', status: STATUS[letter] ?? 'other' });
  }
  const byPath = new Map(files.map(f => [f.path, f]));
  const num = numstat.split('\0');
  for (let i = 0; i < num.length; i++) {
    const token = num[i];
    if (!token) continue;
    const [add = '-', del = '-', inline = ''] = token.split('\t');
    let path = inline;
    if (!path) { i++; path = num[++i] ?? ''; }   // rename: "a\td\t" \0 old \0 new
    const f = byPath.get(path);
    if (f && add !== '-') { f.additions = Number(add); f.deletions = Number(del); }
  }
  return files.filter(f => f.path);
}

// ---- queries ----

interface Scope { cwd: string; from: string; to?: string; untracked: boolean }

export class GitView {
  private constructor(private top: string, private run: Runner) {}

  /** Opens the repository that contains `path`, or returns undefined when it is not inside one. */
  static async open(path: string, run: Runner = runProcess): Promise<GitView | undefined> {
    const r = await run('git', ['rev-parse', '--show-toplevel'], { cwd: path, timeoutMs: 15000 });
    return r.code === 0 && r.stdout.trim() ? new GitView(r.stdout.trim(), run) : undefined;
  }

  private git(args: string[], cwd = this.top) { return this.run('git', args, { cwd, timeoutMs: 15000 }); }
  private async out(args: string[], cwd = this.top): Promise<string> {
    const r = await this.git(args, cwd);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? ''}`);
    return r.stdout;
  }

  async branches(): Promise<GitBranch[]> {
    return parseBranches(await this.out(['for-each-ref', 'refs/heads', '--format=%(refname)%1f%(objectname)%1f%(HEAD)%1f%(upstream:short)%1f%(committerdate:unix)%1f%(contents:subject)']));
  }

  /** The branch helpers branch from and merge into: main, else master, else the remote's default. */
  baseOf(branches: GitBranch[], remoteDefault?: string): string | undefined {
    const names = new Set(branches.map(b => b.name));
    return ['main', 'master', remoteDefault].find((n): n is string => !!n && names.has(n));
  }

  private async remoteDefault(): Promise<string | undefined> {
    const r = await this.git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    return r.code === 0 ? r.stdout.trim().replace(/^origin\//, '') : undefined;
  }

  async worktrees(): Promise<GitWorktree[]> {
    const list = parseWorktrees(await this.out(['worktree', 'list', '--porcelain']));
    return Promise.all(list.map(async (w, i) => {
      const st = w.prunable ? undefined : await this.git(['status', '--porcelain'], w.path);
      const out: GitWorktree = { path: w.path, head: w.head, changed: st?.code === 0 ? st.stdout.split(/\r?\n/).filter(Boolean).length : 0 };
      if (w.branch) out.branch = w.branch;
      if (i === 0) out.main = true;
      return out;
    }));
  }

  async overview(projectId: Id, owners: BranchOwner[]): Promise<GitOverview> {
    const [branches, worktrees, remoteDefault] = await Promise.all([this.branches(), this.worktrees(), this.remoteDefault()]);
    const base = this.baseOf(branches, remoteDefault), notes: string[] = [];
    if (!branches.length) notes.push('This repository has no commits yet.');
    else if (!base) notes.push('No main or master branch found, so ahead/behind counts are not shown.');
    await Promise.all(branches.map(async b => {
      const wt = worktrees.find(w => w.branch === b.name);
      if (wt) b.worktree = wt.path;
      const owner = owners.filter(o => o.branch === b.name).sort((x, y) => y.created - x.created)[0];
      if (owner) Object.assign(b, { agentId: owner.id, agentTitle: owner.title, agentState: owner.state });
      if (!base || b.name === base) return;
      const r = await this.git(['rev-list', '--left-right', '--count', `refs/heads/${base}...refs/heads/${b.name}`]);
      const [behind, ahead] = r.stdout.trim().split(/\s+/).map(Number);
      if (r.code === 0 && Number.isFinite(behind) && Number.isFinite(ahead)) Object.assign(b, { behind, ahead });
    }));
    const rank = (b: GitBranch) => b.name === base ? 0 : b.current ? 1 : 2;
    branches.sort((x, y) => rank(x) - rank(y) || y.updated - x.updated);
    const current = branches.find(b => b.current)?.name;
    return { projectId, ...(base ? { base } : {}), ...(current ? { current } : {}), branches, worktrees, notes };
  }

  async log(opts: { branch?: string; limit?: number } = {}): Promise<GitCommit[]> {
    const limit = Math.min(2000, Math.max(1, Math.floor(opts.limit ?? 300)));
    const revs = opts.branch ? [`refs/heads/${await this.knownBranch(opts.branch)}`] : ['--branches', 'HEAD'];
    const r = await this.git(['log', '--topo-order', `--max-count=${limit}`, '--format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1e', ...revs, '--']);
    return r.code === 0 ? parseLog(r.stdout) : [];   // no commits yet
  }

  async changes(target: GitTarget = {}): Promise<GitFileChange[]> {
    const s = await this.scope(target);
    const range = [s.from, ...(s.to ? [s.to] : [])];
    const [ns, num] = await Promise.all([
      this.out(['diff', '--name-status', '-z', '-M', ...range, '--'], s.cwd),
      this.out(['diff', '--numstat', '-z', '-M', ...range, '--'], s.cwd)
    ]);
    const files = parseChanges(ns, num);
    if (s.untracked) {
      const known = new Set(files.map(f => f.path));
      for (const path of (await this.out(['ls-files', '--others', '--exclude-standard', '-z'], s.cwd)).split('\0')) {
        if (path && !known.has(path)) files.push({ path, status: 'untracked' });
      }
    }
    for (const f of files) if (!reviewable(f.path) || (f.oldPath && !reviewable(f.oldPath))) f.hidden = true;
    return files.slice(0, MAX_CHANGES);
  }

  /** One file's patch. The path must be one of `changes(target)`, so nothing else can be read. */
  async diff(path: string, target: GitTarget = {}): Promise<string> {
    const f = (await this.changes(target)).find(c => c.path === path);
    if (!f) throw new Error('This file has no changes here.');
    if (f.hidden) return 'Preview hidden for credential files.';
    const s = await this.scope(target);
    if (f.status === 'untracked') return this.untrackedPatch(s.cwd, f.path);
    const out = await this.out(['diff', '--no-ext-diff', '--no-textconv', '-M', s.from, ...(s.to ? [s.to] : []), '--', ...(f.oldPath ? [f.oldPath] : []), f.path], s.cwd);
    return out.length > PREVIEW_LIMIT ? 'Diff exceeds the in-app preview limit. Review this file in your editor.' : out;
  }

  private async untrackedPatch(cwd: string, path: string): Promise<string> {
    const full = resolve(cwd, path), rel = relative(cwd, full);
    if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('This file is outside the repository.');
    const info = await lstat(full);
    if (info.isSymbolicLink() || !info.isFile()) return 'Not a regular file. Preview in your editor.';
    if (info.size > 100000) return 'New file exceeds the in-app preview limit.';
    const content = await readFile(full);
    return content.includes(0) ? 'New binary file. Preview in your editor.' : content.toString('utf8').split('\n').map(l => '+' + l).join('\n');
  }

  private async knownBranch(name: string): Promise<string> {
    if (!(await this.branches()).some(b => b.name === name)) throw new Error(`Unknown branch ${name}.`);
    return name;
  }

  private async scope(target: GitTarget): Promise<Scope> {
    if (target.branch && target.commit) throw new Error('Choose a branch or a commit, not both.');
    if (target.commit) {
      if (!/^[0-9a-f]{7,40}$/i.test(target.commit)) throw new Error('Not a commit hash.');
      const r = await this.git(['rev-parse', '--verify', '--quiet', `${target.commit}^{commit}`]);
      if (r.code !== 0) throw new Error('Unknown commit.');
      const hash = r.stdout.trim();
      const parent = await this.git(['rev-parse', '--verify', '--quiet', `${hash}^1`]);
      return { cwd: this.top, from: parent.code === 0 ? parent.stdout.trim() : EMPTY_TREE, to: hash, untracked: false };
    }
    if (target.branch) {
      const branches = await this.branches();
      const name = await this.knownBranch(target.branch);
      const base = this.baseOf(branches, await this.remoteDefault()) ?? name;
      const mb = await this.git(['merge-base', `refs/heads/${base}`, `refs/heads/${name}`]);
      if (mb.code !== 0) throw new Error(`${name} has no history in common with ${base}.`);
      const wt = (await this.worktrees()).find(w => w.branch === name && !w.main && normPath(w.path) !== normPath(this.top));
      // A helper's worktree also holds work it has not committed yet; the project folder's own edits belong to `{}`.
      return wt ? { cwd: wt.path, from: mb.stdout.trim(), untracked: true } : { cwd: this.top, from: mb.stdout.trim(), to: `refs/heads/${name}`, untracked: false };
    }
    const head = await this.git(['rev-parse', '--verify', '--quiet', 'HEAD']);
    return { cwd: this.top, from: head.code === 0 ? head.stdout.trim() : EMPTY_TREE, untracked: true };
  }
}
