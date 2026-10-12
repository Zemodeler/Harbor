import type { AgentRole, CliId, EffortPolicy, LowAllowancePolicy, RolePreference } from '../shared/api';
import type { ResolvedCli } from './clis/discovery';
import type { Effort } from './adapters/types';
import { DEFAULT_CATALOG, TIERS, type CatalogEntry, type Need, type Tier } from './clis/capabilities';
import { WEEK_MS, type Pressure, type UsageLedger, type UsageLevel, type UsageSource } from './usage';

export type Complexity = 'low' | 'medium' | 'high';

export interface RouteRequest {
  role: AgentRole;
  complexity: Complexity;
  /** Explicit tier (concierge, lead). Derived from role and complexity when absent. */
  tier?: Tier;
  /** What the work needs; matched against catalog strengths (duplicates count once, the total is capped). */
  needs?: Need[];
  /** Needs a model must have: one lacking any is skipped (with a note), never scored. */
  required?: Need[];
  effort?: Effort;
  /** CLI that holds this agent's native session; preferred to avoid a context-losing switch. */
  continuity?: CliId;
  /** CLIs already tried and failed for this assignment. Hard skip. */
  exclude?: CliId[];
  /** CLI/model that failed or disappointed but may still be the best left: a soft penalty, not a skip. `model` absent = the whole CLI. */
  avoid?: { cli: CliId; model?: string }[];
  /** CLIs needed by an explicit extension request; restricts the choice when present. */
  requireCli?: CliId;
  /** CLI the user asked for by name. Strong preference, not a requirement: if it is unavailable, another CLI takes over and the reason says so. */
  prefer?: CliId;
  /** Retry of failed or rejected work: worth the highest effort. */
  retry?: boolean;
  /** `effort` is a deliberate choice (the concierge, a user's /deep) that neither the effort policy nor a low allowance may shift. */
  fixedEffort?: boolean;
  /**
   * A resumed session: its last model and effort. While that model is available, the session never moves to a cheaper model or
   * another model of the same tier on that CLI (it would rewrite the prompt cache), may move UP a tier when the work wants it,
   * and keeps its effort (a flip invalidates the cache too) unless `fixedEffort` asks for one.
   */
  keep?: { cli: CliId; model: string; effort?: Effort };
  /** A helper that would fan out (planner, implementer, reviewer): not started on a CLI at 'low' allowance when another CLI is healthy. */
  fanOut?: boolean;
  /** The CLI this session left on its last move and when (epoch ms): going straight back costs W.switchBack for W.switchBackMs (headroom routing only; needs `now`). */
  left?: { cli: CliId; at: number };
}

/** User routing settings already resolved for the project (see effectiveSettings in store.ts). Absent fields keep the defaults. */
export interface RoutingPolicy {
  /** Per CLI, the catalog models that may be picked; absent or empty = all. */
  allowedModels?: Record<CliId, string[]>;
  /** The preference for this request's role. */
  preference?: RolePreference;
  effortPolicy?: EffortPolicy;
  /**
   * What a model at low allowance does.
   * Absent (the default): headroom routing. Each model is judged by the remaining share of its tightest window (5h or weekly,
   *   pace-aware, see headroomOf); a large gap in headroom (about W.switchGap points) moves even a session that holds a CLI,
   *   small gaps never do, and low headroom steps work one tier cheaper where it can (see `cheaper` in evaluate).
   * 'reduceEffort' (explicit): stay put, spend less. Usage never outweighs continuity (its penalty is capped below it), so a
   *   session that holds a CLI keeps it; the effort steps down instead (see finalEffort).
   * 'switch' (explicit): steer away. A low model also takes an extra penalty, so any healthy option of similar fit wins; when
   *   nothing healthier exists the effort still steps down.
   */
  lowAllowance?: LowAllowancePolicy;
  /** Percent of allowance kept free: a model at or above 100 - reserve % used is skipped. */
  reserve?: number;
}

/** One reason a CLI or model was not considered. */
export interface RouteSkip {
  cli: CliId;
  model?: string;
  why: string;
  /** Epoch ms when it may be usable again, when known (usage resetsAt). */
  until?: number;
  /** True for skips that clear by themselves (allowance, reserve); false for configuration. */
  transient?: boolean;
}

export interface ScoredCandidate {
  cli: CliId;
  model: string;
  score: number;
  /** Points per term; score = ROUTING_WEIGHTS.base + the sum. */
  terms: Record<string, number>;
  /** The windows this model was judged on (remaining percent, pace, source). */
  headroom?: { remainingPct: number; windows: Array<{ period: 'session' | 'weekly'; scope?: string; remainingPct: number; resetsAt?: number; projectedPct?: number; source: UsageSource }> };
}

export interface RouteDecision {
  cli: CliId;
  model: string;
  effort: Effort;
  reason: string;
  /** The best three candidates with their per-term breakdown, best first. */
  scored?: ScoredCandidate[];
  /** Score lead over the runner-up (undefined with a single candidate). */
  margin?: number;
  /** The runner-up scored the same; the tie-break decided. */
  tied?: boolean;
  /** The chosen model is a lower tier than wanted (the wanted one was unavailable or lost on score). */
  degraded?: { wantedTier: Tier; gotTier: Tier };
  skipped?: RouteSkip[];
}

export interface RouterInput {
  clis: ResolvedCli[];
  ledger: UsageLedger;
  enabled: (cli: CliId) => boolean;
  /** True when Harbor has a headless adapter for the CLI (detected-only CLIs are never assigned work). */
  hasAdapter: (cli: CliId) => boolean;
  /** Agents currently running per CLI, to spread parallel work. */
  load: (cli: CliId) => number;
  /** Adapters whose headless flow is verified against a real install; used only as a tie-breaker. */
  verified?: (cli: CliId) => boolean;
  /** Capability catalog; defaults to the built-in one. */
  catalog?: CatalogEntry[];
  policy?: RoutingPolicy;
  /** Recent outcomes per "cli/model". Failures cost a bounded, time-decayed penalty (needs `now` to decay). */
  history?: Record<string, { runs: number; fails: number; lastFailAt?: number }>;
  /** Clock for history decay; route() itself never reads the wall clock. */
  now?: () => number;
}

