import type { AgentRole, CliId } from '../shared/api';
import type { Effort } from './adapters/types';
import { poolInputsFrom, poolState, poolsOfEntry, type BudgetPeriod, type HelperBurn, type PoolInput, type PoolState, type PoolStates } from './budget';
import { EFFORT_BONUS, capabilityOf, expectedCost, expectedMinutes, expectedTokens, price, quotaPerKTok, requiredLevel, type PriceBreakdown } from './budgetCost';
import { costPerKTokOf, poolPctPrior } from './budgetPriors';
import { budgetRole, calibrated, pctKey, type Calibration, type TaskSize } from './calibration';
import type { CatalogEntry, Need } from './clis/capabilities';
import type { UsageLedger } from './usage';

/**
 * Router side of the budget governor: the price of each (model, effort) option for one routing request, and how a price becomes
 * score points. PURE apart from reading the ledger it is handed. Builds on budgetCost.price (Phase 2) and adds three things routing
 * needs: use-it-or-lose-it credit, the cost of an automatic review for work that only just clears, and the conversion to points.
 * Every constant is a STARTING VALUE for the Phase 5 simulator. Prices are ESTIMATES in scarcity-weighted weekly-quota %.
 */

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];
export const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2 };

/** Score points per doubling of price over the cheapest feasible option: a session's stickiness (28) holds against a ~7x cheaper option. */
export const PRICE_POINTS_PER_DOUBLING = 10;
/** The price term never costs more than this: below an explicit request (60), so a named CLI always wins while it is available. */
export const PRICE_CAP = 55;
/**
 * Prices are compared as (price + this): differences of a twentieth of a percent of a week are noise, and a free option does not divide
 * by 0. Phase 5: was 0.1; the measured priors made a medium Claude task ~0.2% of the week (was ~2%), so 0.1 flattened most price gaps
 * into noise (a session stayed on a pool in conserve while the other's quota expired, tests/weeklyPacing a); 0.02 made a lead session
 * move every time one pool's credit came or went (7 moves in the 40-turn week, tests/weeklyPacing i). 0.05 keeps both.
 */
export const PRICE_EPSILON_PCT = 0.05;
/** Work at or above this difficulty whose model clears the floor by less than REVIEW_MARGIN levels gets an automatic review. */
export const REVIEW_MIN_DIFFICULTY = 7;
export const REVIEW_MARGIN = 0.25;

/** One routing request as the pricing sees it. */
export interface RouteTask {
  role: AgentRole;
  difficulty: number;
  size: TaskSize;
  needs?: readonly Need[];
  /** Deadline urgency 0..1 (0 without a deadline). */
  urgency?: number;
}

export interface RoutePrice extends PriceBreakdown {
  /** The need the price was judged on: the stated need this model is weakest at (default 'code'). */
  need: Need;
  /** capability + effort bonus - required level: how far above (or below, negative) the floor this option is. */
  margin: number;
  /** Weekly % of this run that draws on quota projected to expire unused (fresh provider readings only); costs nothing. */
  wasteCreditPct: number;
  /** clears the floor by less than REVIEW_MARGIN (or not at all) on work of REVIEW_MIN_DIFFICULTY or more. */
  needsReview: boolean;
  /** Price of that review (a reviewer run on this model at medium effort), included in routeTotal. */
  reviewPrice: number;
  /** What routing compares: the waste-credited price plus the review. */
  routeTotal: number;
}

/** The stated need this model is weakest at: the one that limits it. Needs without a score count as the catalog says (strength or not). */
export function bindingNeed(e: Pick<CatalogEntry, 'capability' | 'strengths'>, needs?: readonly Need[]): Need {
  const list = [...new Set(needs?.length ? needs : (['code'] as Need[]))];
  return list.reduce((a, b) => (capabilityOf(e, b) < capabilityOf(e, a) ? b : a));
}

/** How far above the required level a model at an effort is (negative = below the floor). */
export function marginOf(e: Pick<CatalogEntry, 'capability' | 'strengths'>, need: Need, difficulty: number, effort: Effort): number {
  return capabilityOf(e, need) + EFFORT_BONUS[effort] - requiredLevel(difficulty);
}

export const reviewNeeded = (difficulty: number, margin: number): boolean => difficulty >= REVIEW_MIN_DIFFICULTY && margin < REVIEW_MARGIN - 1e-9;

