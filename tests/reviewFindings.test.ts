import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk, RunOptions } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { Git } from '../src/main/git';
import { runProcess, type Runner } from '../src/main/proc';
import { createHarborService } from '../src/main/service';
import type { AgentRecord } from '../src/main/types';
import { calmReported } from './fixtures/calmReadings';

/** Regression tests for the git/orchestrator review findings (H1, M1-M4, L5, L10). Real git, fake CLI. */

const SLOW = 90_000;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-findings-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const say = (text: string): Chunk[] => [{ kind: 'text', text }];
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();
const commit = (cwd: string, file: string, content: string, msg: string) => { writeFileSync(join(cwd, file), content); git(cwd, 'add', '.'); git(cwd, 'commit', '-q', '-m', msg); return git(cwd, 'rev-parse', 'HEAD'); };
const result = (r: object) => `HARBOR_RESULT: ${JSON.stringify(r)}`;
const until = async (cond: () => boolean, ms = 30_000) => {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
};

type Task = Record<string, unknown>;
const impl = (ref: string, file: string, content: string, extra: Task = {}): Task => ({ ref, title: `Write ${ref}`, role: 'implementer', instructions: `WRITE ${file} ${content}`, complexity: 'low', files: [file], ...extra });
const review = (ref: string, of: string): Task => ({ ref, title: `Review ${of}`, role: 'reviewer', instructions: 'Review it.', complexity: 'low', dependsOn: [of] });

interface Opts { gate?: Promise<void>; hook?: (args: string[], cwd: string) => Promise<void> | void }

/**
 * A repo on `main` and a fake CLI. The lead delegates `plans[n]` on the user message containing `STEP<n>` (once each).
 * Edit helpers write the file named in their prompt (`GATED` ones wait for `gate`); reviewers approve. Git always resolves
 * branch names case-insensitively (as on Windows), so the H1 tests mean the same on every platform.
 */
async function setup(plans: Task[][], o: Opts = {}) {
  const repo = tmp();
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  commit(repo, 'README.md', 'hi', 'init');
  const delegated = new Set<number>();
  const script: FakeScript = async (prompt, opts: RunOptions) => {
    const sys = opts.systemPrompt ?? '';
    if (sys.includes('front desk')) return say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }));
    if (sys.includes('LEAD agent')) {
      const n = plans.findIndex((_, i) => !delegated.has(i) && prompt.includes(`STEP${i}`));
      if (n < 0) return say('ok');
      delegated.add(n);
      return say(['go', ...plans[n]!.map((t) => `HARBOR_DELEGATE: ${JSON.stringify(t)}`)].join('\n'));
    }
    if (opts.permission === 'edit') {
      if (prompt.includes('GATED')) await o.gate;
      const m = [...prompt.matchAll(/WRITE (\S+) (\S+)/g)].at(-1); // a follow-up without a native session is prefixed with the earlier assignment: the newest instruction is last
      if (m) writeFileSync(join(opts.cwd, m[1]!), m[2]!);
      return say(['Done', result({ outcome: 'done', summary: 'Written.', checks: [] })].join('\n'));
    }
    return say(['Reviewed.', result({ outcome: 'done', summary: 'Reviewed.', verdict: 'approve', checks: [] })].join('\n'));
  };
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runner: Runner = async (exe, args, opts) => {
    if (exe === 'git') { calls.push({ args, cwd: String(opts?.cwd ?? '') }); await o.hook?.(args, String(opts?.cwd ?? '')); }
    return runProcess(exe, args, opts);
  };
  const adapter = new FakeAdapter('claude', script);
  const cli: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' };
  const svc = createHarborService({ discover: async () => [cli], adapterFor: () => adapter, autoApproveChecks: true, worktreesRoot: join(tmp(), 'wt'), maxActivePerProject: 2, ledger: { reported: calmReported }, git: new Git(runner, true) });
  const project = (await svc.addProject(repo))!;
  const [conv] = await svc.listConversations(project.id);
  const find = (title: string) => svc.store.listAgentRecords(project.id).find((a) => a.title === title)!;
  const integrators = () => svc.store.listAgentRecords(project.id).filter((a) => a.integration);
  const leadCalls = () => adapter.calls.filter((c) => (c.opts.systemPrompt ?? '').includes('LEAD agent'));
  return { svc, repo, project, conv: conv!, adapter, plans, find, integrators, leadCalls, calls };
}

