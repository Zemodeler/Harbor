import type { CliId, Id, UsageWindow } from '../shared/api';
import type { ReportedLimit } from './codexLimits';
import { newId, type Store } from './store';
import type { UsageEvent } from './types';

export type UsageLevel = 'plenty' | 'limited' | 'low' | 'exhausted';

export const WINDOW_MS = 5 * 60 * 60 * 1000;
/** After a CLI reports a rate limit its reset time is unknown; treat it as exhausted for this long. */
export const COOLDOWN_MS = 30 * 60 * 1000;
export const DEFAULT_RUNS_PER_WINDOW = 40;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_RUNS_PER_WEEK = 300;

export interface LedgerOptions {
  now?: () => number;
  windowMs?: number;
  /** Assumed runs per window. Provider quotas are unknown, so this is an explicit estimate, not a reading. */
  runsPerWindow?: Partial<Record<CliId, number>> & { default?: number };
  /** Supported source of a discretionary reset entitlement. No CLI exposes one today, so the default is none. */
  entitlement?: (cli: CliId) => boolean;
  /** Limits the provider itself reported (read from its own logs). Win over Harbor's estimate when present. */
  reported?: (cli: CliId) => ReportedLimit[];
  weekMs?: number;
  runsPerWeek?: number;
}

/**
 * Application-wide usage ledger. Counts what Harbor itself ran; it cannot see usage outside Harbor, and
 * says so in the window label. Percentages are Harbor-run estimates relative to an assumed budget; a
 * rate-limit reported by the CLI itself is the only 'reported' signal and forces 100%.
 */
export class UsageLedger {
  private now: () => number;
  private windowMs: number;

  constructor(private store: Store, private opts: LedgerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.windowMs = opts.windowMs ?? WINDOW_MS;
  }

  record(e: Omit<UsageEvent, 'id' | 'time'> & { time?: number }): UsageEvent {
    const ev: UsageEvent = { id: newId(), time: this.now(), ...e };
    this.store.addUsage(ev);
    return ev;
  }

  private inWindow(cli: CliId, ms = this.windowMs): UsageEvent[] {
    const from = this.now() - ms;
    return this.store.listUsage().filter((u) => u.cli === cli && u.time >= from);
  }

  private reportedFor(cli: CliId, period: ReportedLimit['period']): ReportedLimit | undefined {
    const live = this.opts.reported?.(cli).find((l) => l.period === period && l.resetsAt > this.now());
    if (live) return live;
    // Limits the CLI printed during Harbor's own runs: newest observation wins; rolled-over windows are stale.
    let best: ReportedLimit | undefined;
    for (const u of this.store.listUsage()) {
      if (u.cli !== cli) continue;
      for (const l of u.limits ?? []) if (l.period === period && l.resetsAt > this.now() && (!best || l.asOf >= best.asOf)) best = l;
    }
    return best;
  }

  private budget(cli: CliId): number {
    const b = this.opts.runsPerWindow;
    return b?.[cli] ?? b?.default ?? DEFAULT_RUNS_PER_WINDOW;
  }

  /** Time until which the CLI is treated as rate limited, if its last rate limit is recent. */
  cooldownUntil(cli: CliId): number | undefined {
    let last = 0;
    for (const u of this.store.listUsage()) if (u.cli === cli && u.rateLimited) last = Math.max(last, u.time);
    const until = last + COOLDOWN_MS;
    return last && until > this.now() ? until : undefined;
  }

  private sessionPct(cli: CliId): number {
    const r = this.reportedFor(cli, 'session');
    if (r) return Math.min(100, Math.round(r.usedPct));
    if (this.cooldownUntil(cli)) return 100;
    return Math.min(100, Math.round((this.inWindow(cli).length / this.budget(cli)) * 100));
  }

  private weeklyPct(cli: CliId): number {
    const r = this.reportedFor(cli, 'weekly');
    if (r) return Math.min(100, Math.round(r.usedPct));
    const budget = this.opts.runsPerWeek ?? DEFAULT_RUNS_PER_WEEK;
    return Math.min(100, Math.round((this.inWindow(cli, this.opts.weekMs ?? WEEK_MS).length / budget) * 100));
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
    return clis.flatMap((cli): UsageWindow[] => {
      const free = this.opts.entitlement?.(cli) ? true : undefined;
      const cooldown = this.cooldownUntil(cli);
      const rs = this.reportedFor(cli, 'session'), rw = this.reportedFor(cli, 'weekly');
      const oldest = oldestOf(this.inWindow(cli)), oldestWeek = oldestOf(this.inWindow(cli, weekMs));
      const session: UsageWindow = rs
        ? { cli, period: 'session', source: 'reported', label: `5h window · reported by ${cli} as of ${clock(rs.asOf)}`, usedPct: this.sessionPct(cli), resetsAt: rs.resetsAt, freeResetAvailable: free }
        : { cli, period: 'session', source: cooldown ? 'reported' : 'estimated', label: cooldown ? 'Rate limited (reported by the CLI)' : '5h window · estimated from Harbor runs only',
            usedPct: this.sessionPct(cli), resetsAt: cooldown ?? (oldest !== undefined ? oldest + this.windowMs : undefined), freeResetAvailable: free };
      const weekly: UsageWindow = rw
        ? { cli, period: 'weekly', source: 'reported', label: `Weekly window · reported by ${cli} as of ${clock(rw.asOf)}`, usedPct: this.weeklyPct(cli), resetsAt: rw.resetsAt }
        : { cli, period: 'weekly', source: 'estimated', label: 'Weekly window · estimated from Harbor runs only (rolling 7 days)',
            usedPct: this.weeklyPct(cli), resetsAt: oldestWeek !== undefined ? oldestWeek + weekMs : undefined };
      return [session, weekly];
    });
  }

  runningCost(projectId?: Id): { runs: number; inputTokens: number; outputTokens: number; costUsd: number } {
    const evs = this.store.listUsage().filter((u) => !projectId || u.projectId === projectId);
    return evs.reduce((a, u) => ({
      runs: a.runs + 1, inputTokens: a.inputTokens + (u.inputTokens ?? 0),
      outputTokens: a.outputTokens + (u.outputTokens ?? 0), costUsd: a.costUsd + (u.costUsd ?? 0)
    }), { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  }
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
