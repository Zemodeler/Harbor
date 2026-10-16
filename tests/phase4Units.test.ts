import { describe, expect, it } from 'vitest';
import { MAX_LEAD_ASKS, routeAsk, safeDefault } from '../src/main/askRouting';
import { MAX_HELPERS_CAP, poolState, type PoolState } from '../src/main/budget';
import { DEFAULT_CATALOG, type CatalogEntry } from '../src/main/clis/capabilities';
import { claimCovers, dirtyOverlap, parseStatusV2, underPrefix } from '../src/main/dirtyBase';
import { helperLimit } from '../src/main/helperLimit';
import { LEAD_SYSTEM, parseProtocol, systemFor } from '../src/main/prompts';
import { MAX_TASK_FILES, MAX_TASK_MINUTES, WHOLE_PROJECT_SPEC_CHARS, catchAll, estimateTaskMinutes, gateTask, planEta } from '../src/main/sizeGate';
import { ACTIVE_WINDOW_MS, HELPER_HARD_CAP_MS, HELPER_SOFT_CAP_MS, capLimits, capResumeAllowed, softCheck } from '../src/main/softCap';

const ask = (question: string, options: string[] = []) => ({ question, options, allowText: true });

describe('soft and hard run limits (softCap.ts)', () => {
  it('defaults to 35 / 70 minutes; the old single limit is the hard one and the soft never exceeds it', () => {
    expect(capLimits()).toEqual({ softMs: HELPER_SOFT_CAP_MS, hardMs: HELPER_HARD_CAP_MS, activeWindowMs: ACTIVE_WINDOW_MS });
    expect(HELPER_SOFT_CAP_MS).toBe(35 * 60_000);
    expect(HELPER_HARD_CAP_MS).toBe(70 * 60_000);
    expect(capLimits({ helperCapMs: 20 * 60_000 })).toMatchObject({ softMs: 20 * 60_000, hardMs: 20 * 60_000 });
    expect(capLimits({ helperCapMs: 100, helperSoftCapMs: 40, activeWindowMs: 10 })).toEqual({ softMs: 40, hardMs: 100, activeWindowMs: 10 });
  });
  it('stops an idle run at the soft limit and lets an active one continue, checking again when its activity ages out', () => {
    expect(softCheck({ idleMs: 6 * 60_000, activeWindowMs: 5 * 60_000 })).toEqual({ stop: true });
    expect(softCheck({ idleMs: 60_000, activeWindowMs: 5 * 60_000 })).toEqual({ stop: false, recheckInMs: 4 * 60_000 });
  });
  it('resumes a capped helper automatically only once', () => {
    expect(capResumeAllowed({})).toBe(true);
    expect(capResumeAllowed({ capResumes: 1 })).toBe(false);
  });
});

describe('who answers a helper question (askRouting.ts)', () => {
  it('sends the real run\'s file-claim question, scope and branch questions to the lead', () => {
    expect(routeAsk(ask('May I include the four packages/ai files from c8afb84 unchanged so this branch contains the exact complete consolidated diff?'), { leadAsks: 0 })).toEqual({ to: 'lead' });
    expect(routeAsk(ask('Should I base this on harbor/engine-fix or on main?'), { leadAsks: 0 })).toEqual({ to: 'lead' });
    expect(routeAsk(ask('Tabs or spaces?', ['Use tabs', 'Use spaces']), { leadAsks: 0 })).toEqual({ to: 'lead' });
  });
  it('sends credentials, destructive actions and publishing to the user', () => {
    expect(routeAsk(ask('Which API key should I use for the staging server?'), { leadAsks: 0 })).toEqual({ to: 'user', kind: 'credentials' });
    expect(routeAsk(ask('Can I drop the database table and recreate it?'), { leadAsks: 0 })).toEqual({ to: 'user', kind: 'destructive' });
    expect(routeAsk(ask('OK to run git reset --hard on the main checkout?'), { leadAsks: 0 })).toEqual({ to: 'user', kind: 'destructive' });
    expect(routeAsk(ask('Shall I push the branch to origin?'), { leadAsks: 0 })).toEqual({ to: 'user', kind: 'publish' });
  });
  it('a helper that asks again after the lead answered, or a lead that cannot run, goes to the user', () => {
    expect(routeAsk(ask('Which file?'), { leadAsks: MAX_LEAD_ASKS })).toEqual({ to: 'user', kind: 'repeat' });
    expect(routeAsk(ask('Which file?'), { leadAsks: 0, leadAvailable: false })).toEqual({ to: 'user', kind: 'repeat' });
  });
  it('the safe default never approves anything', () => {
    for (const k of ['credentials', 'destructive', 'publish', 'repeat', 'lead'] as const) {
      const t = safeDefault(k, 10);
      expect(t).toContain('within 10 minutes');
      expect(t).not.toMatch(/\byes\b|go ahead|approved/i);
    }
    expect(safeDefault('destructive', 10)).toMatch(/NO\. Do not delete/);
    expect(safeDefault('publish', 10)).toMatch(/Do not push/);
  });
});

