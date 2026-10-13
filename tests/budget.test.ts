import { describe, expect, it } from 'vitest';
import {
  CONSERVE_HELPERS, CONSERVE_MIN_RHO, MAX_HELPERS_CAP, NEUTRAL_MIN_RHO, RESERVE_FLOOR_PCT, RESERVE_PCT, SCARCITY_MAX, SCARCITY_MIN, SPEND_RHO, STALE_FLOOR,
  allowancePerHour, burnFromReadings, maxHelpers, modelAvailability, modelScarcity, poolInputsFrom, poolState, poolWindowState, poolsOfEntry,
  reserveFor, scarcity, stateOf, urgency, type PoolInput, type PoolState, type PoolStates
} from '../src/main/budget';
import {
  CALIBRATION_MIN_SAMPLES, calibrate, calibrated, emptyCalibration, pctKey, tokensKey, type CalibrationSample
} from '../src/main/calibration';
import {
  FAILURE_PRICE_WEIGHT, capabilityFloor, cheapestFeasible, clears, expectedCost, expectedMinutes, expectedTokens, failureRisk, price, quotaPerKTok
} from '../src/main/budgetCost';
import { EFFORT_TOKEN_MULT, TOKENS_PRIOR_K, poolPctPrior } from '../src/main/budgetPriors';
import { describeBudget, describePool, describePrice } from '../src/main/budgetText';
import { DEFAULT_CATALOG, entryFor, type CatalogEntry } from '../src/main/clis/capabilities';
import type { ReportedLimit } from '../src/main/codexLimits';

const NOW = 50_000_000_000;
const MIN = 60_000, HOUR = 60 * MIN;

const opus = entryFor(DEFAULT_CATALOG, 'claude', 'opus')!;
const sonnet = entryFor(DEFAULT_CATALOG, 'claude', 'sonnet')!;
const haiku = entryFor(DEFAULT_CATALOG, 'claude', 'haiku')!;

/**
 * Provider readings of one window: `used`% now, `burn`%/h over the last day, reset in `h` hours, newest reading `ageH` old. Phase 5:
 * a day of readings (a weekly burn seen over less is pulled toward on-course, budget.poolWindowState); the oldest may read below 0
 * for a steep test burn, only the slope matters.
 */
function readings(used: number, h: number, burn: number, o: { ageH?: number; period?: 'weekly' | 'session'; scope?: string } = {}): ReportedLimit[] {
  const asOf = NOW - (o.ageH ?? 0) * HOUR, resetsAt = NOW + h * HOUR, period = o.period ?? 'weekly';
  const at = (back: number): ReportedLimit => ({ period, usedPct: used - back * burn, resetsAt, asOf: asOf - back * HOUR, ...(o.scope ? { scope: o.scope } : {}) });
  return period === 'weekly' ? [at(24), at(10), at(0)] : [at(10), at(0)];
}
/** Burn that gives `rho` for a weekly window with `used`% used and `h` hours left (reserve as reserveFor). */
const burnFor = (rho: number, used: number, h: number) => Math.max(0, 100 - used - reserveFor(0, h)) / (rho * h);

function weeklyPool(pool: string, rho: number, o: { used?: number; h?: number } = {}): PoolInput {
  const used = o.used ?? 30, h = o.h ?? 48;
  return { pool, windows: [{ period: 'weekly', readings: readings(used, h, burnFor(rho, used, h)) }] };
}
const statesOf = (...ps: PoolInput[]): PoolStates => Object.fromEntries(ps.map((p) => [p.pool, poolState(p, NOW)]));