/**
 * Every constant the score is made of. The comments are claims; tests/router.test.ts asserts each of them.
 * Score = base - usage - load - tier miss + needs - cost - auth + continuity + requested + verified + preferred
 *         - lowSwitch - avoid - history + pacing - switchBack.
 * `usage` is the headroom penalty unless the policy sets lowAllowance explicitly (then the older percent-used curve).
 */
export const ROUTING_WEIGHTS = {
  base: 100,
  /**
   * Allowance penalty by percent used, linear between points. Flat under 10% (noise: a single run must not
   * reorder fresh CLIs), then continuous, so there is no cliff at a level boundary (80% costs what 79% costs, plus
   * a sliver). At most 0.84 points per percent: one run of a 10-run budget moves the score by < continuity.
   */
  usageCurve: [[10, 0], [50, 14], [80, 28], [99, 44]] as ReadonlyArray<readonly [number, number]>,
  /**
   * Headroom routing (lowAllowance absent). Points lost by the EFFECTIVE remaining percent (100 - used) of the tightest window,
   * linear between [remaining, points] knots. Flat above 95% remaining (noise: one run must not reorder fresh CLIs), then shallow down to 60% (about 0.17 points per percent: enough to
   * spread parallel work between equal CLIs, far below the stickiness, so a comfortable window never moves a session). 25% remaining costs 22, 10% costs 44:
   * against a CLI with 90% left that is more than the stickiness below, so the work moves; 55% against 45% costs 3 points, so it does not.
   */
  headroomCurve: [[95, 0], [60, 6], [40, 12], [25, 22], [10, 44], [0, 55]] as ReadonlyArray<readonly [number, number]>,
  /** The second-tightest window counts for this share of its own points (a healthy 5h window does not hide a nearly spent week). */
  headroomSecondShare: 0.25,
  /** The whole headroom term never exceeds this: below `requested`, and an explicit request waives it anyway. */
  headroomCap: 55,
  /** A reported window whose pace overshoots 100% before its reset keeps remaining * (100 / projected), but never less than this share. */
  paceFloor: 0.5,
  /** A 5h window that resets within this is not paced down: work that must run now is limited by what is left now, not by a projection past the reset. */
  sessionPaceMinMs: 30 * 60 * 1000,
  /** Headroom routing: what a session's CLI is worth over another (replaces `continuity`). Another CLI must beat it by this many points of headroom. Below `preferred` so a settings preference still wins over it. */
  switchGap: 28,
  /** Going straight back to the CLI a session just left costs this, for `switchBackMs` (anti ping-pong). Exhaustion still forces a move: exhausted CLIs are skipped, not scored. */
  switchBack: 12,
  switchBackMs: 30 * 60 * 1000,
  /** Below this effective remaining percent a CLI is "low on headroom": work that can spare it goes one tier cheaper and the effort steps down. */
  lowHeadroomPct: 25,
  /** A level reached through pace (reported windows only) costs at least this. Equals the curve at the level's threshold. */
  levelFloor: { plenty: 0, limited: 14, low: 28, exhausted: 1000 } as Record<UsageLevel, number>,
  /** Harbor's own count of its runs is a guess about the provider's quota: its penalty counts for this share. */
  estimatedUsageFactor: 0.5,
  /** With lowAllowance 'reduceEffort' the usage penalty never exceeds this: below continuity, so a held session is not moved by allowance alone. */
  reduceEffortUsageCap: 20,
  loadPerAgent: 5,
  /** Overspending a tier costs a little per step; an underpowered model costs more. */
  tierOver: 8,
  tierUnder: 25,
  /** A met need is worth `needHit`; a missing one costs `needMiss`, less than overspending a tier, or one unmet need buys the strongest model. */
  needHit: 4,
  needMiss: 4,
  /** The whole needs term stays within +-needCap: stated needs refine a choice, they never beat a tier step (tierUnder). */
  needCap: 12,
  authUnknown: 15,
  continuity: 25,
  /** A CLI the user asked for by name in this message: stronger than a standing settings preference. */
  requested: 60,
  /** A settings preference outweighs continuity and one tier step either way; it is a bonus, never a bypass of the hard skips. */
  preferred: 30,
  verified: 2,
  /** With lowAllowance 'switch', a model at low allowance loses to any healthy option of similar fit. */
  lowSwitch: 40,
  /** A CLI/model to avoid (a retry of work it failed): beats continuity, loses to an explicit request. */
  avoid: 30,
  /** History: per recent failure, capped at historyMax (below requested and the avoid penalty cannot be doubled by it). */
  historyPerFail: 8,
  historyMax: 20,
  historyHalfLifeMs: 6 * 60 * 60 * 1000,
  /**
   * Weekly pacing (replaces the old small 'expiring' bonus; the term is called `pacing`). Allowance not used by the weekly reset is lost,
   * so a CLI is measured against a linear budget: ideal used% = elapsed share of the 7 days. Only for a weekly window whose reset time
   * is KNOWN (reported, or estimated against a calibrated budget; an uncalibrated estimate is ignored). Needs `now`.
   *   surplus = ideal - used. Positive: underspent, and that much of the week's allowance is lost if nothing changes.
   * Spend (surplus > 0): +spendCap * min(1, surplus / spendFullSurplusPct) * urgency * trust * capacity.
   *   urgency follows the hours to the reset along `urgencyKnots` [hours left, urgency]: nothing beyond 4 days, 0.25 at 48h, 0.9 at 12h, 1 at the reset.
   *   capacity: the tightest 5h-type window of the CLI, 0 at lowHeadroomPct remaining, 1 at spendCapacityFullPct (capacity NOW still binds).
   * Conserve (surplus < 0, at least paceMinElapsed of the week gone): -conserveCap * min(1, deficit / conserveFullDeficitPct) * min(1, hoursLeft / conserveFullHours) * trust
   *   (more time left to recover = stronger).
   * trust: 1 for a reported reading at most staleAfterMs old, falling to staleFloor at staleFullMs; an estimate also counts estimatedUsageFactor.
   * The spend bonus is 0 for a model below the wanted tier (a weaker model is never bought with it) and the term is 0 for a CLI the user named.
   */
  spendCap: 35,
  spendFullSurplusPct: 40,
  urgencyKnots: [[96, 0], [48, 0.25], [12, 0.9], [0, 1]] as ReadonlyArray<readonly [number, number]>,
  spendCapacityFullPct: 50,
  conserveCap: 20,
  conserveFullDeficitPct: 40,
  conserveFullHours: 72,
  paceMinElapsed: 0.1,
  staleAfterMs: 3 * 60 * 60 * 1000,
  staleFullMs: 24 * 60 * 60 * 1000,
  staleFloor: 0.25,
  /** Spend freely: reported fresh reading, surplus at least spendUpMinSurplusPct, reset within spendUpWithinMs, capacity at least spendUpMinCapacityPct: standard work (and low work, while spendUpLowWork) goes one tier stronger on that CLI and one effort step up. Never planners, retries or high work (already strongest tier). */
  spendUpMinSurplusPct: 30,
  spendUpWithinMs: 36 * 60 * 60 * 1000,
  spendUpLowWork: true,
  spendUpMinCapacityPct: 50,
  /** Conserve down: reported fresh reading, deficit at least conserveDownMinDeficitPct, at least conserveDownMinMs to the reset: flexible work goes one tier cheaper and one effort step down. */
  conserveDownMinDeficitPct: 20,
  conserveDownMinMs: 24 * 60 * 60 * 1000,
  /** Scores are compared at this resolution (tenths) so float noise cannot decide a tie. */
  scoreResolution: 10
} as const;

