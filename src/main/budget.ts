import type { CliId } from '../shared/api';
import type { ReportedLimit } from './codexLimits';
import { poolOf, type CatalogEntry } from './clis/capabilities';
import type { PressureWindow } from './usage';

/**
 * Budget governor, part 1: where each quota pool stands. PURE: no I/O, no clock reads (every function takes `now`).
 *
 * A pool (see POOLS in capabilities.ts) has a weekly and a 5h window. For each window we derive what is left (W, % of the window),
 * the hours to its reset (H), the trailing burn rate (b, %/h) and a reserve kept for interactive work (R). Then
 *   usable = max(0, W - R), projected = used + b*H, rho = usable / (b*H)   (Infinity when b*H is ~0)
 * rho > 1 means the window resets with quota unspent at the current burn (spend it), rho < 1 means it runs dry first (conserve).
 * Every constant below is a STARTING VALUE, to be tuned by the simulator (Phase 5); none is a provider fact.
 * Harbor's own run counts are estimates and are labelled as such (`source: 'estimated'`); only `reported` readings come from the provider.
 */

export type BudgetPeriod = 'session' | 'weekly';
export type PoolStateName = 'spend' | 'neutral' | 'conserve' | 'protect';
export const BUDGET_PERIODS: readonly BudgetPeriod[] = ['weekly', 'session'];

const HOUR_MS = 3_600_000;
/** Window lengths in hours: used for the average pace since a window started and for rolling estimates without a reset time. */
export const WINDOW_HOURS: Record<BudgetPeriod, number> = { weekly: 7 * 24, session: 5 };

/** rho above this: the window would reset with this much more quota than the burn uses, so spend. */
export const SPEND_RHO = 1.25;
/** rho in [NEUTRAL_MIN_RHO, SPEND_RHO]: on course, nothing to correct. */
export const NEUTRAL_MIN_RHO = 0.8;
/** rho in [CONSERVE_MIN_RHO, NEUTRAL_MIN_RHO): runs dry somewhat early, lean on cheaper options; below it, protect the pool. */
export const CONSERVE_MIN_RHO = 0.5;
/** Demand (b*H, in %) below this counts as no demand: rho is Infinity (nothing burns, all of `usable` would be lost). */
export const RHO_EPSILON_PCT = 0.01;
/** Scarcity = clamp(1/rho): a pool in surplus never makes work free (floor), a starved one never infinitely dear (cap). */
export const SCARCITY_MIN = 0.4;
export const SCARCITY_MAX = 4;

/**
 * Reserve: share of the window kept for the owner's own interactive work, by window. Phase 5 simulator: weekly 20% held through a
 * steady week left the account pools at 82.9-89.8% at the reset (seeds 1-6); 15% (decaying over 72h) gives 85.2-93.4% while
 * interactive work never found a pool closed, also in the heavy workload (demand 1.5x the week).
 */
export const RESERVE_PCT: Record<BudgetPeriod, number> = { weekly: 15, session: 10 };
/**
 * The reserve decays linearly over this many hours before the reset (unspent reserve is lost at the reset anyway), down to
 * RESERVE_FLOOR_PCT. Phase 5 simulator: with 24h the weekly pools of a steady week reset at 74-81% (seeds 1-3), with 48h at 79-85%,
 * with 72h (and the 15% reserve) at 85-93%.
 */
export const RESERVE_DECAY_HOURS: Record<BudgetPeriod, number> = { weekly: 72, session: 1 };
/**
 * What helpers never take, even at the reset: estimates are off by tens of percent per run (token noise, readings minutes late), and a
 * pool that reaches 100% stops interactive work too. Phase 5 simulator: with no floor a steady week ended at 99.4% of a weekly window
 * and a heavy one went over 100% in its last hour.
 */
export const RESERVE_FLOOR_PCT: Record<BudgetPeriod, number> = { weekly: 3, session: 4 };
/** At deadline urgency 1 the reserve shrinks by this share (the owner asked for that work; some reserve stays for chat). */
export const RESERVE_URGENCY_RELEASE = 0.75;

