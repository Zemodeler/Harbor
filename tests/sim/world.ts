import type { BudgetPeriod } from '../../src/main/budget';
import type { ReportedLimit } from '../../src/main/codexLimits';
import { Rng } from './prng';

/**
 * The TRUE quota of the simulated accounts: what the provider counts, which Harbor never sees directly. Each pool window fills as runs
 * burn quota, rolls over at its reset, and is read by Harbor only through provider readings that lag (`lagMin`) and are rounded to
 * whole percents like the real ones. Use outside Harbor (the owner's own sessions) is added as a mean-reverting random walk.
 */

export const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK = 7 * DAY;
export const SESSION_MS = 5 * HOUR;

export type Cli = 'claude' | 'codex';

export interface PoolSpec {
  pool: string;
  cli: Cli;
  /** The provider's limit name for a per-model pool (ReportedLimit.scope). */
  scope?: string;
  periods: BudgetPeriod[];
  /** Whether the provider reports this pool's windows (Claude's per-model caps are not reported on every plan). */
  reported: boolean;
}

/** The pools of the built-in catalog: claude:all (weekly + 5h), claude:opus (weekly), claude:fable (weekly), codex:all (weekly + 5h). */
export const SIM_POOLS: PoolSpec[] = [
  { pool: 'claude:all', cli: 'claude', periods: ['weekly', 'session'], reported: true },
  { pool: 'claude:opus', cli: 'claude', scope: 'opus', periods: ['weekly'], reported: true },
  { pool: 'claude:fable', cli: 'claude', scope: 'fable', periods: ['weekly'], reported: true },
  { pool: 'codex:all', cli: 'codex', periods: ['weekly', 'session'], reported: true }
];

interface WindowTruth { pool: PoolSpec; period: BudgetPeriod; used: number; resetsAt?: number; peak: number }

export interface ResetRecord { pool: string; period: BudgetPeriod; at: number; usedPct: number }
export interface WallHit { pool: string; period: BudgetPeriod; at: number }

export interface OutsideUse {
  /** Mean use outside Harbor in % of the CLI's account-wide weekly window per hour (working hours only). */
  claudeWeeklyPctPerHour?: number;
  codexWeeklyPctPerHour?: number;
}

export class QuotaWorld {
  readonly windows = new Map<string, WindowTruth>();
  readonly resets: ResetRecord[] = [];
  readonly walls: WallHit[] = [];
  /** Snapshots of every window's used % (for lagged readings). */
  private snaps: Array<{ t: number; used: Map<string, { used: number; resetsAt?: number }> }> = [];
  private outsideRate: Record<Cli, number> = { claude: 0, codex: 0 };

  constructor(start: number, private o: { weeklyResetAt: Record<Cli, number>; pools?: PoolSpec[]; lagMin: number; outside?: OutsideUse; rng: Rng; isWorkHour: (t: number) => boolean }) {
    for (const p of o.pools ?? SIM_POOLS) for (const period of p.periods) {
      this.windows.set(key(p.pool, period), { pool: p, period, used: 0, peak: 0, ...(period === 'weekly' ? { resetsAt: o.weeklyResetAt[p.cli] } : {}) });
    }
    this.snapshot(start);
  }

  /** Rolls windows whose reset passed (recording the true use at the reset), then snapshots. */
  advance(now: number): void { this.roll(now); this.snapshot(now); }

  /** Rolls windows whose reset passed, recording the true use at the reset. */
  roll(now: number): void {
    for (const w of this.windows.values()) {
      if (w.resetsAt === undefined || w.resetsAt > now) continue;
      this.resets.push({ pool: w.pool.pool, period: w.period, at: w.resetsAt, usedPct: w.used });
      w.used = 0; w.peak = 0;
      w.resetsAt = w.period === 'weekly' ? w.resetsAt + WEEK : undefined; // a 5h window starts again at the next use
    }
  }

  /** Quota burned in one window; starts an idle 5h window. Returns the new used %. */
  burn(pool: string, period: BudgetPeriod, pct: number, now: number): number {
    const w = this.windows.get(key(pool, period));
    if (!w) return 0;
    if (w.resetsAt === undefined) w.resetsAt = now + SESSION_MS;
    w.used = Math.min(100, w.used + pct);
    w.peak = Math.max(w.peak, w.used);
    return w.used;
  }

