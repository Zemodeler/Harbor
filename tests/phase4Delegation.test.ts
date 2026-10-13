import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '../src/main/clis/capabilities';
import type { AgentRecord } from '../src/main/types';
import { delegate, gitRepo, harness, isHelper, isLead, result, say, script } from './hardeningHarness';
import { calmReported } from './fixtures/calmReadings';

// Phase 4 items 1, 5, 6a, 6c and 7: the size gate and plan estimate, the dirty base, reviewer binding, the automatic review and the
// quota-driven helper limit.

const done = (summary = 'Done.') => `Done\n${result({ outcome: 'done', summary, checks: [] })}`;
const impl = (ref: string, over: Record<string, unknown> = {}) => ({ ref, title: `Write ${ref}`, role: 'implementer', instructions: `write ${ref}`, files: [`src/${ref}.ts`], ...over });

describe('size gate and plan estimate', () => {
  it('refuses a catch-all edit task and what waits on it, tells the lead how to split, and never refuses read-only work', async () => {
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go',
        impl('big', { title: 'Consolidate and correct the complete repair diff' }),
        impl('after', { dependsOn: ['big'] }),
        { ref: 'look', title: 'Finish consolidated release validation', role: 'other', access: 'read', instructions: 'list what is left to validate' },
        impl('small')) : say('ok')),
      helper: () => say(done())
    }) });
    await h.svc.send(h.conv.id, 'repair it');
    await h.svc.whenIdle();
    const titles = h.helpers().map((a) => a.title).sort();
    expect(titles).toEqual(['Finish consolidated release validation', 'Write small']);
    const texts = await h.texts();
    expect(texts.some((t) => t.startsWith('Harbor did not start 2 delegation(s)') && t.includes('catch-all') && t.includes('depends on a task Harbor did not start'))).toBe(true);
    const notice = h.calls(isLead).find((c) => c.prompt.includes('Notice from Harbor'));
    expect(notice!.prompt).toContain('Consolidate and correct the complete repair diff');
    expect(notice!.prompt).toMatch(/one concern per helper, the exact files it edits/);
  });

  it('posts one plan estimate per delegation turn and stores each helper\'s estimate', async () => {
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('a'), impl('b'), { ref: 'r', title: 'Review a', role: 'reviewer', instructions: 'review a', dependsOn: ['a'] }) : say('ok')),
      helper: () => say(done())
    }) }, { service: { ledger: { reported: calmReported } } });
    await h.svc.send(h.conv.id, 'write a and b');
    await h.svc.whenIdle();
    const eta = (await h.texts()).filter((t) => t.startsWith('Plan estimate: about'));
    expect(eta).toHaveLength(1);
    // Phase 5: a small review is now estimated under a minute (measured priors: 25 k-tokens), which prints as "<1 min".
    expect(eta[0]).toMatch(/with up to 3 helper\(s\) at once \(longest chain ~\d+ min\)\. Per task: 1\. Write a ~\d+ min; 2\. Write b ~\d+ min; 3\. Review a (~\d+|<1) min/);
    for (const a of h.helpers()) expect(a.estimatedMinutes).toBeGreaterThan(0);
    expect((await h.svc.listAgents(h.project.id)).find((a) => a.title === 'Write a')!.estimatedMinutes).toBeGreaterThan(0);
  });
});

describe('uncommitted edits in the project folder', () => {
  it('holds a helper whose files overlap them and tells the lead its options; others start', async () => {
    const repo = gitRepo();
    writeFileSync(join(repo, 'README.md'), 'edited but not committed');
    writeFileSync(join(repo, 'scratch.ts'), 'untracked work');
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('readme', { files: ['README.md'] }), impl('scratch', { files: ['scratch.ts'] }), impl('free', { files: ['src/free.ts'] })) : say('ok')),
      helper: () => say(done())
    }) }, { git: repo });
    await h.svc.send(h.conv.id, 'update the docs');
    await h.svc.whenIdle();
    expect(h.helpers().map((a) => a.title)).toEqual(['Write free']);
    const notice = h.calls(isLead).find((c) => c.prompt.includes('Notice from Harbor'))!.prompt;
    expect(notice).toContain('"Write readme": its files overlap uncommitted edits in the project folder (README.md)');
    expect(notice).toContain('"Write scratch": its files overlap uncommitted edits in the project folder (scratch.ts)');
    expect(notice).toMatch(/Commit those files first and delegate it again, narrow its "files" to exclude them, or delegate it with "access":"read"/);
    // A whole-project claim is not held for an untracked file alone.
    const repo2 = gitRepo();
    writeFileSync(join(repo2, 'scratch.ts'), 'untracked work');
    const h2 = await harness({ claude: script({ lead: (p) => (p.includes('User:') ? delegate('go', impl('all', { files: [] })) : say('ok')), helper: () => say(done()) }) }, { git: repo2 });
    await h2.svc.send(h2.conv.id, 'do it');
    await h2.svc.whenIdle();
    expect(h2.helper('Write all').state).toBe('done');
  });
});

