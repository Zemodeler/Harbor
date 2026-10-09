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

const integrationBranches = (repo: string) => git(repo, 'branch', '--list', 'harbor/integrate-*');

it('parses the integrator delegate form into an edit helper with sources', () => {
  const p = parseProtocol([
    'HARBOR_DELEGATE: {"role":"integrator","sources":["a","b","a"],"target":"main"}',
    'HARBOR_DELEGATE: {"role":"integrator","sources":[]}'
  ].join('\n'));
  expect(p.delegate).toHaveLength(1);
  expect(p.delegate[0]).toMatchObject({ role: 'other', access: 'edit', integrate: { sources: ['a', 'b'], target: 'main' } });
  expect(p.malformed).toHaveLength(1);
});

it('merges two approved branches, re-runs idempotently, applies as a fast-forward and lists changes', async () => {
  const { svc, repo, find, integrator, mainHead } = await setup([
    impl('a', 'a.txt', 'A'), impl('b', 'b.txt', 'B'), review('ra', 'a'), review('rb', 'b'),
    { role: 'integrator', ref: 'i', sources: ['a', 'b'] }
  ]);
  const a = find('Write a'), b = find('Write b'), i = integrator();
  expect(i.role).toBe('other');
  expect(i.dependsOn).toEqual(expect.arrayContaining([a.id, b.id, find('Review a').id, find('Review b').id]));
  expect(i.state).toBe('done');
  const integ = i.integration!;
  expect(integ).toMatchObject({ target: 'main', base: mainHead, branch: i.branch });
  expect(i.branch).toMatch(/^harbor\/integrate-main-[0-9a-z]{6}$/);
  expect(integ.sources).toEqual([
    { agentId: a.id, branch: a.branch, commit: git(repo, 'rev-parse', a.branch!), state: 'merged', merge: git(repo, 'rev-parse', `${i.branch!}~1`) },
    { agentId: b.id, branch: b.branch, commit: git(repo, 'rev-parse', b.branch!), state: 'merged', merge: git(repo, 'rev-parse', i.branch!) }
  ]);
  expect(integ.head).toBe(git(repo, 'rev-parse', i.branch!));
  expect(git(i.worktree!, 'log', '--format=%an', '-1')).toBe('Harbor');
  expect(readFileSync(join(i.worktree!, 'b.txt'), 'utf8')).toBe('B');
  // Nothing reached the user's branch yet.
  expect(git(repo, 'rev-parse', 'main')).toBe(mainHead);
  expect(i.report).toContain('Ready to apply');

  expect((await svc.getChanges(i.id)).map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt']);
  expect((await svc.getChanges(a.id)).map((f) => f.path)).toEqual(['a.txt']);
  expect(await svc.getChanges(find('Review a').id)).toEqual([]);

  // A re-run skips sources already in the integration head: no new merge commits.
  const head = integ.head!;
  const merges = integ.sources.map((s) => s.merge);
  const ic = await svc.openAgentConversation(i.id);
  await svc.send(ic.id, 'run again');
  await svc.whenIdle();
  expect(i.state).toBe('done');
  expect(i.integration!.head).toBe(head);
  expect(i.report).toContain('already included');
  // The merges Harbor made in the first run still attribute the sources.
  expect(i.integration!.sources.map((s) => s.merge)).toEqual(merges);

  const applied = await svc.applyIntegration(i.id);
  expect(applied.integration).toMatchObject({ applied: true, head });
  expect(git(repo, 'rev-parse', 'main')).toBe(head);
  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('A');
  // Applying again is a no-op, not an error.
  await expect(svc.applyIntegration(i.id)).resolves.toMatchObject({ integration: { applied: true } });
}, 60_000); // five helper runs, a re-run and real git: slow on a loaded Windows machine

it('records a conflict, aborts the merge and keeps earlier merges', async () => {
  const { svc, repo, find, integrator, mainHead } = await setup([
    impl('a', 'same.txt', 'A'), impl('b', 'same.txt', 'B'), review('ra', 'a'), review('rb', 'b'),
    { role: 'integrator', ref: 'i', sources: ['a', 'b'] }
  ]);
  const i = integrator();
  expect(i.state).toBe('failed');
  expect(i.error).toMatch(/^Merge conflict: "Write b" conflicts in same\.txt/);
  expect(i.integration!.sources.map((s) => s.state)).toEqual(['merged', 'conflict']);
  expect(i.integration!.conflicts).toEqual(['same.txt']);
  // Aborted: no merge in progress, clean worktree, and the head holds the first source's merge.
  expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: i.worktree! }).status).not.toBe(0);
  expect(git(i.worktree!, 'status', '--porcelain')).toBe('');
  expect(spawnSync('git', ['merge-base', '--is-ancestor', find('Write a').branch!, 'HEAD'], { cwd: i.worktree! }).status).toBe(0);
  expect(readFileSync(join(i.worktree!, 'same.txt'), 'utf8')).toBe('A');
  expect(git(repo, 'rev-parse', 'main')).toBe(mainHead);
  await expect(svc.applyIntegration(i.id)).rejects.toThrow(/Only a finished integration/);
});

