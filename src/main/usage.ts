import type { CliId, Id, UsageWindow } from '../shared/api';
import type { ReportedLimit } from './codexLimits';
import { newId, type Store } from './store';
import { DEFAULT_CATALOG, USD_PER_WEIGHT, costWeightOf, entryFor, type CatalogEntry } from './clis/capabilities';
import type { UsageEvent } from './types';

export type UsageLevel = 'plenty' | 'limited' | 'low' | 'exhausted';

/** Whether a reading came from the provider itself or is Harbor's own count of the runs it started. */
export type UsageSource = 'reported' | 'estimated';
/** `calibrated`: an estimated reading whose budget came from the owner's settings or from the provider's own readings (false = fallback constant). */
export interface Pressure {
  level: UsageLevel; pct: number; projectedPct?: number; resetsAt?: number; source: UsageSource; calibrated?: boolean;
  /** Every window that applies to the model (5h and weekly, plus its own per-model limits), for headroom routing. Absent on a rate-limit cooldown. */
  windows?: PressureWindow[];
}
/** One window as routing sees it. `remainingPct` = 100 - usedPct; `projectedPct` only for reported windows past their first 10%. */
export interface PressureWindow {
  period: 'session' | 'weekly'; scope?: string; usedPct: number; remainingPct: number;
  resetsAt?: number; projectedPct?: number; source: UsageSource; calibrated?: boolean;
  /** When the provider's reading was taken (reported windows only): weekly pacing trusts an old reading less. */
  asOf?: number;
}

export const WINDOW_MS =5 * 60 * 60 * 1000;
/** After a CLI reports a rate limit its reset time is unknown; treat it as exhausted for this long. */
export const COOLDOWN_MS = 30 * 60 * 1000;
/**
 * FALLBACKS, used only until the provider's own readings calibrate a budget (see `calibratedBudget`). Measured once on one account:
 * 78 runs were 33% of the 5h window (so ~230 average runs), and the weekly count was about 2.5x too generous at 300. They are
 * guesses for other plans and are shown as 'uncalibrated'.
 */
export const DEFAULT_RUNS_PER_WINDOW = 200;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_RUNS_PER_WEEK = 120;
/** One "average run" in catalog weight points (between a haiku run at 1 and an opus run at 25): budgets are counted in these. */
export const AVERAGE_RUN_WEIGHT = 8;
/** A calibration needs the provider's percent to have moved at least this much between two readings (rounding noise below). */
const MIN_CALIBRATION_DELTA_PCT = 3;
/** The same window if its reset time moved by less than this between two readings. */
const SAME_WINDOW_MS = 2 * 60_000;

export interface LedgerOptions {
  now?: () => number;
  windowMs?: number;
  /**
   * Budget in runs per window, set by the owner: such a budget counts every run as one (no cost weighting) and is never 'uncalibrated'.
   * Without it, runs are weighted by cost and the budget comes from the provider's readings, else from the DEFAULT_ fallback.
   */
  runsPerWindow?: Partial<Record<CliId, number>> & { default?: number };
  /** Catalog for the per-model run weights (default: the built-in one). */
  catalog?: CatalogEntry[];
  /** Supported source of a discretionary reset entitlement. No CLI exposes one today, so the default is none. */
  entitlement?: (cli: CliId) => boolean;
  /** Limits the provider itself reported (read from its own logs). Win over Harbor's estimate when present. */
  reported?: (cli: CliId) => ReportedLimit[];
  weekMs?: number;
  runsPerWeek?: number;
  /** CLIs Harbor can neither run nor read limits from (Gemini today) get no window: a 0% estimate would mislead. */
  measurable?: (cli: CliId) => boolean;
}

/**
 * Application-wide usage ledger. Counts what Harbor itself ran; it cannot see usage outside Harbor, and
 * says so in the window label. Percentages are Harbor-run estimates relative to an assumed budget; a
 * rate-limit reported by the CLI itself is the only 'reported' signal and forces 100%.
 */
/** Readings seen during runs (UsageLedger.observe) are kept this long in memory: the burn rate looks back about a day. */
export const OBSERVED_KEEP_MS = 48 * 60 * 60 * 1000;

export class UsageLedger {
  private now: () => number;
  private windowMs: number;
  /** Provider readings the CLIs printed during runs still in flight (their usage events, which persist them, come at the end). */
  private observed: Array<{ cli: CliId; limit: ReportedLimit }> = [];

