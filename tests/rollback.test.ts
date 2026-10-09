import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk, RunOptions } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { Git } from '../src/main/git';
import { toAgent } from '../src/main/orchestrator';
import { EXTERNAL_EFFECTS_NOTE, findTaskMerges } from '../src/main/rollback';
import { createHarborService } from '../src/main/service';
import { newId } from '../src/main/store';
import type { AgentRecord } from '../src/main/types';

/** Helper runs plus real git: slow on a loaded Windows machine. */
const SLOW = 60_000;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-rollback-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const say = (text: string): Chunk[] => [{ kind: 'text', text }];
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();
const commit = (cwd: string, file: string, content: string, msg: string) => { writeFileSync(join(cwd, file), content); git(cwd, 'add', '.'); git(cwd, 'commit', '-q', '-m', msg); return git(cwd, 'rev-parse', 'HEAD'); };
const result = (r: object) => `HARBOR_RESULT: ${JSON.stringify(r)}`;

type Task = Record<string, unknown>;
const impl = (ref: string, writes: string): Task => ({ ref, title: `Write ${ref}`, role: 'implementer', instructions: writes, complexity: 'low', files: [] });
const review = (ref: string, of: string): Task => ({ ref, title: `Review ${of}`, role: 'reviewer', instructions: 'Review it.', complexity: 'low', dependsOn: [of] });

/** A repo on `main`; the lead delegates `plan` once; edit helpers write every `WRITE <file> <content>`; reviewers approve. */
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
      for (const m of prompt.matchAll(/WRITE (\S+) (\S+)/g)) writeFileSync(join(o.cwd, m[1]!), m[2]!);
      return say(['Done', result({ outcome: 'done', summary: 'Written.', checks: [] })].join('\n'));
    }
    return say(['Reviewed.', result({ outcome: 'done', summary: 'Reviewed.', verdict: 'approve', checks: [] })].join('\n'));
  };
  const adapter = new FakeAdapter('claude', script);
  const cli: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' };
  const patchesRoot = join(tmp(), 'patches');
  const svc = createHarborService({ discover: async () => [cli], adapterFor: () => adapter, worktreesRoot: join(tmp(), 'wt'), maxActivePerProject: 4, patchesRoot });
  const project = (await svc.addProject(repo))!;
  const [conv] = await svc.listConversations(project.id);
  await svc.send(conv!.id, 'do the work');
  await svc.whenIdle();
  const find = (title: string) => svc.store.listAgentRecords(project.id).find((a) => a.title === title)!;
  const ctx = () => ({ git: new Git(), repo, agents: svc.store.listAgentRecords(project.id) });
  return { svc, repo, project, find, ctx, patchesRoot };
}

/** Refs, index/working tree status and HEAD: a preview must leave all three unchanged. */
const repoState = (repo: string) => ({ refs: git(repo, 'for-each-ref'), status: git(repo, 'status', '--porcelain'), head: git(repo, 'symbolic-ref', 'HEAD') + git(repo, 'rev-parse', 'HEAD') });

/** Add a Harbor helper record that owns `branch` (as if it had run), for overlap attribution. */
function addHelper(svc: Awaited<ReturnType<typeof setup>>['svc'], projectId: string, title: string, branch: string, baseCommit: string, extra: Partial<AgentRecord> = {}): AgentRecord {
  return svc.store.upsertAgent({
    id: newId(), projectId, role: 'implementer', title, state: 'done', cli: 'claude', model: 'default', effort: 'low', task: title,
    dependsOn: [], revision: 1, parentConversationId: '', attempts: 0, created: Date.now(), branch, baseCommit, ...extra
  });
}

