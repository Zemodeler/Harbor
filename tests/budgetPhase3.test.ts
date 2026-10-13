import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { calibrate, tokensKey } from '../src/main/calibration';
import { DEFAULT_CATALOG } from '../src/main/clis/capabilities';
import { conversationUrgency, criticalPathMinutes } from '../src/main/deadline';
import { COMPLEXITY_DIFFICULTY, complexityOf, difficultyOf } from '../src/main/difficulty';
import { validateInvoke } from '../src/main/ipcValidate';
import { calibrationSample } from '../src/main/runCalibration';
import { Store } from '../src/main/store';
import type { UsageEvent } from '../src/main/types';
import { INVOKE_METHODS } from '../src/shared/ipc';
import { harness, isLead, say, script } from './hardeningHarness';

const NOW = 50_000_000_000;
const MIN = 60_000, HOUR = 60 * MIN;
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('difficultyOf', () => {
  it('starts from the hint and moves by named signals, in half steps', () => {
    const base = difficultyOf({ role: 'implementer', hint: 'medium', text: 'Add a retry with backoff to the fetch helper and a test for it. Keep the public signature unchanged so that none of the existing callers need to be touched, and log each retry at debug level.', files: ['src/fetch.ts', 'tests/fetch.test.ts'] });
    expect(base.difficulty).toBe(5);
    expect(base.signals[0]).toBe('hint medium = 5');
    const one = difficultyOf({ role: 'implementer', hint: 'medium', text: 'Fix the typo in src/a.ts', files: ['src/a.ts'] });
    expect(one.difficulty).toBe(3.5); // -1 one file, -0.5 short
    expect(one.size).toBe('small');
    const wide = difficultyOf({ role: 'implementer', hint: 'medium', text: 'x'.repeat(2000) + ' implement it', files: Array.from({ length: 9 }, (_, i) => `f${i}.ts`) });
    expect(wide.difficulty).toBe(7); // +2 files, +0.5 long; then capped: no risk words
    expect(wide.size).toBe('large');
    expect(wide.signals.some((s) => s.startsWith('capped at 7'))).toBe(true);
  });
  it('reads the wording when there is no hint, and adds ambiguity and verification', () => {
    const d = difficultyOf({ role: 'implementer', text: 'something about the thing', verify: true });
    expect(d.signals).toEqual(expect.arrayContaining([expect.stringMatching(/^wording /), '+0.5 no files named', '+0.5 no deliverable named', '+0.5 checks will verify it']));
  });
  it('an implementer that follows a planner\'s spec is a step easier; reviewers and read-only helpers stay at or under 5', () => {
    const spec = difficultyOf({ role: 'implementer', hint: 'high', text: 'Implement the plan for src/a.ts and src/b.ts', files: ['src/a.ts', 'src/b.ts'], hasSpec: true });
    const own = difficultyOf({ role: 'implementer', hint: 'high', text: 'Implement the plan for src/a.ts and src/b.ts', files: ['src/a.ts', 'src/b.ts'] });
    expect(spec.difficulty).toBe(own.difficulty - 1);
    expect(difficultyOf({ role: 'reviewer', hint: 'high', text: 'Review the security of the auth migration and the race in the lock code', files: [] }).difficulty).toBe(5);
    expect(difficultyOf({ role: 'other', readOnly: true, hint: 'high', text: 'Research the schema migration and the transaction locks', files: [] }).difficulty).toBe(5);
  });
  it('labels: <= 3 low, <= 6 medium, else high; a bare label maps to 2 / 5 / 8', () => {
    expect([0, 3, 3.5, 6, 6.5, 10].map(complexityOf)).toEqual(['low', 'low', 'medium', 'medium', 'high', 'high']);
    expect(COMPLEXITY_DIFFICULTY).toEqual({ low: 2, medium: 5, high: 8 });
  });
});