it('refuses unapproved and outdated sources before any git write', async () => {
  const { svc, repo, project, find } = await setup([
    impl('a', 'a.txt', 'A'), impl('b', 'b.txt', 'B'), review('ra', 'a'), review('rb', 'b', 'changes')
  ]);
  const a = find('Write a'), b = find('Write b');

  const unapproved = await svc.integrateBranches(project.id, [a.id, b.id]);
  await svc.whenIdle();
  const u = svc.store.getAgent(unapproved.id)!;
  expect(u.state).toBe('failed');
  expect(u.error).toMatch(/^Refused: "Write b": a reviewer asked for changes/);
  expect(u.worktree).toBeUndefined();
  expect(u.integration!.sources.every((s) => s.state === 'pending' && !s.commit)).toBe(true);
  expect(integrationBranches(repo)).toBe('');

  // The approved branch moves after its review: the approval no longer covers it.
  writeFileSync(join(a.worktree!, 'late.txt'), 'late');
  git(a.worktree!, 'add', '.'); git(a.worktree!, 'commit', '-q', '-m', 'late change');
  const outdated = await svc.integrateBranches(project.id, [a.id], 'main');
  await svc.whenIdle();
  const o = svc.store.getAgent(outdated.id)!;
  expect(o.state).toBe('failed');
  expect(o.error).toMatch(/^Refused: "Write a": its approval is outdated/);
  expect(integrationBranches(repo)).toBe('');

  await expect(svc.integrateBranches(project.id, [find('Review a').id])).rejects.toThrow(/no helper branch/);
  await expect(svc.integrateBranches(project.id, [a.id], 'no-such-branch').then(async (x) => { await svc.whenIdle(); return svc.store.getAgent(x.id)!.error; }))
    .resolves.toBe('Refused: "no-such-branch" is not an existing local branch.');
});

it('refuses to apply when the project folder is dirty or the target moved', async () => {
  const { svc, repo, project, find, mainHead } = await setup([impl('a', 'a.txt', 'A'), review('ra', 'a')]);
  const started = await svc.integrateBranches(project.id, [find('Write a').id]);
  await svc.whenIdle();
  const i = svc.store.getAgent(started.id)!;
  expect(i.state).toBe('done');
  expect(i.byUser).toBe(true);

  writeFileSync(join(repo, 'README.md'), 'local edit');
  await expect(svc.applyIntegration(i.id)).rejects.toThrow(/uncommitted changes/);
  writeFileSync(join(repo, 'README.md'), 'hi');

  writeFileSync(join(repo, 'other.txt'), 'x'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'user commit');
  await expect(svc.applyIntegration(i.id)).rejects.toThrow(/main moved since the integration started/);
  expect(git(repo, 'rev-parse', 'main')).not.toBe(i.integration!.head);
  expect(git(repo, 'rev-parse', 'HEAD~1')).toBe(mainHead);
  expect(i.integration!.applied).toBeUndefined();
});

it('fails the integration when the project checks fail on the combined head', async () => {
  const { svc, repo, find, integrator, mainHead } = await setup([
    impl('a', 'a.txt', 'A'), review('ra', 'a'), { role: 'integrator', ref: 'i', sources: ['a'] }
  ], ['node -e "process.exit(4)"']);
  const i = integrator();
  expect(find('Write a').checks?.[0]?.ok).toBe(false);
  expect(i.state).toBe('failed');
  expect(i.error).toMatch(/^Checks failed on integration: /);
  expect(i.integration!.sources[0]!.state).toBe('merged');
  expect(i.checks).toHaveLength(1);
  expect(i.testedCommit).toBe(i.integration!.head);
  await expect(svc.applyIntegration(i.id)).rejects.toThrow(/Only a finished integration/);
  expect(git(repo, 'rev-parse', 'main')).toBe(mainHead);
  expect(existsSync(join(repo, 'a.txt'))).toBe(false);
});