  constructor(private store: Store, private opts: LedgerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.windowMs = opts.windowMs ?? WINDOW_MS;
  }

  /** The ledger's clock (injected in tests): routing judges pools at this time when it is given no clock of its own. */
  time(): number { return this.now(); }

  /**
   * Every provider reading Harbor has seen for a CLI: the CLI's own logs plus the limits it printed during Harbor runs (each window
   * and scope, any age). The budget governor derives burn rates from successive readings, so nothing is deduplicated here.
   */
  readings(cli: CliId): ReportedLimit[] {
    const out = [...(this.opts.reported?.(cli) ?? [])];
    for (const u of this.store.listUsage()) if (u.cli === cli) for (const l of u.limits ?? []) out.push(l);
    for (const o of this.observed) if (o.cli === cli) out.push(o.limit);
    return out;
  }

  /**
   * A reading the CLI printed during a run (Claude's rate_limit_event): visible to routing at once instead of when the run ends and its
   * usage event is recorded. A 40-minute run would otherwise hide its own readings, and every other run's, for 40 minutes (Phase 5).
   */
  observe(cli: CliId, limits: readonly ReportedLimit[]): void {
    const now = this.now();
    this.observed = this.observed.filter((o) => o.limit.asOf >= now - OBSERVED_KEEP_MS);
    for (const limit of limits) this.observed.push({ cli, limit });
  }

  record(e: Omit<UsageEvent, 'id' | 'time'> & { time?: number }): UsageEvent {
    const ev: UsageEvent = { id: newId(), time: this.now(), ...e };
    this.store.addUsage(ev);
    return ev;
  }

  /**
   * The latest reset of an account-wide window that is already behind us: a reset time the CLI reported (during a Harbor run, or
   * in its own logs) that has passed. Estimated usage counts only runs after it, because the provider's counter started again
   * then; without this a window that already reset keeps showing the runs from before it (a lockout until they age out).
   */
  private lastKnownReset(cli: CliId, period?: ReportedLimit['period']): number {
    const now = this.now();
    let last = 0;
    const see = (l: { period: ReportedLimit['period']; scope?: string; resetsAt: number }) => {
      if (l.scope === undefined && (period === undefined || l.period === period) && l.resetsAt <= now) last = Math.max(last, l.resetsAt);
    };
    this.opts.reported?.(cli).forEach(see);
    for (const u of this.store.listUsage()) if (u.cli === cli) u.limits?.forEach(see);
    for (const o of this.observed) if (o.cli === cli) see(o.limit);
    return last;
  }

  private inWindow(cli: CliId, ms = this.windowMs, period?: ReportedLimit['period']): UsageEvent[] {
    const from = this.now() - ms;
    // Strictly after the reset: a run that started before it belongs to the old window.
    const reset = period ? this.lastKnownReset(cli, period) : 0;
    return this.store.listUsage().filter((u) => u.cli === cli && u.time >= from && u.time > reset);
  }

  /** `scope` undefined = the account-wide window; otherwise the per-model limit with that scope. */
  private reportedFor(cli: CliId, period: ReportedLimit['period'], scope?: string): ReportedLimit | undefined {
    const live = this.opts.reported?.(cli).find((l) => l.period === period && l.scope === scope && l.resetsAt > this.now());
    if (live) return live;
    // Limits the CLI printed during Harbor's own runs: newest observation wins; rolled-over windows are stale.
    let best: ReportedLimit | undefined;
    const consider = (l: ReportedLimit) => { if (l.period === period && l.scope === scope && l.resetsAt > this.now() && (!best || l.asOf >= best.asOf)) best = l; };
    for (const u of this.store.listUsage()) if (u.cli === cli) u.limits?.forEach(consider);
    for (const o of this.observed) if (o.cli === cli) consider(o.limit);
    return best;
  }

  /** Quota weight of one run: its real cost when the CLI reported one, else the catalog's weight for the model. */
  private unitsOf(u: UsageEvent): number {
    return u.costUsd !== undefined && u.costUsd >= 0 ? u.costUsd / USD_PER_WEIGHT : costWeightOf(this.opts.catalog ?? DEFAULT_CATALOG, u.cli, u.model);
  }

  /** Runs of average weight in `events` (the unit of every budget). An owner-set budget counts plain runs instead. */
  private runsIn(events: UsageEvent[], countRuns: boolean): number {
    return countRuns ? events.length : events.reduce((s, u) => s + this.unitsOf(u), 0) / AVERAGE_RUN_WEIGHT;
  }