  used(pool: string, period: BudgetPeriod): number { return this.windows.get(key(pool, period))?.used ?? 0; }

  /** Whether any window of these pools is full (the provider refuses work): what a run hitting it records. */
  full(pools: readonly string[]): { pool: string; period: BudgetPeriod } | undefined {
    for (const p of pools) for (const period of ['session', 'weekly'] as const) {
      if (this.used(p, period) >= 100 - 1e-9 && this.windows.has(key(p, period))) return { pool: p, period };
    }
    return undefined;
  }

  wall(pool: string, period: BudgetPeriod, at: number): void { this.walls.push({ pool, period, at }); }

  /** Use outside Harbor for one step: a random walk around the configured mean, only in working hours, on account-wide windows. */
  outside(now: number, stepMs: number, weeklyToSession: Record<Cli, number>): void {
    for (const cli of ['claude', 'codex'] as const) {
      const mean = cli === 'claude' ? this.o.outside?.claudeWeeklyPctPerHour ?? 0 : this.o.outside?.codexWeeklyPctPerHour ?? 0;
      if (mean <= 0) continue;
      const r = this.outsideRate[cli];
      this.outsideRate[cli] = Math.max(0, r + 0.2 * (mean - r) + 0.3 * mean * this.o.rng.normal());
      if (!this.o.isWorkHour(now)) continue;
      const pct = this.outsideRate[cli] * stepMs / HOUR;
      // The owner's own sessions stop at a full window like anything else.
      if (this.used(`${cli}:all`, 'weekly') + pct >= 99.5 || this.used(`${cli}:all`, 'session') + pct * weeklyToSession[cli] >= 99.5) continue;
      this.burn(`${cli}:all`, 'weekly', pct, now);
      this.burn(`${cli}:all`, 'session', pct * weeklyToSession[cli], now);
    }
  }

  /**
   * What the provider reports for `cli` at `now`: the truth `lagMin` ago (interpolated between the step snapshots around it, within one
   * window), rounded to whole percents, stamped `asOf` now.
   */
  reading(cli: Cli, now: number): ReportedLimit[] {
    const at = now - this.o.lagMin * MIN;
    let snap = this.snaps[0]!, next: (typeof this.snaps)[number] | undefined;
    for (const s of this.snaps) if (s.t <= at) snap = s; else { next = s; break; }
    const out: ReportedLimit[] = [];
    for (const w of this.windows.values()) {
      if (w.pool.cli !== cli || !w.pool.reported) continue;
      const k = key(w.pool.pool, w.period);
      let v = snap.used.get(k)!;
      const n = next?.used.get(k);
      if (next && n && n.resetsAt === v.resetsAt && next.t > snap.t) v = { ...v, used: v.used + ((n.used - v.used) * (at - snap.t)) / (next.t - snap.t) };
      // An idle 5h window reads 0% with a reset one window away (the provider's next window would start now).
      const resetsAt = v.resetsAt !== undefined && v.resetsAt > now ? v.resetsAt : w.resetsAt !== undefined && w.resetsAt > now ? w.resetsAt : now + SESSION_MS;
      const used = v.resetsAt !== undefined && v.resetsAt > now ? v.used : 0;
      out.push({ period: w.period, usedPct: Math.round(used), resetsAt, asOf: now, ...(w.pool.scope ? { scope: w.pool.scope } : {}) });
    }
    return out;
  }

  /** Records every window's use at `t` (what a reading `lagMin` later shows). */
  snapshot(t: number): void {
    const used = new Map<string, { used: number; resetsAt?: number }>();
    for (const [k, w] of this.windows) used.set(k, { used: w.used, ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}) });
    this.snaps.push({ t, used });
    // Only the lag matters; keep a few hours.
    const keepFrom = t - Math.max(2 * HOUR, 3 * this.o.lagMin * MIN);
    while (this.snaps.length > 2 && this.snaps[1]!.t < keepFrom) this.snaps.shift();
  }
}

export const key = (pool: string, period: BudgetPeriod) => `${pool}|${period}`;
