import type { AgentRole } from '../shared/api';
import type { Effort } from './adapters/types';
import { clears, expectedCost, expectedMinutes } from './budgetCost';
import { budgetRole, type Calibration, type TaskSize } from './calibration';
import { autoRoutable, type CatalogEntry, type Need } from './clis/capabilities';
import { bindingNeed } from './routePrice';
import type { SizeDrivers } from './difficulty';

/**
 * Size gate and plan ETA. PURE.
 *
 * A real run took about six hours for work a good split does in one and a half: helpers were handed whole areas ("consolidate and
 * correct the complete repair diff", "finish consolidated release validation"), ran into the time limit, and were redone. Harbor now
 * refuses an edit task that is estimated over MAX_TASK_MINUTES, claims more than MAX_TASK_FILES paths, or is an obvious catch-all, and
 * tells the lead to split it by concern. Read-only work (research, review, planning) is never refused for its size. Every estimate is a
 * prior blended with calibration (budgetCost.expectedMinutes), shown as an estimate; the constants are STARTING VALUES for Phase 5.
 */

export const MAX_TASK_MINUTES = 25;
export const MAX_TASK_FILES = 10;
/** A task that claims the whole project (no files) with a spec this long is several tasks. */
export const WHOLE_PROJECT_SPEC_CHARS = 1500;

/** Titles and instructions that name everything rather than one concern. */
const CATCH_ALL: RegExp[] = [
  /\bconsolidat\w*\b[^.\n]{0,40}\b(?:everything|all|complete|whole|entire|changes|diff|branch(?:es)?|work|implementations?|preserved|repair)\b/i,
  /\b(?:complete|finish|port)\b[^.\n]{0,20}\bpreserved\b/i,
  /\bfinish(?:ing)?\b[^.\n]{0,40}\b(?:validation|everything|all|remaining|the rest)\b/i,
  /\bcomplete\b[^.\n]{0,12}\b(?:whole|entire|full|complete|remaining)\b/i,
  /\b(?:everything|all) (?:that is |that's )?(?:left|remaining|outstanding)\b/i,
  /\b(?:fix|do|finish|complete) (?:everything|all of it|the rest)\b/i
];

export function catchAll(text: string): boolean { return CATCH_ALL.some((r) => r.test(text)); }

/**
 * Expected wall minutes of one task: the cheapest catalog option (auto-routable, clears the task's capability floor) at the effort it
 * would need, as the router would pick it with neutral quota. When nothing clears, the strongest model at high effort.
 */
export function estimateTaskMinutes(o: { role: AgentRole; size: TaskSize; difficulty: number; needs?: readonly Need[]; catalog: readonly CatalogEntry[]; calibration?: Calibration }): number {
  const role = budgetRole(o.role);
  const auto = o.catalog.filter(autoRoutable);
  const pool = auto.length ? auto : o.catalog;
  if (!pool.length) return 0;
  let best: { cost: number; minutes: number } | undefined;
  for (const model of pool) {
    const need = bindingNeed(model, o.needs);
    for (const effort of ['low', 'medium', 'high'] as Effort[]) {
      if (!clears(model, need, o.difficulty, effort)) continue;
      const cost = expectedCost({ role, size: o.size, effort, model, calibration: o.calibration }).pct;
      if (!best || cost < best.cost) best = { cost, minutes: expectedMinutes({ role, size: o.size, effort, model, calibration: o.calibration }) };
      break; // the lowest effort that clears is the cheapest on this model
    }
  }
  if (best) return best.minutes;
  const strongest = [...pool].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier])[0]!;
  return expectedMinutes({ role, size: o.size, effort: 'high', model: strongest, calibration: o.calibration });
}
const TIER_RANK: Record<CatalogEntry['tier'], number> = { cheap: 0, standard: 1, strong: 2 };

/**
 * The size the gate prices a task at. difficulty.sizeOf says 'large' for a long spec or three risk words alone, but by the priors every
 * large implementer is ~30 minutes (over MAX_TASK_MINUTES), so such a task was refused however it was written, and resubmitted
 * unchanged. A precise long spec for a few files is one concern: only what the lead can change makes it large here (8 or more files,
 * or many risk words across 4 or more files).
 */
export function gateSize(size: TaskSize, d: SizeDrivers): TaskSize {
  if (size !== 'large') return size;
  const files = d.files;
  return (files !== undefined && files >= 8) || (d.risks.length >= 3 && (files === undefined || files >= 4)) ? 'large' : 'medium';
}

