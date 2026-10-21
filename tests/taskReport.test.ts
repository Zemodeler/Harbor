import { describe, expect, it } from 'vitest';
import type { Conversation, Message } from '../src/shared/api';
import { DEFAULT_CATALOG } from '../src/main/clis/capabilities';
import { buildTaskReport, decisionsOf, runQuota } from '../src/main/taskReport';
import { createHarborService } from '../src/main/service';
import type { AgentRecord, UsageEvent } from '../src/main/types';

const T = 1_800_000_000_000;
const agent = (id: string, role: AgentRecord['role'], extra: Partial<AgentRecord> = {}): AgentRecord => ({
  id, projectId: 'p', role, title: id, state: 'done', cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', task: 't', dependsOn: [], revision: 0,
  attempts: 0, created: T, parentConversationId: 'c1', ...extra
});
const ev = (id: string, agentId: string, extra: Partial<UsageEvent> = {}): UsageEvent => ({
  id, time: T + 60_000, cli: 'claude', model: 'claude-sonnet-5-5', projectId: 'p', agentId, durationMs: 60_000, ok: true, inputTokens: 10_000, outputTokens: 1_000, ...extra
});
const conv: Conversation = { id: 'c1', projectId: 'p', title: 'x', updated: T, agentId: 'lead' };

describe('task report (pure)', () => {
  it('estimates quota per pool and window from the run\'s own billable tokens, and never invents it', () => {
    const q = runQuota({ cli: 'claude', model: 'claude-opus-5-5', inputTokens: 10_000, outputTokens: 0 }, DEFAULT_CATALOG)!;
    // Opus draws on its own pool and the account pool, each with a 5h and a weekly window.
    expect(q.map((x) => `${x.pool}|${x.period}`).sort()).toEqual(['claude:all|session', 'claude:all|weekly', 'claude:opus|session', 'claude:opus|weekly']);
    expect(q.every((x) => x.pct > 0)).toBe(true);
    // Twice the tokens, twice the estimate.
    const q2 = runQuota({ cli: 'claude', model: 'claude-opus-5-5', inputTokens: 20_000, outputTokens: 0 }, DEFAULT_CATALOG)!;
    expect(q2[0]!.pct).toBeCloseTo(q[0]!.pct * 2, 10);
    expect(runQuota({ cli: 'claude', model: 'claude-opus-5-5' }, DEFAULT_CATALOG)).toBeUndefined();
  });

  it('counts the lead only for this conversation and every helper of it, with totals, per agent and per model', () => {
    const agents = [agent('lead', 'main'), agent('impl', 'implementer', { title: 'Write it' }), agent('rev', 'reviewer', { title: 'Review it' }), agent('other', 'implementer', { parentConversationId: 'c2' }), agent('queued', 'planner', { state: 'queued', title: 'Plan' })];
    const usage = [
      ev('u1', 'lead', { conversationId: 'c1', time: T + 60_000, durationMs: 60_000 }),
      ev('u2', 'lead', { conversationId: 'c2' }), // another conversation's lead turn
      ev('u3', 'impl', { time: T + 5 * 60_000, durationMs: 3 * 60_000, model: 'claude-haiku-5-5', cacheReadTokens: 100_000 }),
      ev('u4', 'rev', { time: T + 7 * 60_000, durationMs: 60_000, ok: false, partial: true }),
      ev('u5', 'rev', { time: T + 8 * 60_000, durationMs: 60_000, inputTokens: undefined, outputTokens: undefined, costUsd: 0.5 }),
      ev('u6', 'other', {})
    ];
    const r = buildTaskReport({ conversation: conv, agents, usage, messages: [], catalog: DEFAULT_CATALOG, now: T + 10 * 60_000, keepMs: 8 * 86_400_000 });
    expect(r.runs.map((x) => x.id)).toEqual(['u1', 'u3', 'u4', 'u5']);
    expect(r.totals).toMatchObject({ runs: 4, failedRuns: 1, partialRuns: 1, runsWithoutTokens: 1, inputTokens: 30_000, outputTokens: 3_000, cacheReadTokens: 100_000, costUsd: 0.5 });
    // 3 x 11k plus a tenth of the cache reads.
    expect(r.totals.billableKTok).toBe(43);
    expect(r.totals.agentMinutes).toBe(6);
    // First run started at T, the last ended at T + 8 min.
    expect(r.totals.wallMinutes).toBe(8);
    expect(r.totals.quota.find((q) => q.pool === 'claude:all' && q.period === 'weekly')!.pct).toBeGreaterThan(0);
    expect(r.agents.map((a) => [a.title, a.runs])).toEqual([['Lead', 1], ['Plan', 0], ['Write it', 1], ['Review it', 2]]);
    expect(r.byModel.map((m) => `${m.cli}/${m.model}:${m.runs}:${m.roles.join('+')}`)).toEqual(['claude/claude-sonnet-5-5:3:main+reviewer', 'claude/claude-haiku-5-5:1:implementer']);
    expect(r.runs.find((x) => x.id === 'u5')).toMatchObject({ noTokens: true, quota: [] });
    expect(r.notes.join('\n')).toMatch(/estimates/);
    expect(r.notes.join('\n')).toMatch(/1 run\(s\) reported no token counts/);
    expect(r.notes.join('\n')).toMatch(/lower bound/);
    expect(r.notes.join('\n')).not.toMatch(/days:/);
  });

  it("reports a helper's own conversation as that helper alone, and says when old runs were pruned", () => {
    const agents = [agent('lead', 'main'), agent('impl', 'implementer'), agent('rev', 'reviewer')];
    const usage = [ev('u1', 'lead', { conversationId: 'h1' }), ev('u2', 'impl'), ev('u3', 'rev')];
    const r = buildTaskReport({ conversation: { ...conv, id: 'h1', agentId: 'impl' }, agents, usage, messages: [{ id: 'm', conversationId: 'h1', role: 'user', text: 'x', time: T }], catalog: DEFAULT_CATALOG, now: T + 30 * 86_400_000, keepMs: 8 * 86_400_000 });
    expect(r.runs.map((x) => x.id)).toEqual(['u2']);
    expect(r.notes.join('\n')).toMatch(/keeps run records for 8 days/);
  });

  it('lists each routing decision once, with the price the router gave the chosen option', () => {
    const details = { cli: 'claude', model: 'claude-haiku-5-5', effort: 'low', reason: 'r', difficulty: 2, scored: [{ cli: 'claude', model: 'claude-haiku-5-5', score: 90, terms: {}, price: 0.012 }] };
    const msgs: Message[] = [
      { id: 'a', conversationId: 'c1', role: 'assistant', text: 'part 1', time: T + 2, agentId: 'lead', details },
      { id: 'b', conversationId: 'c1', role: 'assistant', text: 'part 2', time: T + 3, agentId: 'lead', details: { ...details } },
      { id: 'c', conversationId: 'c1', role: 'user', text: 'hi', time: T + 1 }
    ];
    expect(decisionsOf(msgs)).toEqual([{ messageId: 'a', agentId: 'lead', time: T + 2, cli: 'claude', model: 'claude-haiku-5-5', effort: 'low', difficulty: 2, price: 0.012 }]);
  });
});