/**
 * A finished implementer "Write a" on its own harbor/* worktree and an approving review of its head, seeded directly into
 * git and the store: what a delegated run leaves behind, without the CLI runs (the suite shares the machine).
 */
async function approvedHelper(o: Opts = {}) {
  const h = await setup([], o);
  const wt = join(tmp(), 'write-a');
  const base = git(h.repo, 'rev-parse', 'HEAD');
  git(h.repo, 'worktree', 'add', '-q', '-b', 'harbor/write-a-000001', wt);
  const head = commit(wt, 'a.txt', 'A', 'harbor: Write a');
  const rec = { projectId: h.project.id, cli: 'claude', model: 'default', effort: 'low' as const, revision: 1, parentConversationId: h.conv.id, attempts: 0, created: 1 };
  h.svc.store.upsertAgent({ ...rec, id: 'agent-a', role: 'implementer', title: 'Write a', state: 'done', task: 'WRITE a.txt A', files: ['a.txt'], dependsOn: [],
    branch: 'harbor/write-a-000001', worktree: wt, baseCommit: base, headCommit: head, summary: 'Written.' });
  h.svc.store.upsertAgent({ ...rec, id: 'review-a', role: 'reviewer', title: 'Review a', state: 'done', task: 'Review it.', dependsOn: ['agent-a'], created: 2,
    testedCommit: head, testedWorktree: wt, outdated: false, result: { outcome: 'done', summary: 'Reviewed.', verdict: 'approve', checks: [], commit: head } });
  return h;
}

describe('H1: target branch case', () => {
  it('resolves a branch to its real spelling, case-insensitively only where refs are', async () => {
    const repo = tmp();
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    commit(repo, 'README.md', 'hi', 'init');
    git(repo, 'branch', 'feature');
    const wt = join(tmp(), 'fw');
    git(repo, 'worktree', 'add', '-q', wt, 'feature');
    const ci = new Git(runProcess, true), cs = new Git(runProcess, false);
    expect(await ci.resolveBranch(repo, 'Main')).toBe('main');
    expect(await ci.resolveBranch(repo, 'main')).toBe('main');
    expect(await ci.resolveBranch(repo, 'nope')).toBeUndefined();
    expect(await cs.resolveBranch(repo, 'Main')).toBeUndefined();
    expect(ci.sameBranch('Main', 'main')).toBe(true);
    expect(cs.sameBranch('Main', 'main')).toBe(false);
    expect((await ci.worktreeOf(repo, 'FEATURE'))?.replace(/\\/g, '/').toLowerCase()).toBe(realpathSync.native(wt).replace(/\\/g, '/').toLowerCase());
  });

  // One setup for the three cases: helper runs and real git are slow, and the whole suite shares the machine.
  it('refuses a target checked out elsewhere whatever its case, refuses a name matching nothing, and applies "Main" as the checked-out main', async () => {
    const h = await approvedHelper();
    const a = h.find('Write a');

    git(h.repo, 'branch', 'feature');
    const other = join(tmp(), 'fw');
    git(h.repo, 'worktree', 'add', '-q', other, 'feature');
    const before = git(h.repo, 'rev-parse', 'feature');
    const toFeature = await h.svc.integrateBranches(h.project.id, [a.id], 'FEATURE');
    await h.svc.whenIdle();
    const f = h.svc.store.getAgent(toFeature.id)!;
    expect(f.state).toBe('done');
    expect(f.integration!.target).toBe('feature');
    await expect(h.svc.applyIntegration(f.id)).rejects.toThrow(/feature is checked out in/);
    expect(git(h.repo, 'rev-parse', 'feature')).toBe(before);

    const missing = await h.svc.integrateBranches(h.project.id, [a.id], 'Nope');
    await h.svc.whenIdle();
    expect(h.svc.store.getAgent(missing.id)!.error).toBe('Refused: "Nope" is not an existing local branch.');

    const started = await h.svc.integrateBranches(h.project.id, [a.id], 'Main');
    await h.svc.whenIdle();
    const i = h.svc.store.getAgent(started.id)!;
    expect(i.state).toBe('done');
    expect(i.integration!.target).toBe('main');
    expect(i.branch).toMatch(/^harbor\/integrate-main-/);

    // A record stored before the fix still holds the typed spelling: apply must resolve it too.
    i.integration!.target = 'Main';
    h.calls.length = 0;
    await h.svc.applyIntegration(i.id);
    expect(git(h.repo, 'rev-parse', 'main')).toBe(i.integration!.head);
    // Moved through the checked-out branch (ff-only merge), so index and files follow: nothing shows as changed.
    expect(git(h.repo, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(h.repo, 'a.txt'), 'utf8')).toBe('A');
    expect(h.calls.filter((c) => c.args[0] === 'update-ref')).toEqual([]);
    expect(h.calls.some((c) => c.args[0] === 'merge' && c.args.includes('--ff-only'))).toBe(true);
    h.svc.shutdown();
  }, SLOW);
});