const W = ROUTING_WEIGHTS;
const tenth = (n: number) => Math.round(n * W.scoreResolution) / W.scoreResolution;

/** Points lost to allowance used. Piecewise linear in `pct`, at least the level's floor; scaled down for Harbor-only estimates. */
export function usagePenalty(pct: number, level: UsageLevel, source: UsageSource | undefined = 'estimated'): number {
  const c = W.usageCurve;
  let curve = 0;
  if (pct >= c[c.length - 1][0]) curve = c[c.length - 1][1];
  else for (let i = 1; i < c.length; i++) {
    if (pct <= c[i][0]) { const [x0, y0] = c[i - 1], [x1, y1] = c[i]; curve = pct <= x0 ? y0 : y0 + ((pct - x0) / (x1 - x0)) * (y1 - y0); break; }
  }
  const raw = Math.max(curve, W.levelFloor[level]);
  return source === 'reported' ? raw : raw * W.estimatedUsageFactor;
}

export interface HeadroomWindow {
  period: 'session' | 'weekly'; scope?: string; usedPct: number; remainingPct: number;
  /** Remaining after discounting an estimate (counts for W.estimatedUsageFactor) and an overshooting pace. This is what binds. */
  effectiveRemainingPct: number;
  resetsAt?: number; projectedPct?: number; source: UsageSource; paced: boolean;
}
export interface Headroom {
  /** The smallest effective remaining percent over the windows: the binding constraint. */
  remainingPct: number;
  windows: HeadroomWindow[];
  /** Points lost, from the curve (see ROUTING_WEIGHTS.headroomCurve). */
  penalty: number;
}

function curvePoints(remaining: number): number {
  const c = W.headroomCurve;
  if (remaining >= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (remaining >= c[i][0]) { const [x0, y0] = c[i - 1], [x1, y1] = c[i]; return y1 + ((remaining - x1) / (x0 - x1)) * (y0 - y1); }
  }
  return c[c.length - 1][1];
}

/**
 * How much room a model has: BOTH windows count and the tighter binds. An estimate (Harbor's own run count) is discounted like
 * the old usage penalty (used% counts for half); a reported window that would overshoot before its reset keeps only part of what is
 * left, except a 5h window about to reset (capacity now is what matters). A weekly window with plenty left and a distant reset is
 * simply abundant: nothing is added for it, the others are just not worth leaving it for. Pure; `now` only gates the 5h reset rule.
 */
export function headroomOf(p: Pressure, now?: number): Headroom {
  const src: Array<NonNullable<Pressure['windows']>[number]> = p.windows?.length
    ? p.windows
    : [{ period: 'session', usedPct: p.pct, remainingPct: 100 - p.pct, resetsAt: p.resetsAt, projectedPct: p.projectedPct, source: p.source ?? 'estimated' }];
  const windows = src.map((w): HeadroomWindow => {
    let eff = 100 - w.usedPct * (w.source === 'reported' ? 1 : W.estimatedUsageFactor);
    let paced = false;
    if (w.projectedPct !== undefined && w.projectedPct > 100) {
      const soon = w.period === 'session' && now !== undefined && w.resetsAt !== undefined && w.resetsAt - now <= W.sessionPaceMinMs;
      if (!soon) { eff *= Math.max(W.paceFloor, 100 / w.projectedPct); paced = true; }
    }
    return { period: w.period, ...(w.scope !== undefined ? { scope: w.scope } : {}), usedPct: w.usedPct, remainingPct: w.remainingPct, effectiveRemainingPct: Math.max(0, eff), resetsAt: w.resetsAt, projectedPct: w.projectedPct, source: w.source, paced };
  });
  const eff = windows.map((w) => w.effectiveRemainingPct).sort((a, b) => a - b);
  const penalty = Math.min(W.headroomCap, curvePoints(eff[0] ?? 100) + (eff.length > 1 ? W.headroomSecondShare * curvePoints(eff[1]!) : 0));
  return { remainingPct: eff[0] ?? 100, windows, penalty };
}

const span = (ms: number) => (ms >= 3_600_000 ? `${Math.round(ms / 360_000) / 10}h` : `${Math.max(1, Math.round(ms / 60_000))}m`);

/** Plain words for one model's windows, e.g. "5h 12% used, weekly 8% used (pace → ~210% at reset: runs out before it)". */
export function describeHeadroom(h: Headroom, now?: number): string {
  return h.windows.map((w) => {
    const name = `${w.scope ? `${w.scope} ` : ''}${w.period === 'session' ? '5h' : 'weekly'}`;
    const bits = [`${w.usedPct}% used${w.source === 'estimated' ? ' (est.)' : ''}`];
    if (w.paced) bits.push(`pace → ~${w.projectedPct}% at reset: runs out before it`);
    if (now !== undefined && w.resetsAt !== undefined && w.resetsAt > now) bits.push(`resets in ${span(w.resetsAt - now)}`);
    return `${name} ${bits[0]}${bits.length > 1 ? ` (${bits.slice(1).join(', ')})` : ''}`;
  }).join(', ');
}