describe('pool state', () => {
  it('classifies rho at and around every threshold', () => {
    expect(stateOf(Infinity)).toBe('spend');
    expect(stateOf(SPEND_RHO + 0.01)).toBe('spend');
    expect(stateOf(SPEND_RHO)).toBe('neutral');
    expect(stateOf(NEUTRAL_MIN_RHO)).toBe('neutral');
    expect(stateOf(NEUTRAL_MIN_RHO - 0.01)).toBe('conserve');
    expect(stateOf(CONSERVE_MIN_RHO)).toBe('conserve');
    expect(stateOf(CONSERVE_MIN_RHO - 0.01)).toBe('protect');
    expect(stateOf(0)).toBe('protect');
  });

  it('derives rho = usable / (b*H) from readings and lands in the expected state', () => {
    const cases: Array<[number, string]> = [[3, 'spend'], [1.3, 'spend'], [1.2, 'neutral'], [0.85, 'neutral'], [0.75, 'conserve'], [0.55, 'conserve'], [0.45, 'protect'], [0.1, 'protect']];
    for (const [rho, want] of cases) {
      const w = poolWindowState('claude:all', weeklyPool('claude:all', rho).windows[0]!, NOW);
      expect(w.source).toBe('reported');
      expect(w.burnSource).toBe('reported');
      expect(w.rho).toBeCloseTo(rho, 6);
      expect(w.state).toBe(want);
      expect(w.usablePct).toBeCloseTo(70 - reserveFor(0, 48), 6);
      expect(w.projectedPct).toBeCloseTo(30 + w.burnPctPerHour * 48, 6);
    }
  });

  it('reads nothing burning as rho Infinity (spend)', () => {
    const w = poolWindowState('codex:all', { period: 'weekly', readings: readings(40, 30, 0) }, NOW);
    expect(w.burnPctPerHour).toBe(0);
    expect(w.rho).toBe(Infinity);
    expect(w.state).toBe('spend');
  });

  // Phase 5: over the last 72h (was 24h), from 15% (was 20%), down to a floor (was 0); simulator evidence in budget.ts.
  it('decays the reserve linearly over the last 72h before the reset, down to its floor', () => {
    expect(reserveFor(0, 100)).toBe(RESERVE_PCT.weekly);
    expect(reserveFor(0, 72)).toBe(RESERVE_PCT.weekly);
    expect(reserveFor(0, 36)).toBeCloseTo(RESERVE_PCT.weekly / 2);
    expect(reserveFor(0, 0)).toBe(RESERVE_FLOOR_PCT.weekly);
    expect(reserveFor(0, 1)).toBe(RESERVE_FLOOR_PCT.weekly);
    let prev = -1;
    for (let h = 0; h <= 48; h += 0.5) { const r = reserveFor(0, h); expect(r).toBeGreaterThanOrEqual(prev); prev = r; }
    expect(reserveFor(0, 0.5, 'session')).toBeCloseTo(RESERVE_PCT.session / 2);
    // Close to the reset the same remaining quota is more usable.
    const early = poolWindowState('claude:all', { period: 'weekly', readings: readings(50, 30, 0.5) }, NOW);
    const late = poolWindowState('claude:all', { period: 'weekly', readings: readings(50, 6, 0.5) }, NOW);
    expect(late.reservePct).toBeLessThan(early.reservePct);
    expect(late.usablePct).toBeGreaterThan(early.usablePct);
  });

  it('shrinks the reserve with deadline urgency', () => {
    expect(urgency({ now: NOW, criticalPathMinutes: 60 })).toBe(0);
    expect(urgency({ deadline: NOW + 600 * MIN, now: NOW, criticalPathMinutes: 60 })).toBe(0);
    expect(urgency({ deadline: NOW + 90 * MIN, now: NOW, criticalPathMinutes: 60 })).toBeCloseTo(0.5);
    expect(urgency({ deadline: NOW + 60 * MIN, now: NOW, criticalPathMinutes: 60 })).toBe(1);
    expect(urgency({ deadline: NOW - MIN, now: NOW, criticalPathMinutes: 60 })).toBe(1);
    let prev = Infinity;
    for (let u = 0; u <= 1; u += 0.1) { const r = reserveFor(u, 72); expect(r).toBeLessThanOrEqual(prev); prev = r; }
    const calm = poolWindowState('claude:all', weeklyPool('claude:all', 0.9).windows[0]!, NOW, 0);
    const rushed = poolWindowState('claude:all', weeklyPool('claude:all', 0.9).windows[0]!, NOW, 1);
    expect(rushed.reservePct).toBeLessThan(calm.reservePct);
    expect(rushed.rho).toBeGreaterThan(calm.rho);
  });

  it('treats a stale reading as neutral with reduced trust, and an unknown one as neutral with no trust', () => {
    const fresh = poolWindowState('claude:all', { period: 'weekly', readings: readings(30, 48, burnFor(0.3, 30, 48)) }, NOW);
    expect(fresh.state).toBe('protect');
    expect(fresh.trust).toBe(1);
    const old = poolWindowState('claude:all', { period: 'weekly', readings: readings(30, 48, burnFor(0.3, 30, 48), { ageH: 12 }) }, NOW);
    expect(old.stale).toBe(true);
    expect(old.rawState).toBe('protect');
    expect(old.state).toBe('neutral');
    expect(old.trust).toBeGreaterThan(STALE_FLOOR);
    expect(old.trust).toBeLessThan(1);
    expect(scarcity(old)).toBeLessThan(scarcity(fresh));
    const ancient = poolWindowState('claude:all', { period: 'weekly', readings: readings(30, 48, 0.5, { ageH: 30 }) }, NOW);
    expect(ancient.trust).toBe(STALE_FLOOR);
    const none = poolWindowState('claude:opus', { period: 'weekly', readings: [] }, NOW);
    expect(none).toMatchObject({ source: 'unknown', state: 'neutral', trust: 0, exhausted: false });
    expect(scarcity(none)).toBe(1);
  });

  it('counts a Harbor-only estimate at half trust and labels it', () => {
    const est = poolWindowState('claude:all', { period: 'weekly', readings: [], estimate: { usedPct: 84 } }, NOW);
    expect(est.source).toBe('estimated');
    expect(est.burnSource).toBe('estimated');
    expect(est.burnPctPerHour).toBeCloseTo(84 / 168);
    expect(est.trust).toBe(0.5);
    expect(scarcity(est)).toBeCloseTo(1 + 0.5 * (Math.min(SCARCITY_MAX, 1 / est.rho) - 1));
    expect(describeBudget(est)).toContain('estimate from Harbor runs only');
  });

  it('computes the burn rate from successive readings, ignoring resets and too-short spans', () => {
    const at = (h: number, used: number, resetH = 50): ReportedLimit => ({ period: 'weekly', usedPct: used, resetsAt: NOW + resetH * HOUR, asOf: NOW - h * HOUR });
    expect(burnFromReadings([at(4, 10), at(2, 12), at(0, 14)], NOW)).toBeCloseTo(1);
    // A reading 5 minutes after another is merged: the rise counts over the longer span.
    expect(burnFromReadings([at(2, 10), at(2 - 5 / 60, 11), at(0, 12)], NOW)).toBeCloseTo(1);
    // A reset in between (percent fell, new reset time) starts over.
    expect(burnFromReadings([at(6, 80, -1), at(4, 2), at(0, 6)], NOW)).toBeCloseTo(1);
    expect(burnFromReadings([at(1, 10)], NOW)).toBeUndefined();
    // Older than the lookback: ignored.
    expect(burnFromReadings([at(40, 0), at(30, 30)], NOW)).toBeUndefined();
    // Recent rate dominates: a burst after a quiet stretch moves the EMA toward the burst.
    const r = burnFromReadings([at(20, 10), at(10, 10), at(0, 30)], NOW)!;
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(2);
  });

  it('sees use outside Harbor: provider readings rising with no Harbor run raise the burn', () => {
    // Harbor's own estimate says almost nothing ran, the provider's counter rose 3%/h.
    const outside = poolWindowState('claude:all', { period: 'weekly', readings: readings(60, 40, 3), estimate: { usedPct: 2 } }, NOW);
    const quiet = poolWindowState('claude:all', { period: 'weekly', readings: readings(60, 40, 0), estimate: { usedPct: 2 } }, NOW);
    expect(outside.burnSource).toBe('reported');
    expect(outside.burnPctPerHour).toBeCloseTo(3);
    expect(outside.state).toBe('protect');
    expect(quiet.state).toBe('spend');
  });

  it('falls back to the average pace since the window began with a single reading', () => {
    const w = poolWindowState('claude:all', { period: 'weekly', readings: [{ period: 'weekly', usedPct: 42, resetsAt: NOW + 84 * HOUR, asOf: NOW }] }, NOW);
    expect(w.burnSource).toBe('pace');
    expect(w.burnPctPerHour).toBeCloseTo(42 / 84);
  });

  // Phase 5: the full reserve (15%, was 20%) holds until 72h (was 24h) before the reset: 14% left 100h out is inside it.
  it('marks a window at or below its reserve, or a rate limit, as unavailable until the reset', () => {
    const low = poolState({ pool: 'claude:opus', windows: [{ period: 'weekly', readings: readings(86, 100, 0.1) }] }, NOW);
    expect(low.exhausted).toBe(true);
    expect(low.unavailableUntil).toBe(NOW + 100 * HOUR);
    // The same 14% left 10h before the reset is above the decayed reserve: usable.
    expect(poolState({ pool: 'claude:opus', windows: [{ period: 'weekly', readings: readings(86, 10, 0.1) }] }, NOW).exhausted).toBe(false);
    const limited = poolState({ ...weeklyPool('codex:all', 3), rateLimitedUntil: NOW + 20 * MIN }, NOW);
    expect(limited).toMatchObject({ exhausted: true, unavailableUntil: NOW + 20 * MIN });
    expect(modelAvailability(opus, { 'claude:opus': low })).toEqual({ available: false, until: NOW + 100 * HOUR });
    expect(modelAvailability(sonnet, { 'claude:opus': low })).toEqual({ available: true });
  });

  it('clamps scarcity to [SCARCITY_MIN, SCARCITY_MAX] and pulls it to 1 with low trust', () => {
    expect(scarcity({ rho: Infinity, trust: 1 })).toBe(SCARCITY_MIN);
    expect(scarcity({ rho: 100, trust: 1 })).toBe(SCARCITY_MIN);
    expect(scarcity({ rho: 1, trust: 1 })).toBe(1);
    expect(scarcity({ rho: 0.5, trust: 1 })).toBe(2);
    expect(scarcity({ rho: 0.01, trust: 1 })).toBe(SCARCITY_MAX);
    expect(scarcity({ rho: 0, trust: 1 })).toBe(SCARCITY_MAX);
    expect(scarcity({ rho: 0.01, trust: 0 })).toBe(1);
    for (let rho = 0.05; rho < 5; rho += 0.05) {
      const s = scarcity({ rho, trust: 1 });
      expect(s).toBeGreaterThanOrEqual(SCARCITY_MIN);
      expect(s).toBeLessThanOrEqual(SCARCITY_MAX);
    }
  });

  it('lets the tightest pool and window bind a model', () => {
    expect(poolsOfEntry(opus)).toEqual(['claude:opus', 'claude:all']);
    expect(poolsOfEntry(sonnet)).toEqual(['claude:all']);
    const states = statesOf(weeklyPool('claude:opus', 3), weeklyPool('claude:all', 0.5));
    expect(modelScarcity(opus, states)).toBeCloseTo(2);
    expect(modelScarcity(haiku, {})).toBe(1);
    const both = poolState({ pool: 'claude:all', windows: [weeklyPool('x', 3).windows[0]!, { period: 'session', readings: readings(50, 2, burnFor(0.4, 50, 2), { period: 'session' }) }] }, NOW);
    expect(both.windows.map((w) => w.state)).toEqual(['spend', 'protect']);
    expect(both.state).toBe('protect');
  });

  it('builds pool inputs from ledger readings and estimated windows', () => {
    const inputs = poolInputsFrom({
      pools: ['claude:all', 'claude:opus', 'codex:all'],
      readings: { claude: [...readings(30, 48, 1), ...readings(50, 48, 1, { scope: 'opus' })] },
      estimates: { codex: [{ period: 'weekly', usedPct: 12, remainingPct: 88, source: 'estimated', calibrated: false }] },
      rateLimitedUntil: { 'codex:all': NOW + MIN }
    });
    expect(inputs.map((i) => i.pool)).toEqual(['claude:all', 'claude:opus', 'codex:all']);
    expect(inputs[0]!.windows.find((w) => w.period === 'weekly')!.readings.every((r) => r.scope === undefined)).toBe(true);
    expect(inputs[1]!.windows.find((w) => w.period === 'weekly')!.readings.every((r) => r.scope === 'opus')).toBe(true);
    expect(inputs[2]!.windows.find((w) => w.period === 'weekly')!.estimate).toEqual({ usedPct: 12, calibrated: false });
    expect(inputs[2]!.rateLimitedUntil).toBe(NOW + MIN);
  });
});