describe('M1: user-started integrations do not hold back the lead', () => {
  it('reports a sibling helper that finished while a user integration was queued', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = await setup([[impl('a', 'a.txt', 'A'), review('ra', 'a'), impl('b', 'b.txt', 'GATED')]], { gate });
    await h.svc.send(h.conv.id, 'STEP0 do the work');
    await until(() => h.find('Review a')?.state === 'done' && h.find('Write b')?.state === 'working');
    expect(h.leadCalls()).toHaveLength(1);
    const a = h.find('Write a'), b = h.find('Write b');
    const started = await h.svc.integrateBranches(h.project.id, [a.id, b.id]);
    expect(h.svc.store.getAgent(started.id)!.state).toBe('queued');
    release();
    await h.svc.whenIdle();
    // b has no review, so the user's integration is refused; the lead still hears about b (and a, ra) once.
    expect(h.svc.store.getAgent(started.id)!.state).toBe('failed');
    const leads = h.leadCalls();
    expect(leads).toHaveLength(2);
    expect(leads[1]!.prompt).toContain('Write b');
    expect(leads[1]!.prompt.split('Helper reports')[1]).toContain('### Write b');
    expect(leads[1]!.prompt.split('Helper reports')[1]).not.toContain('### Integrate');
    h.svc.shutdown();
  }, SLOW);
});

describe('M2: old reviewers do not block an integration', () => {
  const failedReviewer = (a: AgentRecord): AgentRecord => ({
    id: 'old-review', projectId: a.projectId, role: 'reviewer', title: 'Old review', state: 'failed', cli: 'claude', model: 'default', effort: 'low',
    task: 'Review it.', dependsOn: [a.id], revision: 1, parentConversationId: a.parentConversationId, attempts: 0, created: 1, error: 'crashed'
  });

  it('integrateBranches ignores a failed earlier reviewer, and a reviewer stopped while it waits is left to the gate', async () => {
    const h = await approvedHelper();
    const a = h.find('Write a');
    h.svc.store.upsertAgent(failedReviewer(a));
    h.svc.store.upsertAgent({ ...failedReviewer(a), id: 'slow-review', title: 'Slow review', state: 'queued', paused: true, error: undefined, created: Date.now() });
    const started = await h.svc.integrateBranches(h.project.id, [a.id]);
    const deps = h.svc.store.getAgent(started.id)!.dependsOn;
    expect(deps).not.toContain('old-review');
    expect(deps).toContain('slow-review');
    expect(h.svc.store.getAgent(started.id)!.state).toBe('queued');
    await h.svc.stopAgent('slow-review');
    await h.svc.whenIdle();
    const i = h.svc.store.getAgent(started.id)!;
    expect(i.error).toBeUndefined();
    expect(i.state).toBe('done'); // "Review a" approved the current head
    h.svc.shutdown();
  }, SLOW);

  it('a lead-delegated integrator ignores it too', async () => {
    const h = await approvedHelper();
    const a = h.find('Write a');
    h.svc.store.upsertAgent(failedReviewer(a));
    // In a later turn the lead names the finished helper by id.
    h.plans.push([{ role: 'integrator', ref: 'i', sources: [a.id] }]);
    await h.svc.send(h.conv.id, 'STEP0 land it');
    await h.svc.whenIdle();
    const [i] = h.integrators();
    expect(i!.dependsOn).toContain(a.id);
    expect(i!.dependsOn).not.toContain('old-review');
    expect(i!.error).toBeUndefined();
    expect(i!.state).toBe('done');
    h.svc.shutdown();
  }, SLOW);
});