export interface WeeklyPace {
  scope?: string;
  usedPct: number;
  /** Share of the 7 days already gone (0..1), from the reset time. */
  elapsedFrac: number;
  /** Linear budget: 100 * elapsedFrac. */
  idealUsedPct: number;
  /** ideal - used: positive = underspent (that much of the week's allowance is lost if nothing changes), negative = overspent. */
  surplusPct: number;
  hoursToReset: number;
  resetsAt: number;
  source: UsageSource;
  /** 0..1: how much the reset time counts for (see ROUTING_WEIGHTS.urgencyKnots). */
  urgency: number;
  /** 0..1: 1 for a fresh reported reading; less for an old one or an estimate. */
  trust: number;
  stale: boolean;
  ageMs?: number;
  /** Effective remaining percent of the tightest 5h-type window of the CLI (100 when none is known): capacity now. */
  capacityPct: number;
  /** Score points: positive = spend this CLI's surplus, negative = conserve. 0 when not applicable. */
  points: number;
}

/** Urgency of a reset `hours` away: linear between the knots, nothing far out, 1 at the reset. */
export function burnUrgency(hours: number): number {
  const k = W.urgencyKnots;
  if (hours >= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (hours >= k[i][0]) { const [x0, y0] = k[i - 1], [x1, y1] = k[i]; return y1 + ((hours - x1) / (x0 - x1)) * (y0 - y1); }
  }
  return k[k.length - 1][1];
}

/**
 * Where a CLI stands against a linear weekly budget, from the weekly window with a KNOWN reset time (reported, or estimated against
 * a calibrated budget; anything else, a reset in the past or one further away than a week is ignored: nothing is invented).
 * Of several weekly windows (account-wide, model-scoped) the one with the least surplus binds. Pure; needs `now`.
 */
export function weeklyPaceOf(p: Pressure, now?: number): WeeklyPace | undefined {
  if (now === undefined) return undefined;
  const sess = (p.windows ?? []).filter((w) => w.period === 'session').map((w) => 100 - w.usedPct * (w.source === 'reported' ? 1 : W.estimatedUsageFactor));
  const capacityPct = sess.length ? Math.max(0, Math.min(...sess)) : 100;
  const capacity = Math.max(0, Math.min(1, (capacityPct - W.lowHeadroomPct) / (W.spendCapacityFullPct - W.lowHeadroomPct)));
  let best: WeeklyPace | undefined;
  for (const w of p.windows ?? []) {
    if (w.period !== 'weekly' || w.resetsAt === undefined || !(w.source === 'reported' || w.calibrated === true)) continue;
    const left = w.resetsAt - now;
    if (left <= 0 || left > WEEK_MS * 1.02) continue;
    const elapsedFrac = Math.max(0, Math.min(1, 1 - left / WEEK_MS));
    const surplusPct = elapsedFrac * 100 - w.usedPct;
    const hoursToReset = left / 3_600_000;
    const ageMs = w.source === 'reported' && w.asOf !== undefined ? Math.max(0, now - w.asOf) : undefined;
    const fresh = ageMs === undefined || ageMs <= W.staleAfterMs ? 1
      : Math.max(W.staleFloor, 1 - (1 - W.staleFloor) * (ageMs - W.staleAfterMs) / (W.staleFullMs - W.staleAfterMs));
    const trust = (w.source === 'reported' ? 1 : W.estimatedUsageFactor) * fresh;
    const urgency = burnUrgency(hoursToReset);
    let points = 0;
    if (surplusPct > 0) points = W.spendCap * Math.min(1, surplusPct / W.spendFullSurplusPct) * urgency * trust * capacity;
    else if (surplusPct < 0 && elapsedFrac >= W.paceMinElapsed) points = -W.conserveCap * Math.min(1, -surplusPct / W.conserveFullDeficitPct) * Math.min(1, hoursToReset / W.conserveFullHours) * trust;
    const pace: WeeklyPace = {
      ...(w.scope !== undefined ? { scope: w.scope } : {}), usedPct: w.usedPct, elapsedFrac, idealUsedPct: elapsedFrac * 100, surplusPct, hoursToReset, resetsAt: w.resetsAt,
      source: w.source, urgency, trust, stale: ageMs !== undefined && ageMs > W.staleAfterMs, ...(ageMs !== undefined ? { ageMs } : {}), capacityPct, points: tenth(points)
    };
    if (!best || pace.surplusPct < best.surplusPct) best = pace;
  }
  return best;
}

/** Plain words, e.g. "claude weekly: 35% used, 82% of the week elapsed, resets in 31h → ~47% of the week's allowance would be lost: spending it (+21)". */
export function describePace(cliId: CliId, z: WeeklyPace): string {
  const bits = [`${Math.round(z.usedPct)}% used`, `${Math.round(z.elapsedFrac * 100)}% of the week elapsed`, `resets in ${span(z.hoursToReset * 3_600_000)}`];
  const notes: string[] = [];
  if (z.source === 'estimated') notes.push(`estimate, counts ${Math.round(W.estimatedUsageFactor * 100)}%`);
  if (z.stale && z.ageMs !== undefined) notes.push(`reading ${span(z.ageMs)} old, trusted ${Math.round(z.trust * 100)}%`);
  const lead = `${cliId} ${z.scope ? `${z.scope} ` : ''}weekly: ${bits.join(', ')}${notes.length ? ` (${notes.join('; ')})` : ''}`;
  const pts = (n: number) => `${n > 0 ? '+' : ''}${Math.round(n * 10) / 10}`;
  if (z.surplusPct > 0) return `${lead} → ~${Math.round(z.surplusPct)}% of the week's allowance would be lost${z.points >= 0.5 ? `: spending it (${pts(z.points)})` : ''}`;
  if (z.surplusPct < 0) return `${lead} → ${Math.round(-z.surplusPct)} points over the weekly pace${z.points <= -0.5 ? `: conserving (${pts(z.points)})` : ''}`;
  return `${lead} → on the weekly pace`;
}

/** A planner follows complexity like anyone else (strong only for high); it used to be strong always, which spent Opus on every plan. */
export function tierFor(role: AgentRole, c: Complexity): Tier {
  if (c === 'high') return 'strong';
  if (role === 'planner') return 'standard';
  return c === 'low' ? 'cheap' : 'standard';
}

