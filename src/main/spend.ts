import type { Id, Settings, SpendCeilings, SpendLimit, SpendScope, SpendStatusEntry } from '../shared/api';
import { billableKTok } from './calibration';
import type { RunTokens } from './runUsage';
import type { UsageEvent } from './types';

/**
 * Spend ceilings (PURE): hard stops on what Harbor's own runs spent per task, per rolling day and per rolling week. Spend is counted in
 * billable k-tokens (calibration.billableKTok, as the budget governor counts them) and agent-minutes, from the usage events Harbor
 * recorded plus the runs still in flight. It is an ESTIMATE of Harbor's share only: it never sees usage outside Harbor and is never
 * the provider's quota. Codex reports tokens only when a run ends, so a running Codex run counts by its minutes until then.
 *
 * The usage events are persisted (state.json keeps 8 days, store.USAGE_KEEP_MS), and so are the extensions the user allowed and the
 * last live snapshot of runs in flight (a crash keeps what they had spent), so a restart resets nothing.
 */

export const DAY_MS = 24 * 60 * 60_000;
export const WEEK_MS = 7 * DAY_MS;
/** How often runs in flight are measured against the ceilings (also on every usage report a run streams). */
export const SPEND_CHECK_MS = 30_000;
/** Tool name of the permission request that asks to continue past a ceiling (a `permission` event of kind 'tool'). */
export const SPEND_TOOL = 'Harbor spend ceiling';
export const SPEND_SCOPES: readonly SpendScope[] = ['task', 'day', 'week'];
/** Bounds of one limit (a typo must not become a ceiling of 0 or a ceiling nobody can reach). */
export const KTOKENS_RANGE = [1, 100_000_000] as const;
export const MINUTES_RANGE = [1, 1_000_000] as const;

/** One run as the ceilings count it. `time` = when it ended (or now, for a run in flight). */
export interface SpendRun { projectId: Id; taskId?: Id; time: number; kTokens: number; minutes: number; partial?: boolean }
export interface SpendAmount { kTokens: number; minutes: number; runs: number; partial: boolean }
/** "Continue past this ceiling" the user allowed: one more limit's worth for that key (a rolling window's lasts one window). */
export interface SpendGrant { id: Id; key: string; time: number }
/** One ceiling to check. `projectId` absent = counts every project (a global day/week ceiling). */
export interface SpendCheck { scope: SpendScope; key: string; projectId?: Id; taskId?: Id; limit: SpendLimit }
export interface SpendHit extends SpendCheck { spent: SpendAmount; threshold: SpendLimit; unit: 'kTokens' | 'minutes'; extensions: number }

export const windowMs = (scope: SpendScope): number | undefined => (scope === 'day' ? DAY_MS : scope === 'week' ? WEEK_MS : undefined);

const hasLimit = (l: SpendLimit | undefined): l is SpendLimit => !!l && (l.kTokens !== undefined || l.minutes !== undefined);

/** A usage event as a spend run (its tokens as billable k-tokens; a run that reported none counts 0 tokens and its minutes). */
export function spendRunOf(u: Pick<UsageEvent, 'projectId' | 'taskId' | 'time' | 'durationMs' | 'partial' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): SpendRun {
  return { projectId: u.projectId, ...(u.taskId ? { taskId: u.taskId } : {}), time: u.time, kTokens: billableKTok(u) ?? 0, minutes: Math.max(0, u.durationMs) / 60_000, ...(u.partial ? { partial: true } : {}) };
}

/** A run still in flight: what it streamed so far and the minutes it has run. */
export function liveRunOf(o: { projectId: Id; taskId?: Id; now: number; elapsedMs: number; tokens: RunTokens }): SpendRun {
  return { projectId: o.projectId, ...(o.taskId ? { taskId: o.taskId } : {}), time: o.now, kTokens: billableKTok(o.tokens) ?? 0, minutes: Math.max(0, o.elapsedMs) / 60_000, partial: true };
}

/** Whether any ceiling is configured at all (nothing is measured otherwise). */
export const ceilingsConfigured = (s: Pick<Settings, 'spendCeilings' | 'projectOverrides'>): boolean =>
  !!s.spendCeilings || Object.values(s.projectOverrides ?? {}).some((p) => !!p.spendCeilings);

