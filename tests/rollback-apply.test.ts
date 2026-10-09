import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk, RunOptions } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { Git } from '../src/main/git';
import { toAgent } from '../src/main/orchestrator';
import { runProcess, type Runner } from '../src/main/proc';
import { createHarborService } from '../src/main/service';

/** Helper runs plus real git: slow on a loaded Windows machine. */
const SLOW = 90_000;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-rbapply-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const say = (text: string): Chunk[] => [{ kind: 'text', text }];
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();
const gitOk = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' }).status === 0;
const commit = (cwd: string, file: string, content: string, msg: string) => { writeFileSync(join(cwd, file), content); git(cwd, 'add', '.'); git(cwd, 'commit', '-q', '-m', msg); return git(cwd, 'rev-parse', 'HEAD'); };
const result = (r: object) => `HARBOR_RESULT: ${JSON.stringify(r)}`;
const setChecks = (repo: string, checks: string[]) => { mkdirSync(join(repo, '.harbor'), { recursive: true }); writeFileSync(join(repo, '.harbor', 'checks.json'), JSON.stringify({ checks })); };

type Task = Record<string, unknown>;
const impl = (ref: string, file: string, content: string): Task => ({ ref, title: `Write ${ref}`, role: 'implementer', instructions: `WRITE ${file} ${content}`, complexity: 'low', files: [file] });
const review = (ref: string, of: string): Task => ({ ref, title: `Review ${of}`, role: 'reviewer', instructions: 'Review it.', complexity: 'low', dependsOn: [of] });

/**
 * A repo on `main`; the lead delegates `plan` once (edit helpers write their file, reviewers approve); the integrator's
 * result is applied to main. Every git call Harbor makes is recorded.
 */
async function setup(plan: Task[]) {
  const repo = tmp();
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  commit(repo, 'README.md', 'hi', 'init');
  let delegated = false;
  const script: FakeScript = (prompt, o: RunOptions) => {
    const sys = o.systemPrompt ?? '';
    if (sys.includes('front desk')) return say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }));
    if (sys.includes('LEAD agent')) {
      if (delegated) return say('ok');
      delegated = true;
      return say(['go', ...plan.map((t) => `HARBOR_DELEGATE: ${JSON.stringify(t)}`)].join('\n'));
    }
    if (o.permission === 'edit') {
      const m = /WRITE (\S+) (\S+)/.exec(prompt);
      if (m) writeFileSync(join(o.cwd, m[1]!), m[2]!);
      return say(['Done', result({ outcome: 'done', summary: 'Written.', checks: [] })].join('\n'));
    }
    return say(['Reviewed.', result({ outcome: 'done', summary: 'Reviewed.', verdict: 'approve', checks: [] })].join('\n'));
  };
  const calls: string[][] = [];
  const runner: Runner = (exe, args, opts) => { if (exe === 'git') calls.push(args); return runProcess(exe, args, opts); };
  const adapter = new FakeAdapter('claude', script);
  const cli: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' };
  const svc = createHarborService({ discover: async () => [cli], adapterFor: () => adapter, worktreesRoot: join(tmp(), 'wt'), maxActivePerProject: 4, git: new Git(runner) });
  const project = (await svc.addProject(repo))!;
  const [conv] = await svc.listConversations(project.id);
  await svc.send(conv!.id, 'do the work');
  await svc.whenIdle();
  const integrator = svc.store.listAgentRecords(project.id).find((a) => a.integration)!;
  expect(integrator.state).toBe('done');
  await svc.applyIntegration(integrator.id);
  const find = (title: string) => svc.store.listAgentRecords(project.id).find((a) => a.title === title)!;
  const rollbackOf = (taskId: string) => svc.store.listAgentRecords(project.id).find((a) => a.rollback?.taskId === taskId)!;
  return { svc, repo, project, find, integrator, rollbackOf, calls };
}

/** No history rewrite, no force, no push: none of these may appear in any git call Harbor made for a rollback. */
function expectNoDestructiveGit(calls: string[][]) {
  const banned = ['push', 'reset', 'clean', '--force', '-f', '-D', '--hard', 'rebase', 'filter-branch'];
  for (const c of calls) expect(c.filter((x) => banned.includes(x)), c.join(' ')).toEqual([]);
  // The user's branch moves only by `merge --ff-only` or a compare-and-swap update-ref (old value given).
  for (const c of calls.filter((c) => c.includes('update-ref'))) expect(c).toHaveLength(4);
  for (const c of calls.filter((c) => c[0] === 'merge')) expect(c).toContain('--ff-only');
}

