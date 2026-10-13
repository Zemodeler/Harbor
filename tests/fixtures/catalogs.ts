import { poolPctPrior } from '../../src/main/budgetPriors';
import type { Calibration } from '../../src/main/calibration';
import { DEFAULT_CATALOG, type CatalogEntry } from '../../src/main/clis/capabilities';

/**
 * The built-in Claude entries plus ONE auto-routed Codex model, the shape of catalog v1. Budget and orchestration tests judge
 * claude against codex as two accounts; pinning this keeps them about that mechanism, independent of how many Codex models the
 * built-in catalog lists. Phase 3: the Codex model is priced like Sonnet (costPerKTok 1) and scored like it for code, so with equal
 * quota states the two tie and catalog order decides, as in catalog v1; a test about prices moves the pools, not the priors.
 */
export const ONE_CODEX_MODEL: CatalogEntry[] = [
  ...DEFAULT_CATALOG.filter((e) => e.cli === 'claude'),
  { ...DEFAULT_CATALOG.find((e) => e.cli === 'codex' && e.model === 'default')!, autoRoute: true, costPerKTok: 1 }
];

/**
 * Phase 5: the priors are now measured on one machine (budgetPriors.ts), where a Codex token is ~9x the share of Codex's weekly window
 * that a Claude token is of Claude's. Tests about the mechanism between two accounts (balance, continuity, load, hysteresis) calibrate
 * Codex's pool to Claude's figures, so they keep testing the mechanism rather than one account's plan sizes.
 */
export const EQUAL_POOLS: Calibration = {
  version: 1, throughTime: 0, tokensK: {}, minutes: {},
  pctPerKTok: {
    'codex:all|weekly': { value: poolPctPrior('claude:all', 'weekly'), n: 99 },
    'codex:all|session': { value: poolPctPrior('claude:all', 'session'), n: 99 }
  }
};