  /** The provider's own whole-account readings of one window for a CLI, oldest first, each tied to the run that carried it. */
  private anchors(cli: CliId, period: ReportedLimit['period']): Array<{ time: number; usedPct: number; resetsAt: number }> {
    const out: Array<{ time: number; usedPct: number; resetsAt: number }> = [];
    for (const u of this.store.listUsage()) {
      if (u.cli !== cli) continue;
      const l = u.limits?.find((x) => x.period === period && x.scope === undefined);
      if (l) out.push({ time: u.time, usedPct: l.usedPct, resetsAt: l.resetsAt });
    }
    return out.sort((a, b) => a.time - b.time);
  }

  /**
   * Budget (runs of average weight) learned from the provider: for consecutive readings of the same window whose percent rose by
   * at least MIN_CALIBRATION_DELTA_PCT, the Harbor runs between them cost `units / delta` per percent. The median of the latest
   * pairs wins. Any use of the account outside Harbor makes the budget look smaller than it is (a cautious error). Undefined with
   * fewer than two readings in one window: then nothing is invented, and callers fall back to a flagged constant.
   */
  private calibratedBudget(cli: CliId, period: ReportedLimit['period']): number | undefined {
    const a = this.anchors(cli, period);
    if (a.length < 2) return undefined;
    const events = this.store.listUsage().filter((u) => u.cli === cli);
    const perPct: number[] = [];
    for (let i = 1; i < a.length; i++) {
      const delta = a[i].usedPct - a[i - 1].usedPct;
      if (delta < MIN_CALIBRATION_DELTA_PCT || Math.abs(a[i].resetsAt - a[i - 1].resetsAt) > SAME_WINDOW_MS) continue;
      const units = events.filter((u) => u.time > a[i - 1].time && u.time <= a[i].time).reduce((s, u) => s + this.unitsOf(u), 0);
      if (units > 0) perPct.push(units / delta);
    }
    if (!perPct.length) return undefined;
    const latest = perPct.slice(-8).sort((x, y) => x - y);
    const median = latest[Math.floor((latest.length - 1) / 2)]!;
    return (median * 100) / AVERAGE_RUN_WEIGHT;
  }

  /** The budget one estimated window is measured against, and whether it is trustworthy (owner-set or calibrated) or a fallback. */
  private budgetFor(cli: CliId, period: ReportedLimit['period']): { runs: number; calibrated: boolean; countRuns: boolean } {
    const set = period === 'session' ? (this.opts.runsPerWindow?.[cli] ?? this.opts.runsPerWindow?.default) : this.opts.runsPerWeek;
    if (set !== undefined) return { runs: set, calibrated: true, countRuns: true };
    const cal = this.calibratedBudget(cli, period);
    if (cal !== undefined) return { runs: cal, calibrated: true, countRuns: false };
    return { runs: period === 'session' ? DEFAULT_RUNS_PER_WINDOW : DEFAULT_RUNS_PER_WEEK, calibrated: false, countRuns: false };
  }

  /** Time until which the CLI is treated as rate limited, if its last rate limit is recent. A limit that named no model holds every model out. */
  cooldownUntil(cli: CliId, model?: string): number | undefined {
    let last = 0;
    // A rate limit hit before a reset the CLI has since reported no longer holds the CLI out.
    const reset = this.lastKnownReset(cli);
    for (const u of this.store.listUsage()) if (u.cli === cli && u.rateLimited && u.time > reset && (model === undefined || this.sameModel(cli, u.model, model) || u.cliWide)) last = Math.max(last, u.time);
    const until = last + COOLDOWN_MS;
    return last && until > this.now() ? until : undefined;
  }

  /** One model under two names (a run recorded under an old alias such as 'opus' and its full id now). */
  private sameModel(cli: CliId, a: string, b: string): boolean {
    if (a === b) return true;
    const catalog = this.opts.catalog ?? DEFAULT_CATALOG, ea = entryFor(catalog, cli, a);
    return !!ea && ea === entryFor(catalog, cli, b);
  }

  /** `cooldown`: whether a recent rate limit on any model counts as the whole CLI being out (display) or not (routing, which cools models individually). */
  private sessionPct(cli: CliId, cooldown = true): number {
    const r = this.reportedFor(cli, 'session');
    if (r) return Math.min(100, Math.round(r.usedPct));
    if (cooldown && this.cooldownUntil(cli)) return 100;
    const b = this.budgetFor(cli, 'session');
    return Math.min(100, Math.round((this.runsIn(this.inWindow(cli, this.windowMs, 'session'), b.countRuns) / b.runs) * 100));
  }