describe('describeBudget', () => {
  it('says it in plain words', () => {
    const p = weeklyPool('claude:opus', 1.6, { used: 49, h: 18 });
    const text = describeBudget(poolWindowState('claude:opus', p.windows[0]!, NOW));
    // Phase 5: the reserve 18h before the reset is 15% * 18/72 (was 20% * 18/24 = 15%).
    expect(text).toMatch(/^claude:opus weekly: \d+% unspent beyond the 4% reserve, 18h to reset, burning [\d.]+%\/h -> spend \(rho 1\.6\)$/);
    expect(Math.round(reserveFor(0, 18))).toBe(4);
    const stale = describeBudget(poolWindowState('claude:all', { period: 'weekly', readings: readings(30, 48, 0.5, { ageH: 6 }) }, NOW));
    expect(stale).toContain('old, trusted');
    expect(describePool(poolState({ pool: 'codex:all', windows: [] }, NOW))).toContain('no reading');
  });
});

describe('calibration', () => {
  const run = (i: number, over: Partial<CalibrationSample> = {}): CalibrationSample => ({
    time: NOW + i * MIN, cli: 'claude', model: 'claude-sonnet-5-5', ok: true, durationMs: 10 * MIN,
    inputTokens: 80_000, outputTokens: 20_000, role: 'implementer', size: 'medium', effort: 'medium', ...over
  });

  it('blends the prior toward the measured value as samples accumulate, and replaces it at N', () => {
    const prior = TOKENS_PRIOR_K.implementer.medium;
    let cal = emptyCalibration();
    expect(expectedTokens('implementer', 'medium', 'medium', cal)).toBe(prior);
    for (let n = 1; n <= CALIBRATION_MIN_SAMPLES + 2; n++) {
      cal = calibrate([run(n)], cal);
      const w = Math.min(1, n / CALIBRATION_MIN_SAMPLES);
      expect(cal.tokensK[tokensKey('implementer', 'medium')]!.n).toBe(n);
      expect(expectedTokens('implementer', 'medium', 'medium', cal)).toBeCloseTo(w * 100 + (1 - w) * prior);
    }
    expect(expectedTokens('implementer', 'medium', 'medium', cal)).toBeCloseTo(100);
    // Minutes too.
    const mins = expectedMinutes({ role: 'implementer', size: 'medium', effort: 'medium', model: sonnet, calibration: cal });
    expect(mins).toBeCloseTo(10);
  });

  it('stores tokens as medium-effort equivalents', () => {
    const cal = calibrate(Array.from({ length: 5 }, (_, i) => run(i, { effort: 'high' })));
    expect(cal.tokensK[tokensKey('implementer', 'medium')]!.value).toBeCloseTo(100 / EFFORT_TOKEN_MULT.high);
  });

  it('ignores partial and failed runs for averages but keeps them as a lower bound', () => {
    const partial = calibrate([run(1, { partial: true, inputTokens: 300_000, outputTokens: 0 }), run(2, { ok: false, inputTokens: 300_000, outputTokens: 0 })]);
    const e = partial.tokensK[tokensKey('implementer', 'medium')]!;
    expect(e.n).toBe(0);
    expect(e.floorN).toBe(2);
    expect(expectedTokens('implementer', 'medium', 'medium', partial)).toBeGreaterThanOrEqual(300);
    // A small partial run never lowers the estimate.
    const small = calibrate([run(1, { partial: true, inputTokens: 1000, outputTokens: 0 })]);
    expect(expectedTokens('implementer', 'medium', 'medium', small)).toBe(TOKENS_PRIOR_K.implementer.medium);
    expect(Object.keys(calibrate([run(1, { partial: true, quota: [{ period: 'weekly', beforePct: 10, afterPct: 20 }] })]).pctPerKTok)).toEqual([]);
  });

  it('learns quota per token per pool from provider readings around a run, normalised by model cost', () => {
    const samples = Array.from({ length: 5 }, (_, i) => run(i, { model: 'opus', quota: [{ period: 'weekly', scope: 'opus', beforePct: 10, afterPct: 12 }, { period: 'weekly', beforePct: 5, afterPct: 6 }] }));
    const cal = calibrate(samples);
    expect(cal.pctPerKTok[pctKey('claude:opus', 'weekly')]!.value).toBeCloseTo(2 / (100 * 2));
    expect(cal.pctPerKTok[pctKey('claude:all', 'weekly')]!.value).toBeCloseTo(1 / (100 * 2));
    expect(quotaPerKTok(opus, 'claude:opus', cal)).toBeCloseTo(0.02);
    expect(quotaPerKTok(opus, 'claude:opus')).toBeCloseTo(2 * poolPctPrior('claude:opus', 'weekly'));
    // A reset between the readings is not a sample.
    expect(calibrate([run(1, { quota: [{ period: 'weekly', beforePct: 90, afterPct: 1 }] })]).pctPerKTok).toEqual({});
  });

  it('is incremental and plain JSON', () => {
    const a = calibrate([run(1), run(2)]);
    const b = calibrate([run(1), run(2), run(3)], a);
    expect(b.tokensK[tokensKey('implementer', 'medium')]!.n).toBe(3);
    expect(calibrate([run(1), run(2)], a)).toEqual(a);
    expect(JSON.parse(JSON.stringify(b))).toEqual(b);
    expect(calibrated(10, undefined)).toBe(10);
  });
});

