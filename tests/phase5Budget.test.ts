import { describe, expect, it } from 'vitest';
import { dailyBurn, poolState, poolWindowState, reserveFor, type PoolInput } from '../src/main/budget';
import { expectedMinutes, expectedTokens } from '../src/main/budgetCost';
import { poolPctPrior } from '../src/main/budgetPriors';
import { MIN_SAMPLE_MINUTES, calibrate, emptyCalibration, pctKey, type CalibrationSample } from '../src/main/calibration';
import { DEFAULT_CATALOG, entryFor } from '../src/main/clis/capabilities';
import type { ResolvedCli } from '../src/main/clis/discovery';
import type { ReportedLimit } from '../src/main/codexLimits';
import { helperLimitFromLedger } from '../src/main/helperLimit';
import { route, ROUTING_WEIGHTS } from '../src/main/router';
import {
  FIT_MARGIN, IN_FLIGHT_MIN_REMAINING, READING_LAG_MS, committedFor, fitsBudget, inFlightKTokSoFar, priceOption, runCostByWindow, statesOf
} from '../src/main/routePrice';
import { BEFORE_FRESH_MS, calibrationSample, overlapKTok, readingsDuring } from '../src/main/runCalibration';
import { Store } from '../src/main/store';
import type { UsageEvent } from '../src/main/types';
import { UsageLedger } from '../src/main/usage';

/** Phase 5 units: the governor pieces the week simulator needed (each test names the simulator finding it answers). */
const NOW = 50_000_000_000, MIN = 60_000, HOUR = 60 * MIN;
const opus = entryFor(DEFAULT_CATALOG, 'claude', 'claude-opus-5-5')!;
const sonnet = entryFor(DEFAULT_CATALOG, 'claude', 'claude-sonnet-5-5')!;
const haiku = entryFor(DEFAULT_CATALOG, 'claude', 'claude-haiku-5-5')!;
const r = (period: 'weekly' | 'session', usedPct: number, resetH: number, agoH = 0, scope?: string): ReportedLimit =>
  ({ period, usedPct, resetsAt: NOW + resetH * HOUR, asOf: NOW - agoH * HOUR, ...(scope ? { scope } : {}) });
const cli = (id: string): ResolvedCli => ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'] }) as ResolvedCli;

describe('quota in flight (committedFor)', () => {
  it('counts what a run will still burn, and what it burned after the newest reading could see', () => {
    const run = { entry: sonnet, role: 'implementer' as const, size: 'medium' as const, effort: 'medium' as const, startedAt: NOW - 10 * MIN };
    const total = expectedTokens('implementer', 'medium', 'medium') * poolPctPrior('claude:all', 'weekly');
    const minutes = expectedMinutes({ role: 'implementer', size: 'medium', effort: 'medium', model: sonnet });
    // No reading since it started: all of it is still unseen.
    expect(committedFor([run], NOW, undefined, () => NOW - 30 * MIN)['claude:all']!.weekly).toBeCloseTo(total);
    // A reading taken now has seen the first (10 - lag) minutes of it.
    expect(committedFor([run], NOW, undefined, () => NOW)['claude:all']!.weekly).toBeCloseTo(total * (1 - (10 - READING_LAG_MS / MIN) / minutes));
    // A run past its expected length still counts a floor share.
    const late = { ...run, startedAt: NOW - 10 * HOUR };
    expect(committedFor([late], NOW, undefined, () => NOW)['claude:all']!.weekly).toBeCloseTo(total * IN_FLIGHT_MIN_REMAINING);
    // A run that ended after the newest reading: its measured tokens past that reading.
    const ended = committedFor([], NOW, undefined, () => NOW - 2 * MIN, [{ entry: opus, start: NOW - 20 * MIN, end: NOW - 1 * MIN, kTok: 1000 }]);
    const unseen = (1000 * (2 + READING_LAG_MS / MIN - 1)) / 19; // from (newest reading - lag) = NOW - 7 min to its end at NOW - 1 min
    expect(ended['claude:opus']!.weekly).toBeCloseTo(unseen * 2 * poolPctPrior('claude:opus', 'weekly'));
    // The estimate of tokens so far is not capped at the expected total (the runs still going are the long ones).
    expect(inFlightKTokSoFar(late, NOW)).toBeGreaterThan(expectedTokens('implementer', 'medium', 'medium'));
  });

  it('is counted as used for helpers only, and only where something is known about the window', () => {
    const w = { period: 'weekly' as const, readings: [r('weekly', 40, 100, 24), r('weekly', 50, 100)], committedPct: 20 };
    expect(poolWindowState('claude:all', w, NOW).usedPct).toBe(70);
    expect(poolWindowState('claude:all', w, NOW, 0, { interactive: true }).usedPct).toBe(50);
    expect(poolWindowState('claude:opus', { period: 'weekly', readings: [], committedPct: 20 }, NOW).usedPct).toBe(0);
  });
});

