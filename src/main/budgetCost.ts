import type { Effort } from './adapters/types';
import { modelAvailability, poolsOfEntry, type PoolStates } from './budget';
import { calibrated, minutesKey, pctKey, tokensKey, type BudgetRole, type Calibration, type TaskSize } from './calibration';
import {
  costPerKTokOf, EFFORT_THROUGHPUT_MULT, EFFORT_TOKEN_MULT, poolPctPrior, THROUGHPUT_KTOK_PER_MIN, TOKENS_PRIOR_K
} from './budgetPriors';
import { STRENGTH_MIN_SCORE, type CatalogEntry, type Need } from './clis/capabilities';

/**
 * Budget governor, part 3: what one piece of work costs on one model at one effort, how likely it is to fail there, and the resulting
 * price. PURE. Costs are in % of a pool's WEEKLY window (the window that decides what is lost at a reset); the 5h window limits
 * parallelism (maxHelpers) rather than price. All of it is an ESTIMATE built on priors (budgetPriors.ts) and calibration.
 */

export interface TaskSpec {
  role: BudgetRole;
  size: TaskSize;
  /** 0 (trivial) .. 10 (the hardest work the best model can still do). */
  difficulty: number;
  /** What the work needs most; default 'code'. */
  need?: Need;
}

/**
 * Capability bonus of thinking harder, on the 1-5 scale: high effort lets a model reach half a level above its score. Phase 3 halved
 * the Phase 2 values (0.5 / 1): with a whole level per effort step a cheap model at high effort matched the next model up, and the
 * router sent hard work to Haiku and every high-rated task to Sonnet at high effort.
 */
export const EFFORT_BONUS: Record<Effort, number> = { low: 0, medium: 0.25, high: 0.5 };
/** Failure risk is a logistic in the capability gap (required - offered): RISK_MIDPOINT levels short = 50%, RISK_SCALE sets the steepness. */
export const RISK_MIDPOINT = 0.5;
export const RISK_SCALE = 0.25;
/**
 * A failed run is paid for and then redone, usually on a stronger model that costs several times more: price *= 1 + FAILURE_PRICE_WEIGHT
 * * risk. Phase 3 raised it from 1.5 to 8: at 1.5 a just-clearing option (12% risk) cost only 18% extra, so the router always bought
 * the bare minimum, and Sonnet at high effort undercut Opus for high work even with Opus's pool comfortable. Phase 5 lowered it to 5:
 * with low effort measured at 0.8x the tokens of medium (was 0.6x), 8 made Opus at low effort undercut Sonnet at medium for ordinary
 * medium work (difficulty 6; tests/routingBudget "twelve ordinary helpers", tests/quota retries). At 5, Sonnet keeps work it clears up
 * to difficulty 6 and Opus at low effort still takes high work (7+); the simulator's properties hold either way.
 */
export const FAILURE_PRICE_WEIGHT = 5;
/** Value of a minute at deadline urgency 1, in weekly-quota %; lambda = this * urgency^2 (gentle at low urgency, 0 without a deadline). */
export const TIME_COST_MAX_PCT_PER_MIN = 0.1;
/** Capability assumed for a need the catalog entry does not score: a listed strength, else a weak fit. */
export const UNSCORED_STRENGTH = 4;
export const UNSCORED_WEAKNESS = 2;

/** NaN (a bad external number) clamps to `lo` instead of poisoning every score it feeds. */
const clamp = (v: number, lo: number, hi: number) => (Number.isNaN(v) ? lo : Math.min(hi, Math.max(lo, v)));

const calOf = (c?: Calibration): Pick<Calibration, 'pctPerKTok' | 'tokensK' | 'minutes'> => c ?? { pctPerKTok: {}, tokensK: {}, minutes: {} };

/** Expected billable k-tokens of a task: the (calibrated) medium-effort figure for its role and size, times the effort multiplier. */
export function expectedTokens(role: BudgetRole, size: TaskSize, effort: Effort, calibration?: Calibration): number {
  return calibrated(TOKENS_PRIOR_K[role][size], calOf(calibration).tokensK[tokensKey(role, size)]) * EFFORT_TOKEN_MULT[effort];
}

/** Quota % of `pool`'s weekly window per 1k billable tokens of this model: model costPerKTok times the (calibrated) pool figure. */
export function quotaPerKTok(model: Pick<CatalogEntry, 'costPerKTok'>, pool: string, calibration?: Calibration): number {
  return costPerKTokOf(model) * calibrated(poolPctPrior(pool, 'weekly'), calOf(calibration).pctPerKTok[pctKey(pool, 'weekly')], false);
}

export interface CostEstimate {
  tokensK: number;
  /** Expected % of each pool's weekly window the model draws from. */
  pools: Array<{ pool: string; pct: number }>;
  /** The largest of them (the model's tightest pool by cost) and its pool. */
  pct: number;
  pool: string;
}