describe('M3: recovery neither fails dependents nor starts a lead turn', () => {
  const records = (h: Awaited<ReturnType<typeof setup>>) => {
    const base = { projectId: h.project.id, cli: 'claude', model: 'default', effort: 'low' as const, task: 'x', revision: 1, parentConversationId: h.conv.id, attempts: 0, readOnly: true };
    h.svc.store.upsertAgent({ ...base, id: 'ghost', role: 'other', title: 'Ghost', state: 'working', dependsOn: [], created: 1 });
    h.svc.store.upsertAgent({ ...base, id: 'next', role: 'other', title: 'Next', state: 'queued', dependsOn: ['ghost'], created: 2 });
  };

  it('keeps dependents of a restart-stopped agent queued until the user stops them, across restarts', async () => {
    const h = await setup([]);
    records(h);
    h.svc.orchestrator.recover();
    expect(h.svc.store.getAgent('ghost')!.state).toBe('stopped');
    expect(h.svc.store.getAgent('next')!.state).toBe('queued');
    expect(h.svc.store.getAgent('next')!.error).toMatch(/stopped when Harbor restarted: resume it, or stop this agent/);
    // A second restart: the marker is persisted, so the dependent still waits.
    h.svc.orchestrator.recover();
    expect(h.svc.store.getAgent('next')!.state).toBe('queued');
    await new Promise((r) => setTimeout(r, 100));
    expect(h.adapter.calls).toHaveLength(0); // no lead turn, no helper run
    await h.svc.stopAgent('next');
    expect(h.svc.store.getAgent('next')!.state).toBe('stopped');
    await h.svc.whenIdle();
    expect(h.adapter.calls).toHaveLength(0); // stopping only stopped agents does not wake the lead either
    h.svc.shutdown();
  });

  it('a resumed agent releases its dependents', async () => {
    const h = await setup([]);
    records(h);
    h.svc.store.setSession({ agentId: 'ghost', cli: 'claude', sessionId: 's-1', updated: 1 });
    h.svc.orchestrator.recover();
    expect(h.svc.store.getAgent('next')!.state).toBe('queued');
    await h.svc.resumeAgentSession('ghost');
    await h.svc.whenIdle();
    expect(h.svc.store.getAgent('ghost')!.state).toBe('done');
    expect(h.svc.store.getAgent('next')!.state).toBe('done');
    h.svc.shutdown();
  }, SLOW);
});

