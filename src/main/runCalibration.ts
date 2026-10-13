import type { AgentRole, CliId } from '../shared/api';
import type { Effort } from './adapters/types';
import { poolsOfEntry } from './budget';
import { costPerKTokOf } from './budgetPriors';
import { billableKTok, type CalibrationSample, type TaskSize } from './calibration';
import type { CatalogEntry } from './clis/capabilities';
import type { ReportedLimit } from './codexLimits';
import type { UsageEvent } from './types';

/** Readings closer than this to the run's start count as "before" it; same window when the reset moved by less than SAME_WINDOW_MS. */
const SAME_WINDOW_MS = 2 * 60_000;
/**
 * A "before" reading older than this says nothing about the run: Claude reports its windows only during runs, so the newest one
 * before a run can be hours old and the delta would include everything used since (other runs, the owner's own sessions). Phase 5
 * simulator: without this bound (and with every Claude run sampling the Opus window too, fixed in calibration.ts) the quota-per-token
 * estimates came out 4 to 90 times the truth.
 */
export const BEFORE_FRESH_MS = 20 * 60_000;
/** The first reading a CLI prints during a run (Claude's first rate_limit_event) arrives just after the start: it counts as "before". */
export const BEFORE_GRACE_MS = 3 * 60_000;

/**
 * One calibration sample from a finished run (PURE): the ledger's usage event, what the orchestrator knows about the task (role, size,
 * effort), and the provider's readings of the same windows just before the run (`before`, taken at its start, plus the first reading
 * the CLI printed during it) and the last one it printed (`event.limits`). A window with no fresh reading on both sides gives no quota
 * sample. Other Harbor runs on the same CLI during this one (`overlap`, from overlapKTok) burned part of the delta: calibration divides
 * by both. Use outside Harbor in between still inflates the sample (calibration.ts accepts that: a cautious error). Partial and failed
 * runs pass through flagged: calibration keeps them as lower bounds only.
 */
export function calibrationSample(o: {
  event: UsageEvent; role: AgentRole; size?: TaskSize; effort?: Effort; before: readonly ReportedLimit[]; start: number;
  overlap?: CalibrationSample['overlap'];
}): CalibrationSample {
  const e = o.event;
  const quota: NonNullable<CalibrationSample['quota']> = [];
  for (const after of e.limits ?? []) {
    let prev: ReportedLimit | undefined;
    for (const r of o.before) {
      if (r.period !== after.period || r.scope !== after.scope || Math.abs(r.resetsAt - after.resetsAt) > SAME_WINDOW_MS) continue;
      if (r.asOf > o.start + BEFORE_GRACE_MS || r.asOf < o.start - BEFORE_FRESH_MS || r.asOf >= after.asOf) continue;
      if (!prev || r.asOf > prev.asOf) prev = r;
    }
    if (prev) quota.push({ period: after.period, ...(after.scope !== undefined ? { scope: after.scope } : {}), beforePct: prev.usedPct, afterPct: after.usedPct });
  }
  return {
    time: e.time, cli: e.cli, model: e.model, ok: e.ok, durationMs: e.durationMs,
    ...(e.inputTokens !== undefined ? { inputTokens: e.inputTokens } : {}), ...(e.outputTokens !== undefined ? { outputTokens: e.outputTokens } : {}),
    ...(e.cacheReadTokens !== undefined ? { cacheReadTokens: e.cacheReadTokens } : {}), ...(e.cacheWriteTokens !== undefined ? { cacheWriteTokens: e.cacheWriteTokens } : {}),
    ...(e.partial ? { partial: true } : {}), role: o.role, ...(o.size ? { size: o.size } : {}), ...(o.effort ? { effort: o.effort } : {}),
    ...(quota.length ? { quota } : {}), ...(o.overlap?.length ? { overlap: o.overlap } : {})
  };
}

/** Another Harbor run on the same CLI: finished (its usage event) or still running (its tokens so far, estimated). */
export interface OtherRun { entry: CatalogEntry; start: number; end: number; kTok: number }

/**
 * Cost-weighted k-tokens (k-tokens * costPerKTok, the unit of pctPerKTok) that OTHER Harbor runs of `cli` burned in each pool during
 * [start, end], each run's tokens spread evenly over its own span. PURE. Phase 5 simulator (steady week, seeds 1-2): without it the
 * per-run samples counted their neighbours' use as their own and calibration settled at 1.1 to 2.4 times the true quota per token;
 * with it at 0.89 to 1.02.
 */
export function overlapKTok(o: { cli: CliId; start: number; end: number; others: readonly OtherRun[] }): NonNullable<CalibrationSample['overlap']> {
  const by = new Map<string, number>();
  for (const r of o.others) {
    if (r.entry.cli !== o.cli || r.end <= o.start || r.start >= o.end || !(r.kTok > 0)) continue;
    const span = Math.max(1, r.end - r.start), shared = Math.min(r.end, o.end) - Math.max(r.start, o.start);
    const k = (r.kTok * costPerKTokOf(r.entry) * shared) / span;
    for (const pool of poolsOfEntry(r.entry)) by.set(pool, (by.get(pool) ?? 0) + k);
  }
  return [...by].map(([pool, kTok]) => ({ pool, kTok }));
}

/** The finished runs of `events` as OtherRun (billable k-tokens; the run's span is its duration up to its event time). */
export function finishedRuns(events: readonly UsageEvent[], entryOf: (cli: CliId, model: string) => CatalogEntry | undefined): OtherRun[] {
  const out: OtherRun[] = [];
  for (const u of events) {
    const entry = entryOf(u.cli, u.model), kTok = billableKTok(u);
    if (entry && kTok !== undefined) out.push({ entry, start: u.time - u.durationMs, end: u.time, kTok });
  }
  return out;
}

/**
 * The newest reading of every window taken after `start` (a run's start): what a CLI that prints no limits of its own (Codex writes
 * them to its session logs, which the ledger reads) reported while the run went. Stored on the run's usage event, so Codex windows get
 * a history (the burn rate needs successive readings; the logs keep only the latest) and calibration gets an "after" reading.
 */
export function readingsDuring(readings: readonly ReportedLimit[], start: number): ReportedLimit[] {
  const best = new Map<string, ReportedLimit>();
  for (const r of readings) {
    if (r.asOf <= start) continue;
    const k = `${r.period}|${r.scope ?? ''}`, b = best.get(k);
    if (!b || r.asOf > b.asOf) best.set(k, r);
  }
  return [...best.values()];
}
