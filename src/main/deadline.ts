import type { AgentRole } from '../shared/api';
import { urgency } from './budget';
import type { Calibration, TaskSize } from './calibration';
import { autoRoutable, type CatalogEntry } from './clis/capabilities';
import { typicalMinutes } from './routePrice';

/**
 * Deadline urgency for a conversation. PURE. The critical path is estimated conservatively as the SUM of the expected minutes of the
 * conversation's unfinished work (as if it ran one after another; helpers that run in parallel finish sooner, so this errs toward
 * urgency), each on a typical model at medium effort: the cheapest auto-routable standard model of the catalog, measured minutes when
 * calibrated. Without a deadline urgency is 0 (budget.urgency).
 */

/** The model whose throughput stands for "a typical run": the first auto-routable standard entry, else the first entry. */
export function typicalModel(catalog: readonly CatalogEntry[]): CatalogEntry | undefined {
  return catalog.find((e) => autoRoutable(e) && e.tier === 'standard') ?? catalog[0];
}

export function criticalPathMinutes(o: { work: ReadonlyArray<{ role: AgentRole; size?: TaskSize }>; catalog: readonly CatalogEntry[]; calibration?: Calibration }): number {
  const model = typicalModel(o.catalog);
  if (!model) return 0;
  return o.work.reduce((s, w) => s + typicalMinutes({ role: w.role, size: w.size ?? 'medium', model, calibration: o.calibration }), 0);
}

/** Urgency 0..1 of a conversation's work: 0 without a deadline; see budget.urgency for the curve. */
export function conversationUrgency(o: { deadline?: number; now: number; work: ReadonlyArray<{ role: AgentRole; size?: TaskSize }>; catalog: readonly CatalogEntry[]; calibration?: Calibration }): { urgency: number; criticalPathMinutes: number } {
  if (o.deadline === undefined) return { urgency: 0, criticalPathMinutes: 0 };
  const minutes = criticalPathMinutes(o);
  return { urgency: urgency({ deadline: o.deadline, now: o.now, criticalPathMinutes: minutes }), criticalPathMinutes: minutes };
}