describe('size gate and plan ETA (sizeGate.ts)', () => {
  it('flags the real run\'s catch-all titles and leaves ordinary ones alone', () => {
    for (const t of ['Consolidate and correct the complete repair diff', 'Finish consolidated release validation', 'Complete preserved durable-turn implementation', 'consolidate everything into one branch', 'Complete the whole migration'])
      expect(catchAll(t), t).toBe(true);
    for (const t of ['Add retry to fetchUser', 'Fix the tax harness test', 'Complete the README section on install', 'Consolidate two date helpers in src/dates.ts'])
      expect(catchAll(t), t).toBe(false);
  });
  it('refuses edit tasks over the limits, never read-only ones or integrators', () => {
    const base = { title: 'Add retry', instructions: 'Wrap fetchUser in retries.', access: 'edit' as const, files: ['src/a.ts'], minutes: 10 };
    expect(gateTask(base)).toBeUndefined();
    expect(gateTask({ ...base, minutes: MAX_TASK_MINUTES + 1 })).toMatch(/estimated at about 26 minutes/);
    expect(gateTask({ ...base, files: Array.from({ length: MAX_TASK_FILES + 1 }, (_, i) => `f${i}.ts`) })).toMatch(/claims 11 paths/);
    expect(gateTask({ ...base, files: [], instructions: 'x'.repeat(WHOLE_PROJECT_SPEC_CHARS + 1) })).toMatch(/whole project/);
    expect(gateTask({ ...base, title: 'Finish consolidated release validation' })).toMatch(/catch-all/);
    expect(gateTask({ ...base, access: 'read', title: 'Finish consolidated release validation', minutes: 999 })).toBeUndefined();
    expect(gateTask({ ...base, integrate: true, minutes: 999 })).toBeUndefined();
  });
  it('estimates more minutes for bigger and harder work; large hard work is over the limit, ordinary work under it', () => {
    // Claude's models only: the estimate follows the cheapest option that clears, so it depends on the catalog (Codex has faster ones).
    const claude = DEFAULT_CATALOG.filter((e) => e.cli === 'claude');
    const m = (size: 'small' | 'medium' | 'large', difficulty: number) => estimateTaskMinutes({ role: 'implementer', size, difficulty, catalog: claude });
    expect(m('small', 4)).toBeLessThan(m('medium', 4));
    expect(m('medium', 5)).toBeLessThan(m('large', 5));
    expect(m('medium', 5)).toBeLessThan(MAX_TASK_MINUTES);
    expect(m('large', 8)).toBeGreaterThan(MAX_TASK_MINUTES);
  });
  it('plans with the concurrency limit and reports the longest chain', () => {
    const tasks = [
      { id: 'a', minutes: 10, dependsOn: [] }, { id: 'b', minutes: 10, dependsOn: [] }, { id: 'c', minutes: 10, dependsOn: [] },
      { id: 'r', minutes: 5, dependsOn: ['a'] }
    ];
    expect(planEta(tasks, 3)).toEqual({ minutes: 15, criticalPathMinutes: 15 });
    expect(planEta(tasks, 1)).toEqual({ minutes: 35, criticalPathMinutes: 15 });
    expect(planEta(tasks, 2).minutes).toBe(20);
    expect(planEta([], 3)).toEqual({ minutes: 0, criticalPathMinutes: 0 });
    // A dependency outside the plan (an earlier helper) does not block the estimate.
    expect(planEta([{ id: 'x', minutes: 7, dependsOn: ['elsewhere'] }], 1).minutes).toBe(7);
  });
});

