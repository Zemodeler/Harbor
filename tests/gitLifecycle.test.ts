import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { Git, explainPushFailure, pushArgs, remoteUrlProblem } from '../src/main/git';

const dirs: string[] = [];
const temp = (p = 'harbor-lifecycle-') => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' }).toString();
const identity = (repo: string) => { sh(repo, 'config', 'user.name', 'Harbor Test'); sh(repo, 'config', 'user.email', 'test@example.invalid'); };

/** A repo with one commit and a bare local repo as origin. */
async function pair() {
  const git = new Git(), repo = temp(), origin = temp('harbor-origin-');
  sh(origin, 'init', '--bare', '-b', 'main');
  await git.init(repo); identity(repo);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  await git.initialCommit(repo, 'Initial');
  sh(repo, 'remote', 'add', 'origin', origin);
  return { git, repo, origin };
}

describe('init and first commit', () => {
  it('initialises on the requested branch and commits everything', async () => {
    const git = new Git(), repo = temp();
    writeFileSync(join(repo, 'README.md'), '# x\n');
    await git.init(repo, 'main');
    identity(repo);
    const r = await git.initialCommit(repo, 'Initial commit');
    expect(r.ok).toBe(true);
    expect(r.fallbackIdentity).toBe(false);
    expect(await git.currentBranch(repo)).toBe('main');
    expect(sh(repo, 'ls-files').trim()).toBe('README.md');
  });
  it('uses a neutral identity, and says so, when git has none', async () => {
    const git = new Git((exe, args, o) => import('../src/main/proc').then((m) => m.runProcess(exe, args, { ...o, env: { ...(o?.env ?? process.env), GIT_CONFIG_GLOBAL: join(tmpdir(), 'harbor-no-such-config'), GIT_CONFIG_SYSTEM: join(tmpdir(), 'harbor-no-such-config'), GIT_CONFIG_NOSYSTEM: '1' } })));
    const repo = temp();
    writeFileSync(join(repo, 'a.txt'), 'x');
    await git.init(repo);
    const r = await git.initialCommit(repo, 'Initial');
    expect(r.ok).toBe(true);
    expect(r.fallbackIdentity).toBe(true);
  });
  it('refuses odd branch names', async () => {
    await expect(new Git().init(temp(), '--bad')).rejects.toThrow();
  });
});

describe('remote URLs', () => {
  it('accepts https, ssh and scp-like URLs only', () => {
    for (const ok of ['https://github.com/o/n.git', 'ssh://git@github.com/o/n.git', 'git@github.com:o/n.git']) expect(remoteUrlProblem(ok), ok).toBeUndefined();
    for (const bad of ['file:///c:/x', 'ext::sh -c id', '-oProxyCommand=x', 'C:\\repo', '/tmp/x', 'http://x/y', 'https://user:pw@github.com/o/n', 'https://github.com/o n', '', 'git://github.com/o/n'])
      expect(remoteUrlProblem(bad), bad).toBeTruthy();
  });
  it('adds origin, refuses a silent overwrite, replaces on request', async () => {
    const git = new Git(), repo = temp();
    await git.init(repo);
    await git.setRemote(repo, 'https://github.com/o/a.git');
    expect(await git.remoteUrl(repo)).toBe('https://github.com/o/a.git');
    await expect(git.setRemote(repo, 'https://github.com/o/b.git')).rejects.toThrow(/already has a remote/);
    await git.setRemote(repo, 'https://github.com/o/b.git', { replace: true });
    expect(await git.remoteUrl(repo)).toBe('https://github.com/o/b.git');
    await expect(git.setRemote(repo, 'file:///x', { replace: true })).rejects.toThrow();
  });
});