describe('failure risk and capability floor', () => {
  it('capabilityFloor is monotone from 1 to 5', () => {
    expect(capabilityFloor(0)).toBe(1);
    expect(capabilityFloor(10)).toBe(5);
    let prev = 0;
    for (let d = 0; d <= 10.0001; d += 0.1) {
      const f = capabilityFloor(d);
      expect(f).toBeGreaterThanOrEqual(prev);
      expect(f).toBeGreaterThanOrEqual(1);
      expect(f).toBeLessThanOrEqual(5);
      // Phase 3: quarter steps (the effort bonuses are quarter levels now; was half steps).
      expect(f * 4).toBe(Math.round(f * 4));
      prev = f;
    }
  });

  it('failureRisk is in [0,1], rises with difficulty and falls with effort and capability', () => {
    for (const e of DEFAULT_CATALOG) {
      for (const eff of ['low', 'medium', 'high'] as const) {
        let prev = -1;
        for (let d = 0; d <= 10; d += 0.5) {
          const r = failureRisk(e, d, eff);
          expect(r).toBeGreaterThanOrEqual(0);
          expect(r).toBeLessThanOrEqual(1);
          expect(r).toBeGreaterThanOrEqual(prev);
          prev = r;
        }
      }
      for (let d = 0; d <= 10; d += 1) {
        expect(failureRisk(e, d, 'medium')).toBeLessThanOrEqual(failureRisk(e, d, 'low'));
        expect(failureRisk(e, d, 'high')).toBeLessThanOrEqual(failureRisk(e, d, 'medium'));
      }
    }
    for (let d = 0; d <= 10; d++) expect(failureRisk(opus, d, 'low')).toBeLessThanOrEqual(failureRisk(haiku, d, 'low'));
    expect(failureRisk(haiku, 10, 'low')).toBeGreaterThan(0.9);
    expect(failureRisk(opus, 2, 'low')).toBeLessThan(0.01);
  });

  // Phase 3 retuned EFFORT_BONUS (0 / 0.25 / 0.5) and the difficulty knots: Sonnet at high effort reaches high work (8) but no longer
  // the hardest (10), and Haiku clears easy work (3) at low effort but no longer medium-low work (4) without more effort.
  it('clears compares capability plus effort bonus with the floor', () => {
    expect(clears(sonnet, 'code', 8, 'medium')).toBe(false);
    expect(clears(sonnet, 'code', 8, 'high')).toBe(true);
    expect(clears(sonnet, 'code', 10, 'high')).toBe(false);
    expect(clears(haiku, 'code', 3, 'low')).toBe(true);
    expect(clears(haiku, 'code', 4, 'low')).toBe(false);
    expect(clears(haiku, 'code', 4, 'high')).toBe(true);
    expect(clears(haiku, 'planning', 9, 'high')).toBe(false);
  });
});