/**
 * The ceilings that apply to a run of `projectId` working on `taskId`: the task ceiling (the project's own, else the global one),
 * the global day and week ceilings over every project, and the project's own day and week ceilings over that project.
 */
export function checksFor(s: Pick<Settings, 'spendCeilings' | 'projectOverrides'>, projectId: Id, taskId?: Id): SpendCheck[] {
  const g = s.spendCeilings ?? {};
  const p = s.projectOverrides?.[projectId]?.spendCeilings ?? {};
  const out: SpendCheck[] = [];
  const task = hasLimit(p.task) ? p.task : g.task;
  if (taskId && hasLimit(task)) out.push({ scope: 'task', key: `task:${taskId}`, projectId, taskId, limit: task });
  for (const scope of ['day', 'week'] as const) {
    if (hasLimit(g[scope])) out.push({ scope, key: `${scope}:*`, limit: g[scope]! });
    if (hasLimit(p[scope])) out.push({ scope, key: `${scope}:${projectId}`, projectId, limit: p[scope]! });
  }
  return out;
}

/** Whether a run counts towards a check: same task, or same project (or any project) within the rolling window. */
export function counts(c: Pick<SpendCheck, 'scope' | 'projectId' | 'taskId'>, r: SpendRun, now: number): boolean {
  if (c.scope === 'task') return !!c.taskId && r.taskId === c.taskId;
  if (c.projectId && r.projectId !== c.projectId) return false;
  return r.time > now - windowMs(c.scope)!;
}

export function spentFor(c: Pick<SpendCheck, 'scope' | 'projectId' | 'taskId'>, runs: readonly SpendRun[], now: number): SpendAmount {
  const a: SpendAmount = { kTokens: 0, minutes: 0, runs: 0, partial: false };
  for (const r of runs) {
    if (!counts(c, r, now)) continue;
    a.kTokens += r.kTokens; a.minutes += r.minutes; a.runs++;
    if (r.partial) a.partial = true;
  }
  return a;
}

/** Extensions in force for a key: a task's last for the task, a day's or week's for one window from when they were allowed. */
export function activeGrants(grants: readonly SpendGrant[], c: Pick<SpendCheck, 'scope' | 'key'>, now: number): number {
  const w = windowMs(c.scope);
  return grants.filter((g) => g.key === c.key && (w === undefined || g.time > now - w)).length;
}

export const thresholdOf = (limit: SpendLimit, extensions: number): SpendLimit => ({
  ...(limit.kTokens !== undefined ? { kTokens: limit.kTokens * (1 + extensions) } : {}),
  ...(limit.minutes !== undefined ? { minutes: limit.minutes * (1 + extensions) } : {})
});

/** The unit of `spent` at or past `threshold`, if any (tokens first: they are what the quota is made of). */
export function reached(spent: SpendAmount, threshold: SpendLimit): 'kTokens' | 'minutes' | undefined {
  if (threshold.kTokens !== undefined && spent.kTokens >= threshold.kTokens) return 'kTokens';
  if (threshold.minutes !== undefined && spent.minutes >= threshold.minutes) return 'minutes';
  return undefined;
}

/** The first ceiling (task, then day, then week) the runs have reached, counting the extensions the user allowed. */
export function firstHit(checks: readonly SpendCheck[], runs: readonly SpendRun[], grants: readonly SpendGrant[], now: number): SpendHit | undefined {
  for (const c of [...checks].sort((x, y) => SPEND_SCOPES.indexOf(x.scope) - SPEND_SCOPES.indexOf(y.scope))) {
    const extensions = activeGrants(grants, c, now);
    const threshold = thresholdOf(c.limit, extensions);
    const spent = spentFor(c, runs, now);
    const unit = reached(spent, threshold);
    if (unit) return { ...c, spent, threshold, unit, extensions };
  }
  return undefined;
}