describe('reviewers', () => {
  it('binds a reviewer without dependsOn to the one edit helper of the turn', async () => {
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('a'), { ref: 'r', title: 'Review it', role: 'reviewer', instructions: 'review the change' }) : say('ok')),
      helper: (p, o) => (o.permission === 'edit' ? (writeFileSync(join(o.cwd, 'a.txt'), 'x'), say(done())) : say(`ok\n${result({ outcome: 'done', summary: 'fine', verdict: 'approve', checks: [] })}`))
    }) });
    await h.svc.send(h.conv.id, 'write a');
    await h.svc.whenIdle();
    const r = h.helper('Review it');
    expect(r.dependsOn).toEqual([h.helper('Write a').id]);
    expect(r.state).toBe('done');
    expect(r.testedCommit).toBe(h.helper('Write a').headCommit);
    expect((await h.texts()).some((t) => t.startsWith('Harbor bound the reviewer "Review it" to "Write a"'))).toBe(true);
  });

  it('refuses it with the candidate ids when more than one change could be meant', async () => {
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('a'), impl('b'), { ref: 'r', title: 'Review it', role: 'reviewer', instructions: 'review the change' }) : say('ok')),
      helper: () => say(done())
    }) });
    await h.svc.send(h.conv.id, 'write a and b');
    await h.svc.whenIdle();
    const r = h.helper('Review it');
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/depends on no helper.*Candidates: ref a \("Write a"\), ref b \("Write b"\)/);
    expect(h.calls(isHelper).every((c) => !c.prompt.includes('Review it'))).toBe(true);
  });

  it('schedules one review by itself when routing says the model only just clears hard work', async () => {
    // One model that clears difficulty 7.5 only at high effort: the router flags needsReview.
    const catalog: CatalogEntry[] = [{ cli: 'claude', model: 'default', tier: 'standard', strengths: ['code', 'review'], capability: { code: 4, review: 4 }, costPerKTok: 1 }];
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('lease', { title: 'Fix the lease race', instructions: 'fix the race condition in the lease transaction', complexity: 'high', reason: 'concurrency bug', files: ['src/lease.ts', 'src/tx.ts'] })) : say('ok')),
      helper: (p, o) => (o.permission === 'edit' ? (writeFileSync(join(o.cwd, 'lease.txt'), 'x'), say(done())) : say(`ok\n${result({ outcome: 'done', summary: 'fine', verdict: 'approve', checks: [] })}`))
    }) }, { service: { catalog } });
    await h.svc.send(h.conv.id, 'fix the lease race');
    await h.svc.whenIdle();
    const impl1 = h.helper('Fix the lease race');
    expect(impl1.needsReview).toBe(true);
    const reviews = h.helpers().filter((a) => a.role === 'reviewer');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ autoReviewOf: impl1.id, dependsOn: [impl1.id], readOnly: true, state: 'done' });
    expect(reviews[0]!.difficulty).toBeLessThanOrEqual(5);
    // The lead hears once, with both reports.
    const reportTurns = h.calls(isLead).filter((c) => c.prompt.includes('Helper reports'));
    expect(reportTurns).toHaveLength(1);
    expect(reportTurns[0]!.prompt).toContain('Review "Fix the lease race"');
  });
});

describe('helpers at once follow the quota budget', () => {
  it('holds queued helpers while every pool is exhausted and pumps again at the reset', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const h = await harness({}, { service: { setTimer: (fn, ms) => { timers.push({ fn, ms }); return () => {}; } } });
    const now = Date.now();
    const resetsAt = now + 2 * 3_600_000;
    h.svc.store.addUsage({ id: 'u1', time: now - 60_000, cli: 'claude', model: 'claude-sonnet-5-5', projectId: h.project.id, agentId: 'x', durationMs: 1, ok: true,
      limits: [{ period: 'weekly', usedPct: 100, resetsAt, asOf: now - 60_000 }, { period: 'session', usedPct: 100, resetsAt, asOf: now - 60_000 }] });
    h.svc.store.upsertAgent({
      id: 'held-1', projectId: h.project.id, role: 'other', readOnly: true, title: 'Look around', state: 'queued', cli: 'auto', model: 'auto', effort: 'low',
      task: 'look', dependsOn: [], revision: 1, parentConversationId: h.conv.id, attempts: 0, created: now
    } satisfies AgentRecord);
    h.svc.orchestrator.pump(h.project.id);
    const a = h.svc.store.getAgent('held-1')!;
    expect(a.state).toBe('queued');
    expect(a.error).toMatch(/^Waiting: every quota pool Harbor can use is exhausted until about/);
    expect((await h.texts()).filter((t) => t.startsWith('Every quota pool Harbor can use is exhausted'))).toHaveLength(1);
    expect(timers.some((t) => t.ms > 2 * 3_600_000 - 120_000 && t.ms <= 2 * 3_600_000 + 1_000)).toBe(true);
    h.svc.orchestrator.pump(h.project.id); // a second pump does not repeat the notice or arm another timer
    expect((await h.texts()).filter((t) => t.startsWith('Every quota pool Harbor can use is exhausted'))).toHaveLength(1);
    expect(timers.filter((t) => t.ms > 3_600_000)).toHaveLength(1);
    h.svc.store.patchAgent('held-1', { state: 'stopped', stopKind: 'user' });
  });
});
