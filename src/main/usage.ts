import type { CliId, Id, UsageWindow } from '../shared/api';
import { newId, type Store } from './store';
import type { UsageEvent } from './types';

export type UsageLevel = 'plenty' | 'limited' | 'low' | 'exhausted';

export const WINDOW_MS = 5 * 60 * 60 * 1000;
/** After a CLI reports a rate limit its reset time is unknown; treat it as exhausted for this long. */
export const COOLDOWN_MS = 30 * 60 * 1000;
export const DEFAULT_RUNS_PER_WINDOW = 40;

export interface LedgerOptions {
  now?: () => number;
  windowMs?: number;
  /** Assumed runs per window. Provider quotas are unknown, so this is an explicit estimate, not a reading. */
  runsPerWindow?: Partial<Record<CliId, number>> & { default?: number };
  /** Supported source of a discretionary reset entitlement. No CLI exposes one today, so the default is none. */
  entitlement?: (cli: CliId) => boolean;
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

  private inWindow(cli: CliId): UsageEvent[] {
    const from = this.now() - this.windowMs;
    return this.store.listUsage().filter((u) => u.cli === cli && u.time >= from);
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

  usedPct(cli: CliId): number {
    if (this.cooldownUntil(cli)) return 100;
    return Math.min(100, Math.round((this.inWindow(cli).length / this.budget(cli)) * 100));
  }

  level(cli: CliId): UsageLevel {
    const p = this.usedPct(cli);
    return p >= 100 ? 'exhausted' : p >= 80 ? 'low' : p >= 50 ? 'limited' : 'plenty';
  }

  windows(clis: CliId[]): UsageWindow[] {
    return clis.map((cli) => {
      const events = this.inWindow(cli);
      const cooldown = this.cooldownUntil(cli);
      const oldest = events.reduce<number | undefined>((m, u) => (m === undefined ? u.time : Math.min(m, u.time)), undefined);
      return {
        cli,
        label: cooldown ? 'Rate limited (reported by the CLI)' : '5h window · estimated from Harbor runs only',
        usedPct: this.usedPct(cli),
        resetsAt: cooldown ?? (oldest !== undefined ? oldest + this.windowMs : undefined),
        freeResetAvailable: this.opts.entitlement?.(cli) ? true : undefined
      };
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
