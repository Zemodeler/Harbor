import { describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/main/types';
import { harness, isHelper, until } from './hardeningHarness';

/**
 * Phase 5 in the orchestrator: a helper that no model can take only for now (its capable models have too little quota left above
 * the reserve for the run) goes back to the queue until the reset instead of failing, nothing runs, and later pumps do not restart
 * it before then. Readings arrive as a CLI would print them.
 */
describe('a helper held for quota', () => {
  it('waits in the queue (not failed, nothing run) while its capable models lack room for the run, and is not restarted early', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const h = await harness({}, { git: false, service: { setTimer: (fn, ms) => { timers.push({ fn, ms }); return () => {}; } } });
    const now = Date.now();
    const weekReset = now + 100 * 3_600_000;
    // 84.5% of the week used with 100h to go: 0.5% above the 15% reserve. Not exhausted, but a hard large run does not fit in it.
    h.svc.store.addUsage({ id: 'u1', time: now - 60_000, cli: 'claude', model: 'claude-sonnet-5-5', projectId: h.project.id, agentId: 'x', durationMs: 1, ok: true,
      limits: [{ period: 'weekly', usedPct: 84.5, resetsAt: weekReset, asOf: now - 60_000 }, { period: 'session', usedPct: 10, resetsAt: now + 3_600_000, asOf: now - 60_000 }] });
    h.svc.store.upsertAgent({
      id: 'held-2', projectId: h.project.id, role: 'other', readOnly: true, title: 'Trace the lease race', state: 'queued', cli: 'auto', model: 'auto', effort: 'high',
      task: 'find the root cause of the race in the lease code', dependsOn: [], revision: 1, parentConversationId: h.conv.id, attempts: 0, created: now,
      difficulty: 8, size: 'large', complexity: 'high'
    } satisfies AgentRecord);
    h.svc.orchestrator.pump(h.project.id);
    await until(() => /^Waiting: too little quota is left above the reserve for this helper until about/.test(h.svc.store.getAgent('held-2')!.error ?? ''));
    const a = h.svc.store.getAgent('held-2')!;
    expect(a.state).toBe('queued');
    expect(h.calls(isHelper)).toHaveLength(0);
    expect(timers.some((t) => t.ms > 99 * 3_600_000)).toBe(true); // pumps again at the weekly reset
    // Another pump before then does not start it again (no second assignment message, still queued).
    h.svc.orchestrator.pump(h.project.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.svc.store.getAgent('held-2')!.state).toBe('queued');
    expect((await h.texts()).filter((t) => t.startsWith('Assignment (other'))).toHaveLength(1);
    h.svc.store.patchAgent('held-2', { state: 'stopped', stopKind: 'user' });
  });

  // Review finding: a follow-up (resume, lead reply, direct message) that routing held was marked failed ("No eligible CLI").
  it('a follow-up that is held waits in the queue with its text instead of failing', async () => {
    const h = await harness({}, { git: false, service: { setTimer: () => () => {} } });
    const now = Date.now();
    h.svc.store.addUsage({ id: 'u1', time: now - 60_000, cli: 'claude', model: 'claude-sonnet-5-5', projectId: h.project.id, agentId: 'x', durationMs: 1, ok: true,
      limits: [{ period: 'weekly', usedPct: 84.5, resetsAt: now + 100 * 3_600_000, asOf: now - 60_000 }, { period: 'session', usedPct: 10, resetsAt: now + 3_600_000, asOf: now - 60_000 }] });
    h.svc.store.upsertAgent({
      id: 'held-3', projectId: h.project.id, role: 'other', readOnly: true, title: 'Trace the lease race', state: 'done', cli: 'auto', model: 'auto', effort: 'high',
      task: 'find the root cause of the race in the lease code', dependsOn: [], revision: 1, parentConversationId: h.conv.id, attempts: 0, created: now,
      difficulty: 8, size: 'large', complexity: 'high'
    } satisfies AgentRecord);
    const o = h.svc.orchestrator as unknown as { followUp(a: AgentRecord, t: string): void; heldFollowUps: Map<string, string> };
    o.followUp(h.svc.store.getAgent('held-3')!, 'Finish the lease fix.');
    await until(() => h.svc.store.getAgent('held-3')!.state === 'queued' && o.heldFollowUps.has('held-3'));
    expect(o.heldFollowUps.get('held-3')).toBe('Finish the lease fix.');
    expect(h.svc.store.getAgent('held-3')!.error).toMatch(/^Waiting: too little quota/);
    expect(h.calls(isHelper)).toHaveLength(0);
    h.svc.store.patchAgent('held-3', { state: 'stopped', stopKind: 'user' });
  });
});
