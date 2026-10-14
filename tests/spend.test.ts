import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Chunk } from '../src/main/adapters/types';
import { createHarborService } from '../src/main/service';
import {
  DAY_MS, SPEND_TOOL, WEEK_MS, checksFor, continuePrompt, describeHit, firstHit, liveRunOf, normalizeCeilings, pruneGrants, spendRunOf, statusOf,
  type SpendRun
} from '../src/main/spend';
import { Store } from '../src/main/store';
import { validateInvoke } from '../src/main/ipcValidate';
import type { HarborEvent, Settings } from '../src/shared/api';
import { delegate, harness, isConcierge, isLead, result, say, script } from './hardeningHarness';

const NOW = 1_900_000_000_000;
const base: Settings = { routing: 'auto', cliOverrides: {}, allowFreeReset: 'ask' };
const run = (o: Partial<SpendRun> = {}): SpendRun => ({ projectId: 'p1', time: NOW - 1000, kTokens: 10, minutes: 1, ...o });

describe('spend ceilings (pure)', () => {
  it('builds the checks: task (project value wins), global day/week over all projects, project day/week over that project', () => {
    const s: Settings = { ...base, spendCeilings: { task: { kTokens: 100 }, day: { minutes: 60 } }, projectOverrides: { p1: { spendCeilings: { task: { minutes: 5 }, week: { kTokens: 900 } } } } };
    expect(checksFor(s, 'p1', 't1')).toEqual([
      { scope: 'task', key: 'task:t1', projectId: 'p1', taskId: 't1', limit: { minutes: 5 } },
      { scope: 'day', key: 'day:*', limit: { minutes: 60 } },
      { scope: 'week', key: 'week:p1', projectId: 'p1', limit: { kTokens: 900 } }
    ]);
    expect(checksFor(s, 'p2', 't2').map((c) => [c.key, c.limit])).toEqual([['task:t2', { kTokens: 100 }], ['day:*', { minutes: 60 }]]);
    // No task id (nothing to attribute to): no task check.
    expect(checksFor(s, 'p2').map((c) => c.key)).toEqual(['day:*']);
    expect(checksFor(base, 'p1', 't1')).toEqual([]);
  });

  it('counts a task by its id, a day or week by the rolling window, and a project ceiling by its project', () => {
    const s: Settings = { ...base, spendCeilings: { day: { kTokens: 25 } }, projectOverrides: { p1: { spendCeilings: { day: { kTokens: 15 } } } } };
    const runs = [run({ kTokens: 10 }), run({ projectId: 'p2', kTokens: 10 }), run({ kTokens: 100, time: NOW - DAY_MS - 1 })];
    // The project's own ceiling (10 of 15) holds; the global one sees both projects (20 of 25).
    expect(firstHit(checksFor(s, 'p1'), runs, [], NOW)).toBeUndefined();
    const more = [...runs, run({ projectId: 'p2', kTokens: 6 })];
    expect(firstHit(checksFor(s, 'p1'), more, [], NOW)).toMatchObject({ key: 'day:*', unit: 'kTokens', spent: { kTokens: 26, runs: 3 } });
    // A run older than a week is outside every window, but still part of its task.
    const t = { ...base, spendCeilings: { task: { minutes: 3 }, week: { minutes: 3 } } };
    const old = [run({ taskId: 't', minutes: 2, time: NOW - WEEK_MS - 1 }), run({ taskId: 't', minutes: 1 })];
    expect(firstHit(checksFor(t, 'p1', 't'), old, [], NOW)).toMatchObject({ scope: 'task', spent: { minutes: 3 } });
    expect(firstHit(checksFor(t, 'p1', 'other'), old, [], NOW)).toBeUndefined();
  });

  it('each extension the user allowed adds one limit; day and week extensions expire with their window', () => {
    const s: Settings = { ...base, spendCeilings: { task: { kTokens: 10 }, day: { kTokens: 10 } } };
    const runs = [run({ taskId: 't', kTokens: 15 })];
    expect(firstHit(checksFor(s, 'p1', 't'), runs, [], NOW)?.key).toBe('task:t');
    const grants = [{ id: 'g1', key: 'task:t', time: NOW - 9 * DAY_MS }, { id: 'g2', key: 'day:*', time: NOW - 1000 }];
    expect(firstHit(checksFor(s, 'p1', 't'), runs, grants, NOW)).toBeUndefined();
    expect(firstHit(checksFor(s, 'p1', 't'), runs, [{ id: 'g3', key: 'day:*', time: NOW - DAY_MS - 1 }, grants[0]!], NOW)).toMatchObject({ key: 'day:*', extensions: 0 });
    expect(statusOf(checksFor(s, 'p1', 't'), runs, grants, NOW)).toEqual([
      { scope: 'task', limit: { kTokens: 10 }, threshold: { kTokens: 20 }, spent: { kTokens: 15, minutes: 1, runs: 1, partial: false }, hit: false, extensions: 1 },
      { scope: 'day', limit: { kTokens: 10 }, threshold: { kTokens: 20 }, spent: { kTokens: 15, minutes: 1, runs: 1, partial: false }, hit: false, extensions: 1 }
    ]);
    expect(pruneGrants([...grants, { id: 'old', key: 'week:*', time: NOW - WEEK_MS - 1 }], NOW).map((g) => g.id)).toEqual(['g2']);
  });

  it('measures usage events and runs in flight as billable k-tokens and agent-minutes', () => {
    expect(spendRunOf({ projectId: 'p', taskId: 't', time: NOW, durationMs: 120_000, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 10_000, partial: true }))
      .toEqual({ projectId: 'p', taskId: 't', time: NOW, kTokens: 2.5, minutes: 2, partial: true });
    expect(spendRunOf({ projectId: 'p', time: NOW, durationMs: 60_000 })).toMatchObject({ kTokens: 0, minutes: 1 });
    expect(liveRunOf({ projectId: 'p', now: NOW, elapsedMs: 30_000, tokens: { outputTokens: 2000 } })).toEqual({ projectId: 'p', time: NOW, kTokens: 2, minutes: 0.5, partial: true });
  });

  it('describes a hit as Harbor\'s own estimate, never as the provider\'s quota', () => {
    const s: Settings = { ...base, spendCeilings: { week: { kTokens: 10 } } };
    const hit = firstHit(checksFor(s, 'p1'), [run({ kTokens: 12, partial: true })], [], NOW)!;
    const text = describeHit(hit);
    expect(text).toContain('the all-projects 7-day ceiling of 10k tokens');
    expect(text).toContain('estimate from Harbor\'s own runs');
    expect(text).toContain('lower bound');
    expect(text).toContain('not your provider\'s quota');
    expect(continuePrompt(hit)).toMatch(/Yes allows one more 10k tokens for the next 7 days\. No keeps everything in this scope stopped/);
  });

  it('validates settings: numbers above 0, rounded and clamped; empty limits dropped', () => {
    expect(normalizeCeilings({ task: { kTokens: 99.6 }, day: {}, week: { minutes: 1e12 } })).toEqual({ task: { kTokens: 100 }, week: { minutes: 1_000_000 } });
    expect(normalizeCeilings({ day: {} })).toBeUndefined();
    expect(() => normalizeCeilings({ day: { kTokens: 0 } })).toThrow(/above 0/);
    expect(() => normalizeCeilings({ day: { minutes: 'ten' } })).toThrow(/must be a number/);
    expect(() => normalizeCeilings([1])).toThrow(/task\?, day\?, week\?/);
  });
});