/** Burn rate: provider readings from the last BURN_LOOKBACK_MS feed a time-weighted EMA with time constant BURN_EMA_TAU_MS. */
export const BURN_LOOKBACK_MS = 24 * HOUR_MS;
export const BURN_EMA_TAU_MS = 8 * HOUR_MS;
/** Two readings closer than this are merged (percentages are rounded; a short span turns rounding into a wild rate). */
export const BURN_MIN_SPAN_MS = 15 * 60_000;
/** Same window when the reset time moved by less than this (matches usage.ts). */
export const SAME_WINDOW_MS = 2 * 60_000;
/** The average pace since a window started is used only past this share of the window (earlier it is noise). */
export const PACE_MIN_ELAPSED = 0.1;

/** Trust (same idea and values as ROUTING_WEIGHTS' stale logic): fresh up to STALE_AFTER_MS, then linearly down to STALE_FLOOR at STALE_FULL_MS. */
export const STALE_AFTER_MS = 3 * HOUR_MS;
export const STALE_FULL_MS = 24 * HOUR_MS;
export const STALE_FLOOR = 0.25;
/** Harbor's own count of its runs is a guess about the provider's quota: it counts this much. */
export const ESTIMATE_TRUST = 0.5;

/** Parallelism: never more helpers at once than this, whatever the budget says. */
export const MAX_HELPERS_CAP = 3;
/** A helper is assumed to run this long within the 5h window when checking that window's room. */
export const HELPER_RUN_HOURS = 1;

/** NaN (a bad external number) clamps to `lo` instead of poisoning every score it feeds. */
const clamp = (v: number, lo: number, hi: number) => (Number.isNaN(v) ? lo : Math.min(hi, Math.max(lo, v)));

/** `claude:opus` -> cli 'claude', scope 'opus' (the provider's per-model limit name); `<cli>:all` -> no scope (account-wide). */
export function poolTarget(pool: string): { cli: CliId; scope?: string } {
  const i = pool.indexOf(':');
  const cli = i < 0 ? pool : pool.slice(0, i), rest = i < 0 ? 'all' : pool.slice(i + 1);
  return rest === 'all' ? { cli } : { cli, scope: rest };
}

/** Pool id of a CLI and limit scope: the inverse of poolTarget. */
export const poolId = (cli: CliId, scope?: string): string => `${cli}:${scope ?? 'all'}`;

/** Pools a model draws from: its most specific pool and its CLI's account-wide pool. The tightest one binds. */
export function poolsOfEntry(e: Pick<CatalogEntry, 'cli' | 'pool'>): string[] {
  return [...new Set([poolOf(e), poolId(e.cli)])];
}

/** One window of one pool, as observed. */
export interface PoolWindowInput {
  period: BudgetPeriod;
  /** Provider readings of this window (any order; older windows and other scopes are ignored by the burn rate). */
  readings: readonly ReportedLimit[];
  /** Harbor's own estimate, used only without a live provider reading. Rolling: no reset time means a full window of rolling history. */
  estimate?: { usedPct: number; resetsAt?: number; calibrated?: boolean };
  /**
   * What Harbor's runs in flight are still expected to burn in this window (routePrice.committedFor), in %. Counted as used for
   * helpers (not for interactive work, which has the reserve): a reading cannot show it yet.
   */
  committedPct?: number;
}
export interface PoolInput {
  pool: string;
  windows: PoolWindowInput[];
  /** The provider rate limited this pool (or its whole CLI) until then: unavailable regardless of the readings. */
  rateLimitedUntil?: number;
}

export type BurnSource = 'reported' | 'pace' | 'estimated' | 'none';

