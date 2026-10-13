import type { Effort } from './adapters/types';
import type { CatalogEntry, Tier } from './clis/capabilities';
import type { BudgetPeriod } from './budget';
import type { BudgetRole, TaskSize } from './calibration';

/**
 * PRIORS of the budget governor: what Harbor assumes before calibration (calibration.ts) has measured runs of its own.
 * Phase 5 set them from REAL measurements on the owner's machine, 2026-10-12 (tests/fixtures/realUsage.ts has the numbers and their
 * provenance; tests/realPriors.test.ts checks the priors reproduce them within 30%). One account each of Claude and Codex were
 * measured: other plans differ, which is what calibration is for. Where a figure was not measured it says so.
 * Billable k-tokens everywhere = input + output + cache writes + CACHE_READ_WEIGHT (0.1) * cache reads (calibration.billableKTok):
 * cache reads dominate an agentic run (an Opus implementer read 18M cached tokens in 30 minutes; 77k output).
 */

/**
 * Billable k-tokens one task takes at medium effort, by role and size. Measured: a large implementer (Chronica) 2,113 k-tokens in
 * 30 minutes on Opus, and the others at its pace took 45+ minutes (stopped by the old cap), so large = ~40 minutes at strong
 * throughput; medium and small implementers, planners and reviewers from the 2026-10-09 durations (median 9, 4.4, 5.3 and 2.3
 * minutes) at the measured throughput; Codex lead turns (priced as 'other') median ~4.5 minutes at ~37 k-tokens/min.
 */
export const TOKENS_PRIOR_K: Record<BudgetRole, Record<TaskSize, number>> = {
  planner: { small: 120, medium: 320, large: 600 },
  implementer: { small: 150, medium: 550, large: 2400 },
  reviewer: { small: 25, medium: 140, large: 360 },
  other: { small: 20, medium: 200, large: 1500 }
};

/**
 * Tokens relative to medium effort. Thinking is a small share of billable tokens (output was 3.6% of the Opus implementer's), so
 * effort moves billable tokens far less than it moves thinking: more effort mostly means more tool loops (checking, re-reading).
 * NOT measured (no same-task runs at two efforts exist yet); calibration stores measured tokens divided by this.
 * Phase 2-4 used 0.6 / 1 / 1.8, which made low effort look 3x cheaper than high and sent hard work to low effort.
 */
export const EFFORT_TOKEN_MULT: Record<Effort, number> = { low: 0.8, medium: 1, high: 1.35 };

/**
 * Quota % of a pool's window per 1k billable tokens of a model with costPerKTok 1 (claude-sonnet-5-5). MEASURED on 2026-10-12:
 *   claude:all  weekly +11 points and 5h +67 for ~14,600 k-tokens of Opus/Fable runs (costPerKTok 2): 0.00038 and 0.0023;
 *   codex:all   weekly +12 points for 4,285 k-tokens of gpt-6.1-sol (costPerKTok 0.8), 5h +72 for 4,056: 0.0035 and 0.022.
 * The owner's own use outside Harbor is inside the Claude deltas, so those figures are an upper bound (cautious).
 * Per-model pools (claude:opus, claude:fable) were NOT reported on this account; a separate per-model cap is a smaller limit than the
 * account's, so the same tokens are assumed to be twice the share of it (a judgment). A pool with no reading at all never binds a
 * price while the model's account pool has one (routePrice.creditedCost).
 */
export const ACCOUNT_POOL_PCT_PER_KTOK: Record<BudgetPeriod, number> = { weekly: 0.00038, session: 0.0023 };
export const SPECIFIC_POOL_PCT_PER_KTOK: Record<BudgetPeriod, number> = { weekly: 0.00076, session: 0.0046 };
export const POOL_PCT_PER_KTOK_PRIOR: Record<string, Record<BudgetPeriod, number>> = {
  'claude:all': ACCOUNT_POOL_PCT_PER_KTOK,
  'claude:opus': SPECIFIC_POOL_PCT_PER_KTOK,
  'claude:fable': SPECIFIC_POOL_PCT_PER_KTOK,
  'codex:all': { weekly: 0.0035, session: 0.022 }
};
export const poolPctPrior = (pool: string, period: BudgetPeriod): number =>
  (POOL_PCT_PER_KTOK_PRIOR[pool] ?? (pool.endsWith(':all') ? ACCOUNT_POOL_PCT_PER_KTOK : SPECIFIC_POOL_PCT_PER_KTOK))[period];

/** costPerKTok of a catalog entry that has none: a sonnet-like model. */
export const FALLBACK_COST_PER_KTOK = 1;
export const costPerKTokOf = (e: Pick<CatalogEntry, 'costPerKTok'> | undefined): number => e?.costPerKTok ?? FALLBACK_COST_PER_KTOK;

/**
 * Billable k-tokens per wall minute by tier (agentic runs: tool calls and waits included). MEASURED: strong 62 (Opus 71, Fable 53 on
 * the Chronica implementers), standard 40 (Codex gpt-6.1-sol lead turns 37). Cheap NOT measured with cache counts: assumed as fast
 * as strong (smaller contexts, quicker turns).
 */
export const THROUGHPUT_KTOK_PER_MIN: Record<Tier, number> = { cheap: 60, standard: 40, strong: 62 };
/** Throughput by effort relative to medium: more thinking per tool call is slower, but tool time dominates. NOT measured. */
export const EFFORT_THROUGHPUT_MULT: Record<Effort, number> = { low: 1.05, medium: 1, high: 0.92 };