describe('M4: re-running an integration after the target moved', () => {
  const landed = async () => {
    const h = await approvedHelper();
    const started = await h.svc.integrateBranches(h.project.id, [h.find('Write a').id]);
    await h.svc.whenIdle();
    const i = h.svc.store.getAgent(started.id)!;
    expect(i.state).toBe('done');
    return { h, i };
  };

  it('rebuilds on the new target head (resetting only its own branch) and can then be applied', async () => {
    const { h, i } = await landed();
    const oldBase = i.integration!.base!;
    const moved = commit(h.repo, 'other.txt', 'x', 'user commit');
    await expect(h.svc.applyIntegration(i.id)).rejects.toThrow(/main moved since the integration started .*Run the integration again: it rebuilds on the new head/);

    h.calls.length = 0;
    await h.svc.send((await h.svc.openAgentConversation(i.id)).id, 'run again');
    await h.svc.whenIdle();
    expect(i.state).toBe('done');
    expect(i.integration!.base).toBe(moved);
    expect(oldBase).not.toBe(moved);
    expect(i.baseCommit).toBe(moved);
    expect(i.report).toContain('moved since the last run');
    expect(i.integration!.sources[0]!.state).toBe('merged');
    expect(spawnSync('git', ['merge-base', '--is-ancestor', moved, 'HEAD'], { cwd: i.worktree! }).status).toBe(0);
    // The only reset was of Harbor's own integration branch, in its own worktree.
    const resets = h.calls.filter((c) => c.args.includes('reset'));
    expect(resets).toHaveLength(1);
    expect(resets[0]!.cwd).toBe(i.worktree);
    expect(i.branch).toMatch(/^harbor\/integrate-/);

    await h.svc.applyIntegration(i.id);
    expect(git(h.repo, 'rev-parse', 'main')).toBe(i.integration!.head);
    expect(readFileSync(join(h.repo, 'a.txt'), 'utf8')).toBe('A');
    expect(readFileSync(join(h.repo, 'other.txt'), 'utf8')).toBe('x');
    h.svc.shutdown();
  }, SLOW);

  it('skips a source the target already contains after rebuilding', async () => {
    const { h, i } = await landed();
    git(h.repo, 'merge', '-q', '--no-ff', '--no-edit', h.find('Write a').branch!); // the user merged it by hand
    const moved = git(h.repo, 'rev-parse', 'main');
    await h.svc.send((await h.svc.openAgentConversation(i.id)).id, 'run again');
    await h.svc.whenIdle();
    expect(i.state).toBe('done');
    expect(i.report).toContain('already included');
    expect(i.integration!.head).toBe(moved);
    await h.svc.applyIntegration(i.id);
    expect(i.integration!.applied).toBe(true);
    expect(git(h.repo, 'rev-parse', 'main')).toBe(moved);
    h.svc.shutdown();
  }, SLOW);
});

describe('L5: apply re-checks that the run is not running right before the write', () => {
  it('a re-run that starts during apply cancels the ref update', async () => {
    let arm = false, conv = '';
    let svcRef: Awaited<ReturnType<typeof setup>>['svc'] | undefined;
    const hook = async (args: string[]) => {
      // isDirty is the last await before the write: start a re-run of the integration there.
      if (arm && args[0] === 'status' && args.includes('--untracked-files=no')) { arm = false; await svcRef!.send(conv, 'run again'); }
    };
    const h = await approvedHelper({ hook });
    svcRef = h.svc;
    git(h.repo, 'branch', 'release'); // not checked out: applied by compare-and-swap update-ref
    const started = await h.svc.integrateBranches(h.project.id, [h.find('Write a').id], 'release');
    await h.svc.whenIdle();
    const i = h.svc.store.getAgent(started.id)!;
    expect(i.state).toBe('done');
    const before = git(h.repo, 'rev-parse', 'release');
    conv = (await h.svc.openAgentConversation(i.id)).id;
    arm = true;
    h.calls.length = 0;
    await expect(h.svc.applyIntegration(i.id)).rejects.toThrow(/started running again; nothing was changed/);
    expect(h.calls.filter((c) => c.args[0] === 'update-ref')).toEqual([]);
    expect(git(h.repo, 'rev-parse', 'release')).toBe(before);
    await h.svc.whenIdle();
    expect(i.state).toBe('done');
    await h.svc.applyIntegration(i.id);
    expect(git(h.repo, 'rev-parse', 'release')).toBe(i.integration!.head);
    h.svc.shutdown();
  }, SLOW);
});

describe('L10: markOutdated compares worktree paths like reviewersOf', () => {
  it('flags a review whose tested worktree differs only in case and separators', async () => {
    const h = await approvedHelper();
    const a = h.find('Write a'), ra = h.find('Review a');
    expect(ra.outdated).toBe(false);
    ra.testedWorktree = a.worktree!.replace(/\\/g, '/').toUpperCase() + '/';
    h.svc.store.upsertAgent(ra);
    await h.svc.send((await h.svc.openAgentConversation(a.id)).id, 'WRITE late.txt L');
    await h.svc.whenIdle();
    expect(a.headCommit).not.toBe(ra.testedCommit);
    expect(h.svc.store.getAgent(ra.id)!.outdated).toBe(true);
    h.svc.shutdown();
  }, SLOW);
});