const tierDistance = (want: Tier, have: Tier) => Math.abs(TIERS.indexOf(have) - TIERS.indexOf(want));

function tierPenalty(want: Tier, have: Tier): number {
  const d = TIERS.indexOf(have) - TIERS.indexOf(want);
  return d === 0 ? 0 : d > 0 ? W.tierOver * d : -W.tierUnder * d;
}

/** Needs are a set (a lead repeating one must not double it) and the sum is capped. */
function needsFit(needs: Need[] | undefined, e: CatalogEntry): number {
  if (!needs?.length) return 0;
  const sum = [...new Set(needs)].reduce((s, n) => s + (e.strengths.includes(n) ? W.needHit : -W.needMiss), 0);
  return Math.max(-W.needCap, Math.min(W.needCap, sum));
}

/**
 * Hard work already gets a stronger model; high effort on top doubles the cost. Only planners on hard problems and
 * retries of failed work get high effort; everything else tops out at medium.
 */
export function effortFor(role: AgentRole, c: Complexity, retry = false): Effort {
  if (retry) return 'high';
  if (role === 'planner') return c === 'high' ? 'high' : 'medium';
  return c === 'high' ? 'medium' : c;
}

const stepDown = (e: Effort): Effort => (e === 'high' ? 'medium' : 'low');
const stepUp = (e: Effort): Effort => (e === 'low' ? 'medium' : 'high');
const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2 };

/** Applies the effort policy. Conserve never weakens a retry: that is the verification a tight budget must keep. */
export function applyEffortPolicy(e: Effort, policy: EffortPolicy | undefined, retry = false): Effort {
  if (policy === 'conserve' && !retry) return stepDown(e);
  if (policy === 'quality') return stepUp(e);
  return e;
}

export interface EffortInput {
  role: AgentRole;
  complexity: Complexity;
  /** The effort asked for; derived from role and complexity when absent. */
  requested?: Effort;
  fixed?: boolean;
  retry?: boolean;
  policy?: EffortPolicy;
  /** The chosen model's allowance is low. */
  allowanceLow?: boolean;
}

/**
 * The one place effort is decided. Precedence, strongest first:
 *   1. fixed (a deliberate choice: concierge, /deep): returned untouched.
 *   2. retry: high. Neither policy nor a low allowance weakens the verification of failed work.
 *   3. low allowance: one step down from the base; wins over a policy that would raise it (quality), and is not
 *      stepped twice with conserve (the lower of the two applies).
 *   4. effort policy (conserve/quality/adaptive) on the base.
 * Pure; `notes` explain every change for the decision's reason.
 */
export function finalEffort(i: EffortInput): { effort: Effort; notes: string[] } {
  const base = i.requested ?? effortFor(i.role, i.complexity);
  if (i.fixed) return { effort: base, notes: [] };
  if (i.retry) {
    const notes = base !== 'high' ? [`effort ${base} → high: retry of failed work`] : [];
    if (i.allowanceLow) notes.push('retry keeps its effort despite low allowance');
    return { effort: 'high', notes };
  }
  const notes: string[] = [];
  let effort = base;
  if (i.policy && i.policy !== 'adaptive') {
    const shifted = applyEffortPolicy(base, i.policy);
    if (shifted !== base) notes.push(`effort ${base} → ${shifted}: ${i.policy} policy`);
    effort = shifted;
  }
  if (i.allowanceLow) {
    const lowered = stepDown(base);
    if (EFFORT_RANK[lowered] < EFFORT_RANK[effort]) { effort = lowered; notes.push('effort lowered: allowance low'); }
  }
  return { effort, notes };
}

interface Cand {
  cli: ResolvedCli; entry: CatalogEntry; index: number;
  score: number; terms: Record<string, number>;
  level: UsageLevel; pct: number; source: UsageSource; projected?: number;
  load: number; verified: boolean;
  hr: Headroom;
  /** This model's tier was judged against a tier one step cheaper: headroom was low, or (`by: 'pace'`) the CLI is over its weekly pace. */
  shifted?: { from: Tier; to: Tier; by?: 'pace' };
  /** Weekly pace of the window this model was judged on (see weeklyPaceOf); absent when its reset time is unknown. */
  pace?: WeeklyPace;
  /** CLI-level weekly decisions: spend the surplus (one tier and effort step up) or conserve (effort step down). `tierTo` when a model of that tier was available. */
  spend?: { dir: 'up' | 'down'; pace: WeeklyPace; tierTo?: Tier };
}

interface Evaluation { want: Tier; cands: Cand[]; skipped: RouteSkip[]; notes: string[] }

function failurePenalty(inp: RouterInput, cli: CliId, model: string): number {
  const h = inp.history?.[`${cli}/${model}`];
  if (!h || h.fails <= 0) return 0;
  const decay = inp.now && h.lastFailAt !== undefined ? 0.5 ** (Math.max(0, inp.now() - h.lastFailAt) / W.historyHalfLifeMs) : 1;
  return Math.min(W.historyMax, W.historyPerFail * h.fails * decay);
}