/** The drivers of a size, for a refusal the lead can act on. */
export function describeDrivers(d: SizeDrivers, size: TaskSize): string {
  const parts = [`${d.files === undefined ? 'no files named' : `${d.files} file${d.files === 1 ? '' : 's'}`}`, `${d.chars}-character spec`, `${d.risks.length} risk word${d.risks.length === 1 ? '' : 's'}${d.risks.length ? ` (${d.risks.join(', ')})` : ''}`];
  return `sized ${size}: ${parts.join(', ')}`;
}

export interface GateInput {
  title: string;
  instructions: string;
  access: 'read' | 'edit';
  files: readonly string[];
  minutes: number;
  integrate?: boolean;
  /** describeDrivers(): what the estimate was based on. */
  detail?: string;
}

/** Why an edit task is refused, or undefined when it may start. */
export function gateTask(t: GateInput): string | undefined {
  if (t.access !== 'edit' || t.integrate) return undefined;
  if (catchAll(`${t.title}\n${t.instructions}`)) return 'it is a catch-all ("consolidate", "finish everything", "complete the whole ..."), not one concern';
  if (t.files.length > MAX_TASK_FILES) return `it claims ${t.files.length} paths (limit ${MAX_TASK_FILES}): more than one concern`;
  if (!t.files.length && t.instructions.length > WHOLE_PROJECT_SPEC_CHARS) return `it claims the whole project (no "files") with a ${t.instructions.length}-character spec`;
  if (t.minutes > MAX_TASK_MINUTES) return `it is estimated at about ${Math.round(t.minutes)} minutes (limit ${MAX_TASK_MINUTES})${t.detail ? `; ${t.detail}` : ''}. To bring it under: claim fewer files (fewer than 8), drop the "consolidate/everything" wording, and give each helper one concern`;
  return undefined;
}

export const SPLIT_ADVICE = `Split it by concern or package: one concern per helper, the exact files it edits, a concrete spec and deliverable, about ${MAX_TASK_MINUTES} minutes of work or less. Integrate and run the project's full test suite yourself, or delegate ONE validation helper for that.`;

export interface EtaTask { id: string; minutes: number; dependsOn: readonly string[] }

/**
 * Wall-clock estimate of a plan: list scheduling with `concurrency` helpers at once, in the given order, a task starting once the tasks
 * it depends on (within the plan) are done. Also the longest dependency chain (the bound with unlimited helpers).
 */
export function planEta(tasks: readonly EtaTask[], concurrency: number): { minutes: number; criticalPathMinutes: number } {
  const ids = new Set(tasks.map((t) => t.id));
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn.filter((d) => ids.has(d) && d !== t.id)]));
  const chain = new Map<string, number>();
  const longest = (id: string, seen = new Set<string>()): number => {
    const known = chain.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0; // a cycle (broken elsewhere) adds nothing
    seen.add(id);
    const t = tasks.find((x) => x.id === id)!;
    const v = t.minutes + Math.max(0, ...deps.get(id)!.map((d) => longest(d, seen)));
    chain.set(id, v);
    return v;
  };
  const criticalPathMinutes = Math.max(0, ...tasks.map((t) => longest(t.id)));
  const slots = Math.max(1, Math.floor(concurrency));
  const finish = new Map<string, number>();
  const running: Array<{ id: string; end: number }> = [];
  const pending = [...tasks];
  let now = 0;
  for (let guard = 0; (pending.length || running.length) && guard < 10_000; guard++) {
    let started = false;
    for (let i = 0; i < pending.length && running.length < slots; i++) {
      const t = pending[i]!;
      if (!deps.get(t.id)!.every((d) => finish.has(d) && finish.get(d)! <= now)) continue;
      running.push({ id: t.id, end: now + t.minutes });
      pending.splice(i--, 1);
      started = true;
    }
    if (!running.length) { if (!started) break; continue; }
    running.sort((a, b) => a.end - b.end);
    const next = running.shift()!;
    now = next.end;
    finish.set(next.id, now);
    while (running.length && running[0]!.end <= now) { const r = running.shift()!; finish.set(r.id, r.end); }
  }
  // Anything left (a cycle) runs after the rest.
  for (const t of pending) { now += t.minutes; finish.set(t.id, now); }
  return { minutes: Math.max(0, ...finish.values()), criticalPathMinutes };
}

export const fmtMinutes = (m: number): string => (m < 1 ? '<1 min' : m < 90 ? `~${Math.round(m)} min` : `~${(m / 60).toFixed(1)} h`);