describe('push', () => {
  it('pushes a new branch, tracks it, and reports ahead and behind', async () => {
    const { git, repo, origin } = await pair();
    expect((await git.push(repo, 'origin', 'main', { setUpstream: true })).ok).toBe(true);
    expect(sh(origin, 'rev-parse', 'refs/heads/main').trim()).toBe(await git.head(repo));
    sh(repo, 'switch', '-c', 'harbor/x');
    writeFileSync(join(repo, 'b.txt'), 'two\n'); sh(repo, 'add', '.'); sh(repo, 'commit', '-m', 'Two');
    expect((await git.unpushedCommits(repo, 'harbor/x')).map((c) => c.subject)).toEqual(['Two']);
    expect((await git.aheadBehind(repo, 'harbor/x')).ahead).toBe(1);
    expect((await git.push(repo, 'origin', 'harbor/x', { setUpstream: true })).ok).toBe(true);
    expect(await git.aheadBehind(repo, 'harbor/x')).toEqual({ upstream: 'origin/harbor/x', ahead: 0, behind: 0 });
    expect(await git.unpushedCommits(repo, 'harbor/x')).toEqual([]);
  });
  it('maps a non-fast-forward rejection to a plain message and never forces', async () => {
    const { git, repo, origin } = await pair();
    await git.push(repo, 'origin', 'main', { setUpstream: true });
    const other = temp(); sh(other, 'clone', origin, '.'); identity(other);
    writeFileSync(join(other, 'c.txt'), 'x'); sh(other, 'add', '.'); sh(other, 'commit', '-m', 'Remote work'); sh(other, 'push', 'origin', 'main');
    writeFileSync(join(repo, 'd.txt'), 'y'); sh(repo, 'add', '.'); sh(repo, 'commit', '-m', 'Local work');
    const r = await git.push(repo, 'origin', 'main');
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Merge or rebase/);
    expect(sh(origin, 'log', '--format=%s', 'main')).toContain('Remote work');
    expect(sh(origin, 'log', '--format=%s', 'main')).not.toContain('Local work');
  });
  it('explains a missing remote and a missing login', async () => {
    const git = new Git(), repo = temp();
    await git.init(repo); identity(repo);
    writeFileSync(join(repo, 'a'), 'x'); await git.initialCommit(repo, 'i');
    expect((await git.push(repo, 'origin', 'main')).output).toMatch(/could not be reached/);
    expect(explainPushFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toMatch(/Not signed in/);
    expect(explainPushFailure('remote: error: GH006: Protected branch update failed')).toMatch(/protected/);
  });
  it('never builds a force, delete, mirror or odd-ref push', () => {
    expect(pushArgs('origin', 'harbor/x', { setUpstream: true })).toEqual(['push', '--set-upstream', '--', 'origin', 'refs/heads/harbor/x:refs/heads/harbor/x']);
    for (const f of ['--force', '-f', '--force-with-lease', '--force-with-lease=main', '--mirror', '--delete', '-d', '--prune', '--all', '--tags'])
      expect(() => pushArgs('origin', 'x', { extra: [f] }), f).toThrow(/never forces/);
    for (const [r, b] of [['origin', '+main'], ['origin', ':main'], ['--force', 'main'], ['origin', '--delete'], ['origin', 'a:b'], ['origin', '-x'], ['', 'main']] as const)
      expect(() => pushArgs(r, b), `${r} ${b}`).toThrow();
  });
});

describe('deleteBranch', () => {
  it('deletes only harbor/* branches, merged unless forced, never one checked out in a worktree', async () => {
    const { git, repo } = await pair();
    await git.push(repo, 'origin', 'main', { setUpstream: true });
    sh(repo, 'branch', 'harbor/merged'); sh(repo, 'branch', 'feature/keep');
    await expect(git.deleteBranch(repo, 'main')).rejects.toThrow(/not a harbor/);
    await expect(git.deleteBranch(repo, 'feature/keep')).rejects.toThrow(/not a harbor/);
    await expect(git.deleteBranch(repo, 'harbor/../main')).rejects.toThrow();
    expect(await git.deleteBranch(repo, 'harbor/merged')).toBe(true);
    expect(await git.deleteBranch(repo, 'harbor/missing')).toBe(false);
    // unmerged work needs force
    sh(repo, 'switch', '-c', 'harbor/work'); writeFileSync(join(repo, 'w'), 'w'); sh(repo, 'add', '.'); sh(repo, 'commit', '-m', 'W'); sh(repo, 'switch', 'main');
    expect(await git.deleteBranch(repo, 'harbor/work')).toBe(false);
    expect((await git.harborBranches(repo)).find((b) => b.name === 'harbor/work')).toMatchObject({ merged: false, unpushed: 1 });
    const wtRoot = temp(); const wt = join(wtRoot, 'w'); mkdirSync(wtRoot, { recursive: true });
    sh(repo, 'worktree', 'add', wt, 'harbor/work');
    await expect(git.deleteBranch(repo, 'harbor/work', { force: true })).rejects.toThrow(/checked out/);
    sh(repo, 'worktree', 'remove', '--force', wt);
    expect(await git.deleteBranch(repo, 'harbor/work', { force: true })).toBe(true);
    expect(await git.branchHead(repo, 'feature/keep')).toBeTruthy();
  });
});

describe('default branch', () => {
  it('prefers origin/HEAD, then main or master, then the current branch', async () => {
    const { git, repo } = await pair();
    expect(await git.defaultBranch(repo)).toBe('main');
    sh(repo, 'branch', '-m', 'main', 'trunk');
    expect(await git.defaultBranch(repo)).toBe('trunk');
  });
});