describe('room for one run (fitsBudget)', () => {
  const states = (weeklyUsed: number, sessionUsed: number) => statesOf([{ pool: 'claude:all', windows: [
    { period: 'weekly', readings: [r('weekly', weeklyUsed - 5, 100, 24), r('weekly', weeklyUsed, 100)] },
    { period: 'session', readings: [r('session', sessionUsed, 3)] }
  ] }], NOW, 0, false);
  it('needs the run\'s expected cost times a margin in every window with a provider reading', () => {
    const cost = runCostByWindow({ model: sonnet, effort: 'high', role: 'implementer', size: 'large' });
    const session = cost.find((c) => c.period === 'session')!.pct;
    expect(session * FIT_MARGIN.session).toBeGreaterThan(10);
    expect(fitsBudget({ model: sonnet, effort: 'high', role: 'implementer', size: 'large', states: states(10, 5) }).fits).toBe(true);
    const tight = fitsBudget({ model: sonnet, effort: 'high', role: 'implementer', size: 'large', states: states(10, 100 - 10 - session) });
    expect(tight).toEqual({ fits: false, until: NOW + 3 * HOUR });
    // Haiku's run of the same task is small enough.
    expect(fitsBudget({ model: haiku, effort: 'low', role: 'implementer', size: 'large', states: states(10, 100 - 10 - session) }).fits).toBe(true);
  });
  it('ignores Harbor\'s estimated windows (a run count against an assumed budget is not a provider %)', () => {
    const est = statesOf([{ pool: 'claude:all', windows: [{ period: 'weekly', readings: [], estimate: { usedPct: 99, calibrated: true } }] }], NOW, 0, false);
    expect(fitsBudget({ model: opus, effort: 'high', role: 'implementer', size: 'large', states: est }).fits).toBe(true);
  });
});

