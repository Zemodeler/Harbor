import type { AgentRole, CliId } from '../shared/api';
import type { Effort } from './adapters/types';
import { poolId, poolsOfEntry, type BudgetPeriod } from './budget';
import { costPerKTokOf, EFFORT_TOKEN_MULT } from './budgetPriors';
import { DEFAULT_CATALOG, entryFor, type CatalogEntry } from './clis/capabilities';

/**
 * Budget governor, part 2: learning the cost priors from measured runs. PURE: no I/O, no clock. The result is plain JSON so the
 * ledger/store can persist it later (nothing is persisted yet).
 *
 * Three exponential moving averages:
 *   pctPerKTok  quota % of a pool's window per 1k billable tokens of a costPerKTok-1 model (sonnet-equivalent: the run's tokens are
 *               scaled by its model's costPerKTok), keyed `<pool>|<period>`, from the provider's reading before and after a run. A
 *               RATIO OF DECAYED SUMS (sum of deltas / sum of tokens), not an average of per-run ratios: readings are whole percents,
 *               so a small run's delta is 0 or 1 and its own ratio is mostly noise; summed, the rounding cancels out (Phase 5).
 *   tokensK     billable k-tokens per task at medium effort (a run's tokens divided by EFFORT_TOKEN_MULT), keyed `<role>|<size>`
 *   minutes     wall minutes per task, keyed `<role>|<cli>/<model>|<effort>` (recorded; no longer used for estimates, see minPerKTok)
 *   minPerKTok  wall minutes per 1k billable tokens, keyed like minutes: estimates take expected tokens times this. Phase 5: minutes
 *               per task mixed sizes under one key, so a model calibrated on medium runs expected a large run to take the same 14
 *               minutes, and the quota a long run in flight still needed was counted as nearly spent.
 * A measured value replaces its prior only after CALIBRATION_MIN_SAMPLES samples; before that the two blend linearly (n/N measured).
 * Partial and failed runs are not averaged (their counts are cut short) but are kept as a lower bound on tokens and minutes.
 */

export type BudgetRole = 'planner' | 'implementer' | 'reviewer' | 'other';
export type TaskSize = 'small' | 'medium' | 'large';
export const BUDGET_ROLES: readonly BudgetRole[] = ['planner', 'implementer', 'reviewer', 'other'];
export const TASK_SIZES: readonly TaskSize[] = ['small', 'medium', 'large'];

/** The lead's own turns are priced like 'other' work. */
export const budgetRole = (r: AgentRole): BudgetRole => (r === 'main' ? 'other' : r);

/** Samples needed before a measured average fully replaces its prior. */
export const CALIBRATION_MIN_SAMPLES = 5;
/** Weight of the newest sample in every average (about the last 1/alpha samples dominate). */
export const CALIBRATION_EMA_ALPHA = 0.2;
/** Cache reads cost the provider (and, as far as is known, the quota) a fraction of fresh input: placeholder weight. */
export const CACHE_READ_WEIGHT = 0.1;
/** Runs below this many k-tokens are too small for a quota-per-token sample (rounded percentages would dominate). */
export const MIN_SAMPLE_KTOK = 20;
/**
 * Runs shorter than this give no quota-per-token sample: provider readings trail the use they count by a few minutes, so the reading
 * at a run's end misses its last minutes, and on a short run that is most of it. Phase 5 simulator: with every run sampled the
 * estimates settled at 0.72-0.83 of the truth (readings 5 minutes late); from 15 minutes Codex, whose runs are short, had too few
 * samples a day after priors 2x off (0.72 of the truth on day 2, and a 5h window run to 100%); 10 minutes gives 0.85-1.2.
 */
export const MIN_SAMPLE_MINUTES = 10;
/**
 * Each new quota sample keeps this share of the earlier sums (about the last 1/(1-x) samples count). Phase 5 simulator: a Claude run is
 * 0.3-3% of the weekly window, read in whole percents, so one sample is +-50% noise; at 0.95 (~20 samples) the weekly estimate ended
 * 0.8-1.4x the truth, at 0.98 (~50 samples) 0.9-1.2x, still settling within the first day after the priors were 2x off.
 */