  private weeklyPct(cli: CliId): number {
    const r = this.reportedFor(cli, 'weekly');
    if (r) return Math.min(100, Math.round(r.usedPct));
    const b = this.budgetFor(cli, 'weekly');
    return Math.min(100, Math.round((this.runsIn(this.inWindow(cli, this.opts.weekMs ?? WEEK_MS, 'weekly'), b.countRuns) / b.runs) * 100));
  }

  /** Model-family limits currently reported for a CLI (e.g. 'opus', 'fable'). */
  private liveScopes(cli: CliId): string[] {
    const out = new Set<string>();
    const add = (l: ReportedLimit) => { if (l.scope && l.resetsAt > this.now()) out.add(l.scope); };
    this.opts.reported?.(cli).forEach(add);
    for (const u of this.store.listUsage()) if (u.cli === cli) u.limits?.forEach(add);
    for (const o of this.observed) if (o.cli === cli) add(o.limit);
    return [...out];
  }

  private scopeMatches(scope: string, model: string): boolean {
    const m = model.toLowerCase();
    return m !== 'default' && (m.includes(scope) || scope.includes(m));
  }

  private windowState(cli: CliId, period: ReportedLimit['period'], scope?: string): { pct: number; resetsAt?: number; ms: number; source: UsageSource; calibrated?: boolean; asOf?: number } | undefined {
    const ms = period === 'session' ? this.windowMs : (this.opts.weekMs ?? WEEK_MS);
    const r = this.reportedFor(cli, period, scope);
    if (r) return { pct: Math.min(100, Math.round(r.usedPct)), resetsAt: r.resetsAt, ms, source: 'reported', asOf: r.asOf };
    if (scope !== undefined) return undefined; // per-model limits are only known when the CLI reports them
    // Estimated: the "window" is Harbor's own rolling count, so its start is the first Harbor run, not the provider's window start.
    const calibrated = this.budgetFor(cli, period).calibrated;
    if (period === 'session') {
      const oldest = this.inWindow(cli, this.windowMs, 'session').reduce<number | undefined>((m, u) => (m === undefined ? u.time : Math.min(m, u.time)), undefined);
      return { pct: this.sessionPct(cli, false), resetsAt: oldest !== undefined ? oldest + ms : undefined, ms, source: 'estimated', calibrated };
    }
    const oldest = this.inWindow(cli, ms, 'weekly').reduce<number | undefined>((m, u) => (m === undefined ? u.time : Math.min(m, u.time)), undefined);
    return { pct: this.weeklyPct(cli), resetsAt: oldest !== undefined ? oldest + ms : undefined, ms, source: 'estimated', calibrated };
  }