/** Status rows for the UI (getSpendStatus). */
export function statusOf(checks: readonly SpendCheck[], runs: readonly SpendRun[], grants: readonly SpendGrant[], now: number): SpendStatusEntry[] {
  return checks.map((c) => {
    const extensions = activeGrants(grants, c, now);
    const threshold = thresholdOf(c.limit, extensions);
    const spent = spentFor(c, runs, now);
    const round = (n: number) => Math.round(n * 10) / 10;
    return {
      scope: c.scope, ...(c.projectId && c.scope !== 'task' ? { projectId: c.projectId } : {}), limit: c.limit, threshold,
      spent: { kTokens: round(spent.kTokens), minutes: round(spent.minutes), runs: spent.runs, partial: spent.partial },
      hit: !!reached(spent, threshold), extensions
    };
  });
}

/** Grants still able to matter: task grants for as long as usage events are kept, day/week grants for one window. */
export function pruneGrants(grants: readonly SpendGrant[], now: number, keepMs = 8 * DAY_MS): SpendGrant[] {
  return grants.filter((g) => g.time > now - Math.min(keepMs, g.key.startsWith('day:') ? DAY_MS : g.key.startsWith('week:') ? WEEK_MS : keepMs));
}

const fmt = (n: number): string => (n >= 100 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 10) / 10));

export function describeLimit(l: SpendLimit): string {
  return [l.kTokens !== undefined ? `${fmt(l.kTokens)}k tokens` : '', l.minutes !== undefined ? `${fmt(l.minutes)} agent-minutes` : ''].filter(Boolean).join(' or ');
}

const scopeText = (h: Pick<SpendCheck, 'scope' | 'projectId'>): string =>
  h.scope === 'task' ? "this request's" : `${h.projectId ? "this project's" : 'the all-projects'} ${h.scope === 'day' ? '24-hour' : '7-day'}`;

/** One line for the user and the lead. Always says it is Harbor's own estimate. */
export function describeHit(h: SpendHit): string {
  const ext = h.extensions ? ` (after ${h.extensions} extension${h.extensions === 1 ? '' : 's'} you allowed)` : '';
  return `Spend ceiling reached: ${scopeText(h)} ceiling of ${describeLimit(h.threshold)}${ext}; Harbor's runs so far: ${fmt(h.spent.kTokens)}k tokens, ${fmt(h.spent.minutes)} agent-minutes over ${h.spent.runs} run${h.spent.runs === 1 ? '' : 's'}. This is an estimate from Harbor's own runs${h.spent.partial ? ' (some stopped before their final usage report, so it is a lower bound)' : ''}, not your provider's quota.`;
}

/** The permission prompt that asks to continue. */
export function continuePrompt(h: SpendHit): string {
  const more = describeLimit(h.limit);
  const span = h.scope === 'task' ? 'for this request' : `for the next ${h.scope === 'day' ? '24 hours' : '7 days'}`;
  return `${describeHit(h)}\nContinue? Yes allows one more ${more} ${span}. No keeps everything in this scope stopped until you send a new message.`;
}

// ---- settings validation (store.ts normalizeSettingsPatch)

function limitOf(v: unknown, name: string): SpendLimit | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${name} must be { kTokens?, minutes? }.`);
  const o = v as Record<string, unknown>;
  const num = (k: 'kTokens' | 'minutes', [lo, hi]: readonly [number, number]): number | undefined => {
    const x = o[k];
    if (x === undefined || x === null) return undefined;
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`${name}.${k} must be a number.`);
    if (x <= 0) throw new Error(`${name}.${k} must be above 0 (leave it out for no limit).`);
    return Math.min(hi, Math.max(lo, Math.round(x)));
  };
  const kTokens = num('kTokens', KTOKENS_RANGE), minutes = num('minutes', MINUTES_RANGE);
  return kTokens !== undefined || minutes !== undefined ? { ...(kTokens !== undefined ? { kTokens } : {}), ...(minutes !== undefined ? { minutes } : {}) } : undefined;
}

/** Throws on a malformed value; drops empty limits; undefined when nothing is left (no ceilings). */
export function normalizeCeilings(v: unknown, name = 'spendCeilings'): SpendCeilings | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${name} must be { task?, day?, week? }.`);
  const o = v as Record<string, unknown>;
  const out: SpendCeilings = {};
  for (const scope of SPEND_SCOPES) { const l = limitOf(o[scope], `${name}.${scope}`); if (l) out[scope] = l; }
  return Object.keys(out).length ? out : undefined;
}