it('records a snapshot with files and a patch that leaves credential files out', async () => {
  const { find, patchesRoot } = await setup([impl('a', 'WRITE a.txt A WRITE .env SECRET=1')]);
  const a = find('Write a');
  expect(a.state).toBe('done');
  expect(a.snapshots).toHaveLength(1);
  const s = a.snapshots![0]!;
  expect(s).toMatchObject({ revision: 1, base: a.baseCommit, head: a.headCommit });
  expect(s.files.map((f) => [f.path, !!f.hidden]).sort()).toEqual([['.env', true], ['a.txt', false]]);
  expect(s.patchPath).toBeDefined();
  expect(s.patchPath!.startsWith(patchesRoot)).toBe(true);
  expect(s.patchPath!.endsWith(`1-${a.headCommit!.slice(0, 7)}.patch`)).toBe(true);
  const patch = readFileSync(s.patchPath!, 'utf8');
  expect(patch).toContain('a.txt');
  expect(patch).not.toContain('SECRET');
  expect(patch).not.toContain('.env');
  // The snapshot is main-process state, not part of the contract.
  expect('snapshots' in toAgent(a)).toBe(false);
}, SLOW);

it('attributes via IntegrationSource.merge, previews a clean rollback and changes nothing', async () => {
  const { svc, repo, find, ctx } = await setup([impl('a', 'WRITE a.txt A'), review('ra', 'a'), { role: 'integrator', ref: 'i', sources: ['a'] }]);
  const a = find('Write a'), i = svc.store.listAgentRecords(a.projectId).find((x) => x.integration)!;
  expect(i.state).toBe('done');
  const merge = i.integration!.sources[0]!.merge!;
  expect(merge).toBe(git(repo, 'rev-parse', i.branch!));
  expect(git(repo, 'rev-list', '--parents', '-n', '1', merge).split(' ')).toHaveLength(3);
  // Before it is applied, main does not contain the merge.
  expect(await findTaskMerges(ctx(), a, git(repo, 'rev-parse', 'main'))).toEqual([]);
  await svc.applyIntegration(i.id);
  expect(await findTaskMerges(ctx(), a, git(repo, 'rev-parse', 'main'))).toMatchObject([{ commit: merge, source: a.id, integrationId: i.id }]);

  const before = repoState(repo);
  const p = await svc.previewRollback(a.id);
  expect(repoState(repo)).toEqual(before);
  expect(p).toMatchObject({ agentId: a.id, target: 'main', targetHead: merge, supported: true, clean: true, conflicts: [], blockers: [], laterCommits: [] });
  expect(p.merges).toEqual([{ commit: merge, agentId: a.id, integrationId: i.id }]);
  expect(p.files!.map((f) => f.path)).toEqual(['a.txt']);
  expect(p.notes).toContain(EXTERNAL_EFFECTS_NOTE);
  expect(p.dependents!.map((d) => [d.title, d.reason]).sort()).toEqual([[i.title, 'dependsOn'], ['Review a', 'dependsOn']]);

  // An integrator as the task: the merges of all its sources.
  const pi = await svc.previewRollback(i.id, 'main');
  expect(pi.merges).toEqual([{ commit: merge, agentId: a.id, integrationId: i.id }]);
  expect(pi.clean).toBe(true);
  expect(repoState(repo)).toEqual(before);
}, SLOW);

it('attributes a hand-made merge through the fallback and reports a later conflicting commit', async () => {
  const { svc, repo, find, ctx } = await setup([impl('a', 'WRITE a.txt A'), review('ra', 'a')]);
  const a = find('Write a');
  git(repo, 'merge', '--no-ff', '--no-edit', '-q', a.branch!);
  const merge = git(repo, 'rev-parse', 'HEAD');
  expect(await findTaskMerges(ctx(), a, merge)).toMatchObject([{ commit: merge, source: a.id }]);
  expect((await findTaskMerges(ctx(), a, merge))[0]!.integrationId).toBeUndefined();
  expect((await svc.previewRollback(a.id)).clean).toBe(true);

  const later = commit(repo, 'a.txt', 'C', 'user edits a');
  const before = repoState(repo);
  const p = await svc.previewRollback(a.id);
  expect(repoState(repo)).toEqual(before);
  expect(p).toMatchObject({ supported: true, clean: false, conflicts: ['a.txt'] });
  expect(p.laterCommits).toEqual([{ hash: later, subject: 'user edits a', files: ['a.txt'] }]);
  expect(p.notes!.some((n) => n.includes('conflicts with later work'))).toBe(true);
}, SLOW);