  /**
   * How tight the allowance is for one model: the worst of the account windows and any per-model limit that
   * applies to it. Uses pace as well as percent: used% divided by the elapsed share of the window projects where
   * usage lands at reset. Ahead of pace (would run out before reset) tightens a notch; well under pace relaxes one.
   * Pace is ignored in the first 10% of a window (too noisy to extrapolate) and for estimated windows altogether:
   * those start at Harbor's first run, not the provider's window start, so "elapsed" would be meaningless.
   * `source` says whether the deciding window was reported by the provider or is Harbor's own estimate; routing
   * weighs estimates less.
   */
  pressure(cli: CliId, model?: string): Pressure {
    const scopes = model ? this.liveScopes(cli).filter((s) => this.scopeMatches(s, model)) : [];
    const wins = [undefined, ...scopes].flatMap((sc) => (['session', 'weekly'] as const).map((p) => { const w = this.windowState(cli, p, sc); return w && { ...w, period: p, scope: sc }; }));
    const order: UsageLevel[] = ['plenty', 'limited', 'low', 'exhausted'];
    let worst: Pressure = { level: 'plenty', pct: 0, source: 'estimated' };
    const windows: PressureWindow[] = [];
    // A rate limit hit while running this model holds it out for a while; its siblings on the same CLI are judged on their own windows.
    const until = model ? this.cooldownUntil(cli, model) : this.cooldownUntil(cli);
    if (until) return { level: 'exhausted', pct: 100, resetsAt: until, source: 'reported' };
    for (const w of wins) {
      if (!w) continue;
      let level: UsageLevel = w.pct >= 100 ? 'exhausted' : w.pct >= 80 ? 'low' : w.pct >= 50 ? 'limited' : 'plenty';
      let projectedPct: number | undefined;
      const elapsed = w.source !== 'reported' || w.resetsAt === undefined ? 0 : Math.min(1, 1 - (w.resetsAt - this.now()) / w.ms);
      if (level !== 'exhausted' && elapsed >= 0.1) {
        projectedPct = Math.round(w.pct / elapsed);
        if (projectedPct >= 100 && level !== 'low') level = order[order.indexOf(level) + 1];
        else if (projectedPct < 70 && level === 'limited') level = 'plenty';
      }
      windows.push({ period: w.period, ...(w.scope !== undefined ? { scope: w.scope } : {}), usedPct: w.pct, remainingPct: 100 - w.pct, resetsAt: w.resetsAt, projectedPct, source: w.source, ...(w.calibrated !== undefined ? { calibrated: w.calibrated } : {}), ...(w.asOf !== undefined ? { asOf: w.asOf } : {}) });
      if (order.indexOf(level) > order.indexOf(worst.level) || (level === worst.level && w.pct > worst.pct)) worst = { level, pct: w.pct, projectedPct, resetsAt: w.resetsAt, source: w.source, ...(w.calibrated !== undefined ? { calibrated: w.calibrated } : {}) };
    }
    return { ...worst, windows };
  }

  /** Routing sees the tighter of the two windows: an exhausted week blocks a CLI even when the 5h window is empty. */
  usedPct(cli: CliId): number {
    return Math.max(this.sessionPct(cli), this.weeklyPct(cli));
  }

  level(cli: CliId): UsageLevel {
    const p = this.usedPct(cli);
    return p >= 100 ? 'exhausted' : p >= 80 ? 'low' : p >= 50 ? 'limited' : 'plenty';
  }

  windows(clis: CliId[]): UsageWindow[] {
    const weekMs = this.opts.weekMs ?? WEEK_MS;
    const oldestOf = (events: UsageEvent[]) => events.reduce<number | undefined>((m, u) => (m === undefined ? u.time : Math.min(m, u.time)), undefined);
    const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    // An estimate against a fallback budget says so: its percentage is a guess about someone else's quota, not a reading.
    const noteOf = (calibrated: boolean) => (calibrated ? '' : ' · uncalibrated (assumed budget; becomes accurate once two provider readings are seen)');
    return clis.filter((c) => this.opts.measurable?.(c) ?? true).flatMap((cli): UsageWindow[] => {
      const free = this.opts.entitlement?.(cli) ? true : undefined;
      const cooldown = this.cooldownUntil(cli);
      const rs = this.reportedFor(cli, 'session'), rw = this.reportedFor(cli, 'weekly');
      const oldest = oldestOf(this.inWindow(cli, this.windowMs, 'session')), oldestWeek = oldestOf(this.inWindow(cli, weekMs, 'weekly'));
      const session: UsageWindow = rs
        ? { cli, period: 'session', source: 'reported', label: `5h window · reported by ${cli} as of ${clock(rs.asOf)}`, usedPct: this.sessionPct(cli), resetsAt: rs.resetsAt, freeResetAvailable: free }
        : { cli, period: 'session', source: cooldown ? 'reported' : 'estimated', label: cooldown ? 'Rate limited (reported by the CLI)' : `5h window · estimated from Harbor runs only${noteOf(this.budgetFor(cli, 'session').calibrated)}`,
            usedPct: this.sessionPct(cli), resetsAt: cooldown ?? (oldest !== undefined ? oldest + this.windowMs : undefined), freeResetAvailable: free,
            ...(cooldown ? {} : { calibrated: this.budgetFor(cli, 'session').calibrated }) };
      const weekly: UsageWindow = rw
        ? { cli, period: 'weekly', source: 'reported', label: `Weekly window · reported by ${cli} as of ${clock(rw.asOf)}`, usedPct: this.weeklyPct(cli), resetsAt: rw.resetsAt }
        : { cli, period: 'weekly', source: 'estimated', label: `Weekly window · estimated from Harbor runs only (rolling 7 days)${noteOf(this.budgetFor(cli, 'weekly').calibrated)}`,
            usedPct: this.weeklyPct(cli), resetsAt: oldestWeek !== undefined ? oldestWeek + weekMs : undefined, calibrated: this.budgetFor(cli, 'weekly').calibrated };
      const scoped = this.liveScopes(cli).flatMap((scope): UsageWindow[] => (['session', 'weekly'] as const).flatMap((period) => {
        const r = this.reportedFor(cli, period, scope);
        return r ? [{ cli, period, source: 'reported' as const, model: scope, label: `${scope} only · ${period === 'session' ? '5h' : 'weekly'} · reported by ${cli} as of ${clock(r.asOf)}`, usedPct: Math.min(100, Math.round(r.usedPct)), resetsAt: r.resetsAt }] : [];
      }));
      return [session, weekly, ...scoped];
    });
  }