export interface PoolWindowState {
  pool: string;
  period: BudgetPeriod;
  /** Where W came from. 'unknown' = no reading at all: neutral, trust 0. */
  source: 'reported' | 'estimated' | 'unknown';
  usedPct: number;
  /** W */
  remainingPct: number;
  /** H; a full window when the reset time is unknown. */
  hoursToReset: number;
  resetsAt?: number;
  /** b, %/h. 'reported' = EMA of successive provider readings (includes use outside Harbor); 'pace' = average since the window started; 'estimated' = Harbor runs only. */
  burnPctPerHour: number;
  burnSource: BurnSource;
  /** R */
  reservePct: number;
  usablePct: number;
  /** used + b*H */
  projectedPct: number;
  rho: number;
  /** What the numbers say. */
  rawState: PoolStateName;
  /** What routing should act on: rawState, except a stale or unknown reading is 'neutral'. */
  state: PoolStateName;
  /** 0..1: 1 = fresh provider reading; less for an old one; ESTIMATE_TRUST for an estimate; 0 when unknown. */
  trust: number;
  stale: boolean;
  ageMs?: number;
  /** Remaining is at or below the reserve (or 0 for an estimate): automatic work should not draw on it until `resetsAt`. */
  exhausted: boolean;
}

export interface PoolState {
  pool: string;
  windows: PoolWindowState[];
  /** The tightest window's state (highest scarcity); 'neutral' when nothing is known. */
  state: PoolStateName;
  /** Smallest rho over the windows. */
  rho: number;
  /** max over windows of scarcity(window). */
  scarcity: number;
  /** Rate limited, or a window exhausted: unavailable for automatic work until `unavailableUntil` (undefined = unknown). */
  exhausted: boolean;
  unavailableUntil?: number;
}

/** Trust of one reading, from its source and age (see the STALE_ constants). */
export function readingTrust(source: 'reported' | 'estimated' | 'unknown', ageMs?: number): number {
  if (source === 'unknown') return 0;
  if (source === 'estimated') return ESTIMATE_TRUST;
  if (ageMs === undefined || ageMs <= STALE_AFTER_MS) return 1;
  return Math.max(STALE_FLOOR, 1 - (1 - STALE_FLOOR) * (ageMs - STALE_AFTER_MS) / (STALE_FULL_MS - STALE_AFTER_MS));
}

/** State for a rho (boundaries: > SPEND_RHO spend, >= NEUTRAL_MIN_RHO neutral, >= CONSERVE_MIN_RHO conserve, else protect). */
export function stateOf(rho: number): PoolStateName {
  if (rho > SPEND_RHO) return 'spend';
  if (rho >= NEUTRAL_MIN_RHO) return 'neutral';
  if (rho >= CONSERVE_MIN_RHO) return 'conserve';
  return 'protect';
}

/**
 * Reserve kept for interactive work in one window: RESERVE_PCT, decaying linearly to RESERVE_FLOOR_PCT over the last RESERVE_DECAY_HOURS before the
 * reset (what is not used by then is lost anyway), and shrunk by deadline urgency (work the owner needs by a deadline may use it).
 */
export function reserveFor(urgency: number, hoursToReset: number, period: BudgetPeriod = 'weekly'): number {
  const decay = clamp(hoursToReset / RESERVE_DECAY_HOURS[period], 0, 1);
  return Math.max(RESERVE_FLOOR_PCT[period], RESERVE_PCT[period] * decay) * (1 - RESERVE_URGENCY_RELEASE * clamp(urgency, 0, 1));
}

/**
 * Deadline urgency in [0,1]: 1 - slack/ETA with slack = minutes to the deadline - ETA. 0 without a deadline or with at least twice the
 * ETA left; 1 when the deadline is already at or inside the ETA. `criticalPathMinutes` is the ETA of the longest remaining chain.
 */
export function urgency(o: { deadline?: number; now: number; criticalPathMinutes: number }): number {
  if (o.deadline === undefined) return 0;
  const left = (o.deadline - o.now) / 60_000;
  if (o.criticalPathMinutes <= 0) return left <= 0 ? 1 : 0;
  return clamp(1 - (left - o.criticalPathMinutes) / o.criticalPathMinutes, 0, 1);
}

