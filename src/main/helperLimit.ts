import type { CliId } from '../shared/api';
import { MAX_HELPERS_CAP, hasReportedWindow, maxHelpers, modelAvailability, poolsOfEntry, type HelperBurn, type PoolState, type PoolStates } from './budget';
import type { Calibration } from './calibration';
import { autoRoutable, type CatalogEntry } from './clis/capabilities';
import { typicalModel } from './deadline';
import { helperBurnPctPerHour, poolInputsFromLedger, statesOf, type Committed } from './routePrice';
import type { UsageLedger } from './usage';

/**
 * How many helpers may run at once, from the quota budget. PURE.
 *
 * - The budget's own answer (budget.maxHelpers over the pools of the models helpers can be routed to), never above MAX_HELPERS_CAP.
 * - 1 while a running helper's model draws on a pool in 'protect': that pool is running dry and parallel work would empty it.
 * - 0 when no model can run automatic work (every pool exhausted or rate limited): queued helpers wait, and `until` says when the
 *   earliest pool resets (undefined when no reset time is known).
 * The user's concurrency setting still applies on top (the smaller wins); file locks still apply per helper.
 */

export interface HelperLimit { limit: number; why: string; until?: number }

export function helperLimit(o: {
  /** Auto-routable catalog entries of the CLIs Harbor can use now. */
  entries: readonly CatalogEntry[];
  /** Pool states for helpers (reserve kept). */
  states: PoolStates;
  /** Harbor's own view that a model is out (ledger pressure exhausted or a rate-limit cooldown), with its reset when known. */
  outFor?: (e: CatalogEntry) => { until?: number } | undefined;
  burn: HelperBurn;
  /** Models of the helpers running now. */
  running: readonly CatalogEntry[];
}): HelperLimit {
  if (!o.entries.length) return { limit: MAX_HELPERS_CAP, why: 'no model to judge the budget by' };
  const untils: Array<number | undefined> = [];
  const available = o.entries.filter((e) => {
    const av = modelAvailability(e, o.states);
    const out = o.outFor?.(e);
    if (av.available && !out) return true;
    untils.push(!av.available ? av.until : out?.until);
    return false;
  });
  if (!available.length) {
    const known = untils.filter((u): u is number => u !== undefined);
    return { limit: 0, why: 'every quota pool is exhausted or rate limited', ...(known.length ? { until: Math.min(...known) } : {}) };
  }
  const pools = [...new Set(available.flatMap((e) => poolsOfEntry(e)))];
  const states = pools.map((p) => o.states[p]).filter((s): s is PoolState => !!s);
  let limit = states.length ? maxHelpers({ states, perHelperBurnPctPerHour: o.burn }) : MAX_HELPERS_CAP;
  let why = `quota budget allows ${limit}`;
  // No provider reading for any pool helpers can use (a fresh install, a CLI without readable logs): no fit or reserve check applies, so one at a time.
  if (states.length && !states.some(hasReportedWindow)) { limit = Math.min(limit, 1); why = 'no provider-reported quota reading yet for the pools helpers can use: one helper at a time until there is one'; }
  if (o.running.some((e) => poolsOfEntry(e).some((p) => o.states[p]?.state === 'protect'))) { limit = Math.min(limit, 1); why = 'a running helper draws on a pool in protect'; }
  return { limit: Math.max(1, Math.min(MAX_HELPERS_CAP, limit)), why };
}

/**
 * The orchestrator's budget limit from what the ledger holds (pure apart from reading the ledger): the auto-routable models of the
 * usable CLIs, their pool states for helpers (reserve kept, quota already promised to runs in flight counted as used), the burn of a
 * typical helper (an implementer of medium size at medium effort on the catalog's typical model) and the models running now.
 * An all-exhausted budget with no known reset time does not hold work (limit 1): routing then says why it cannot run.
 * Shared by the orchestrator and the Phase 5 week simulator so the two can never compute different limits.
 */
export function helperLimitFromLedger(o: {
  catalog: readonly CatalogEntry[];
  /** CLIs Harbor can use now (installed, signed in, enabled, with an adapter). */
  clis: readonly CliId[];
  ledger: UsageLedger;
  now: number;
  calibration?: Calibration;
  running: readonly CatalogEntry[];
  /** Quota the runs in flight are still expected to burn (routePrice.committedFor). */
  committed?: Committed;
}): HelperLimit {
  const entries = o.catalog.filter((e) => autoRoutable(e) && o.clis.includes(e.cli));
  const model = typicalModel(entries);
  if (!model) return { limit: MAX_HELPERS_CAP, why: 'no model to judge the budget by' };
  const states = statesOf(poolInputsFromLedger(o.ledger, entries, o.clis, o.committed), o.now, 0, false);
  const burn = helperBurnPctPerHour({ role: 'implementer', size: 'medium', effort: 'medium', model, ...(o.calibration ? { calibration: o.calibration } : {}) });
  const out = (e: CatalogEntry): { until?: number } | undefined => {
    const p = o.ledger.pressure(e.cli, e.model);
    return p.level === 'exhausted' ? (p.resetsAt !== undefined ? { until: p.resetsAt } : {}) : undefined;
  };
  const l = helperLimit({ entries, states, burn, running: o.running, outFor: out });
  return l.limit === 0 && l.until === undefined ? { limit: 1, why: l.why } : l;
}