describe('price', () => {
  const task = { role: 'implementer' as const, size: 'medium' as const, difficulty: 6 };

  it('returns every term, and total = cost * scarcity * (1 + 1.5 risk) + lambda * minutes', () => {
    const states = statesOf(weeklyPool('claude:opus', 0.6), weeklyPool('claude:all', 2));
    for (const urg of [0, 0.3, 0.7, 1]) {
      const p = price({ model: opus, effort: 'medium', task, states, urgency: urg });
      expect(p.costTerm).toBeCloseTo(p.expectedCostPct * p.scarcity);
      expect(p.failureFactor).toBeCloseTo(1 + FAILURE_PRICE_WEIGHT * p.failureRisk);
      expect(p.timeCost).toBeCloseTo(p.lambda * p.minutes);
      expect(p.total).toBeCloseTo(p.costTerm * p.failureFactor + p.timeCost);
      expect(p.bindingPool).toBe('claude:opus');
      expect(p.pools.map((x) => x.pool)).toEqual(['claude:opus', 'claude:all']);
      if (urg === 0) expect(p.timeCost).toBe(0); else expect(p.timeCost).toBeGreaterThan(0);
    }
    expect(price({ model: opus, effort: 'medium', task, states, urgency: 1 }).timeCost).toBeGreaterThan(price({ model: opus, effort: 'medium', task, states, urgency: 0.5 }).timeCost);
    const c = expectedCost({ role: 'implementer', size: 'medium', effort: 'medium', model: opus });
    expect(c.pct).toBeCloseTo(TOKENS_PRIOR_K.implementer.medium * 2 * poolPctPrior('claude:opus', 'weekly'));
    expect(describePrice(price({ model: opus, effort: 'medium', task, states }))).toContain('(estimate)');
  });

  // Sonnet with its own capped pool (as providers do for some models): the case where pools of one CLI diverge.
  const sonnetPooled: CatalogEntry = { ...sonnet, pool: 'claude:sonnet' };
  const models = [opus, sonnetPooled];

  it('Opus pool in spend, Sonnet pool in conserve: the cheapest feasible easy option is Opus at low effort', () => {
    const states = statesOf(weeklyPool('claude:opus', 3), weeklyPool('claude:sonnet', 0.55), weeklyPool('claude:all', 3));
    expect(states['claude:sonnet']!.state).toBe('conserve');
    const best = cheapestFeasible({ models, task: { role: 'implementer', size: 'medium', difficulty: 2 }, states });
    expect(best).toMatchObject({ model: opus.model, effort: 'low' });
  });

  // Phase 3: difficulty 8 (was 10): with the halved effort bonus Sonnet at high effort reaches high work, not the hardest.
  it('reversed: a hard task goes to Sonnet at high effort', () => {
    const states = statesOf(weeklyPool('claude:opus', 0.55), weeklyPool('claude:sonnet', 3), weeklyPool('claude:all', 3));
    const best = cheapestFeasible({ models, task: { role: 'implementer', size: 'medium', difficulty: 8 }, states });
    expect(best).toMatchObject({ model: sonnet.model, effort: 'high' });
  });

  it('never offers an unavailable model', () => {
    const states = statesOf(weeklyPool('claude:all', 3), { pool: 'claude:opus', windows: [{ period: 'weekly', readings: readings(95, 40, 0.1) }] });
    const best = cheapestFeasible({ models: [opus, sonnet], task: { role: 'implementer', size: 'medium', difficulty: 2 }, states });
    expect(best?.model).toBe(sonnet.model);
  });
});