export function expectedCost(o: { role: BudgetRole; size: TaskSize; effort: Effort; model: CatalogEntry; calibration?: Calibration }): CostEstimate {
  const tokensK = expectedTokens(o.role, o.size, o.effort, o.calibration);
  const pools = poolsOfEntry(o.model).map((pool) => ({ pool, pct: tokensK * quotaPerKTok(o.model, pool, o.calibration) }));
  const top = pools.reduce((a, b) => (b.pct > a.pct ? b : a));
  return { tokensK, pools, pct: top.pct, pool: top.pool };
}

/**
 * Expected wall minutes: expected tokens times minutes per k-token, measured for this role/model/effort (calibration.minPerKTok)
 * blended with the prior 1 / throughput(tier, effort). Per token, not per task, so a large task takes longer than a medium one on
 * the same model whatever sizes were measured.
 */
export function expectedMinutes(o: { role: BudgetRole; size: TaskSize; effort: Effort; model: CatalogEntry; calibration?: Calibration }): number {
  const rate = calibrated(1 / (THROUGHPUT_KTOK_PER_MIN[o.model.tier] * EFFORT_THROUGHPUT_MULT[o.effort]), o.calibration?.minPerKTok?.[minutesKey(o.role, o.model.cli, o.model.model, o.effort)]);
  return expectedTokens(o.role, o.size, o.effort, o.calibration) * rate;
}

/** Capability of a model for a need on the 1-5 scale (scores when given, else from its strengths). */
export function capabilityOf(e: Pick<CatalogEntry, 'capability' | 'strengths'>, need: Need = 'code'): number {
  return e.capability?.[need] ?? (e.strengths.includes(need) ? Math.max(UNSCORED_STRENGTH, STRENGTH_MIN_SCORE) : UNSCORED_WEAKNESS);
}

/**
 * [difficulty, capability level] knots of requiredLevel, linear between them. A STARTING VALUE (Phase 5 tunes it), chosen so that on the
 * built-in scores (haiku 3, sonnet 4, opus 5 for code): easy work (<= 3) fits Haiku at low effort, medium work (5-6) needs Sonnet at
 * medium effort (Haiku at high effort no longer reaches it), high work (7-8) needs Sonnet at high effort or Opus at low effort, and
 * d=10 needs Opus. Phase 2 used a straight line 1 + 0.4 d, which put medium work (d=5, level 3) on Haiku.
 */
export const REQUIRED_LEVEL_KNOTS: ReadonlyArray<readonly [number, number]> = [[0, 1], [3, 3], [4, 3.5], [5, 4.1], [6, 4.25], [8, 4.5], [10, 5]];

/** Capability a difficulty demands, continuous and non-decreasing: 1 at d=0 to 5 at d=10 (see REQUIRED_LEVEL_KNOTS). */
export function requiredLevel(difficulty: number): number {
  const d = clamp(difficulty, 0, 10), k = REQUIRED_LEVEL_KNOTS;
  for (let i = 1; i < k.length; i++) {
    const [x0, y0] = k[i - 1]!, [x1, y1] = k[i]!;
    if (d <= x1) return y0 + ((d - x0) / (x1 - x0)) * (y1 - y0);
  }
  return k[k.length - 1]![1];
}

/** Effort bonuses come in quarter levels, so the floor is the required level rounded UP to a quarter (never below what is required). */
const FLOOR_STEP = 0.25;

/** Capability level (1-5, in quarter steps) a difficulty requires: requiredLevel rounded up to FLOOR_STEP. Monotone non-decreasing in d. */
export function capabilityFloor(difficulty: number): number {
  return Math.ceil(requiredLevel(difficulty) / FLOOR_STEP - 1e-9) * FLOOR_STEP;
}

/** Whether a model at an effort is strong enough: capability(need) + EFFORT_BONUS >= capabilityFloor(difficulty). */
export function clears(e: Pick<CatalogEntry, 'capability' | 'strengths'>, need: Need, difficulty: number, effort: Effort): boolean {
  return capabilityOf(e, need) + EFFORT_BONUS[effort] >= capabilityFloor(difficulty) - 1e-9;
}

/**
 * The largest difficulty whose floor `level` still clears (inverse of capabilityFloor on the knots). Used to cap an escalated retry
 * at what the strongest auto-routable model can do: raising the floor past it would only make every model fail the check.
 */
export function maxDifficultyFor(level: number): number {
  if (level >= requiredLevel(10)) return 10;
  let lo = 0, hi = 10;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (capabilityFloor(mid) <= level + 1e-9) lo = mid; else hi = mid; }
  return Math.floor(lo * 100) / 100;
}