export const RATIO_KEEP = 0.98;

export interface Ema {
  /** Average of the full samples (meaningless while n is 0). */
  value: number;
  n: number;
  /** Average of partial/failed samples: a lower bound on the true value. */
  floor?: number;
  floorN?: number;
  /** Ratio estimates (pctPerKTok): decayed sums of the numerators and denominators; `value` = num / den. */
  num?: number;
  den?: number;
}

export interface Calibration {
  version: 1;
  /** Events at or before this time were already folded in (calibrate is incremental over a growing event list). */
  throughTime: number;
  pctPerKTok: Record<string, Ema>;
  tokensK: Record<string, Ema>;
  minutes: Record<string, Ema>;
  /** Absent in files written before Phase 5. */
  minPerKTok?: Record<string, Ema>;
}

/** One measured run. A UsageEvent plus what the orchestrator knows about the task (role, size, effort) and readings around it. */
export interface CalibrationSample {
  time: number; cli: CliId; model: string; ok: boolean; durationMs: number;
  inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number;
  partial?: boolean;
  role?: AgentRole; size?: TaskSize; effort?: Effort;
  /** Provider readings of the same window just before and just after the run (`scope` as in ReportedLimit). Use outside Harbor in between inflates the sample. */
  quota?: Array<{ period: BudgetPeriod; scope?: string; beforePct: number; afterPct: number }>;
  /** Cost-weighted k-tokens other Harbor runs burned in each pool meanwhile (runCalibration.overlapKTok): part of the same delta. */
  overlap?: Array<{ pool: string; kTok: number }>;
}

export const emptyCalibration = (): Calibration => ({ version: 1, throughTime: 0, pctPerKTok: {}, tokensK: {}, minutes: {}, minPerKTok: {} });

export const pctKey = (pool: string, period: BudgetPeriod) => `${pool}|${period}`;
export const tokensKey = (role: BudgetRole, size: TaskSize) => `${role}|${size}`;
export const minutesKey = (role: BudgetRole, cli: CliId, model: string, effort: Effort) => `${role}|${cli}/${model}|${effort}`;