describe('maxHelpers', () => {
  const burn = { weekly: 1, session: 10 };
  const st = (p: PoolInput): PoolState => poolState(p, NOW);

  it('caps at MAX_HELPERS_CAP with plenty of room', () => {
    const roomy = st({ pool: 'claude:all', windows: [{ period: 'weekly', readings: readings(10, 10, 0.1) }, { period: 'session', readings: readings(5, 4, 1, { period: 'session' }) }] });
    expect(allowancePerHour(roomy.windows[0]!)).toBeGreaterThan(3);
    expect(maxHelpers({ states: [roomy], perHelperBurnPctPerHour: burn })).toBe(MAX_HELPERS_CAP);
    // Changed by the review (finding 7): a pool with no provider-reported window has no fit or reserve check, so it runs one helper at a time.
    expect(maxHelpers({ states: [st({ pool: 'codex:all', windows: [] })], perHelperBurnPctPerHour: burn })).toBe(1);
    expect(maxHelpers({ states: [st({ pool: 'codex:all', windows: [] }), roomy], perHelperBurnPctPerHour: burn })).toBe(MAX_HELPERS_CAP); // a measured pool still carries more
  });

  // Phase 5: the weekly window limits parallelism through its state (CONSERVE_HELPERS in conserve, 1 in protect), no longer through
  // its all-hours allowance per helper (simulator evidence in budget.ts); the 5h window still through its room.
  it('is limited by the weekly state and the 5h room, never below 1 while a pool can run', () => {
    const weekly = st({ pool: 'claude:all', windows: [{ period: 'weekly', readings: readings(10, 35, 0.1) }] });
    expect(allowancePerHour(weekly.windows[0]!)).toBeLessThan(MAX_HELPERS_CAP);
    expect(maxHelpers({ states: [weekly], perHelperBurnPctPerHour: burn })).toBe(MAX_HELPERS_CAP);
    const conserve = st(weeklyPool('claude:all', 0.6));
    expect(conserve.state).toBe('conserve');
    expect(maxHelpers({ states: [conserve], perHelperBurnPctPerHour: burn })).toBe(CONSERVE_HELPERS);
    const tight5h = st({ pool: 'claude:all', windows: [{ period: 'weekly', readings: readings(10, 10, 0.1) }, { period: 'session', readings: readings(84, 3, 0.1, { period: 'session' }) }] });
    expect(maxHelpers({ states: [tight5h], perHelperBurnPctPerHour: burn })).toBe(1);
  });

  it('allows one helper in protect and none when every pool is exhausted', () => {
    const prot = st(weeklyPool('claude:all', 0.3, { used: 10, h: 10 }));
    expect(prot.state).toBe('protect');
    expect(maxHelpers({ states: [prot], perHelperBurnPctPerHour: { weekly: 0.01, session: 0.01 } })).toBe(1);
    const out = st({ pool: 'claude:all', windows: [{ period: 'weekly', readings: readings(99, 40, 0.1) }] });
    const limited = st({ ...weeklyPool('codex:all', 3), rateLimitedUntil: NOW + HOUR });
    expect(maxHelpers({ states: [out, limited], perHelperBurnPctPerHour: burn })).toBe(0);
    expect(maxHelpers({ states: [out, prot], perHelperBurnPctPerHour: { weekly: 0.01, session: 0.01 } })).toBe(1);
  });
});