describe('getSpendStatus over IPC', () => {
  it('accepts no ids or short string ids only', () => {
    expect(() => validateInvoke('getSpendStatus', [])).not.toThrow();
    expect(() => validateInvoke('getSpendStatus', ['p1', 'c1'])).not.toThrow();
    expect(() => validateInvoke('getSpendStatus', [5])).toThrow(/project id/);
    expect(() => validateInvoke('getSpendStatus', ['p1', 'a\nb'])).toThrow(/conversation id/);
  });
});

describe('spend settings and persistence (store)', () => {
  const dirs: string[] = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-spend-')); dirs.push(d); return d; };
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

  it('setSettings validates ceilings and allowlists, globally and per project; undefined resets', () => {
    const s = new Store();
    s.setSettings({ spendCeilings: { day: { kTokens: 500 } }, secretAllowlist: [' tests/fixtures/** ', '', 'tests/fixtures/**'], projectOverrides: { p1: { spendCeilings: { task: { minutes: 20 } }, secretAllowlist: ['jwt@docs/**'] } } });
    expect(s.getSettings()).toMatchObject({ spendCeilings: { day: { kTokens: 500 } }, secretAllowlist: ['tests/fixtures/**'], projectOverrides: { p1: { spendCeilings: { task: { minutes: 20 } }, secretAllowlist: ['jwt@docs/**'] } } });
    expect(() => s.setSettings({ spendCeilings: { week: { kTokens: -5 } } })).toThrow();
    expect(() => s.setSettings({ secretAllowlist: 'x' as unknown as string[] })).toThrow(/list/);
    expect(() => s.setSettings({ projectOverrides: { p1: { secretAllowlist: ['a\nb'] } } })).toThrow(/single-line/);
    s.setSettings({ spendCeilings: undefined });
    expect('spendCeilings' in s.getSettings()).toBe(false);
  });

  it('keeps allowed extensions and the spend of runs a crash interrupted across a restart', () => {
    const dir = tmp();
    const a = new Store(dir);
    a.addSpendGrant('day:*');
    a.setSpendFlight('agent:1:0', { projectId: 'p1', taskId: 't', time: Date.now(), kTokens: 42, minutes: 3, partial: true });
    a.flush();
    const b = new Store(dir);
    expect(b.listSpendGrants().map((g) => g.key)).toEqual(['day:*']);
    expect(b.listCarriedSpend()).toEqual([{ projectId: 'p1', taskId: 't', time: expect.any(Number), kTokens: 42, minutes: 3, partial: true }]);
    b.flush();
    // Carried once: the live record became a carried one and is not doubled at the next start.
    expect(new Store(dir).listCarriedSpend()).toHaveLength(1);
  });
});