/**
 * Use-it-or-lose-it credit starts this many hours before a weekly reset and is whole from CREDIT_FULL_HOURS on. Phase 5 simulator
 * (steady week, seeds 1-3, claude:all at its reset): 72h/12h 74-83%, 120h/24h 77-85%, 168h/48h (with CREDIT_RUN_SHARE 0.5) 79-86%,
 * before the reserve and price changes that brought it to 86-94%. A week is the whole window: with fresh readings and a pool in spend
 * the leftover is a projection, and spending raises the burn, which shrinks it.
 */
export const CREDIT_START_HOURS = 168;
export const CREDIT_FULL_HOURS = 48;
/**
 * One run may draw at most this share of the projected leftover as credit. Phase 5: the credit used to be a share of the run's own cost
 * (near * cost), which leaves every price RATIO unchanged until the share reaches 1, so nothing spent up before the last ~12 hours and
 * a steady week (seeds 1-3) reset with 40-55% of the weekly quota unused. An allowance per run makes runs that fit in it free, so the
 * strongest model at the lowest effort wins them; spending raises the burn, which shrinks the leftover and with it the allowance.
 */
export const CREDIT_RUN_SHARE = 0.5;

/**
 * Use it or lose it. When every window of a pool that has a reading is in 'spend' (so its 5h window has room too) and a fresh provider reading of its
 * weekly window projects quota left over at the reset (usable - burn * hours), the part of a run that fits in that leftover would
 * expire anyway: it is credited, scaled by trust and by how close the reset is (a leftover five days out is a guess about the rest of
 * the week; in the last CREDIT_FULL_HOURS it is certain). This is what lets Opus take easy work when its pool would go unused.
 */
export function wasteCredit(s: PoolState | undefined, costPct: number): number {
  // Every window with a trusted reading must be in spend (a window the provider never reports, e.g. a per-model 5h limit, or a guess
  // against Harbor's fallback budget, does not block it).
  const known = s?.windows.filter((x) => x.trust > 0) ?? [];
  if (!s || s.exhausted || !known.length || !known.every((x) => x.state === 'spend' || (x.period === 'session' && x.state === 'neutral'))) return 0;
  const w = s.windows.find((x) => x.period === 'weekly' && x.source === 'reported' && !x.stale);
  if (!w) return 0;
  const leftover = w.usablePct - w.burnPctPerHour * w.hoursToReset;
  const near = Math.min(1, Math.max(0, (CREDIT_START_HOURS - w.hoursToReset) / (CREDIT_START_HOURS - CREDIT_FULL_HOURS)));
  return leftover > 0 ? Math.min(costPct, w.trust * near * leftover * CREDIT_RUN_SHARE) : 0;
}

/** The binding pool after credit: the largest (cost - credit) * scarcity over the model's pools. */
function creditedCost(all: ReadonlyArray<{ pool: string; costPct: number; scarcity: number }>, states: PoolStates): { term: number; credit: number; pool: string; costPct: number; scarcity: number } {
  // A pool nothing is known about (no provider reading, no estimate: e.g. a per-model cap this account's provider never reports) is a
  // guess about a limit that may not exist: it binds only when none of the model's pools is known. Without this a model whose own
  // pool is never reported (Opus on the measured account) was always priced as neutral, so it never got the use-it-or-lose-it credit.
  const informed = all.filter((p) => states[p.pool]?.windows.some((w) => w.source !== 'unknown'));
  const pools = informed.length ? informed : all;
  let best = { term: -1, credit: 0, pool: pools[0]?.pool ?? '', costPct: 0, scarcity: 1 };
  for (const p of pools) {
    const credit = wasteCredit(states[p.pool], p.costPct);
    const term = Math.max(0, p.costPct - credit) * p.scarcity;
    if (term > best.term) best = { term, credit, pool: p.pool, costPct: p.costPct, scarcity: p.scarcity };
  }
  return { ...best, term: Math.max(0, best.term) };
}