  /** Lifetime totals: live events plus what pruning folded into the store's archive, so the figure never drops when old events are pruned. */
  runningCost(projectId?: Id): { runs: number; inputTokens: number; outputTokens: number; costUsd: number } {
    const evs = this.store.listUsage().filter((u) => !projectId || u.projectId === projectId);
    const archived = this.store.usageArchive(projectId);
    return evs.reduce((a, u) => ({
      runs: a.runs + 1, inputTokens: a.inputTokens + (u.inputTokens ?? 0),
      outputTokens: a.outputTokens + (u.outputTokens ?? 0), costUsd: a.costUsd + (u.costUsd ?? 0)
    }), { runs: archived.runs, inputTokens: archived.inputTokens, outputTokens: archived.outputTokens, costUsd: archived.costUsd });
  }
}

/** Recent outcomes per "cli/model" for the router: runs, failures (rate limits included: they are why a model is a bad pick right now) and the last failure time. */
export function buildHistory(events: readonly UsageEvent[], now: number, sinceMs = 24 * 60 * 60 * 1000): Record<string, { runs: number; fails: number; lastFailAt?: number }> {
  const out: Record<string, { runs: number; fails: number; lastFailAt?: number }> = {};
  for (const u of events) {
    if (u.time < now - sinceMs) continue;
    const h = (out[`${u.cli}/${u.model}`] ??= { runs: 0, fails: 0 });
    h.runs++;
    if (!u.ok || u.rateLimited) { h.fails++; h.lastFailAt = Math.max(h.lastFailAt ?? 0, u.time); }
  }
  return out;
}

export interface FreeResetDeps {
  ledger: UsageLedger;
  store: Store;
  /** How many authorized tasks are waiting for capacity. */
  backlog: () => number;
  /** Ask the user (permission event). Resolves with their answer. */
  ask: (prompt: string) => Promise<boolean>;
  /** Perform a supported reset. Absent => the user must do it in the provider's own UI. */
  perform?: (cli: CliId) => Promise<'done' | 'manual'>;
  allow: () => 'ask' | 'never';
  now?: () => number;
}

/**
 * Optional free reset flow. Never automatic: only proposes when an entitlement is confirmed, existing
 * allowance is low/exhausted, there is backlog to benefit, and the user hasn't already answered for this
 * window. Approval applies to this reset only.
 */
export class FreeResetCoordinator {
  private answered = new Map<CliId, number>();
  constructor(private d: FreeResetDeps) {}

  async maybePropose(cli: CliId): Promise<'not-offered' | 'declined' | 'done' | 'manual'> {
    const now = (this.d.now ?? Date.now)();
    const win = this.d.ledger.windows([cli])[0];
    if (this.d.allow() === 'never' || !win.freeResetAvailable) return 'not-offered';
    const level = this.d.ledger.level(cli);
    if ((level !== 'low' && level !== 'exhausted') || this.d.backlog() === 0) return 'not-offered';
    const prev = this.answered.get(cli);
    if (prev !== undefined && now - prev < WINDOW_MS) return 'not-offered';

    const reset = win.resetsAt ? `next scheduled refresh around ${new Date(win.resetsAt).toLocaleTimeString()}` : 'next refresh time unknown';
    const ok = await this.d.ask(
      `Use a free reset for ${cli}? Estimated usage ${win.usedPct}% (Harbor-observed). ${this.d.backlog()} queued task(s) are waiting; ${reset}. This uses one reset entitlement (count unknown).`
    );
    this.answered.set(cli, now);
    this.d.store.addResetApproval({ id: newId(), cli, time: now, approved: ok });
    if (!ok) return 'declined';
    return (await this.d.perform?.(cli)) ?? 'manual';
  }
}
