import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk, RunOptions } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { parseProtocol } from '../src/main/prompts';
import { createHarborService } from '../src/main/service';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-integ-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const say = (text: string): Chunk[] => [{ kind: 'text', text }];
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();
const result = (r: object) => `HARBOR_RESULT: ${JSON.stringify(r)}`;

type Task = Record<string, unknown>;
const impl = (ref: string, file: string, content: string): Task => ({ ref, title: `Write ${ref}`, role: 'implementer', instructions: `WRITE ${file} ${content}`, complexity: 'low', files: [file] });
const review = (ref: string, of: string, verdict: 'approve' | 'changes' = 'approve'): Task => ({ ref, title: `Review ${of}`, role: 'reviewer', instructions: `Review it. VERDICT:${verdict}`, complexity: 'low', dependsOn: [of] });

/**
 * A repo on `main` and a fake CLI: the lead delegates `plan` once; an edit helper writes the file named in its
 * instructions; a reviewer returns the verdict named in its instructions.
 */
async function setup(plan: Task[], checks?: string[]) {
  const repo = tmp();
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), 'hi'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  if (checks) { mkdirSync(join(repo, '.harbor')); writeFileSync(join(repo, '.harbor', 'checks.json'), JSON.stringify({ checks })); }

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
    const verdict = /VERDICT:(approve|changes)/.exec(prompt)?.[1] ?? 'approve';
    return say(['Reviewed.', result({ outcome: 'done', summary: 'Reviewed.', verdict, checks: [] })].join('\n'));
  };
  const adapter = new FakeAdapter('claude', script);
  const cli: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' };
  const svc = createHarborService({ discover: async () => [cli], adapterFor: () => adapter, worktreesRoot: join(tmp(), 'wt'), maxActivePerProject: 4 });
  const project = (await svc.addProject(repo))!;
  const [conv] = await svc.listConversations(project.id);
  await svc.send(conv!.id, 'do the work');
  await svc.whenIdle();
  const find = (title: string) => svc.store.listAgentRecords(project.id).find((a) => a.title === title)!;
  const integrator = () => svc.store.listAgentRecords(project.id).find((a) => a.integration)!;
  return { svc, repo, project, find, integrator, mainHead: git(repo, 'rev-parse', 'main') };
}


const dirty = (cwd: string) => git(cwd, 'status', '--porcelain');

async function integrated(plan: Task[] = [impl('a', 'a.txt', 'A'), impl('b', 'b.txt', 'B'), review('ra', 'a'), review('rb', 'b')]) {
  const t = await setup(plan);
  const started = await t.svc.integrateBranches(t.project.id, [t.find('Write a').id, t.find('Write b').id]);
  await t.svc.whenIdle();
  const i = t.svc.store.getAgent(started.id)!;
  expect(i.state).toBe('done');
  return { ...t, i };
}

it('apply refuses when an untracked file in the folder would be overwritten, and changes nothing', async () => {
  const { svc, repo, i, mainHead } = await integrated();
  writeFileSync(join(repo, 'a.txt'), 'my own notes');
  await expect(svc.applyIntegration(i.id)).rejects.toThrow();
  expect(git(repo, 'rev-parse', 'main')).toBe(mainHead);
  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('my own notes');
  expect(i.integration!.applied).toBeUndefined();
  // Once the user moves the file away, apply works.
  rmSync(join(repo, 'a.txt'));
  await svc.applyIntegration(i.id);
  expect(git(repo, 'rev-parse', 'main')).toBe(i.integration!.head);
}, 60_000);

it('apply recovers when the branch moved but Harbor stopped before recording it', async () => {
  const { svc, repo, i } = await integrated();
  git(repo, 'merge', '--ff-only', i.integration!.head!); // what a crash right after the write leaves behind
  expect(i.integration!.applied).toBeUndefined();
  const r = await svc.applyIntegration(i.id);
  expect(r.integration!.applied).toBe(true);
  expect(git(repo, 'rev-parse', 'main')).toBe(i.integration!.head);
}, 60_000);

it('apply moves a target that is not checked out, without touching the folder, and refuses a dirty folder on another branch', async () => {
  const { svc, repo, i, mainHead } = await integrated();
  git(repo, 'checkout', '-q', '-b', 'scratch');
  writeFileSync(join(repo, 'README.md'), 'local');
  await expect(svc.applyIntegration(i.id)).rejects.toThrow(/uncommitted changes/);
  expect(git(repo, 'rev-parse', 'main')).toBe(mainHead);
  git(repo, 'checkout', '-q', '--', 'README.md');
  await svc.applyIntegration(i.id);
  expect(git(repo, 'rev-parse', 'main')).toBe(i.integration!.head);
  expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('scratch');
  expect(dirty(repo)).toBe('');
}, 60_000);

it('apply refuses when the integration branch gained commits after its checks ran', async () => {
  const { svc, repo, i, mainHead } = await integrated();
  writeFileSync(join(i.worktree!, 'sneaky.txt'), 'x'); git(i.worktree!, 'add', '.'); git(i.worktree!, 'commit', '-q', '-m', 'late');
  await expect(svc.applyIntegration(i.id)).rejects.toThrow(/moved since its checks ran/);
  expect(git(repo, 'rev-parse', 'main')).toBe(mainHead);
}, 60_000);

it('a restart in the middle of an integration is recoverable: half-done merge cleaned up, no duplicate merges', async () => {
  const { svc, repo, i, find, mainHead } = await integrated();
  const b = find('Write b');
  const doneHead = i.integration!.head!;
  // Simulate the crash: branch back at the base, a merge of b half done (MERGE_HEAD present), state still 'working'.
  git(i.worktree!, 'reset', '-q', '--hard', mainHead);
  spawnSync('git', ['merge', '--no-commit', '--no-ff', b.branch!], { cwd: i.worktree! });
  expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: i.worktree! }).status).toBe(0);
  svc.store.getAgent(i.id)!.state = 'working';
  svc.store.upsertAgent(svc.store.getAgent(i.id)!);

  svc.orchestrator.recover();
  const stopped = svc.store.getAgent(i.id)!;
  expect(stopped.state).toBe('stopped');
  expect(stopped.error).toMatch(/restarted/);

  svc.orchestrator.resumeAgent(i.id);
  await svc.whenIdle();
  const again = svc.store.getAgent(i.id)!;
  expect(again.state).toBe('done');
  expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: i.worktree! }).status).not.toBe(0);
  expect(git(i.worktree!, 'status', '--porcelain')).toBe('');
  expect(again.integration!.sources.map((s) => s.state)).toEqual(['merged', 'merged']);
  expect(git(i.worktree!, 'rev-list', '--merges', '--count', `${mainHead}..HEAD`)).toBe('2');
  expect(doneHead).toBeTruthy();
  await svc.applyIntegration(i.id);
  expect(git(repo, 'rev-parse', 'main')).toBe(again.integration!.head);
}, 90_000);

it('a stopped integration can be resumed (cancel then retry) without duplicating merges', async () => {
  const { svc, i, mainHead } = await integrated();
  const rec = svc.store.getAgent(i.id)!;
  rec.state = 'stopped'; rec.error = 'Stopped by the user.';
  svc.store.upsertAgent(rec);
  svc.orchestrator.resumeAgent(i.id);
  await svc.whenIdle();
  const again = svc.store.getAgent(i.id)!;
  expect(again.state).toBe('done');
  expect(git(i.worktree!, 'rev-list', '--merges', '--count', `${mainHead}..HEAD`)).toBe('2');
}, 90_000);
