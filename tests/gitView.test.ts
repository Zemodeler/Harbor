import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBranches, parseChanges, parseLog, parseWorktrees } from '../src/main/gitView';
import { createHarborService, type HarborService } from '../src/main/service';

const dirs: string[] = [], services: HarborService[] = [];
const directory = () => { const p = mkdtempSync(join(tmpdir(), 'harbor-gitview-')); dirs.push(p); return p; };
afterEach(() => { services.splice(0).forEach(s => s.shutdown()); dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });

describe('git view parsers', () => {
  it('parses branches, worktrees and log records', () => {
    expect(parseBranches('refs/heads/main\x1fabc\x1f*\x1forigin/main\x1f1700000000\x1fFirst\n')).toEqual([{ name: 'main', head: 'abc', current: true, upstream: 'origin/main', updated: 1700000000000, subject: 'First' }]);
    expect(parseWorktrees('worktree C:/r\nHEAD aaa\nbranch refs/heads/main\n\nworktree C:/w/x\nHEAD bbb\ndetached\nprunable gitdir file points to non-existent location\n')).toEqual([
      { path: 'C:/r', head: 'aaa', branch: 'main' }, { path: 'C:/w/x', head: 'bbb', prunable: true }]);
    expect(parseLog('h1\x1fp1 p2\x1fAna\x1f10\x1fHEAD -> main, tag: v1\x1fMerge it\x1e\nh2\x1f\x1fAna\x1f5\x1f\x1fRoot\x1e\n')).toEqual([
      { hash: 'h1', parents: ['p1', 'p2'], author: 'Ana', time: 10000, refs: ['HEAD -> main', 'tag: v1'], subject: 'Merge it' },
      { hash: 'h2', parents: [], author: 'Ana', time: 5000, refs: [], subject: 'Root' }]);
  });
  it('joins name-status and numstat, including renames and binaries', () => {
    const ns = 'M\0a.ts\0R087\0old.ts\0new.ts\0A\0img.png\0D\0gone.ts\0';
    const num = '3\t1\ta.ts\0' + '2\t2\t\0old.ts\0new.ts\0' + '-\t-\timg.png\0' + '0\t4\tgone.ts\0';
    expect(parseChanges(ns, num)).toEqual([
      { path: 'a.ts', status: 'modified', additions: 3, deletions: 1 },
      { path: 'new.ts', oldPath: 'old.ts', status: 'renamed', additions: 2, deletions: 2 },
      { path: 'img.png', status: 'added' },
      { path: 'gone.ts', status: 'deleted', additions: 0, deletions: 4 }]);
  });
});

describe('git view service', () => {
  async function fixture() {
    const repo = directory(), wtRoot = directory();
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' }).toString();
    git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Harbor Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(repo, 'app.ts'), 'one\n'); writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Initial');
    const wt = join(wtRoot, 'fix');
    git(repo, 'worktree', 'add', '-b', 'harbor/fix-abc123', wt);
    writeFileSync(join(wt, 'app.ts'), 'one\ntwo\n'); git(wt, 'commit', '-am', 'Helper commit');
    writeFileSync(join(wt, 'draft.ts'), 'draft\n');   // helper work not committed yet
    mkdirSync(join(repo, 'config')); writeFileSync(join(repo, 'config', '.env.local'), 'synthetic fixture value');
    writeFileSync(join(repo, 'app.ts'), 'one\nlocal\n');
    const service = createHarborService({ discover: async () => [] }); services.push(service);
    const project = await service.addProject(repo);
    if (!project) throw new Error('Fixture project was not created.');
    service.store.upsertAgent({ id: 'helper', projectId: project.id, role: 'implementer', title: 'Fix app', state: 'done', cli: 'claude', model: 'm', effort: 'low', task: 't', dependsOn: [], revision: 0, attempts: 0, created: 1, parentConversationId: 'c', branch: 'harbor/fix-abc123', worktree: wt });
    return { service, project, git, repo, wt };
  }

  it('shows branches with their owning helper, worktrees and a log', async () => {
    const { service, project } = await fixture();
    const o = await service.getGitOverview(project.id);
    expect(o).toMatchObject({ base: 'main', current: 'main', notes: [] });
    expect(o.branches.map(b => b.name)).toEqual(['main', 'harbor/fix-abc123']);
    expect(o.branches[1]).toMatchObject({ ahead: 1, behind: 0, agentId: 'helper', agentTitle: 'Fix app', agentState: 'done', subject: 'Helper commit' });
    expect(o.worktrees.find(w => w.main)).toMatchObject({ branch: 'main', changed: 2 });
    expect(o.worktrees.find(w => !w.main)).toMatchObject({ branch: 'harbor/fix-abc123', changed: 1 });
    const log = await service.getGitLog(project.id);
    expect(log.map(c => c.subject)).toEqual(['Helper commit', 'Initial']);
    expect(log[0]!.parents).toEqual([log[1]!.hash]);
    expect((await service.getGitLog(project.id, { branch: 'main' })).map(c => c.subject)).toEqual(['Initial']);
  });

  it('lists and diffs the project folder, a helper branch and a commit', async () => {
    const { service, project } = await fixture();
    const local = await service.getGitChanges(project.id);
    expect(local).toEqual(expect.arrayContaining([{ path: 'app.ts', status: 'modified', additions: 1, deletions: 0 }, { path: 'config/.env.local', status: 'untracked', hidden: true }]));
    expect(await service.getGitDiff(project.id, 'app.ts')).toContain('+local');
    expect(await service.getGitDiff(project.id, 'config/.env.local')).toBe('Preview hidden for credential files.');

    const branch = { branch: 'harbor/fix-abc123' };
    expect((await service.getGitChanges(project.id, branch)).map(f => [f.path, f.status]).sort()).toEqual([['app.ts', 'modified'], ['draft.ts', 'untracked']]);
    expect(await service.getGitDiff(project.id, 'app.ts', branch)).toContain('+two');
    expect(await service.getGitDiff(project.id, 'draft.ts', branch)).toContain('+draft');

    const [helper, root] = await service.getGitLog(project.id);
    expect(await service.getGitChanges(project.id, { commit: helper!.hash.slice(0, 10) })).toEqual([{ path: 'app.ts', status: 'modified', additions: 1, deletions: 0 }]);
    expect((await service.getGitChanges(project.id, { commit: root!.hash })).map(f => f.path).sort()).toEqual(['.gitignore', 'app.ts']);
  });

  it('only accepts branches, commits and paths git reports', async () => {
    const { service, project } = await fixture();
    await expect(service.getGitChanges(project.id, { branch: '--output=x' })).rejects.toThrow('Unknown branch');
    await expect(service.getGitLog(project.id, { branch: 'nope' })).rejects.toThrow('Unknown branch');
    await expect(service.getGitChanges(project.id, { commit: 'HEAD~1' })).rejects.toThrow('Not a commit hash');
    await expect(service.getGitChanges(project.id, { commit: 'deadbeefdeadbeef' })).rejects.toThrow('Unknown commit');
    await expect(service.getGitDiff(project.id, '../outside.txt')).rejects.toThrow('no changes here');
  });

  it('reports a folder that is not a repository', async () => {
    const service = createHarborService({ discover: async () => [] }); services.push(service);
    const project = await service.addProject(directory());
    expect(await service.getGitOverview(project!.id)).toMatchObject({ branches: [], worktrees: [], notes: ['This project folder is not a Git repository.'] });
    await expect(service.getGitChanges(project!.id)).rejects.toThrow('not a Git repository');
  });
});