/**
 * Probability in [0,1] that the work is rejected or fails: logistic in the gap between what the difficulty requires and what the model
 * offers at this effort. About 12% when it just meets the requirement, under 1% a level above, about 88% a level below. A placeholder
 * shape (calibrate from review outcomes later); monotone: rises with difficulty, falls with effort and capability.
 */
export function failureRisk(e: Pick<CatalogEntry, 'capability' | 'strengths'>, difficulty: number, effort: Effort, need: Need = 'code'): number {
  const gap = requiredLevel(difficulty) - (capabilityOf(e, need) + EFFORT_BONUS[effort]);
  return 1 / (1 + Math.exp(-(gap - RISK_MIDPOINT) / RISK_SCALE));
}

/** Value of a minute (weekly-quota % per minute) at a deadline urgency: 0 at urgency 0, TIME_COST_MAX_PCT_PER_MIN at 1. */
export const lambda = (urg: number): number => TIME_COST_MAX_PCT_PER_MIN * clamp(urg, 0, 1) ** 2;

export interface PriceBreakdown {
  cli: string; model: string; effort: Effort;
  tokensK: number;
  /** Per pool: expected weekly % and the pool's scarcity (1 = neutral when the pool's state is unknown). */
  pools: Array<{ pool: string; costPct: number; scarcity: number }>;
  /** The pool whose costPct * scarcity is largest: the one that binds. */
  bindingPool: string;
  expectedCostPct: number;
  scarcity: number;
  /** expectedCostPct * scarcity */
  costTerm: number;
  failureRisk: number;
  /** 1 + FAILURE_PRICE_WEIGHT * failureRisk */
  failureFactor: number;
  minutes: number;
  lambda: number;
  /** lambda * minutes */
  timeCost: number;
  /** costTerm * failureFactor + timeCost */
  total: number;
  /** clears(model, need, difficulty, effort) */
  clears: boolean;
  /** Every pool of the model can run automatic work now; else `availableUntil` when known. */
  available: boolean;
  availableUntil?: number;
}

/**
 * Price of doing `task` on `model` at `effort`: expectedCost * scarcity * (1 + failureRisk * FAILURE_PRICE_WEIGHT) + lambda(urgency) *
 * expectedMinutes, in scarcity-weighted weekly-quota %. Scarcity and cost are taken in the binding pool (the largest product over the
 * model's pools), so a model drawing on a cheap own pool still pays for a tight account-wide pool. Every term is returned for the reason text.
 */
export function price(o: { model: CatalogEntry; effort: Effort; task: TaskSpec; states: PoolStates; calibration?: Calibration; urgency?: number }): PriceBreakdown {
  const { model, effort, task } = o;
  const need = task.need ?? 'code';
  const cost = expectedCost({ role: task.role, size: task.size, effort, model, calibration: o.calibration });
  const pools = cost.pools.map((p) => ({ pool: p.pool, costPct: p.pct, scarcity: o.states[p.pool]?.scarcity ?? 1 }));
  const bind = pools.reduce((a, b) => (b.costPct * b.scarcity > a.costPct * a.scarcity ? b : a));
  const risk = failureRisk(model, task.difficulty, effort, need);
  const minutes = expectedMinutes({ role: task.role, size: task.size, effort, model, calibration: o.calibration });
  const lam = lambda(o.urgency ?? 0);
  const costTerm = bind.costPct * bind.scarcity, failureFactor = 1 + FAILURE_PRICE_WEIGHT * risk, timeCost = lam * minutes;
  const av = modelAvailability(model, o.states);
  return {
    cli: model.cli, model: model.model, effort, tokensK: cost.tokensK, pools, bindingPool: bind.pool, expectedCostPct: bind.costPct, scarcity: bind.scarcity,
    costTerm, failureRisk: risk, failureFactor, minutes, lambda: lam, timeCost, total: costTerm * failureFactor + timeCost,
    clears: clears(model, need, task.difficulty, effort), available: av.available, ...(av.until !== undefined ? { availableUntil: av.until } : {})
  };
}

/** The cheapest feasible (clears and available) model/effort pair, or undefined. Ties keep the earlier option. */
export function cheapestFeasible(o: { models: readonly CatalogEntry[]; efforts?: readonly Effort[]; task: TaskSpec; states: PoolStates; calibration?: Calibration; urgency?: number }): PriceBreakdown | undefined {
  let best: PriceBreakdown | undefined;
  for (const model of o.models) for (const effort of o.efforts ?? (['low', 'medium', 'high'] as const)) {
    const p = price({ model, effort, task: o.task, states: o.states, calibration: o.calibration, urgency: o.urgency });
    if (p.clears && p.available && (!best || p.total < best.total)) best = p;
  }
  return best;
}