/**
 * Trailing burn rate (%/h) from successive provider readings of ONE window: a time-weighted EMA of the rise between readings at least
 * BURN_MIN_SPAN_MS apart, over the last BURN_LOOKBACK_MS. A pair across a reset (reset time moved, or the percent fell) starts over.
 * Because readings are the provider's own counter, use outside Harbor raises the rate too. Undefined with fewer than two usable readings.
 */
export function burnFromReadings(readings: readonly ReportedLimit[], now: number): number | undefined {
  const rs = readings.filter((r) => r.asOf <= now && r.asOf >= now - BURN_LOOKBACK_MS).slice().sort((a, b) => a.asOf - b.asOf);
  let anchor: ReportedLimit | undefined, ema: number | undefined;
  for (const r of rs) {
    if (!anchor) { anchor = r; continue; }
    if (Math.abs(r.resetsAt - anchor.resetsAt) > SAME_WINDOW_MS || r.usedPct < anchor.usedPct) { anchor = r; continue; }
    const dt = r.asOf - anchor.asOf;
    if (dt < BURN_MIN_SPAN_MS) continue;
    const rate = (r.usedPct - anchor.usedPct) / (dt / HOUR_MS);
    ema = ema === undefined ? rate : ema + (1 - Math.exp(-dt / BURN_EMA_TAU_MS)) * (rate - ema);
    anchor = r;
  }
  return ema;
}

/**
 * A weekly window's burn is the average over about a day (the reading closest to 24h before the newest one, at most DAILY_BURN_MAX_MS
 * old), or over what there is of it when the window is younger, from DAILY_BURN_MIN_MS. Work follows the owner's day: an EMA of
 * daytime readings projects daytime burn over nights. Phase 5 simulator (steady week): with the EMA alone the weekly pools sat in
 * neutral or conserve most of the week and reset about 45% unused; and an EMA over the first readings of a week (1% steps 15 minutes
 * apart) swung between 0 and 12%/h and put a fresh week in protect.
 */
export const DAILY_BURN_MIN_MS = 2 * HOUR_MS;
export const DAILY_BURN_MAX_MS = 30 * HOUR_MS;

/** %/h between the newest reading and the one closest to a day before it (same window, DAILY_BURN_MIN_MS to _MAX_MS older). */
export function dailyBurn(readings: readonly ReportedLimit[], now: number): number | undefined {
  const live = latestLive(readings, now);
  if (!live) return undefined;
  let old: ReportedLimit | undefined;
  const off = (r: ReportedLimit) => Math.abs(live.asOf - r.asOf - 24 * HOUR_MS);
  for (const r of readings) {
    const age = live.asOf - r.asOf;
    if (age < DAILY_BURN_MIN_MS || age > DAILY_BURN_MAX_MS || Math.abs(r.resetsAt - live.resetsAt) > SAME_WINDOW_MS) continue;
    if (!old || off(r) < off(old)) old = r;
  }
  if (!old || live.usedPct < old.usedPct) return undefined;
  return (live.usedPct - old.usedPct) / ((live.asOf - old.asOf) / HOUR_MS);
}

/** The newest live (reset in the future) reading of a window. */
function latestLive(readings: readonly ReportedLimit[], now: number): ReportedLimit | undefined {
  let best: ReportedLimit | undefined;
  for (const r of readings) if (r.resetsAt > now && r.asOf <= now && (!best || r.asOf >= best.asOf)) best = r;
  return best;
}

/**
 * How a state is computed for one kind of work. `interactive` (the lead and the concierge, which the owner is waiting on) may use the
 * reserve: its usable quota is everything that is left.
 */
export interface PoolStateOptions { interactive?: boolean }