describe('uncommitted files against a claim (dirtyBase.ts)', () => {
  it('parses porcelain v2 (changed, renamed, unmerged, untracked) even when the output was trimmed', () => {
    const out = [
      '1 .M N... 100644 100644 100644 abc abc src/app.ts',
      '2 R. N... 100644 100644 100644 abc abc R100 src/new name.ts\tsrc/old.ts',
      'u UU N... 100644 100644 100644 100644 a b c src/conflict.ts',
      '? notes/todo.md',
      '! dist/out.js'
    ].join('\n');
    expect(parseStatusV2(out)).toEqual({ tracked: ['src/app.ts', 'src/new name.ts', 'src/old.ts', 'src/conflict.ts'], untracked: ['notes/todo.md'] });
  });
  it('matches files and directories case-insensitively; no claim means the whole project', () => {
    expect(claimCovers('src', 'SRC/app.ts')).toBe(true);
    expect(claimCovers('src/app.ts', 'src/app.tsx')).toBe(false);
    expect(dirtyOverlap(['packages/ai/'], ['packages/ai/src/coin-gate.ts', 'README.md'])).toEqual(['packages/ai/src/coin-gate.ts']);
    expect(dirtyOverlap([], ['README.md'])).toEqual(['README.md']);
    expect(dirtyOverlap(['src/a.ts'], ['README.md'])).toEqual([]);
    expect(underPrefix(['packages/app/x.ts', 'other/y.ts'], 'packages/app')).toEqual(['x.ts']);
  });
});

describe('helpers at once from the budget (helperLimit.ts)', () => {
  const NOW = 1_000_000_000;
  const H = 3_600_000;
  const entries = DEFAULT_CATALOG.filter((e) => e.cli === 'claude' && e.autoRoute !== false && !e.legacy);
  const burn = { weekly: 1, session: 5 };
  const reading = (period: 'weekly' | 'session', usedPct: number, resetsAt: number, scope?: string) => ({ period, usedPct, resetsAt, asOf: NOW - 60_000, ...(scope ? { scope } : {}) });
  const states = (weekly: number, session: number, until = NOW + 2 * H): Record<string, PoolState> => Object.fromEntries(['claude:all', 'claude:opus', 'claude:fable'].map((pool) => [pool, poolState({
    pool, windows: pool === 'claude:all' ? [{ period: 'weekly', readings: [reading('weekly', weekly, until)] }, { period: 'session', readings: [reading('session', session, until)] }] : []
  }, NOW)]));

  it('never more than MAX_HELPERS_CAP, and nothing known means the cap', () => {
    expect(helperLimit({ entries, states: {}, burn, running: [] }).limit).toBe(MAX_HELPERS_CAP);
    expect(helperLimit({ entries: [], states: {}, burn, running: [] }).limit).toBe(MAX_HELPERS_CAP);
    expect(helperLimit({ entries, states: states(10, 5), burn: { weekly: 0.001, session: 0.001 }, running: [] }).limit).toBe(MAX_HELPERS_CAP);
  });
  // Review finding 7: with no provider reading for any pool there is no fit or reserve check, so parallel helpers could not be judged.
  it('one helper at a time while no pool has a provider-reported window, and the reason says so', () => {
    const noWindows = Object.fromEntries(['claude:all', 'claude:opus', 'claude:fable'].map((pool) => [pool, poolState({ pool, windows: [] }, NOW)]));
    const l = helperLimit({ entries, states: noWindows, burn, running: [] });
    expect(l.limit).toBe(1);
    expect(l.why).toMatch(/no provider-reported quota reading/);
    const estimated = Object.fromEntries(['claude:all', 'claude:opus', 'claude:fable'].map((pool) => [pool, poolState({
      pool, windows: [{ period: 'weekly', readings: [], estimate: { usedPct: 5, resetsAt: NOW + 2 * H } }]
    }, NOW)]));
    expect(helperLimit({ entries, states: estimated, burn: { weekly: 0.001, session: 0.001 }, running: [] }).limit).toBe(1);
  });
  it('0 with the earliest reset when every pool is out', () => {
    const l = helperLimit({ entries, states: states(100, 100, NOW + 2 * H), burn, running: [] });
    expect(l).toMatchObject({ limit: 0, until: NOW + 2 * H });
  });
  it('1 while a running helper draws on a pool in protect', () => {
    // The pool's numbers leave room; its state says protect (budget.stateOf decides that from rho, tested in budget.test.ts).
    const st = states(10, 5, NOW + 6 * 24 * H);
    const prot = Object.fromEntries(Object.entries(st).map(([k, v]) => [k, k === 'claude:all' ? { ...v, state: 'protect' as const } : v]));
    const sonnet = entries.find((e) => e.model.includes('sonnet')) as CatalogEntry;
    expect(helperLimit({ entries, states: prot, burn: { weekly: 0.001, session: 0.001 }, running: [sonnet] }).limit).toBe(1);
  });
  it('an entry Harbor itself holds out (rate limit cooldown) counts as out', () => {
    expect(helperLimit({ entries, states: {}, burn, running: [], outFor: () => ({ until: NOW + H }) })).toMatchObject({ limit: 0, until: NOW + H });
  });
});