describe('spend ceilings in the orchestrator', () => {
  const impl = { ref: 'a', title: 'Write a', role: 'implementer', instructions: 'write a', files: ['src/a.ts'] };
  const spendAsks = (events: HarborEvent[]) => events.filter((e): e is Extract<HarborEvent, { type: 'permission' }> => e.type === 'permission' && e.tool === SPEND_TOOL);

  it('stops a helper mid-run at the task ceiling, wakes the lead only after asking, and never answers for the user', async () => {
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl) : say('lead woken')),
      helper: (): Chunk[] => [
        { kind: 'text', text: 'starting' },
        { kind: 'usage', partial: true, messageId: 'm1', inputTokens: 300_000 },
        { kind: 'text', text: `Done\n${result({ outcome: 'done', summary: 'x', checks: [] })}` }
      ]
    }) });
    await h.svc.setSettings({ spendCeilings: { task: { kTokens: 100 } } });
    const answered: boolean[] = [];
    h.svc.onEvent((e) => { if (e.type === 'permission' && e.tool === SPEND_TOOL) { answered.push(false); void h.svc.answerPermission(e.requestId, false); } });
    await h.svc.send(h.conv.id, 'write a');
    await h.svc.whenIdle();

    const a = h.helper('Write a');
    expect(a.state).toBe('stopped');
    expect(a.stopKind).toBe('spend');
    expect(a.error).toMatch(/^Harbor stopped this run: Spend ceiling reached: this request's ceiling of 100k tokens/);
    expect(a.error).toContain('estimate');
    const texts = await h.texts();
    expect(texts.some((t) => t.includes('Harbor stopped the run in this scope; work so far is kept'))).toBe(true);
    // The wake-up turn asked first (one question), the user said no, so the lead did not run again.
    expect(spendAsks(h.events)).toHaveLength(1);
    expect(spendAsks(h.events)[0]!.prompt).toContain('Continue? Yes allows one more 100k tokens for this request');
    expect(answered).toEqual([false]);
    expect(h.calls(isLead)).toHaveLength(1);
    expect(texts.some((t) => t.startsWith('The lead did not start: Spend ceiling reached'))).toBe(true);
    expect(h.svc.orchestrator.journal.list(h.project.id).filter((e) => e.kind === 'spend').length).toBeGreaterThanOrEqual(2);
    // The usage of the stopped run counts (a lower bound), and the status says so.
    const status = await h.svc.getSpendStatus(h.project.id, h.conv.id);
    expect(status.estimate).toBe(true);
    expect(status.entries).toEqual([expect.objectContaining({ scope: 'task', hit: true, spent: expect.objectContaining({ kTokens: 300, partial: true }) })]);
  });

  it('asks before the next run once a day ceiling is reached; a yes is persisted and extends it by one limit', async () => {
    const h = await harness({ claude: script({
      lead: (_p, _o, i) => (i <= 1 ? [{ kind: 'usage', inputTokens: 60_000 }, ...say('worked')] : say('worked again'))
    }) }, { dataDir: true });
    await h.svc.send(h.conv.id, 'first');
    await h.svc.whenIdle();
    await h.svc.setSettings({ spendCeilings: { day: { kTokens: 50 } } });
    h.svc.onEvent((e) => { if (e.type === 'permission' && e.tool === SPEND_TOOL) void h.svc.answerPermission(e.requestId, true); });
    const before = h.calls(isConcierge).length;
    await h.svc.send(h.conv.id, 'second');
    await h.svc.whenIdle();
    expect(spendAsks(h.events)).toHaveLength(1);
    expect(h.calls(isConcierge).length).toBe(before + 1);
    expect((await h.texts()).some((t) => t.startsWith('Continuing: you allowed one more 50k tokens (estimate) for the next 24 hours'))).toBe(true);
    expect((await h.svc.getSpendStatus()).entries).toEqual([expect.objectContaining({ scope: 'day', extensions: 1, hit: false, spent: expect.objectContaining({ kTokens: 60 }) })]);
    await h.svc.shutdown();

    // A restart keeps the counters (usage events) and the extension.
    const again = createHarborService({ dataDir: h.dataDir, discover: async () => [] });
    expect((await again.getSpendStatus()).entries).toEqual([expect.objectContaining({ scope: 'day', extensions: 1, threshold: { kTokens: 100 }, spent: expect.objectContaining({ kTokens: 60 }) })]);
    await again.shutdown();
  });

  it('an unanswered question is a no: nothing runs', async () => {
    const h = await harness({ claude: script({ lead: () => [{ kind: 'usage', inputTokens: 60_000 }, ...say('worked')] }) }, { service: { toolPermissionTimeoutMs: 50 } });
    await h.svc.send(h.conv.id, 'first');
    await h.svc.whenIdle();
    await h.svc.setSettings({ spendCeilings: { week: { minutes: 1, kTokens: 10 } } });
    const calls = h.adapters['claude']!.calls.length;
    await h.svc.send(h.conv.id, 'second');
    await h.svc.whenIdle();
    expect(spendAsks(h.events)).toHaveLength(1);
    expect(h.adapters['claude']!.calls.length).toBe(calls);
    const texts = await h.texts();
    expect(texts.some((t) => t.includes('No answer within') && t.includes(SPEND_TOOL))).toBe(true);
    expect(texts.some((t) => t.startsWith('Not answered: Spend ceiling reached'))).toBe(true);
  });
});

describe('Agent.stopKind (contract 0.1.42)', () => {
  it('toAgent exposes who stopped a stopped agent, and nothing otherwise', async () => {
    const { toAgent } = await import('../src/main/orchestrator');
    const base = { id: 'a1', projectId: 'p1', role: 'implementer', title: 't', state: 'stopped', cli: 'claude', model: 'm', effort: 'medium', revision: 1 } as unknown as Parameters<typeof toAgent>[0];
    expect(toAgent({ ...base, stopKind: 'spend' }).stopKind).toBe('spend');
    expect(toAgent({ ...base, stopKind: 'loop' }).stopKind).toBe('loop');
    expect('stopKind' in toAgent({ ...base })).toBe(false);
    expect('stopKind' in toAgent({ ...base, state: 'working', stopKind: 'cap' } as typeof base)).toBe(false);
  });
});