it('lists dependents, including overlapping later helper work, and blocks while they are active', async () => {
  const { svc, repo, project, find } = await setup([impl('a', 'WRITE a.txt A'), review('ra', 'a')]);
  const a = find('Write a'), ra = find('Review a');
  git(repo, 'merge', '--no-ff', '--no-edit', '-q', a.branch!);
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'harbor/later-edit');
  const laterCommit = commit(repo, 'a.txt', 'A2', 'later helper edit');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '--no-ff', '--no-edit', '-q', 'harbor/later-edit');
  const b = addHelper(svc, project.id, 'Later edit', 'harbor/later-edit', base);

  let p = await svc.previewRollback(a.id);
  expect(p.laterCommits).toEqual([{ hash: laterCommit, subject: 'later helper edit', files: ['a.txt'], agentId: b.id, agentTitle: 'Later edit' }]);
  expect(p.dependents).toEqual(expect.arrayContaining([
    { agentId: ra.id, title: 'Review a', state: 'done', reason: 'dependsOn' },
    { agentId: b.id, title: 'Later edit', state: 'done', reason: 'overlap' }
  ]));
  expect(p.clean).toBe(false);
  expect(p.blockers).toEqual([]);

  ra.state = 'working'; b.state = 'queued';
  p = await svc.previewRollback(a.id);
  expect(p.blockers).toEqual(['"Review a" (dependsOn) is working.', '"Later edit" (overlap) is queued.']);
}, SLOW);

it('reports blockers: active task, running integration, no merge, detached HEAD, missing branch, not a repo', async () => {
  const { svc, repo, project, find } = await setup([impl('a', 'WRITE a.txt A'), review('ra', 'a')]);
  const a = find('Write a');
  let p = await svc.previewRollback(a.id);
  expect(p.supported).toBe(false);
  expect(p.blockers).toEqual(['No merge of "Write a" is on main.']);
  expect(p.notes).toContain(EXTERNAL_EFFECTS_NOTE);

  git(repo, 'merge', '--no-ff', '--no-edit', '-q', a.branch!);
  a.state = 'working';
  addHelper(svc, project.id, 'Integrate x', 'harbor/integrate-x', git(repo, 'rev-parse', 'HEAD'), { role: 'other', state: 'working', integration: { target: 'main', sources: [] } });
  p = await svc.previewRollback(a.id);
  expect(p.blockers).toEqual(['"Write a" is working.', 'Integration "Integrate x" is running for main.']);
  a.state = 'done';

  expect((await svc.previewRollback(a.id, 'nope')).blockers).toEqual(['"nope" is not an existing local branch.']);
  git(repo, 'checkout', '-q', '--detach');
  expect((await svc.previewRollback(a.id)).blockers).toEqual(['The project folder has a detached HEAD; name a target branch.']);
  await expect(svc.previewRollback('missing')).rejects.toThrow(/Unknown agent/);

  const plain = tmp();
  const other = (await svc.addProject(plain))!;
  const x = addHelper(svc, other.id, 'No repo', 'harbor/x', 'abc');
  expect((await svc.previewRollback(x.id)).blockers).toEqual(['The project folder is not a git repository with commits.']);
}, SLOW);

it('explains a fast-forward as unsupported and changes nothing', async () => {
  const { svc, repo, find } = await setup([impl('a', 'WRITE a.txt A'), review('ra', 'a')]);
  const a = find('Write a');
  git(repo, 'merge', '--ff-only', '-q', a.branch!);
  expect(existsSync(join(repo, 'a.txt'))).toBe(true);
  const before = repoState(repo);
  const p = await svc.previewRollback(a.id);
  expect(repoState(repo)).toEqual(before);
  expect(p).toMatchObject({ supported: false, clean: null, merges: [], blockers: ['No merge of "Write a" is on main.'] });
  expect(p.notes!.some((n) => n.includes('without a merge commit (fast-forward)'))).toBe(true);
}, SLOW);