/** Eligibility and scoring, shared by route() and explainNoRoute() so they can never disagree. */
function evaluate(req: RouteRequest, inp: RouterInput): Evaluation {
  const skipped: RouteSkip[] = [], notes: string[] = [];
  const skip = (cli: CliId, why: string, extra: { model?: string; until?: number; transient?: boolean } = {}) => {
    skipped.push({ cli, why, ...extra });
    notes.push(`${cli}${extra.model ? `/${extra.model}` : ''} skipped: ${why}`);
  };
  const catalog = inp.catalog ?? DEFAULT_CATALOG;
  const want = req.tier ?? tierFor(req.role, req.complexity);
  const cands: Cand[] = [];
  const pol = inp.policy ?? {};
  const reserve = pol.reserve ?? 0, pref = pol.preference;
  const prefersCli = (id: CliId) => !!pref?.cli && pref.cli === id;
  // A model preference without a CLI applies to that model name on any CLI.
  const prefersModel = (id: CliId, model: string) => !!pref?.model && pref.model === model && (!pref.cli || pref.cli === id);
  const avoids = (id: CliId, model: string) => !!req.avoid?.some((a) => a.cli === id && (a.model === undefined || a.model === model));
  const required = [...new Set(req.required ?? [])];
  // Absent = headroom routing; an explicit 'reduceEffort' or 'switch' keeps its older meaning (percent-used curve).
  const headroomMode = pol.lowAllowance === undefined;
  const reduce = pol.lowAllowance === 'reduceEffort', steer = pol.lowAllowance === 'switch';
  const now = inp.now?.();
  const flexible = !req.retry && req.role !== 'planner' && req.complexity !== 'high' && want !== 'strong' && TIERS.indexOf(want) > 0;
  const lowerTier = TIERS[Math.max(0, TIERS.indexOf(want) - 1)]!;
  const wanted = [...new Set(req.needs ?? [])];

  for (const c of inp.clis) {
    if (!c.installed) { skip(c.id, 'not installed'); continue; }
    if (!inp.hasAdapter(c.id)) { skip(c.id, 'no headless adapter yet'); continue; }
    if (!inp.enabled(c.id)) { skip(c.id, 'disabled in settings'); continue; }
    if (c.authState === 'signedOut') { skip(c.id, 'login required'); continue; }
    if (req.exclude?.includes(c.id)) { skip(c.id, 'failed earlier for this task'); continue; }
    if (req.requireCli && req.requireCli !== c.id) { skip(c.id, `task needs ${req.requireCli}`); continue; }
    const entries = catalog.filter((e) => e.cli === c.id);
    // A CLI missing from the catalog is still usable with its default model (capabilities unknown: it has no strengths).
    const known: CatalogEntry[] = entries.length ? entries : [{ cli: c.id, model: 'default', tier: 'standard', strengths: [] }];
    // Allowed models only narrow the catalog: a model the catalog does not know is never invented here.
    const allowed = pol.allowedModels?.[c.id];
    const usable = allowed?.length ? known.filter((e) => allowed.includes(e.model)) : known;
    if (!usable.length) { skip(c.id, 'no allowed model (settings)'); continue; }
    // Low headroom: judge the work against one tier cheaper on this CLI, when a model of that tier covers what it needs (never for retries, planners or high work, and not for a resumed session, which keeps its model).
    const cliHr = headroomMode && flexible && !(req.keep && req.keep.cli === c.id) ? headroomOf(inp.ledger.pressure(c.id), now) : undefined;
    const fitsNeeds = (e: CatalogEntry) => !required.some((n) => !e.strengths.includes(n)) && wanted.every((n) => e.strengths.includes(n));
    const lowHere = !!cliHr && cliHr.remainingPct < W.lowHeadroomPct;
    // Weekly pacing decisions (reported, fresh readings only; never for a CLI the user named, a retry, a planner, high work or a resumed session on this CLI).
    const eligible = !req.retry && req.role !== 'planner' && req.complexity !== 'high' && want !== 'strong';
    const cliPace = headroomMode && eligible && now !== undefined && req.prefer !== c.id && !(req.keep && req.keep.cli === c.id) ? weeklyPaceOf(inp.ledger.pressure(c.id), now) : undefined;
    const sure = !!cliPace && cliPace.source === 'reported' && !cliPace.stale;
    const upperTier = TIERS[Math.min(TIERS.length - 1, TIERS.indexOf(want) + 1)]!;
    const spendUp = sure && cliPace!.surplusPct >= W.spendUpMinSurplusPct && cliPace!.hoursToReset * 3_600_000 <= W.spendUpWithinMs
      && cliPace!.capacityPct >= W.spendUpMinCapacityPct && (W.spendUpLowWork || req.complexity !== 'low') && pol.effortPolicy !== 'conserve';
    const conserveDown = sure && flexible &&-cliPace!.surplusPct >= W.conserveDownMinDeficitPct && cliPace!.points < 0 && cliPace!.hoursToReset * 3_600_000 >= W.conserveDownMinMs && !lowHere;
    // The stronger model must itself be in good standing: not exhausted and not over its own weekly pace.
    const upperOk = spendUp && upperTier !== want && usable.some((e) => {
      if (e.tier !== upperTier || !fitsNeeds(e)) return false;
      const pe = inp.ledger.pressure(c.id, e.model);
      return pe.level !== 'exhausted' && (weeklyPaceOf(pe, now)?.surplusPct ?? 0) >= 0;
    });
    const cheaper = (lowHere || conserveDown) && usable.some((e) => e.tier === lowerTier && fitsNeeds(e));
    const wantHere = cheaper ? lowerTier : upperOk ? upperTier : want;
    const spend: Cand['spend'] = spendUp ? { dir: 'up', pace: cliPace!, ...(upperOk ? { tierTo: upperTier } : {}) } : conserveDown ? { dir: 'down', pace: cliPace!, ...(cheaper ? { tierTo: lowerTier } : {}) } : undefined;
    for (const entry of usable) {
      const missing = required.find((n) => !entry.strengths.includes(n));
      if (missing) { skip(c.id, `lacks required ${missing}`, { model: entry.model }); continue; }
      // Per entry: Opus or Fable can be capped while Sonnet on the same account is fine.
      const p = inp.ledger.pressure(c.id, entry.model), level = p.level, source: UsageSource = p.source ?? 'estimated';
      if (level === 'exhausted') { skip(c.id, 'allowance exhausted or rate limited', { model: entry.model, until: p.resetsAt, transient: true }); continue; }
      if (reserve > 0 && p.pct >= 100 - reserve) { skip(c.id, `~${p.pct}% used, inside the ${reserve}% subscription reserve`, { model: entry.model, until: p.resetsAt, transient: true }); continue; }
      const hr = headroomOf(p, now);
      let usage: number;
      // A CLI the user asked for by name is not judged on headroom (only exhaustion, above, can stop it).
      if (headroomMode) usage = req.prefer === c.id ? 0 : hr.penalty;
      else { usage = usagePenalty(p.pct, level, source); if (reduce) usage = Math.min(usage, W.reduceEffortUsageCap); }
      const verified = !!inp.verified?.(c.id);
      // Weekly pacing: judged on this model's own weekly windows. A CLI the user named is not judged on it; a model below the wanted tier is never bought with the spend bonus.
      const pace = headroomMode && req.prefer !== c.id ? weeklyPaceOf(p, now) : undefined;
      const pacing = pace ? (pace.points > 0 && TIERS.indexOf(entry.tier) < TIERS.indexOf(want) ? 0 : pace.points) : 0;
      const terms: Record<string, number> = {
        usage: -usage,
        load: -W.loadPerAgent * inp.load(c.id),
        tier: -tierPenalty(wantHere, entry.tier),
        needs: needsFit(req.needs, entry),
        cost: -(entry.cost ?? 0),
        auth: c.authState === 'unknown' ? -W.authUnknown : 0, // sign-in unverified: usable, but prefer confirmed ones
        continuity: req.continuity === c.id ? (headroomMode ? W.switchGap : W.continuity) : 0,
        switchBack: headroomMode && req.left?.cli === c.id && now !== undefined && now - req.left.at < W.switchBackMs ? -W.switchBack : 0,
        requested: req.prefer === c.id ? W.requested : 0,
        verified: verified ? W.verified : 0,
        preferred: (prefersCli(c.id) ? W.preferred : 0) + (prefersModel(c.id, entry.model) ? W.preferred : 0),
        lowSwitch: level === 'low' && steer ? -W.lowSwitch : 0,
        avoid: avoids(c.id, entry.model) ? -W.avoid : 0,
        history: -failurePenalty(inp, c.id, entry.model),
        pacing
      };
      const score = W.base + Object.values(terms).reduce((a, b) => a + b, 0);
      const index = catalog.indexOf(entry);
      cands.push({ cli: c, entry, index: index < 0 ? catalog.length : index, score, terms, level, pct: p.pct, source, projected: p.projectedPct, load: inp.load(c.id), verified, hr, ...(cheaper ? { shifted: { from: want, to: lowerTier, ...(lowHere ? {} : { by: 'pace' as const }) } } : {}), ...(pace ? { pace } : {}), ...(spend ? { spend } : {}) });
    }
  }

  // A resumed session keeps its model while that model is available: nothing cheaper and no sibling of the same tier on its CLI.
  if (req.keep) {
    const k = req.keep;
    const kept = cands.find((c) => c.cli.id === k.cli && c.entry.model === k.model);
    if (kept) {
      const keptRank = TIERS.indexOf(kept.entry.tier);
      for (let i = cands.length - 1; i >= 0; i--) {
        const c = cands[i]!;
        if (c.cli.id !== k.cli || c === kept) continue;
        const rank = TIERS.indexOf(c.entry.tier);
        if (rank < keptRank || (rank === keptRank && c.entry.model !== k.model)) {
          skip(c.cli.id, `session already runs on ${k.model} (a different model would rewrite its prompt cache)`, { model: c.entry.model });
          cands.splice(i, 1);
        }
      }
    }
  }
  // Fan-out helpers stay off a CLI at 'low' allowance while another CLI is healthy: the whole job goes there instead.
  if (req.fanOut) {
    const healthy = cands.filter((c) => c.level === 'plenty' || c.level === 'limited');
    for (let i = cands.length - 1; i >= 0; i--) {
      const c = cands[i]!;
      if (c.level === 'low' && healthy.some((h) => h.cli.id !== c.cli.id)) {
        skip(c.cli.id, `allowance low (~${c.pct}% used): ${req.role} helpers are not started on it while ${healthy.find((h) => h.cli.id !== c.cli.id)!.cli.id} is healthy`, { model: c.entry.model, transient: true });
        cands.splice(i, 1);
      }
    }
  }

  // Total order, independent of the order the CLIs were listed in: score (tenths), tier distance, load, verified, catalog order, ids.
  cands.sort((a, b) =>
    tenth(b.score) - tenth(a.score)
    || tierDistance(want, a.entry.tier) - tierDistance(want, b.entry.tier)
    || a.load - b.load
    || Number(b.verified) - Number(a.verified)
    || a.index - b.index
    || (a.cli.id < b.cli.id ? -1 : a.cli.id > b.cli.id ? 1 : 0)
    || (a.entry.model < b.entry.model ? -1 : a.entry.model > b.entry.model ? 1 : 0));
  return { want, cands, skipped, notes };
}