/** Billable k-tokens of a run: fresh input, output and cache writes in full, cache reads at CACHE_READ_WEIGHT. Undefined when nothing was counted. */
export function billableKTok(s: Pick<CalibrationSample, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number | undefined {
  const parts = [s.inputTokens, s.outputTokens, s.cacheWriteTokens, s.cacheReadTokens];
  if (parts.every((p) => p === undefined)) return undefined;
  return ((s.inputTokens ?? 0) + (s.outputTokens ?? 0) + (s.cacheWriteTokens ?? 0) + CACHE_READ_WEIGHT * (s.cacheReadTokens ?? 0)) / 1000;
}

function fold(e: Ema | undefined, v: number): Ema {
  if (!e || e.n === 0) return { ...e, value: v, n: 1 };
  return { ...e, value: e.value + CALIBRATION_EMA_ALPHA * (v - e.value), n: e.n + 1 };
}
function foldRatio(e: Ema | undefined, num: number, den: number): Ema {
  const n0 = e && e.n > 0 ? (e.num ?? e.value * (e.den ?? 1)) : 0, d0 = e && e.n > 0 ? (e.den ?? 1) : 0;
  const nn = RATIO_KEEP * n0 + num, dd = RATIO_KEEP * d0 + den;
  return { ...e, value: dd > 0 ? nn / dd : 0, n: (e?.n ?? 0) + 1, num: nn, den: dd };
}
function foldFloor(e: Ema | undefined, v: number): Ema {
  const base: Ema = e ?? { value: 0, n: 0 };
  const floor = base.floor === undefined ? v : base.floor + CALIBRATION_EMA_ALPHA * (v - base.floor);
  return { ...base, floor, floorN: (base.floorN ?? 0) + 1 };
}

/** Folds the samples newer than `previous.throughTime` into a new Calibration (the previous one is not mutated). */
export function calibrate(samples: readonly CalibrationSample[], previous?: Calibration, catalog: readonly CatalogEntry[] = DEFAULT_CATALOG): Calibration {
  const c: Calibration = previous
    ? { version: 1, throughTime: previous.throughTime, pctPerKTok: { ...previous.pctPerKTok }, tokensK: { ...previous.tokensK }, minutes: { ...previous.minutes }, minPerKTok: { ...previous.minPerKTok } }
    : emptyCalibration();
  const fresh = samples.filter((s) => s.time > c.throughTime).slice().sort((a, b) => a.time - b.time);
  for (const s of fresh) {
    const full = s.ok && !s.partial;
    const k = billableKTok(s);
    const role = s.role ? budgetRole(s.role) : undefined;
    if (role && s.size && k !== undefined) {
      const key = tokensKey(role, s.size);
      const medium = k / EFFORT_TOKEN_MULT[s.effort ?? 'medium'];
      c.tokensK[key] = full ? fold(c.tokensK[key], medium) : foldFloor(c.tokensK[key], medium);
    }
    if (role && s.effort && s.durationMs > 0) {
      const key = minutesKey(role, s.cli, s.model, s.effort), m = s.durationMs / 60_000;
      c.minutes[key] = full ? fold(c.minutes[key], m) : foldFloor(c.minutes[key], m);
      // A cut-short run's tokens are a lower bound, so its minutes per token would overstate the rate: full runs only.
      if (full && k !== undefined && k >= MIN_SAMPLE_KTOK) { const r = (c.minPerKTok ??= {}); r[key] = fold(r[key], m / k); }
    }
    // Quota per token needs the full token count: a partial run's tokens are a lower bound, so its ratio would overstate the cost.
    if (full && k !== undefined && k >= MIN_SAMPLE_KTOK && s.durationMs >= MIN_SAMPLE_MINUTES * 60_000) {
      const entry = entryFor(catalog, s.cli, s.model);
      // Only the pools this model draws on: a Sonnet run's readings of the Opus window measure other runs, not Sonnet (Phase 5 found
      // every Claude run feeding the Opus and Fable estimates).
      const ownPools = entry ? poolsOfEntry(entry) : undefined;
      for (const q of s.quota ?? []) {
        if (ownPools && !ownPools.includes(poolId(s.cli, q.scope))) continue;
        const delta = q.afterPct - q.beforePct;
        if (delta < 0) continue; // the window reset in between
        const pool = poolId(s.cli, q.scope), key = pctKey(pool, q.period);
        const mine = k * costPerKTokOf(entry);
        const others = s.overlap?.find((x) => x.pool === pool)?.kTok ?? 0;
        c.pctPerKTok[key] = foldRatio(c.pctPerKTok[key], delta, mine + Math.max(0, others));
      }
    }
    c.throughTime = Math.max(c.throughTime, s.time);
  }
  return c;
}

/** Share of the measured value in a blend: n / CALIBRATION_MIN_SAMPLES, at most 1. */
export const measuredWeight = (n: number): number => Math.min(1, Math.max(0, n) / CALIBRATION_MIN_SAMPLES);

/**
 * The value to use: prior blended with the measured average (n/N measured), never below the partial-run lower bound when `useFloor`.
 * A lower bound from cut-short runs can only raise an estimate, never lower it.
 */
export function calibrated(prior: number, e: Ema | undefined, useFloor = true): number {
  if (!e) return prior;
  const w = measuredWeight(e.n);
  const v = w * (e.n > 0 ? e.value : prior) + (1 - w) * prior;
  return useFloor && e.floor !== undefined ? Math.max(v, e.floor) : v;
}