describe('routing with room checks', () => {
  const ledgerWith = (limits: ReportedLimit[]) => {
    const ledger = new UsageLedger(new Store(), { now: () => NOW });
    ledger.record({ cli: 'claude', model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, time: NOW, limits });
    return ledger;
  };
  const input = (ledger: UsageLedger) => ({ clis: [cli('claude')], ledger, enabled: () => true, hasAdapter: () => true, load: () => 0, now: () => NOW });
  it('a hard helper waits for its capable models rather than taking a weaker one that still fits', () => {
    // 15.5% left, 100h out: 0.5% above the reserve: Haiku's run fits, the models that clear difficulty 8 do not.
    const ledger = ledgerWith([r('weekly', 84.5, 100), r('session', 10, 3)]);
    expect(route({ role: 'implementer', complexity: 'high', difficulty: 8, size: 'large' }, input(ledger))).toBeUndefined();
    // Easy work that Haiku clears still runs.
    expect(route({ role: 'implementer', complexity: 'low', difficulty: 2, size: 'small' }, input(ledger))!.model).toBe('claude-haiku-5-5');
  });
  it('interactive work is never refused for room: an option that would not fit is only scored last', () => {
    const ledger = ledgerWith([r('weekly', 50, 100), r('session', 99.4, 3)]);
    const d = route({ role: 'main', complexity: 'high', difficulty: 8, size: 'medium', interactive: true }, input(ledger))!;
    expect(d).toBeDefined();
    expect(d.scored![0]!.terms['unfit']).toBe(-ROUTING_WEIGHTS.unfit);
  });
  it('a per-model pool nobody reports does not bind the price while the account pool has a reading', () => {
    const states = statesOf([
      { pool: 'claude:all', windows: [{ period: 'weekly', readings: [r('weekly', 5, 10, 24), r('weekly', 10, 10)] }] },
      { pool: 'claude:opus', windows: [{ period: 'weekly', readings: [] }] }
    ], NOW, 0, false);
    const p = priceOption({ model: opus, effort: 'low', task: { role: 'implementer', difficulty: 2, size: 'small' }, states });
    expect(p.bindingPool).toBe('claude:all');
    expect(p.wasteCreditPct).toBeGreaterThan(0);
  });
});

describe('weekly burn over a day', () => {
  it('takes the rise since the reading closest to a day before, and pulls a younger window toward on course', () => {
    const rs = [r('weekly', 10, 100, 30), r('weekly', 20, 100, 24), r('weekly', 30, 100, 12), r('weekly', 44, 100)];
    expect(dailyBurn(rs, NOW)).toBeCloseTo(1);
    // One morning of readings (2h) at 3%/h: no longer read as a week run dry.
    const young: PoolInput = { pool: 'claude:all', windows: [{ period: 'weekly', readings: [r('weekly', 4, 160, 2), r('weekly', 10, 160)] }] };
    const w = poolState(young, NOW).windows[0]!;
    expect(w.burnPctPerHour).toBeLessThan(1);
    expect(w.state).not.toBe('protect');
    expect(reserveFor(0, 160)).toBe(15);
  });
});