/** One window's state. `urgency` (0..1) shrinks the reserve; interactive work sees no reserve at all. */
export function poolWindowState(pool: string, w: PoolWindowInput, now: number, urg = 0, o: PoolStateOptions = {}): PoolWindowState {
  const live = latestLive(w.readings, now);
  const len = WINDOW_HOURS[w.period];
  let source: PoolWindowState['source'], usedPct: number, resetsAt: number | undefined, ageMs: number | undefined;
  if (live) { source = 'reported'; usedPct = live.usedPct; resetsAt = live.resetsAt; ageMs = Math.max(0, now - live.asOf); }
  else if (w.estimate) { source = 'estimated'; usedPct = w.estimate.usedPct; resetsAt = w.estimate.resetsAt !== undefined && w.estimate.resetsAt > now ? w.estimate.resetsAt : undefined; }
  else { source = 'unknown'; usedPct = 0; }
  const seenPct = clamp(usedPct, 0, 100);
  // Quota promised to runs in flight is spent as far as new helper work is concerned (only when something is known about the window).
  if (!o.interactive && source !== 'unknown' && w.committedPct && w.committedPct > 0) usedPct += w.committedPct;
  usedPct = clamp(usedPct, 0, 100);
  const remainingPct = 100 - usedPct;
  const hoursToReset = resetsAt !== undefined ? (resetsAt - now) / HOUR_MS : len;

  let burnPctPerHour = 0, burnSource: BurnSource = 'none';
  const same = source === 'reported' ? w.readings.filter((r) => Math.abs(r.resetsAt - live!.resetsAt) <= SAME_WINDOW_MS) : [];
  const fromReadings = source !== 'reported' ? undefined : (w.period === 'weekly' ? dailyBurn(same, now) : undefined) ?? burnFromReadings(same, now);
  const elapsed = 1 - hoursToReset / len;
  if (fromReadings !== undefined) { burnPctPerHour = Math.max(0, fromReadings); burnSource = 'reported'; }
  else if (source === 'reported' && elapsed >= PACE_MIN_ELAPSED) { burnPctPerHour = seenPct / (elapsed * len); burnSource = 'pace'; }
  // A rolling estimate is Harbor's runs over the last full window: its average rate is used% per window length.
  else if (source === 'estimated') { burnPctPerHour = seenPct / len; burnSource = 'estimated'; }

  const reservePct = o.interactive ? 0 : reserveFor(urg, hoursToReset, w.period);
  const usablePct = Math.max(0, remainingPct - reservePct);
  // A weekly burn seen over less than a day is mostly the hours of one working day: projected over the whole week it would read a
  // busy Monday morning as a week run dry. Until a day of readings exists it is pulled toward the on-course rate (rho 1).
  if (w.period === 'weekly' && burnSource === 'reported' && live && hoursToReset > 0) {
    const first = same.reduce((m, r) => (r.asOf >= live.asOf - DAILY_BURN_MAX_MS ? Math.min(m, r.asOf) : m), live.asOf);
    const weight = clamp((live.asOf - first) / (24 * HOUR_MS), 0, 1);
    burnPctPerHour = weight * burnPctPerHour + (1 - weight) * (usablePct / hoursToReset);
  }
  const demand = burnPctPerHour * hoursToReset;
  const rho = demand < RHO_EPSILON_PCT ? Infinity : usablePct / demand;
  // An estimate against Harbor's FALLBACK budget (calibrated false) is a guess about someone else's quota: it may still hold work out
  // at 100% (below), but it never moves prices.
  const trust = source === 'estimated' && w.estimate?.calibrated === false ? 0 : readingTrust(source, ageMs);
  const stale = ageMs !== undefined && ageMs > STALE_AFTER_MS;
  const rawState = source === 'unknown' ? 'neutral' : stateOf(rho);
  // An uncalibrated estimate measures Harbor's runs against a guessed budget: it never holds work out on its own until it hits 100%.
  // With no reserve (interactive work) a reported window is out only when nothing is left.
  const exhausted = source === 'reported' ? (reservePct > 0 ? remainingPct <= reservePct : remainingPct <= 0) : source === 'estimated' ? usedPct >= 100 : false;
  return {
    pool, period: w.period, source, usedPct, remainingPct, hoursToReset, ...(resetsAt !== undefined ? { resetsAt } : {}),
    burnPctPerHour, burnSource, reservePct, usablePct, projectedPct: usedPct + demand, rho, rawState,
    state: stale || source === 'unknown' || trust === 0 ? 'neutral' : rawState, trust, stale, ...(ageMs !== undefined ? { ageMs } : {}), exhausted
  };
}