describe('calibration: samples, persistence, feed', () => {
  const event = (over: Partial<UsageEvent> = {}): UsageEvent => ({
    id: 'u', time: NOW, cli: 'claude', model: 'claude-sonnet-5-5', projectId: 'p', agentId: 'a', durationMs: 10 * MIN, ok: true,
    inputTokens: 80_000, outputTokens: 20_000, limits: [{ period: 'weekly', usedPct: 12, resetsAt: NOW + 50 * HOUR, asOf: NOW }], ...over
  });
  it('a sample pairs the run\'s readings with the ones just before it (same window), and carries role, size and effort', () => {
    const before = [
      { period: 'weekly' as const, usedPct: 10, resetsAt: NOW + 50 * HOUR, asOf: NOW - 20 * MIN },
      { period: 'weekly' as const, usedPct: 8, resetsAt: NOW + 50 * HOUR, asOf: NOW - 2 * HOUR },
      { period: 'weekly' as const, usedPct: 1, resetsAt: NOW - HOUR, asOf: NOW - 9 * HOUR } // an older window
    ];
    const s = calibrationSample({ event: event(), role: 'implementer', size: 'medium', effort: 'medium', before, start: NOW - 10 * MIN });
    expect(s).toMatchObject({ role: 'implementer', size: 'medium', effort: 'medium', ok: true, inputTokens: 80_000, quota: [{ period: 'weekly', beforePct: 10, afterPct: 12 }] });
    expect(calibrationSample({ event: event({ ok: false, partial: true }), role: 'implementer', before: [], start: NOW }).partial).toBe(true);
  });
  it('the store persists it as an optional field; an old state file without it loads unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor-cal-')); dirs.push(dir);
    const old = new Store(dir); old.flush();
    const raw = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as Record<string, unknown>;
    expect(raw['calibration']).toBeUndefined();
    writeFileSync(join(dir, 'state.json'), JSON.stringify(raw));
    const s = new Store(dir);
    expect(s.getCalibration()).toBeUndefined();
    const cal = calibrate([calibrationSample({ event: event(), role: 'implementer', size: 'medium', effort: 'medium', before: [], start: NOW })]);
    s.setCalibration(cal); s.flush();
    expect(new Store(dir).getCalibration()).toEqual(cal);
    // A malformed value is ignored rather than trusted.
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...raw, calibration: { version: 9 } }));
    expect(new Store(dir).getCalibration()).toBeUndefined();
  });
  it('the orchestrator folds every finished run into it, and the router reads it back', async () => {
    const h = await harness({ claude: script({ lead: () => [{ kind: 'usage', inputTokens: 90_000, outputTokens: 30_000 }, { kind: 'text', text: 'done' }] }) });
    await h.svc.send(h.conv.id, 'fix the bug in src/app.ts');
    await h.svc.whenIdle();
    const cal = h.svc.store.getCalibration();
    expect(cal).toBeDefined();
    expect(cal!.tokensK[tokensKey('other', 'medium')]?.n ?? cal!.tokensK[tokensKey('other', 'small')]?.n).toBe(1);
    // Minutes need a measurable duration; a fake run can finish within the same millisecond (budget.test.ts covers minutes).
  });
});

describe('deadline', () => {
  it('urgency is 0 without a deadline and rises as the deadline nears the estimated critical path', () => {
    const work = [{ role: 'implementer' as const, size: 'medium' as const }, { role: 'reviewer' as const, size: 'small' as const }];
    const minutes = criticalPathMinutes({ work, catalog: DEFAULT_CATALOG });
    expect(minutes).toBeGreaterThan(0);
    expect(conversationUrgency({ now: NOW, work, catalog: DEFAULT_CATALOG }).urgency).toBe(0);
    expect(conversationUrgency({ deadline: NOW + 10 * minutes * MIN, now: NOW, work, catalog: DEFAULT_CATALOG }).urgency).toBe(0);
    const mid = conversationUrgency({ deadline: NOW + 1.5 * minutes * MIN, now: NOW, work, catalog: DEFAULT_CATALOG }).urgency;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(conversationUrgency({ deadline: NOW, now: NOW, work, catalog: DEFAULT_CATALOG }).urgency).toBe(1);
  });
  it('setConversationDeadline is part of the IPC contract and validated', () => {
    expect(INVOKE_METHODS).toContain('setConversationDeadline');
    expect(() => validateInvoke('setConversationDeadline', ['c1', NOW])).not.toThrow();
    expect(() => validateInvoke('setConversationDeadline', ['c1', null])).not.toThrow();
    for (const bad of [['c1', 'tomorrow'], ['c1', -5], ['c1', Number.NaN], ['', NOW], ['c1', undefined]]) expect(() => validateInvoke('setConversationDeadline', bad)).toThrow(/Invalid request/);
  });
  it('sets and clears the deadline, and a near one reaches the routing reason', async () => {
    const h = await harness({ claude: script({ lead: () => say('done') }) });
    const set = await h.svc.setConversationDeadline(h.conv.id, Date.now() + 5 * MIN);
    expect(set.deadline).toBeGreaterThan(Date.now());
    expect(h.events.some((e) => e.type === 'conversation' && e.conversation.id === h.conv.id && e.conversation.deadline !== undefined)).toBe(true);
    await h.svc.send(h.conv.id, 'fix the bug in src/app.ts');
    await h.svc.whenIdle();
    const lead = (await h.messages()).find((m) => m.role === 'assistant' && m.details && h.calls(isLead).length)!;
    expect(lead.details!.reason).toMatch(/deadline urgency [\d.]+: reserve released in part, time priced/);
    const cleared = await h.svc.setConversationDeadline(h.conv.id, null);
    expect(cleared.deadline).toBeUndefined();
    expect((await h.svc.listConversations(h.project.id)).find((c) => c.id === h.conv.id)!.deadline).toBeUndefined();
    await expect(h.svc.setConversationDeadline('nope', null)).rejects.toThrow(/no longer available/);
    await expect(h.svc.setConversationDeadline(h.conv.id, -1)).rejects.toThrow(/deadline must be/);
  });
});