/** Price of one option for routing. */
export function priceOption(o: { model: CatalogEntry; effort: Effort; task: RouteTask; states: PoolStates; calibration?: Calibration }): RoutePrice {
  const need = bindingNeed(o.model, o.task.needs);
  const role = budgetRole(o.task.role);
  const base = price({ model: o.model, effort: o.effort, task: { role, size: o.task.size, difficulty: o.task.difficulty, need }, states: o.states, calibration: o.calibration, urgency: o.task.urgency });
  const cost = creditedCost(base.pools, o.states);
  const margin = marginOf(o.model, need, o.task.difficulty, o.effort);
  const needsReview = reviewNeeded(o.task.difficulty, margin);
  let reviewPrice = 0;
  if (needsReview) {
    // Phase 4 schedules the reviewer; its model is not known yet, so it is priced on this one at medium effort.
    const rc = expectedCost({ role: 'reviewer', size: o.task.size, effort: 'medium', model: o.model, calibration: o.calibration });
    reviewPrice = creditedCost(rc.pools.map((p) => ({ pool: p.pool, costPct: p.pct, scarcity: o.states[p.pool]?.scarcity ?? 1 })), o.states).term;
  }
  const total = cost.term * base.failureFactor + base.timeCost;
  return {
    ...base, bindingPool: cost.pool, expectedCostPct: cost.costPct, scarcity: cost.scarcity, costTerm: cost.term, total,
    need, margin, wasteCreditPct: cost.credit, needsReview, reviewPrice, routeTotal: total + reviewPrice
  };
}

/**
 * The best effort for one model: the cheapest feasible (clears, available) option among `efforts`; on a tie the one less likely to
 * fail by at least a whole percent (equal prices mean credit made them free: spend the expiring quota on care), else the lower effort. When none clears, the
 * strongest allowed effort is returned with `clears` false, so the caller can still use it as a degraded fallback.
 */
export function bestEffort(o: { model: CatalogEntry; efforts: readonly Effort[]; task: RouteTask; states: PoolStates; calibration?: Calibration }): RoutePrice {
  const opts = o.efforts.map((effort) => priceOption({ model: o.model, effort, task: o.task, states: o.states, calibration: o.calibration }));
  const ok = opts.filter((p) => p.clears);
  if (!ok.length) return opts.reduce((a, b) => (EFFORT_RANK[b.effort] > EFFORT_RANK[a.effort] ? b : a));
  // Efforts come low to high, so on a tie in price and in whole-percent risk the lower effort stays.
  return ok.reduce((a, b) => (b.routeTotal < a.routeTotal - 1e-12 || (Math.abs(b.routeTotal - a.routeTotal) <= 1e-12 && Math.round(b.failureRisk * 100) < Math.round(a.failureRisk * 100)) ? b : a));
}

/** Points lost for being dearer than the cheapest feasible option: PRICE_POINTS_PER_DOUBLING per doubling, capped at PRICE_CAP. */
export function pricePoints(total: number, cheapest: number): number {
  const ratio = (Math.max(0, total) + PRICE_EPSILON_PCT) / (Math.max(0, cheapest) + PRICE_EPSILON_PCT);
  return ratio <= 1 ? 0 : Math.min(PRICE_CAP, PRICE_POINTS_PER_DOUBLING * Math.log2(ratio));
}

/** The newest provider reading Harbor holds for a CLI (its asOf), for committedFor. */
export const newestReadingAt = (ledger: UsageLedger) => (cli: CliId): number | undefined => {
  let t: number | undefined;
  for (const r of ledger.readings(cli)) if (t === undefined || r.asOf > t) t = r.asOf;
  return t;
};

/** Pool inputs from what the ledger holds (provider readings and Harbor's own estimated windows) for every pool of these entries. */
export function poolInputsFromLedger(ledger: UsageLedger, entries: readonly CatalogEntry[], clis: readonly CliId[], committed?: Committed): PoolInput[] {
  const pools = [...new Set(entries.filter((e) => clis.includes(e.cli)).flatMap((e) => poolsOfEntry(e)))].sort();
  const inputs = poolInputsFrom({
    pools,
    readings: Object.fromEntries(clis.map((c) => [c, ledger.readings(c)])),
    estimates: Object.fromEntries(clis.map((c) => [c, ledger.pressure(c).windows ?? []]))
  });
  if (!committed) return inputs;
  return inputs.map((p) => ({ ...p, windows: p.windows.map((w) => { const c = committed[p.pool]?.[w.period]; return c && c > 0 ? { ...w, committedPct: c } : w; }) }));
}

/** Quota (in % of each pool's window) that runs already in flight are still expected to burn. */
export type Committed = Readonly<Record<string, Partial<Record<BudgetPeriod, number>>>>;

/** A run that ended (its usage event): span and billable k-tokens. */
export interface FinishedRun { entry: CatalogEntry; start: number; end: number; kTok: number }