/**
 * Scarcity multiplier of a window or pool: clamp(1/rho, SCARCITY_MIN, SCARCITY_MAX), pulled toward 1 (neutral) by low trust so an old
 * reading or a Harbor-only estimate moves prices less. rho Infinity gives SCARCITY_MIN.
 */
export function scarcity(s: { rho: number; trust: number }): number {
  const raw = clamp(s.rho === Infinity ? 0 : 1 / Math.max(s.rho, 1e-9), SCARCITY_MIN, SCARCITY_MAX);
  return 1 + clamp(s.trust, 0, 1) * (raw - 1);
}

/** A pool's state over its windows: the tightest window binds. */
export function poolState(p: PoolInput, now: number, urg = 0, o: PoolStateOptions = {}): PoolState {
  const windows = p.windows.map((w) => poolWindowState(p.pool, w, now, urg, o));
  let tight: PoolWindowState | undefined, sc = SCARCITY_MIN, rho = Infinity;
  // A window nobody reports (Opus has no 5h reading of its own) or only a fallback guess of says nothing: the trusted ones decide.
  const trusted = windows.filter((w) => w.trust > 0);
  for (const w of trusted.length ? trusted : windows) {
    const s = scarcity(w);
    if (!tight || s > sc) { tight = w; sc = s; }
    rho = Math.min(rho, w.rho);
  }
  const limited = p.rateLimitedUntil !== undefined && p.rateLimitedUntil > now;
  const out = windows.filter((w) => w.exhausted);
  const exhausted = limited || out.length > 0;
  // Available again once every reason has passed: the latest of the cooldown and the exhausted windows' resets (unknown if any lacks one).
  const untils = [...(limited ? [p.rateLimitedUntil] : []), ...out.map((w) => w.resetsAt)];
  const unavailableUntil = exhausted && untils.every((u) => u !== undefined) ? Math.max(...(untils as number[])) : undefined;
  return {
    pool: p.pool, windows, state: tight ? tight.state : 'neutral', rho, scarcity: tight ? sc : 1, exhausted,
    ...(unavailableUntil !== undefined ? { unavailableUntil } : {})
  };
}

export type PoolStates = Readonly<Record<string, PoolState>>;

/** Effective scarcity of a model: the max over its pools (and their windows). Pools with no state count as neutral (1). */
export function modelScarcity(e: Pick<CatalogEntry, 'cli' | 'pool'>, states: PoolStates): number {
  return Math.max(...poolsOfEntry(e).map((p) => states[p]?.scarcity ?? 1));
}

/** Whether a model can run automatically now, and if not until when (undefined = unknown). */
export function modelAvailability(e: Pick<CatalogEntry, 'cli' | 'pool'>, states: PoolStates): { available: boolean; until?: number } {
  const out = poolsOfEntry(e).map((p) => states[p]).filter((s): s is PoolState => !!s?.exhausted);
  if (!out.length) return { available: true };
  const untils = out.map((s) => s.unavailableUntil);
  return untils.every((u) => u !== undefined) ? { available: false, until: Math.max(...(untils as number[])) } : { available: false };
}

/** Sustainable spend of a window in %/h: what can be used beyond the reserve before the reset. */
export function allowancePerHour(w: Pick<PoolWindowState, 'usablePct' | 'hoursToReset'>): number {
  return w.hoursToReset > 0 ? w.usablePct / w.hoursToReset : w.usablePct;
}

/** Expected burn of one helper, in % of each window per hour (Phase 3 derives it from expectedCost / expectedMinutes). */
export interface HelperBurn { weekly: number; session: number }

