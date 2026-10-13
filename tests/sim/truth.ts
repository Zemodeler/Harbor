import type { Effort } from '../../src/main/adapters/types';
import type { BudgetPeriod } from '../../src/main/budget';
import type { BudgetRole, TaskSize } from '../../src/main/calibration';
import type { Tier } from '../../src/main/clis/capabilities';

/**
 * What the simulated world REALLY costs: the measured values of 2026-10-12 (tests/fixtures/realUsage.ts), kept here as their own
 * copy so that tuning Harbor's priors never moves the truth they are judged against. `poolFactor` / `tokenFactor` in the simulator
 * config scale the truth away from the priors (e.g. 0.5x .. 2x) to test adaptation.
 */

/** Billable k-tokens of a task at medium effort (median; each run draws lognormal noise around it). */
export const TRUE_TOKENS_K: Record<BudgetRole, Record<TaskSize, number>> = {
  planner: { small: 120, medium: 320, large: 600 },
  implementer: { small: 150, medium: 550, large: 2400 },
  reviewer: { small: 25, medium: 140, large: 360 },
  other: { small: 20, medium: 200, large: 1500 }
};
export const TRUE_EFFORT_TOKENS: Record<Effort, number> = { low: 0.8, medium: 1, high: 1.35 };
export const TRUE_THROUGHPUT: Record<Tier, number> = { cheap: 60, standard: 40, strong: 62 };
export const TRUE_EFFORT_THROUGHPUT: Record<Effort, number> = { low: 1.05, medium: 1, high: 0.92 };

/** % of each pool window per sonnet-equivalent k-token. */
export const TRUE_POOL_PCT: Record<string, Record<BudgetPeriod, number>> = {
  'claude:all': { weekly: 0.00038, session: 0.0023 },
  'claude:opus': { weekly: 0.00076, session: 0.0046 },
  'claude:fable': { weekly: 0.00076, session: 0.0046 },
  'codex:all': { weekly: 0.0035, session: 0.022 }
};