it('rolls back one of two integrated tasks on a new branch, applies it as a fast-forward, twice', async () => {
  const { svc, repo, project, find, integrator, rollbackOf, calls } = await setup([
    impl('a', 'a.txt', 'A'), impl('b', 'b.txt', 'B'), review('ra', 'a'), review('rb', 'b'), { role: 'integrator', ref: 'i', sources: ['a', 'b'] }
  ]);
  const a = find('Write a'), ra = find('Review a'), rb = find('Review b');
  const mergeA = integrator.integration!.sources.find((s) => s.agentId === a.id)!.merge!;
  const base = git(repo, 'rev-parse', 'main');
  // The rollback branch must not keep a.txt yet keep b.txt: checks enforce it.
  setChecks(repo, ['node -e "process.exit(require(\'fs\').existsSync(\'a.txt\')?6:0)"']);
  calls.length = 0;

  const queued = await svc.rollbackTask(a.id);
  expect(queued).toMatchObject({ role: 'other', cli: 'harbor', model: 'git', rollback: { taskId: a.id, merges: [] } });
  expect(await svc.openAgentConversation(queued.id)).toMatchObject({ projectId: project.id, title: 'rollback: Roll back "Write a"', agentId: queued.id });
  await svc.whenIdle();

  const r = rollbackOf(a.id);
  expect(r.state).toBe('done');
  expect(r.byUser).toBe(true);
  expect(r.branch).toMatch(/^harbor\/rollback-write-a-[0-9a-z]{6}$/);
  expect(r.rollback).toMatchObject({ taskId: a.id, target: 'main', base, branch: r.branch, merges: [{ commit: mergeA, agentId: a.id, integrationId: integrator.id, state: 'reverted' }] });
  const head = r.rollback!.head!;
  expect(head).toBe(git(repo, 'rev-parse', r.branch!));
  expect(r.rollback!.merges[0]!.revert).toBe(head);
  expect(git(repo, 'rev-parse', `${head}~1`)).toBe(base);
  expect(git(repo, 'ls-tree', '--name-only', head).split('\n').sort()).toEqual(['README.md', 'b.txt']);
  expect(r.checks).toMatchObject([{ ok: true }]);
  expect(r.testedCommit).toBe(head);
  expect(toAgent(r).rollback?.head).toBe(head);
  // Nothing touched main before apply.
  expect(git(repo, 'rev-parse', 'main')).toBe(base);
  expect(existsSync(join(repo, 'a.txt'))).toBe(true);
  expect(ra.testedCommit).toBeDefined();
  expect(ra.outdated).not.toBe(true);

  await svc.applyIntegration(r.id);
  expect(git(repo, 'rev-parse', 'main')).toBe(head);
  expect(existsSync(join(repo, 'a.txt'))).toBe(false);
  expect(existsSync(join(repo, 'b.txt'))).toBe(true);
  expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  expect(r.rollback!.applied).toBe(true);
  // Verification of the reverted task and its dependents no longer covers the code; the other task's stays valid.
  expect(ra.outdated).toBe(true);
  expect(toAgent(ra).outdated).toBe(true);
  expect(rb.outdated).not.toBe(true);
  expect(svc.orchestrator.journal.list(project.id).some((e) => e.agentId === r.id && e.text.startsWith('Rolled back "Write a" on main'))).toBe(true);

  // Applying twice changes nothing.
  const journalSize = svc.orchestrator.journal.list(project.id).length;
  await svc.applyIntegration(r.id);
  expect(git(repo, 'rev-parse', 'main')).toBe(head);
  expect(svc.orchestrator.journal.list(project.id)).toHaveLength(journalSize);
  expect(calls.some((c) => c.includes('revert'))).toBe(true);
  expectNoDestructiveGit(calls);
}, SLOW);

it('aborts a conflicting revert, reports it and leaves the target untouched', async () => {
  const { svc, repo, find, rollbackOf, calls } = await setup([impl('a', 'a.txt', 'A'), review('ra', 'a'), { role: 'integrator', ref: 'i', sources: ['a'] }]);
  const a = find('Write a');
  const later = commit(repo, 'a.txt', 'C', 'user edits a');
  calls.length = 0;

  await svc.rollbackTask(a.id);
  await svc.whenIdle();
  const r = rollbackOf(a.id);
  expect(r.state).toBe('failed');
  expect(r.error).toBe(`Rollback conflict: reverting ${r.rollback!.merges[0]!.commit.slice(0, 10)} conflicts in a.txt`);
  expect(toAgent(r).summary).toMatch(/^Rollback conflict: /);
  expect(r.rollback).toMatchObject({ base: later, conflicts: ['a.txt'], merges: [{ state: 'conflict' }] });
  expect(r.rollback!.head).toBe(later);
  // The revert was aborted cleanly; the user's branch and folder are as they were.
  expect(gitOk(r.worktree!, 'rev-parse', '--verify', '--quiet', 'REVERT_HEAD')).toBe(false);
  expect(git(r.worktree!, 'status', '--porcelain')).toBe('');
  expect(git(repo, 'rev-parse', 'main')).toBe(later);
  expect(git(repo, 'status', '--porcelain')).toBe('');
  expect(calls.some((c) => c.includes('revert') && c.includes('--abort'))).toBe(true);
  await expect(svc.applyIntegration(r.id)).rejects.toThrow(/Only a finished rollback/);
  expect(git(repo, 'rev-parse', 'main')).toBe(later);
  expectNoDestructiveGit(calls);
}, SLOW);