describe('lead prompt delegation rules (prompts.ts)', () => {
  it('states the sizing, model, review, question, stop and validation rules and stays bounded', () => {
    // Raised from 8000/7950 when project notes (HARBOR_NOTE) joined screenshots and documents in one prompt (roadmap wave 1).
    expect(LEAD_SYSTEM.length).toBeLessThan(9100);
    expect(LEAD_SYSTEM).toContain(`about ${MAX_TASK_MINUTES} minutes of work or less`);
    expect(LEAD_SYSTEM).toMatch(/No catch-alls \("consolidate everything", "finish validation"/);
    expect(LEAD_SYSTEM).toMatch(/full test suite and any database setup run once, by you or by ONE validation helper/);
    expect(LEAD_SYSTEM).toMatch(/Do not inflate: leave "complexity" out unless the task is genuinely unusual; "high" needs a one-line "reason"/);
    expect(LEAD_SYSTEM).toMatch(/never pass such a question on to the user/);
    expect(LEAD_SYSTEM).toMatch(/already resumed once by Harbor/);
    expect(LEAD_SYSTEM).toContain('HARBOR_REPLY: {"to":"<helper id>","text":"<your answer or instruction>"}');
    expect(systemFor('implementer')).toMatch(/full test suite and any database setup run once, in one validation step/);
    expect(systemFor('implementer')).toMatch(/It goes to the lead first/);
  });
});

describe('lead protocol additions (prompts.ts)', () => {
  it('parses HARBOR_REPLY, bounded per turn', () => {
    const p = parseProtocol(['ok', 'HARBOR_REPLY: {"to":"abc123","text":"Yes, include them unchanged."}', 'HARBOR_REPLY: {"to":"","text":"x"}'].join('\n'));
    expect(p.reply).toEqual([{ to: 'abc123', text: 'Yes, include them unchanged.' }]);
    expect(p.malformed).toHaveLength(1);
  });
  it('a "high" without a one-line reason counts as medium; with one it stays high', () => {
    const line = (o: object) => `HARBOR_DELEGATE: ${JSON.stringify({ ref: 't', title: 'T', role: 'implementer', instructions: 'do it', ...o })}`;
    expect(parseProtocol(line({ complexity: 'high' })).delegate[0]).toMatchObject({ complexity: 'medium' });
    expect(parseProtocol(line({ complexity: 'high', reason: 'cross-package schema migration' })).delegate[0]).toMatchObject({ complexity: 'high', reason: 'cross-package schema migration' });
    expect(parseProtocol(line({})).delegate[0]!.complexity).toBe('medium');
  });
});