/**
 * Helpers at once while a pool's weekly window is in 'conserve' (it runs dry somewhat early at the current burn). Phase 5: the weekly
 * window used to cap parallelism at (usable / hours to reset) / per-helper burn, an all-hours average: one Sonnet implementer running
 * through the working hours only fits it, so the cap was 1 for most of the week. In the simulator (steady week, seeds 1-3) that left
 * helpers queued for hours (p95 340 minutes) while the weekly pools reset 45% unused. The weekly window now limits parallelism through
 * its state (rho already compares the real burn, nights included, with what is usable), the 5h window through its room.
 */
export const CONSERVE_HELPERS = 2;

/** True when the provider itself reported at least one window of this pool (an estimate of Harbor's own is not a measurement). */
export const hasReportedWindow = (s: Pick<PoolState, 'windows'>): boolean => s.windows.some((w) => w.source === 'reported' && w.trust > 0);

/**
 * How many helpers may run at once. Per available pool: the 5h room (usable / (per-helper burn * HELPER_RUN_HOURS)), at most
 * CONSERVE_HELPERS while a window is in 'conserve' and 1 in 'protect'; windows with no reading do not limit. The best pool decides
 * (helpers can be routed to it), capped at MAX_HELPERS_CAP, never below 1 while any pool can run, 0 when every pool is exhausted or
 * rate limited.
 */
export function maxHelpers(o: { states: readonly PoolState[]; perHelperBurnPctPerHour: HelperBurn }): number {
  let best = 0;
  for (const s of o.states) {
    if (s.exhausted) continue;
    let n = MAX_HELPERS_CAP;
    for (const w of s.windows) {
      if (w.source === 'unknown') continue;
      if (w.state === 'conserve') n = Math.min(n, CONSERVE_HELPERS);
      const burn = o.perHelperBurnPctPerHour[w.period];
      if (w.period !== 'session' || !(burn > 0)) continue;
      // 5h window: what one helper burns before the reset (or in HELPER_RUN_HOURS, whichever is sooner) against what is usable now.
      const hours = Math.max(Math.min(w.hoursToReset, HELPER_RUN_HOURS), 1 / 60);
      n = Math.min(n, Math.floor(w.usablePct / (burn * hours)));
    }
    if (s.state === 'protect') n = Math.min(n, 1);
    // Nothing the provider reported for this pool: no fit check and no reserve apply (fitsBudget skips estimated windows), so one helper at a time.
    if (!hasReportedWindow(s)) n = Math.min(n, 1);
    best = Math.max(best, Math.max(1, n));
  }
  return Math.min(MAX_HELPERS_CAP, best);
}

/**
 * Builds pool inputs from what the ledger already holds: provider readings (the CLI's own logs, and limits printed during Harbor runs)
 * and Harbor's estimated windows from `UsageLedger.pressure(cli).windows` (source 'estimated', account-wide only). Pure.
 */
export function poolInputsFrom(o: {
  pools: readonly string[];
  /** Provider readings per CLI: `reported(cli)` plus every UsageEvent.limits of that CLI. */
  readings: Partial<Record<CliId, readonly ReportedLimit[]>>;
  /** Estimated windows per CLI (from `pressure(cli).windows`); reported ones in it are ignored (the readings carry them). */
  estimates?: Partial<Record<CliId, readonly PressureWindow[]>>;
  rateLimitedUntil?: Partial<Record<string, number>>;
}): PoolInput[] {
  return o.pools.map((pool): PoolInput => {
    const { cli, scope } = poolTarget(pool);
    const windows = BUDGET_PERIODS.map((period): PoolWindowInput => {
      const readings = (o.readings[cli] ?? []).filter((r) => r.period === period && r.scope === scope);
      const est = scope === undefined ? o.estimates?.[cli]?.find((w) => w.period === period && w.scope === undefined && w.source === 'estimated') : undefined;
      return { period, readings, ...(est ? { estimate: { usedPct: est.usedPct, ...(est.resetsAt !== undefined ? { resetsAt: est.resetsAt } : {}), ...(est.calibrated !== undefined ? { calibrated: est.calibrated } : {}) } } : {}) };
    });
    const until = o.rateLimitedUntil?.[pool];
    return { pool, windows, ...(until !== undefined ? { rateLimitedUntil: until } : {}) };
  });
}