/** One run in flight, as committedFor sees it. */
export interface InFlightRun { entry: CatalogEntry; role: AgentRole; size: TaskSize; effort: Effort; startedAt: number }

/**
 * A run past its expected length still burns: it is counted as at least this share of its expected cost until it ends. A judgment,
 * not a simulator finding: with 0 the simulator showed no pool at 100% either (steady, bursty, heavy, seeds 1-6), because what a run
 * burned since the newest reading is counted anyway (READING_LAG_MS); it stays as a margin for runs that overrun a lot.
 */
export const IN_FLIGHT_MIN_REMAINING = 0.15;

/** Provider readings trail the use they count by about this much: use after (newest reading - this) is not in any reading yet. */
export const READING_LAG_MS = 5 * 60_000;

/**
 * Quota the runs in flight will still burn, or burned after the newest provider reading of their CLI could see it, per pool and window
 * (expected cost of each run times the share of its expected minutes not yet in a reading, never below IN_FLIGHT_MIN_REMAINING).
 * Readings come every few minutes at best and trail the use (READING_LAG_MS); the rest of the run is what this adds. The governor
 * counts it as used for helpers, so parallel helpers started at once cannot together carry a pool past its reserve. `seenAt` gives
 * the newest reading of a CLI (default: none, so only the time elapsed counts). PURE; an ESTIMATE from priors and calibration.
 */
export function committedFor(runs: readonly InFlightRun[], now: number, calibration?: Calibration, seenAt?: (cli: CliId) => number | undefined,
  recent: readonly FinishedRun[] = []): Committed {
  const out: Record<string, Partial<Record<BudgetPeriod, number>>> = {};
  const add = (entry: CatalogEntry, tokensK: number) => {
    for (const pool of poolsOfEntry(entry)) {
      const slot = (out[pool] ??= {});
      for (const period of ['weekly', 'session'] as const) {
        slot[period] = (slot[period] ?? 0) + tokensK * costPerKTokOf(entry) * calibrated(poolPctPrior(pool, period), calibration?.pctPerKTok[pctKey(pool, period)], false);
      }
    }
  };
  // Runs that already ended but burned after the newest reading could see: their measured tokens in that part are not in any reading.
  // Phase 5 simulator: three short Codex runs burned 26% of the 5h window between two readings and vanished from the count when they ended.
  for (const f of recent) {
    if (!seenAt) continue;
    const seen = (seenAt(f.entry.cli) ?? 0) - READING_LAG_MS;
    if (f.end <= seen || !(f.kTok > 0)) continue;
    add(f.entry, (f.kTok * (f.end - Math.max(f.start, seen))) / Math.max(1, f.end - f.start));
  }
  for (const r of runs) {
    const role = budgetRole(r.role);
    const minutes = expectedMinutes({ role, size: r.size, effort: r.effort, model: r.entry, calibration });
    const seen = Math.min(now, seenAt ? (seenAt(r.entry.cli) ?? r.startedAt) - READING_LAG_MS : now);
    const ahead = Math.max(IN_FLIGHT_MIN_REMAINING, 1 - Math.max(0, seen - r.startedAt) / 60_000 / Math.max(1, minutes));
    add(r.entry, expectedTokens(role, r.size, r.effort, calibration) * ahead);
  }
  return out;
}

/** States of every pool at `now`, for helpers (reserve kept) or interactive work (no reserve). */
export function statesOf(inputs: readonly PoolInput[], now: number, urgency: number, interactive: boolean): PoolStates {
  return Object.fromEntries(inputs.map((p) => [p.pool, poolState(p, now, urgency, { interactive })]));
}

/** Expected % of each window (weekly and 5h) of each pool of `model` that one run of this task takes. An ESTIMATE. */
export function runCostByWindow(o: { model: CatalogEntry; effort: Effort; role: AgentRole; size: TaskSize; calibration?: Calibration }): Array<{ pool: string; period: BudgetPeriod; pct: number }> {
  const tokensK = expectedTokens(budgetRole(o.role), o.size, o.effort, o.calibration);
  return poolsOfEntry(o.model).flatMap((pool) => (['weekly', 'session'] as const).map((period) => ({
    pool, period, pct: tokensK * costPerKTokOf(o.model) * calibrated(poolPctPrior(pool, period), o.calibration?.pctPerKTok[pctKey(pool, period)], false)
  })));
}