describe('getTaskReport (service)', () => {
  it('reports the runs recorded for a conversation and rejects an unknown one', async () => {
    const svc = createHarborService({ discover: async () => [] });
    const project = svc.store.upsertProject({ id: 'p', name: 'p', path: 'C:/nowhere', lastOpened: T });
    svc.store.upsertAgent(agent('lead', 'main'));
    svc.store.upsertAgent(agent('impl', 'implementer'));
    svc.store.addConversation({ ...conv, projectId: project.id });
    const now = Date.now();
    svc.store.addUsage(ev('u1', 'lead', { conversationId: 'c1', time: now }));
    svc.store.addUsage(ev('u2', 'impl', { time: now }));
    const r = await svc.getTaskReport('c1');
    expect(r).toMatchObject({ conversationId: 'c1', projectId: 'p', totals: { runs: 2, inputTokens: 20_000 } });
    await expect(svc.getTaskReport('missing')).rejects.toThrow(/no longer available/);
    await svc.shutdown();
  });
});

describe('task report per request and per day', () => {
  const DAY = 86_400_000;
  const msg = (id: string, text: string): Message => ({ id, conversationId: 'c1', role: 'user', text, time: T } as Message);

  it('splits the totals by request and by day with the numbers the spend ceilings count, retries and fallbacks included', () => {
    const agents = [agent('lead', 'main'), agent('impl', 'implementer')];
    const usage = [
      ev('u1', 'lead', { conversationId: 'c1', taskId: 'm1', time: T }),
      // The first attempt failed on a limit and the retry ran on another CLI: both are runs of the same request.
      ev('u2', 'impl', { taskId: 'm1', time: T + 60_000, ok: false, rateLimited: true, inputTokens: 5_000, outputTokens: 0 }),
      ev('u3', 'impl', { taskId: 'm1', time: T + 120_000, cli: 'codex', model: 'gpt-6', costUsd: 0.25 }),
      ev('u4', 'lead', { conversationId: 'c1', taskId: 'm2', time: T + 2 * DAY, partial: true }),
      ev('u5', 'lead', { conversationId: 'c1', time: T + 3 * DAY }) // recorded before requests were tracked
    ];
    const r = buildTaskReport({ conversation: conv, agents, usage, messages: [msg('m1', 'Add  the\nlogin page'), msg('m2', 'Now the tests')], catalog: DEFAULT_CATALOG, now: T + 4 * DAY });
    expect(r.estimate).toBe(true);
    expect(r.requests!.map((q) => [q.taskId, q.label, q.runs, q.failedRuns, q.partial])).toEqual([['m1', 'Add the login page', 3, 1, false], ['m2', 'Now the tests', 1, 0, true], [undefined, undefined, 1, 0, false]]);
    expect(r.requests![0]).toMatchObject({ kTokens: 11 + 5 + 11, costUsd: 0.25 });
    expect(r.days!.map((d) => d.runs)).toEqual([3, 1, 1]);
    // Both splits add up to the report's own totals.
    for (const split of [r.requests!, r.days!]) {
      expect(split.reduce((s, x) => s + x.runs, 0)).toBe(r.totals.runs);
      expect(Math.round(split.reduce((s, x) => s + x.kTokens, 0) * 1e4) / 1e4).toBe(r.totals.billableKTok);
      expect(Math.round(split.reduce((s, x) => s + x.minutes, 0) * 10) / 10).toBe(r.totals.agentMinutes);
    }
    expect(r.notes.some((n) => /retry or a fallback/.test(n))).toBe(true);
  });

  it('an empty conversation has empty splits', () => {
    const r = buildTaskReport({ conversation: conv, agents: [agent('lead', 'main')], usage: [], messages: [], catalog: DEFAULT_CATALOG, now: T });
    expect(r.requests).toEqual([]);
    expect(r.days).toEqual([]);
  });
});
