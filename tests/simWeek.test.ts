import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG, entryFor } from '../src/main/clis/capabilities';
import { run } from './sim/runs';
import { simulate } from './sim/simulate';
import type { WorkloadName } from './sim/workloads';

/**
 * Phase 5: the week simulator (tests/sim) drives the REAL router, budget governor, calibration, helper limit and size gate against
 * simulated accounts whose true quota Harbor never sees, and checks the properties the redesign promised. Fixed seeds; the numbers
 * each property is judged on are printed by `npx tsx scripts/simulate-week.ts`. Properties 6 and 7 are in simDeadline/simAdapt.
 */
const SEEDS = [1, 2, 3];
const entryTier = (d: { cli: string; model: string }) => entryFor(DEFAULT_CATALOG, d.cli, d.model)?.tier;
const T = 180_000; // generous: a busy machine runs the 7-day weeks several times slower than an idle one

describe('week simulator: never out of usage, not wasting, reserve, premium, balance', () => {
  it.each(['steady', 'bursty', 'light', 'chronica'] as WorkloadName[])('1. NEVER OUT OF USAGE (%s): no pool window reaches 100%% before its reset', (w) => {
    for (const seed of SEEDS) {
      const { s } = run(w, seed);
      expect(s.walls.list, `${w} seed ${seed}`).toEqual([]);
      for (const [k, v] of Object.entries(s.peak)) expect(v, `${w} seed ${seed} ${k}`).toBeLessThan(100);
      expect(s.tasks.pending, `${w} seed ${seed}: every task finished`).toBe(0);
    }
  }, T);

  it('1. NEVER OUT OF USAGE (heavy, demand ~1.5x the week): interactive work never meets a full pool; helpers wait and finish after the reset', () => {
    for (const seed of [1, 2]) {
      const { s } = run('heavy', seed);
      expect(s.walls.interactive, `seed ${seed}`).toBe(0);
      expect(s.walls.helper, `seed ${seed}`).toBe(0);
      expect(s.interactiveBlocked, `seed ${seed}`).toBe(0);
      // The first week runs dry of helper capacity: work queues (hours), is held over the weekly reset, and none is lost.
      expect(s.queueDelayMin.p95, `seed ${seed}`).toBeGreaterThan(120);
      expect(s.heldOverReset, `seed ${seed}`).toBeGreaterThan(0);
      expect(s.tasks.pending, `seed ${seed}`).toBe(0);
      expect(s.tasks.completed + s.tasks.gaveUp, `seed ${seed}`).toBe(s.tasks.arrived);
      for (const p of ['claude:all', 'codex:all']) expect(s.weeklyAtReset[p]![0]!, `seed ${seed} ${p}`).toBeLessThan(100);
    }
  }, T);

  it.each(['steady', 'bursty'] as WorkloadName[])('2. NOT WASTING (%s, enough demand): each account-wide weekly pool resets at 85%% or more', (w) => {
    for (const seed of SEEDS) {
      const { s } = run(w, seed);
      // claude:opus is a sub-limit inside claude:all (its use counts in both): once the account pool is spent it cannot be, so it
      // is reported, not asserted (scripts/simulate-week.ts: 81-86%).
      for (const p of ['claude:all', 'codex:all']) expect(s.weeklyAtReset[p]![0]!, `${w} seed ${seed} ${p}`).toBeGreaterThanOrEqual(85);
    }
  }, T);

  it('3. RESERVE: helpers without a deadline never carry a pool into its reserve (beyond reading noise); interactive work always runs', () => {
    for (const w of ['steady', 'bursty', 'heavy', 'chronica'] as WorkloadName[]) for (const seed of w === 'heavy' ? [1, 2] : SEEDS) {
      const { s } = run(w, seed);
      // Weekly windows: readings are whole percents taken minutes late, so up to 2 points past the line is noise, not a breach.
      // 5h windows: one run is up to ~40% of Codex's 5h window and its real tokens vary +-40% (a tail draw is 2x), so the 10% 5h
      // reserve is the buffer that absorbs a run's estimate error; it may be used up to 10 points (measured max over seeds 1-6 of
      // steady, bursty, heavy: 9.6, bursty seed 2), never past 100% (property 1). Not a silent tolerance: see the Phase 5 report.
      for (const [k, v] of Object.entries(s.reserveOvershoot)) expect(v, `${w} seed ${seed} ${k}`).toBeLessThanOrEqual(k.endsWith('|session') ? 10 : 2);
      expect(s.interactiveBlocked, `${w} seed ${seed}`).toBe(0);
    }
  }, T);

  it('4. NO PREMIUM WASTE: Fable never; strong models on easy work only when the pool is in spend; hard work on capable models', () => {
    for (const w of ['steady', 'bursty', 'heavy', 'light', 'chronica'] as WorkloadName[]) for (const seed of w === 'heavy' ? [1, 2] : SEEDS) {
      const { s } = run(w, seed);
      expect(s.fableUsed, `${w} seed ${seed}`).toBe(0);
      for (const st of ['neutral', 'conserve', 'protect'] as const) expect(s.premiumLow[st].premium, `${w} seed ${seed} ${st}`).toBe(0);
      // Spend-up is bounded: only quota projected to expire pays for it (a share of the leftover per run), and it buys the strong model
      // at LOW effort ("Opus on low"), never more effort on easy work. The share of easy work it takes is reported (scripts/simulate-week:
      // about half in steady weeks, most of it in a light week, where nearly all of the quota would expire).
      const { r } = run(w, seed);
      const easyPremium = r.decisions.filter((d) => d.kind !== 'concierge' && !d.kept && d.difficulty <= 3 && d.capability >= 5 && d.credit > 0 && entryTier(d) === 'strong');
      for (const d of easyPremium) expect(d.effort, `${w} seed ${seed} ${d.task}`).toBe('low');
      // Difficulty >= 7 lands on a model of capability 5 (Opus, Astra, Sol for code) or on a weaker one at high effort with review.
      expect(s.highWork.other, `${w} seed ${seed}`).toBe(0);
    }
  }, T);

  it('5. BALANCE: both CLIs carry work, and neither sits in protect while the other is in spend for long', () => {
    for (const w of ['steady', 'bursty', 'heavy'] as WorkloadName[]) for (const seed of w === 'heavy' ? [1, 2] : SEEDS) {
      const { s } = run(w, seed);
      const share = s.share.codexDecisions / (s.share.claudeDecisions + s.share.codexDecisions);
      expect(share, `${w} seed ${seed}: codex share of decisions`).toBeGreaterThan(0.1);
      expect(s.protectWhileOtherSpendsH, `${w} seed ${seed}`).toBeLessThanOrEqual(12);
    }
  }, T);

  it('8. DETERMINISM: the same seed gives the same decision log; another seed does not', () => {
    const a = simulate({ workload: 'bursty', seed: 7, days: 2 });
    const b = simulate({ workload: 'bursty', seed: 7, days: 2 });
    expect(a.decisions.length).toBeGreaterThan(50);
    expect(JSON.stringify(b.decisions)).toBe(JSON.stringify(a.decisions));
    expect(JSON.stringify(b.hours)).toBe(JSON.stringify(a.hours));
    expect(JSON.stringify(simulate({ workload: 'bursty', seed: 8, days: 2 }).decisions)).not.toBe(JSON.stringify(a.decisions));
  }, T);
});