/**
 * A run must fit with this much to spare: one run's real tokens vary by about +-40% around the estimate (lognormal, tails to 2x). The
 * 5h window gets more because one run is a large share of it (a large Codex implementer is ~40% of Codex's 5h window). Phase 5
 * simulator: without the room check helpers took Codex's 5h window to 100% (steady and heavy weeks); with a 1.6 margin heavy seeds 4
 * and 5 still did; with 2, no workload did over seeds 1-6. The weekly 1.25 is a judgment (one run is at most a few % of a week).
 */
export const FIT_MARGIN: Record<BudgetPeriod, number> = { weekly: 1.25, session: 2 };

/**
 * Whether one helper run of this task fits in what its pools have left above the reserve (after the quota runs in flight still
 * need): every window with a trusted provider reading must have at least the run's expected cost usable. `less`: quota to take off what the
 * states call usable (interactive states ignore the runs in flight; the fit check of interactive work must not). A helper that does not fit would
 * carry the pool into its reserve, or past 100%, before anything could stop it. Phase 5 simulator: admission on "anything left above
 * the reserve" let single large runs (a Codex large implementer is ~7% of its weekly window, ~45% of its 5h one) hit the wall.
 */
export function fitsBudget(o: { model: CatalogEntry; effort: Effort; role: AgentRole; size: TaskSize; states: PoolStates; calibration?: Calibration; less?: Committed }): { fits: boolean; until?: number } {
  for (const c of runCostByWindow(o)) {
    const w = o.states[c.pool]?.windows.find((x) => x.period === c.period);
    // Only the provider's own readings: Harbor's estimate counts runs against an assumed budget, a different unit from a run's %.
    if (!w || w.source !== 'reported' || w.trust <= 0) continue;
    if (w.usablePct - (o.less?.[c.pool]?.[c.period] ?? 0) < c.pct * FIT_MARGIN[c.period]) return { fits: false, ...(w.resetsAt !== undefined ? { until: w.resetsAt } : {}) };
  }
  return { fits: true };
}

/**
 * Billable k-tokens a run in flight has burned so far (estimate): its expected token rate times the minutes elapsed. Not capped at the
 * expected total: the runs still going are disproportionately the long ones, and capping them made calibration count too little of
 * its neighbours' use (Phase 5 simulator, tokens twice the priors: claude:all weekly settled at 1.5x the truth).
 */
export function inFlightKTokSoFar(r: InFlightRun, now: number, calibration?: Calibration): number {
  const role = budgetRole(r.role);
  const minutes = expectedMinutes({ role, size: r.size, effort: r.effort, model: r.entry, calibration });
  return expectedTokens(role, r.size, r.effort, calibration) * Math.max(0, now - r.startedAt) / 60_000 / Math.max(1, minutes);
}

/** Expected minutes of one task on a typical model (used for the deadline's critical path): the cheapest option's minutes. */
export function typicalMinutes(o: { role: AgentRole; size: TaskSize; model: CatalogEntry; calibration?: Calibration }): number {
  return expectedMinutes({ role: budgetRole(o.role), size: o.size, effort: 'medium', model: o.model, calibration: o.calibration });
}

/**
 * Expected burn of one helper on `model`, in % per hour of its tightest pool's weekly and 5h windows: expected cost over expected
 * minutes (budget.maxHelpers takes it). An ESTIMATE from the priors and calibration; the 5h figure uses the pool's 5h prior.
 */
export function helperBurnPctPerHour(o: { role: AgentRole; size: TaskSize; effort: Effort; model: CatalogEntry; calibration?: Calibration }): HelperBurn {
  const role = budgetRole(o.role);
  const hours = Math.max(1 / 60, expectedMinutes({ role, size: o.size, effort: o.effort, model: o.model, calibration: o.calibration }) / 60);
  const tokensK = expectedTokens(role, o.size, o.effort, o.calibration);
  const pools = poolsOfEntry(o.model);
  const weekly = Math.max(...pools.map((p) => tokensK * quotaPerKTok(o.model, p, o.calibration)));
  // quotaPerKTok covers the weekly window; the 5h one blends its own prior with what calibration measured for that window.
  const session = Math.max(...pools.map((p) => tokensK * costPerKTokOf(o.model) * calibrated(poolPctPrior(p, 'session'), o.calibration?.pctPerKTok[pctKey(p, 'session')], false)));
  return { weekly: weekly / hours, session: session / hours };
}