const clock = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * Why nothing can take this work, with every skip and when the transient ones clear. Empty-handed route() callers
 * show this instead of a bare "no CLI available".
 */
export function explainNoRoute(req: RouteRequest, inp: RouterInput): string {
  const ev = evaluate(req, inp);
  if (ev.cands.length) return `${ev.cands[0].cli.id}/${ev.cands[0].entry.model} is eligible for this ${req.role} work.`;
  if (!ev.skipped.length) return 'No CLI is known to Harbor, so nothing can take this work.';
  const lines = ev.skipped.map((s) => {
    const what = `${s.cli}${s.model ? `/${s.model}` : ''}`;
    const when = s.until !== undefined ? ` (available again around ${clock(s.until)})` : s.transient ? ' (reset time unknown)' : '';
    return `${what}: ${s.why}${when}`;
  });
  const times = ev.skipped.flatMap((s) => (s.until !== undefined ? [s.until] : []));
  const soonest = times.length ? ` Earliest expected availability: ${clock(Math.min(...times))}.` : '';
  return `Nothing can take this ${req.role} work right now. ${lines.join('; ')}.${soonest}`;
}

/** Returns undefined when nothing is eligible (see explainNoRoute). Scores come from state and the editable catalog, never from code-level claims. */
export function route(req: RouteRequest, inp: RouterInput): RouteDecision | undefined {
  const { want, cands, skipped, notes } = evaluate(req, inp);
  const best = cands[0];
  if (!best) return undefined;
  const second = cands[1];
  const pol = inp.policy ?? {};
  const prefersCli = !!pol.preference?.cli && pol.preference.cli === best.cli.id;
  const preferred = best.terms['preferred'] > 0 || prefersCli;
  const tied = !!second && tenth(second.score) === tenth(best.score);

  const now = inp.now?.();
  // Both windows of every CLI that was in the running (its best model), the chosen one first.
  const seen = new Set<CliId>(), perCli: Cand[] = [];
  for (const c of cands) if (!seen.has(c.cli.id)) { seen.add(c.cli.id); perCli.push(c); }
  const headroomText = perCli.map((c) => `${c.cli.id}: ${describeHeadroom(c.hr, now)}`).join('; ');
  const why = [`${best.cli.id}/${best.entry.model} (${best.entry.tier}) for ${want}${req.needs?.length ? ` [${[...new Set(req.needs)].join(', ')}]` : ''}: ${best.cli.authState === 'signedIn' ? 'signed in' : 'sign-in unverified'}, usage ${best.level} (~${best.pct}%${best.source === 'estimated' ? ' estimated' : ''}${best.projected !== undefined ? `, pace → ~${best.projected}% at reset` : ''})`];
  if (req.continuity === best.cli.id) why.push('continues existing session');
  if (preferred) why.push(`preferred for ${req.role} (settings)`);
  if (tied) why.push(`tied with ${second.cli.id}/${second.entry.model}; decided by tie-break (tier distance, load, verified, catalog order, cli id)`);
  why.push(`headroom (${pol.lowAllowance === undefined ? 'both windows count, the tighter binds' : `policy ${pol.lowAllowance}`}): ${headroomText}${perCli.length > 1 ? ` → ${best.cli.id}` : ''}`);
  if (pol.lowAllowance === undefined && req.prefer === best.cli.id && best.hr.remainingPct < W.lowHeadroomPct) why.push(`headroom not weighed: you asked for ${best.cli.id}`);
  const paceText = perCli.flatMap((c) => (c.pace && (Math.abs(c.pace.points) >= 0.5 || c.pace.surplusPct >= W.spendUpMinSurplusPct) ? [describePace(c.cli.id, c.pace)] : []));
  if (paceText.length) why.push(`weekly pacing (linear budget; reset time known): ${paceText.join('; ')}`);
  if (best.shifted?.by === 'pace') why.push(`${best.cli.id} is over its weekly pace with ${span(best.spend!.pace.hoursToReset * 3_600_000)} left to recover: one tier cheaper (${best.shifted.to} instead of ${best.shifted.from}) because the work can spare it`);
  else if (best.shifted) why.push(`${best.cli.id} headroom low (~${Math.round(best.hr.remainingPct)}% left): one tier cheaper (${best.shifted.to} instead of ${best.shifted.from}) because the work can spare it`);
  if (best.terms['switchBack'] < 0) why.push('moving back to the CLI this session just left: counted against it');
  const degraded = !best.shifted && TIERS.indexOf(best.entry.tier) < TIERS.indexOf(want) ? { wantedTier: want, gotTier: best.entry.tier } : undefined;
  if (degraded) why.push(`tier lowered: wanted ${want}, got ${best.entry.tier}`);
  const fx = finalEffort({ role: req.role, complexity: req.complexity, requested: req.effort, fixed: req.fixedEffort, retry: req.retry, policy: pol.effortPolicy, allowanceLow: best.level === 'low' || (pol.lowAllowance === undefined && best.hr.remainingPct < W.lowHeadroomPct) });
  let effort = fx.effort;
  // Weekly pacing on effort: spend the surplus about to be lost (one step up) or conserve when over pace (one step down). Never a deliberate or retry effort.
  const sp = best.spend;
  if (sp && !req.fixedEffort && !req.retry) {
    if (sp.dir === 'up' && !(pol.lowAllowance === undefined && best.hr.remainingPct < W.lowHeadroomPct)) {
      const up = stepUp(effort);
      const stronger = sp.tierTo && best.entry.tier === sp.tierTo ? `one tier stronger (${best.entry.model} instead of the ${want} model)` : 'no stronger model to use';
      why.push(`${best.cli.id} weekly allowance (~${Math.round(sp.pace.surplusPct)}% of the week) would otherwise be lost in ${span(sp.pace.hoursToReset * 3_600_000)}: spending it, ${stronger}${up !== effort ? `, effort ${effort} → ${up}` : ''}`);
      effort = up;
    } else if (sp.dir === 'down') {
      const down = stepDown(effort);
      if (EFFORT_RANK[down] < EFFORT_RANK[effort]) { fx.notes.push(`effort ${effort} → ${down}: ${best.cli.id} is over its weekly pace`); effort = down; }
    }
  }
  // A resumed session keeps the effort it started with: flipping it mid-session invalidates the prompt cache. An explicit choice still wins.
  const keepsEffort = !!req.keep?.effort && !req.fixedEffort && !req.retry && best.cli.id === req.keep.cli;
  if (keepsEffort && effort !== req.keep!.effort) { fx.notes.push(`effort ${effort} → ${req.keep!.effort}: kept for the resumed session`); effort = req.keep!.effort!; }
  if (req.keep && best.cli.id === req.keep.cli && best.entry.model === req.keep.model) why.push('keeps the session model');
  else if (req.keep && best.cli.id === req.keep.cli) why.push(`session model ${req.keep.model} → ${best.entry.model} (stronger tier wanted, or the session model is unavailable)`);
  // 'switch' already steered away from low allowance in scoring; when nothing healthier exists, still spend less.
  if (best.level === 'low' && pol.lowAllowance === 'switch') why.push('allowance low and no healthier option to switch to');
  if (req.prefer) {
    if (req.prefer === best.cli.id) why.push(`${req.prefer} requested by you`);
    else why.push(`you asked for ${req.prefer} but it is unavailable (${notes.filter((n) => n.startsWith(`${req.prefer}`)).join('; ') || 'no usable model'})`);
  }
  if (best.terms['avoid'] < 0) why.push('on the avoid list but the best left');
  if (best.terms['history'] < 0) why.push('recent failures on this model counted against it');
  why.push(...fx.notes);
  why.push(`${req.role}/${req.complexity} → effort ${effort}`);
  if (notes.length) why.push(notes.join('; '));
  return {
    cli: best.cli.id, model: best.entry.model, effort, reason: why.join(' · '),
    scored: cands.slice(0, 3).map((c) => ({
      cli: c.cli.id, model: c.entry.model, score: tenth(c.score), terms: c.terms,
      headroom: { remainingPct: Math.round(c.hr.remainingPct), windows: c.hr.windows.map((w) => ({ period: w.period, ...(w.scope !== undefined ? { scope: w.scope } : {}), remainingPct: w.remainingPct, resetsAt: w.resetsAt, projectedPct: w.projectedPct, source: w.source })) }
    })),
    margin: second ? tenth(tenth(best.score) - tenth(second.score)) : undefined,
    tied, degraded, skipped
  };
}