describe('calibration from runs that overlap', () => {
  const sample = (over: Partial<CalibrationSample>): CalibrationSample => ({
    time: NOW, cli: 'claude', model: 'claude-sonnet-5-5', ok: true, durationMs: 20 * MIN, inputTokens: 100_000, outputTokens: 0,
    role: 'implementer', size: 'medium', effort: 'medium', quota: [{ period: 'weekly', beforePct: 10, afterPct: 12 }], ...over
  });
  it('divides the delta by its own and its neighbours\' tokens, sums before dividing, and samples only its own pools', () => {
    const solo = calibrate([sample({})]);
    expect(solo.pctPerKTok[pctKey('claude:all', 'weekly')]!.value).toBeCloseTo(2 / 100);
    const shared = calibrate([sample({ overlap: [{ pool: 'claude:all', kTok: 100 }] })]);
    expect(shared.pctPerKTok[pctKey('claude:all', 'weekly')]!.value).toBeCloseTo(2 / 200);
    // Ratio of sums: a 0-delta small run and a 4-point big one average to the right figure, not to the mean of their ratios.
    const two = calibrate([sample({ time: NOW, quota: [{ period: 'weekly', beforePct: 10, afterPct: 10 }], inputTokens: 50_000 }), sample({ time: NOW + 1, quota: [{ period: 'weekly', beforePct: 10, afterPct: 14 }], inputTokens: 150_000 })]);
    expect(two.pctPerKTok[pctKey('claude:all', 'weekly')]!.value).toBeGreaterThan(0.019);
    // A Sonnet run's reading of the Opus window says nothing about Sonnet.
    const opusWindow = calibrate([sample({ quota: [{ period: 'weekly', scope: 'opus', beforePct: 10, afterPct: 15 }] })]);
    expect(opusWindow.pctPerKTok[pctKey('claude:opus', 'weekly')]).toBeUndefined();
    // Short runs give no quota sample (the reading at their end misses their last minutes).
    expect(calibrate([sample({ durationMs: (MIN_SAMPLE_MINUTES - 1) * MIN })]).pctPerKTok).toEqual({});
    // Minutes are learned per token, so a large task takes longer than the medium ones measured.
    const cal = calibrate(Array.from({ length: 5 }, (_, i) => sample({ time: NOW + i })), emptyCalibration());
    const med = expectedMinutes({ role: 'implementer', size: 'medium', effort: 'medium', model: sonnet, calibration: cal });
    const large = expectedMinutes({ role: 'implementer', size: 'large', effort: 'medium', model: sonnet, calibration: cal });
    expect(large / med).toBeCloseTo(expectedTokens('implementer', 'large', 'medium', cal) / expectedTokens('implementer', 'medium', 'medium', cal));
  });

  it('pairs a run only with a fresh "before" reading, and spreads other runs over the overlap', () => {
    const event: UsageEvent = { id: 'u', time: NOW, cli: 'claude', model: 'claude-sonnet-5-5', projectId: 'p', agentId: 'a', durationMs: 30 * MIN, ok: true,
      inputTokens: 100_000, limits: [r('weekly', 20, 50)] };
    const start = NOW - 30 * MIN;
    const stale = [{ ...r('weekly', 5, 50), asOf: start - BEFORE_FRESH_MS - MIN }];
    expect(calibrationSample({ event, role: 'implementer', before: stale, start }).quota).toBeUndefined();
    const firstInRun = [{ ...r('weekly', 15, 50), asOf: start + MIN }];
    expect(calibrationSample({ event, role: 'implementer', before: firstInRun, start }).quota).toEqual([{ period: 'weekly', beforePct: 15, afterPct: 20 }]);
    const ov = overlapKTok({ cli: 'claude', start, end: NOW, others: [
      { entry: opus, start: start - 30 * MIN, end: start + 15 * MIN, kTok: 900 }, // a third of it inside: 300 k-tokens at costPerKTok 2
      { entry: entryFor(DEFAULT_CATALOG, 'codex', 'gpt-6.1-sol')!, start, end: NOW, kTok: 500 } // another CLI: not counted
    ] });
    expect(ov).toEqual([{ pool: 'claude:opus', kTok: 600 }, { pool: 'claude:all', kTok: 600 }]);
    expect(readingsDuring([r('weekly', 1, 50, 2), r('weekly', 3, 50, 0.1), r('weekly', 2, 50, 0.2), r('session', 9, 2, 0.1)], NOW - HOUR)).toEqual([r('weekly', 3, 50, 0.1), r('session', 9, 2, 0.1)]);
  });
});

describe('ledger readings seen during a run', () => {
  it('are visible to routing at once (observe), before the run\'s usage event', () => {
    const ledger = new UsageLedger(new Store(), { now: () => NOW });
    expect(ledger.readings('claude')).toEqual([]);
    ledger.observe('claude', [r('weekly', 42, 50)]);
    expect(ledger.readings('claude')).toEqual([r('weekly', 42, 50)]);
    expect(ledger.pressure('claude').windows!.find((w) => w.period === 'weekly')).toMatchObject({ usedPct: 42, source: 'reported' });
  });
  it('the helper limit counts quota in flight like routing does', () => {
    const ledger = new UsageLedger(new Store(), { now: () => NOW });
    ledger.observe('claude', [r('weekly', 70, 100), r('session', 70, 3)]);
    const base = { catalog: DEFAULT_CATALOG, clis: ['claude'], ledger, now: NOW, running: [] };
    expect(helperLimitFromLedger(base).limit).toBeGreaterThanOrEqual(1);
    const full = helperLimitFromLedger({ ...base, committed: { 'claude:all': { weekly: 20, session: 30 } } });
    expect(full).toMatchObject({ limit: 0, until: NOW + 100 * HOUR }); // inside the reserve once the runs in flight are counted: wait for the resets
  });
});