it('refuses before any git write while a dependent is working, and validates the request', async () => {
  const { svc, repo, project, find, rollbackOf, calls } = await setup([impl('a', 'a.txt', 'A'), review('ra', 'a'), { role: 'integrator', ref: 'i', sources: ['a'] }]);
  const a = find('Write a'), ra = find('Review a');
  const main = git(repo, 'rev-parse', 'main');
  ra.state = 'working';
  calls.length = 0;

  await svc.rollbackTask(a.id);
  // whenIdle would wait for the "working" reviewer: wait for the rollback itself.
  for (let t = Date.now(); !['done', 'failed', 'stopped'].includes(rollbackOf(a.id).state); ) {
    if (Date.now() - t > 30_000) throw new Error('rollback did not finish');
    await new Promise((res) => setTimeout(res, 20));
  }
  const r = rollbackOf(a.id);
  expect(r.state).toBe('failed');
  expect(r.error).toBe('Refused: "Review a" (dependsOn) is working.');
  expect(r.worktree).toBeUndefined();
  expect(git(repo, 'branch', '--list', 'harbor/rollback-*')).toBe('');
  expect(git(repo, 'rev-parse', 'main')).toBe(main);
  expect(calls.filter((c) => ['revert', 'worktree', 'update-ref', 'merge', 'commit'].includes(c.find((x) => !x.startsWith('-') && !x.includes('=')) ?? ''))).toEqual([]);

  const lead = svc.store.mainAgent(project.id)!;
  await expect(svc.rollbackTask('missing')).rejects.toThrow(/Unknown agent/);
  await expect(svc.rollbackTask(lead.id)).rejects.toThrow(/lead agent/);
  await expect(svc.rollbackTask(r.id)).rejects.toThrow(/rollback/);
  await expect(svc.rollbackTask(a.id, ' ')).rejects.toThrow(/target branch/);
  ra.state = 'done';
}, SLOW);

it('refuses to apply when the folder is dirty or the target moved, and fails when checks fail', async () => {
  const { svc, repo, find, rollbackOf } = await setup([impl('a', 'a.txt', 'A'), review('ra', 'a'), { role: 'integrator', ref: 'i', sources: ['a'] }]);
  const a = find('Write a');
  const base = git(repo, 'rev-parse', 'main');
  await svc.rollbackTask(a.id);
  await svc.whenIdle();
  const r = rollbackOf(a.id);
  expect(r.state).toBe('done');

  writeFileSync(join(repo, 'README.md'), 'local edit');
  await expect(svc.applyIntegration(r.id)).rejects.toThrow(/uncommitted changes/);
  expect(git(repo, 'rev-parse', 'main')).toBe(base);
  git(repo, 'checkout', '--', 'README.md');

  const moved = commit(repo, 'c.txt', 'C', 'user work');
  await expect(svc.applyIntegration(r.id)).rejects.toThrow(/main moved since the rollback started/);
  expect(git(repo, 'rev-parse', 'main')).toBe(moved);
  expect(r.rollback!.applied).toBeUndefined();

  // A new rollback on the moved target, whose checks need a.txt: it reverts cleanly but must not be applicable.
  setChecks(repo, ['node -e "process.exit(require(\'fs\').existsSync(\'a.txt\')?0:5)"']);
  await svc.rollbackTask(a.id);
  await svc.whenIdle();
  const r2 = svc.store.listAgentRecords(r.projectId).filter((x) => x.rollback?.taskId === a.id).find((x) => x.id !== r.id)!;
  expect(r2.state).toBe('failed');
  expect(r2.error).toMatch(/^Checks failed on rollback: /);
  expect(r2.rollback).toMatchObject({ base: moved, merges: [{ state: 'reverted' }] });
  await expect(svc.applyIntegration(r2.id)).rejects.toThrow(/Only a finished rollback/);
  expect(git(repo, 'rev-parse', 'main')).toBe(moved);
}, SLOW);

it('revert helpers refuse to run outside a harbor/* branch', async () => {
  const repo = tmp();
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  const c = commit(repo, 'README.md', 'hi', 'init');
  const g = new Git();
  await expect(g.revertMerge(repo, c)).rejects.toThrow(/harbor\/\*/);
  await expect(g.abortRevert(repo)).rejects.toThrow(/harbor\/\*/);
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(c);
});
