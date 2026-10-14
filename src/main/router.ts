import type { AgentRole, CliId, EffortPolicy, LowAllowancePolicy, RolePreference, RoutingRequestRecord } from '../shared/api';
import type { ResolvedCli } from './clis/discovery';
import type { Effort } from './adapters/types';
import { modelAvailability, poolsOfEntry, type PoolInput, type PoolStates } from './budget';
import type { Calibration, TaskSize } from './calibration';
import { DEFAULT_CATALOG, TIERS, autoRoutable, modelMatches, type CatalogEntry, type Need, type Tier } from './clis/capabilities';
import { COMPLEXITY_DIFFICULTY } from './difficulty';
import { routeReason } from './routeReason';
import { routeSummary } from './routeSummary';
import {
  EFFORTS, EFFORT_RANK, bestEffort, bindingNeed, fitsBudget, marginOf, poolInputsFromLedger, pricePoints, reviewNeeded, statesOf, type Committed, type RoutePrice, type RouteTask
} from './routePrice';
import type { UsageLedger, UsageLevel, UsageSource } from './usage';

export type Complexity = 'low' | 'medium' | 'high';

export interface RouteRequest {
  role: AgentRole;
  /** The user-facing label; when `difficulty` is absent it is derived from this (low 2, medium 5, high 8). */
  complexity: Complexity;
  /** 0..10 from difficulty.ts: what the capability floor and the prices are computed from. */
  difficulty?: number;
  /** Signals behind `difficulty`, for the reason text. */
  difficultySignals?: string[];
  /** Size of the work for the cost estimates (default medium). */
  size?: TaskSize;
  /** Deadline urgency 0..1 (budget.urgency): shrinks the reserve and prices time. 0 or absent without a deadline. */
  urgency?: number;
  /** The owner is waiting on this run (lead, concierge): it may use the reserve kept for interactive work. Helpers never do. */
  interactive?: boolean;
  /**
   * Upper tier the work should stay within (the concierge: cheap). A ceiling, not a target: higher tiers are used only when nothing
   * within it can do the work. Deprecated for anything else: difficulty decides the model.
   */
  tier?: Tier;
  /** What the work needs; matched against catalog strengths (duplicates count once, the total is capped) and priced on the weakest one. */
  needs?: Need[];
  /** Needs a model must have: one lacking any is skipped (with a note), never scored. */
  required?: Need[];
  /** With `fixedEffort`: the effort to use. Otherwise ignored: the price decides the effort. */
  effort?: Effort;
  /** CLI that holds this agent's native session; preferred to avoid a context-losing switch. */
  continuity?: CliId;
  /** CLIs already tried and failed for this assignment. Hard skip. */
  exclude?: CliId[];
  /** The run must not write (planners, reviewers, plan mode, the concierge): only CLIs that can keep it read-only are considered. */
  readOnly?: boolean;
  /** CLI/model that failed or disappointed but may still be the best left: a soft penalty, not a skip. `model` absent = the whole CLI. */
  avoid?: { cli: CliId; model?: string }[];
  /** CLIs needed by an explicit extension request; restricts the choice when present. */
  requireCli?: CliId;
  /** CLI the user asked for by name. Not judged on budget (only exhaustion stops it), and its models are kept even below the floor. */
  prefer?: CliId;
  /** Retry of rejected work: the effort policy never lowers it (the caller raises `difficulty`; see orchestrator createTasks). */
  retry?: boolean;
  /**
   * A rejected run being redone: on its model the effort must rise above the effort it used, and cheaper models of that CLI are not
   * considered. A stronger model is used only when it is the cheaper way to clear the raised floor.
   */
  escalateFrom?: { cli: CliId; model: string; effort?: Effort };
  /** `effort` is a deliberate choice (the concierge, a user's /deep) that neither price nor policy may shift. */
  fixedEffort?: boolean;
  /**
   * A resumed session: its last model and effort. While that model is available and can do the work at that effort, the session never
   * moves to a cheaper model or another model of the same tier on that CLI (it would rewrite the prompt cache), and keeps its effort
   * (a flip invalidates the cache too) unless `fixedEffort` asks for one. A stronger model of the same CLI takes over when it cannot.
   */
  keep?: { cli: CliId; model: string; effort?: Effort };
  /** A helper that would fan out (planner, implementer, reviewer): not started on a CLI at 'low' allowance or a pool in 'protect' when another CLI is healthy. */
  fanOut?: boolean;
  /** The CLI this session left on its last move and when (epoch ms): going straight back costs W.switchBack for W.switchBackMs. */
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
   * Absent (the default): the price decides, and a session moves only for a large price gap (W.switchGap).
   * 'reduceEffort' (explicit): stay put, spend less. The price term never exceeds W.reduceEffortUsageCap (below continuity), and at low
   *   allowance the effort steps down where the work still clears.
   * 'switch' (explicit): steer away. A model at low allowance (or whose pool is in protect) also costs W.lowSwitch.
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
  /** Kept for the contract (0.1.24); no longer filled: the price breakdown in the reason replaces it. */
  headroom?: { remainingPct: number; windows: Array<{ period: 'session' | 'weekly'; scope?: string; remainingPct: number; resetsAt?: number; projectedPct?: number; source: UsageSource }> };
  /** The effort this model would run at and its estimated price (scarcity-weighted weekly-quota %). */
  effort?: Effort;
  price?: number;
}

export interface RouteDecision {
  cli: CliId;
  model: string;
  effort: Effort;
  reason: string;
  /** The same choice in plain sentences for a person (Message.details.summary). */
  summary?: string;
  /** The difficulty the floor was computed from, and the size the cost was estimated for. */
  difficulty: number;
  size: TaskSize;
  /** The chosen option's price (estimate) and the runner-up's, for the reason and for callers. */
  price?: RoutePrice;
  runnerUp?: RoutePrice;
  /** The best three candidates with their per-term breakdown, best first. */
  scored?: ScoredCandidate[];
  /** Score lead over the runner-up (undefined with a single candidate). */
  margin?: number;
  /** The runner-up scored the same; the tie-break decided. */
  tied?: boolean;
  /** Nothing that clears the floor was available: the chosen model is below it (`wantedTier` would have cleared). */
  degraded?: { wantedTier: Tier; gotTier: Tier };
  /** The chosen model only just clears (or does not clear) the floor of high work: its result should be reviewed (Phase 4 schedules it). */
  needsReview?: boolean;
  reviewReason?: string;
  skipped?: RouteSkip[];
  /** What was asked, without any state: stored with the decision so a what-if replay can ask again (routingReplay.ts). */
  request?: RoutingRequestRecord;
}

/**
 * The stateless part of a request, as recorded on the message. Session holds (keep, escalateFrom, avoid, exclude, left) are not kept:
 * they depend on what ran before, which a replay cannot reproduce.
 */
export function requestRecord(req: RouteRequest, ev: Pick<Evaluation, 'difficulty' | 'size' | 'urgency' | 'interactive'>): RoutingRequestRecord {
  return {
    role: req.role, difficulty: ev.difficulty, size: ev.size,
    ...(req.needs?.length ? { needs: [...new Set(req.needs)] } : {}), ...(req.required?.length ? { required: [...new Set(req.required)] } : {}),
    ...(req.tier ? { tier: req.tier } : {}), ...(req.fixedEffort && req.effort ? { effort: req.effort, fixedEffort: true } : {}),
    ...(ev.interactive ? { interactive: true } : {}), ...(ev.urgency > 0 ? { urgency: ev.urgency } : {}), ...(req.retry ? { retry: true } : {}),
    ...(req.prefer ? { prefer: req.prefer } : {}), ...(req.continuity ? { continuity: req.continuity } : {})
  };
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
  /** Whether the CLI can keep a `readOnly` run read-only (absent = every CLI can). A safety filter, not a capability claim. */
  readOnlySafe?: (cli: CliId) => boolean;
  /** Capability catalog; defaults to the built-in one. */
  catalog?: CatalogEntry[];
  policy?: RoutingPolicy;
  /** Recent outcomes per "cli/model". Failures cost a bounded, time-decayed penalty. */
  history?: Record<string, { runs: number; fails: number; lastFailAt?: number }>;
  /** Clock; default the ledger's own clock. route() itself never reads the wall clock. */
  now?: () => number;
  /** Pool inputs (budget.poolInputsFrom); default: built from the ledger's readings and estimates. States follow the request's urgency and interactivity. */
  poolInputs?: PoolInput[];
  /** Ready pool states, used as they are for every request (tests, simulators). Wins over `poolInputs`. */
  poolStates?: PoolStates;
  /** Learned cost figures (calibration.ts); default: the priors. */
  calibration?: Calibration;
  /** Quota runs in flight are still expected to burn (routePrice.committedFor): counted as used for helpers, ignored with `poolInputs`/`poolStates`. */
  committed?: Committed;
}

/**
 * Every constant the score is made of besides the price. Score = base - price - load + needs - cost - auth + continuity + requested
 * + verified + preferred - lowSwitch - avoid - history - switchBack + escalate - shortfall. The price term (routePrice.ts) is PRICE_POINTS_PER_DOUBLING per
 * doubling over the cheapest feasible option, capped at PRICE_CAP. tests/router.test.ts asserts the ordering claims below.
 */
export const ROUTING_WEIGHTS = {
  base: 100,
  loadPerAgent: 5,
  /** A met need is worth `needHit`; a missing one costs `needMiss`. The whole term stays within +-needCap. */
  needHit: 4,
  needMiss: 4,
  needCap: 12,
  authUnknown: 15,
  /** With an explicit lowAllowance policy: what a session's CLI is worth over another. */
  continuity: 25,
  /** Default policy: what a session's CLI is worth over another. Another CLI must be about 2^(28/10) = 7x cheaper. Below `preferred`. */
  switchGap: 28,
  /** Going straight back to the CLI a session just left costs this, for `switchBackMs` (anti ping-pong). */
  switchBack: 12,
  switchBackMs: 30 * 60 * 1000,
  /** A CLI the user asked for by name in this message: stronger than a settings preference and than the whole price term. */
  requested: 60,
  /** A settings preference outweighs continuity; it is a bonus, never a bypass of the hard skips. */
  preferred: 30,
  verified: 2,
  /** With lowAllowance 'switch', a model at low allowance loses to any healthy option of similar fit. */
  lowSwitch: 40,
  /** A CLI/model to avoid (a retry of work it failed): beats continuity, loses to an explicit request. */
  avoid: 30,
  /**
   * A redo of rejected work on the model that did it, now at a higher effort: worth this much (a ~1.7x price gap), so more effort on the
   * same model comes first and the next capability step wins only when it is clearly cheaper.
   */
  escalateSame: 8,
  /**
   * When nothing clears the floor, each level a model falls short costs this (a quarter level = 15 points, more than a price doubling):
   * the degraded choice is the strongest model available, not the cheapest.
   */
  shortfallPerLevel: 60,
  /** History: per recent failure, capped at historyMax. */
  historyPerFail: 8,
  historyMax: 20,
  historyHalfLifeMs: 6 * 60 * 60 * 1000,
  /** With lowAllowance 'reduceEffort' the price term never exceeds this: below continuity, so a held session is not moved by budget alone. */
  reduceEffortUsageCap: 20,
  /**
   * Interactive work whose run does not fit in what its pools have left (runs in flight counted): it may still run there when nothing
   * else can (the owner is waiting), but anything that fits wins. Phase 5 simulator: a lead turn started on a nearly full Codex 5h
   * window took it to 100%.
   */
  unfit: 50,
  /** Scores are compared at this resolution (tenths) so float noise cannot decide a tie. */
  scoreResolution: 10
} as const;

const W = ROUTING_WEIGHTS;
/** Failure risk in whole percents: differences below a percent do not buy more effort or a stronger model on a price tie. */
const riskPct = (p: { failureRisk: number }) => Math.round(p.failureRisk * 100);
const tenth = (n: number) => Math.round(n * W.scoreResolution) / W.scoreResolution;
const clamp01 = (v: number) => (Number.isNaN(v) ? 0 : Math.min(1, Math.max(0, v)));

/**
 * @deprecated Routing no longer picks a tier from complexity (difficulty and price decide); kept for callers that show a tier label.
 */
export function tierFor(role: AgentRole, c: Complexity): Tier {
  if (c === 'high') return 'strong';
  if (role === 'planner') return 'standard';
  return c === 'low' ? 'cheap' : 'standard';
}

/** Needs are a set (a lead repeating one must not double it) and the sum is capped. */
function needsFit(needs: Need[] | undefined, e: CatalogEntry): number {
  if (!needs?.length) return 0;
  const sum = [...new Set(needs)].reduce((s, n) => s + (e.strengths.includes(n) ? W.needHit : -W.needMiss), 0);
  return Math.max(-W.needCap, Math.min(W.needCap, sum));
}

/** The effort a record shows before routing decides (a label only: route() picks the real one by price). */
export function effortFor(role: AgentRole, c: Complexity, retry = false): Effort {
  if (retry) return 'high';
  if (role === 'planner') return c === 'high' ? 'high' : 'medium';
  return c === 'high' ? 'medium' : c;
}

const stepDown = (e: Effort): Effort => (e === 'high' ? 'medium' : 'low');
const stepUp = (e: Effort): Effort => (e === 'low' ? 'medium' : 'high');

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
 * Effort composition for a label-based request (kept for callers that have no price): fixed > retry > low allowance > policy.
 * route() uses the price instead and applies the same precedence to the priced effort (see adjustEffort).
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

export interface Cand {
  cli: ResolvedCli; entry: CatalogEntry; index: number;
  score: number; terms: Record<string, number>;
  level: UsageLevel; pct: number; source: UsageSource; projected?: number;
  load: number; verified: boolean;
  /** The option this model would run: its best effort and price. */
  opt: RoutePrice;
  /** Efforts it may use (fixed, kept or escalated narrow the full set). */
  efforts: readonly Effort[];
  /** A pool of this model is in 'protect'. */
  protect: boolean;
  /** ...according to a fresh provider reading (not Harbor's estimate): the pool is really running out. */
  protectReported: boolean;
}

export interface Evaluation {
  cands: Cand[]; skipped: RouteSkip[]; notes: string[];
  difficulty: number; size: TaskSize; urgency: number; interactive: boolean;
  states: PoolStates; catalog: CatalogEntry[];
}

function failurePenalty(inp: RouterInput, cli: CliId, e: CatalogEntry): number {
  // Runs recorded under an old alias (e.g. 'sonnet' before the full id) are the same model's history.
  let fails = 0, lastFailAt: number | undefined;
  for (const name of [e.model, ...(e.aliases ?? [])]) {
    const h = inp.history?.[`${cli}/${name}`];
    if (!h || h.fails <= 0) continue;
    fails += h.fails;
    if (h.lastFailAt !== undefined) lastFailAt = Math.max(lastFailAt ?? h.lastFailAt, h.lastFailAt);
  }
  if (fails <= 0) return 0;
  const decay = inp.now && lastFailAt !== undefined ? 0.5 ** (Math.max(0, inp.now() - lastFailAt) / W.historyHalfLifeMs) : 1;
  return Math.min(W.historyMax, W.historyPerFail * fails * decay);
}

/** Efforts a model may run at for this request. */
function effortsFor(req: RouteRequest, cli: CliId, e: CatalogEntry): readonly Effort[] {
  if (req.fixedEffort && req.effort) return [req.effort];
  if (req.keep?.effort && !req.retry && !req.escalateFrom && req.keep.cli === cli) return [req.keep.effort];
  const from = req.escalateFrom;
  if (from?.effort && from.cli === cli && modelMatches(e, from.model)) {
    const higher = EFFORTS.filter((x) => EFFORT_RANK[x] > EFFORT_RANK[from.effort!]);
    return higher.length ? higher : ['high'];
  }
  return EFFORTS;
}

/** Drops models of `cli` cheaper than (or a same-tier sibling of) `model`, when `model` itself is a candidate that can do the work. */
function holdModel(cands: Cand[], cli: CliId, model: string, why: string, skip: (c: Cand, why: string) => void): void {
  const held = cands.find((c) => c.cli.id === cli && modelMatches(c.entry, model));
  if (!held || !held.opt.clears) return;
  const rank = TIERS.indexOf(held.entry.tier);
  for (let i = cands.length - 1; i >= 0; i--) {
    const c = cands[i]!;
    if (c.cli.id !== cli || c === held) continue;
    const r = TIERS.indexOf(c.entry.tier);
    if (r < rank || (r === rank && !modelMatches(c.entry, model))) { skip(c, why); cands.splice(i, 1); }
  }
}

/** Eligibility, pricing and scoring, shared by route() and explainNoRoute() so they can never disagree. */
export function evaluate(req: RouteRequest, inp: RouterInput): Evaluation {
  const skipped: RouteSkip[] = [], notes: string[] = [];
  const skip = (cli: CliId, why: string, extra: { model?: string; until?: number; transient?: boolean } = {}) => {
    skipped.push({ cli, why, ...extra });
    notes.push(`${cli}${extra.model ? `/${extra.model}` : ''} skipped: ${why}`);
  };
  const catalog = inp.catalog ?? DEFAULT_CATALOG;
  const pol = inp.policy ?? {};
  const now = inp.now?.() ?? inp.ledger.time();
  // A non-finite difficulty (bad external input) falls back to the complexity label instead of turning every score into NaN.
  const difficulty = Math.min(10, Math.max(0, typeof req.difficulty === 'number' && Number.isFinite(req.difficulty) ? req.difficulty : COMPLEXITY_DIFFICULTY[req.complexity]));
  const size: TaskSize = req.size ?? 'medium';
  const urgency = clamp01(req.urgency ?? 0);
  const interactive = !!req.interactive;
  const task: RouteTask = { role: req.role, difficulty, size, needs: req.needs, urgency };
  const ids = inp.clis.map((c) => c.id);
  const inputs = inp.poolStates ? undefined : (inp.poolInputs ?? poolInputsFromLedger(inp.ledger, catalog, ids, inp.committed));
  const states: PoolStates = inp.poolStates ?? statesOf(inputs!, now, urgency, interactive);
  // Only needed to tell "held for interactive work" from "out": computed when a helper meets an unavailable pool.
  let open: PoolStates | undefined;
  const openStates = () => (open ??= inp.poolStates ?? statesOf(inputs!, now, urgency, true));
  const reserve = pol.reserve ?? 0, pref = pol.preference;
  const prefersCli = (id: CliId) => !!pref?.cli && pref.cli === id;
  // A model preference without a CLI applies to that model name on any CLI.
  const prefersModel = (id: CliId, e: CatalogEntry) => !!pref?.model && modelMatches(e, pref.model) && (!pref.cli || pref.cli === id);
  // An entry kept out of automatic routing (autoRoute false, legacy) is still used when something names it: the settings
  // preference, an allowed-models list, or the resumed session that runs on it.
  const named = (id: CliId, e: CatalogEntry) => prefersModel(id, e) || !!pol.allowedModels?.[id]?.some((m) => modelMatches(e, m))
    || (!!req.keep && req.keep.cli === id && modelMatches(e, req.keep.model));
  const avoids = (id: CliId, e: CatalogEntry) => !!req.avoid?.some((a) => a.cli === id && (a.model === undefined || modelMatches(e, a.model)));
  const required = [...new Set(req.required ?? [])];
  const explicit = pol.lowAllowance !== undefined;
  const steer = pol.lowAllowance === 'switch';
  const cands: Cand[] = [];
  // Models that could do the work but have too little quota left for it now: a helper waits for them rather than taking a weaker model.
  let unfitButClears = false;

  // In id order, so skips and notes read the same whatever order the CLIs were listed in.
  for (const c of [...inp.clis].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
    if (!c.installed) { skip(c.id, 'not installed'); continue; }
    if (c.blocked) { skip(c.id, c.blocked); continue; }
    if (!inp.hasAdapter(c.id)) { skip(c.id, 'no headless adapter yet'); continue; }
    if (req.readOnly && inp.readOnlySafe && !inp.readOnlySafe(c.id)) { skip(c.id, 'has no read-only mode (allow it for read-only work in Settings)'); continue; }
    if (!inp.enabled(c.id)) { skip(c.id, 'disabled in settings'); continue; }
    if (c.authState === 'signedOut') { skip(c.id, 'login required'); continue; }
    if (req.exclude?.includes(c.id)) { skip(c.id, 'failed earlier for this task'); continue; }
    if (req.requireCli && req.requireCli !== c.id) { skip(c.id, `task needs ${req.requireCli}`); continue; }
    const entries = catalog.filter((e) => e.cli === c.id);
    // A CLI missing from the catalog is still usable with its default model (capabilities unknown: it has no strengths).
    const known: CatalogEntry[] = entries.length ? entries : [{ cli: c.id, model: 'default', tier: 'standard', strengths: [] }];
    // Allowed models only narrow the catalog: a model the catalog does not know is never invented here.
    const allowed = pol.allowedModels?.[c.id];
    const allowedHere = allowed?.length ? known.filter((e) => allowed.some((m) => modelMatches(e, m))) : known;
    if (!allowedHere.length) { skip(c.id, 'no allowed model (settings)'); continue; }
    for (const entry of allowedHere) {
      if (!autoRoutable(entry) && !named(c.id, entry)) { skip(c.id, entry.legacy ? 'legacy model' : 'not auto-routed', { model: entry.model }); continue; }
      const missing = required.find((n) => !entry.strengths.includes(n));
      if (missing) { skip(c.id, `lacks required ${missing}`, { model: entry.model }); continue; }
      // Per entry: Opus or Fable can be capped while Sonnet on the same account is fine.
      const p = inp.ledger.pressure(c.id, entry.model), level = p.level, source: UsageSource = p.source ?? 'estimated';
      if (level === 'exhausted') { skip(c.id, 'allowance exhausted or rate limited', { model: entry.model, until: p.resetsAt, transient: true }); continue; }
      if (reserve > 0 && p.pct >= 100 - reserve) { skip(c.id, `~${p.pct}% used, inside the ${reserve}% subscription reserve`, { model: entry.model, until: p.resetsAt, transient: true }); continue; }
      const av = modelAvailability(entry, states);
      if (!av.available) {
        const held = !interactive && modelAvailability(entry, openStates()).available;
        skip(c.id, held ? 'quota left is held in reserve for interactive work' : 'allowance exhausted or rate limited', { model: entry.model, ...(av.until !== undefined ? { until: av.until } : {}), transient: true });
        continue;
      }
      let efforts = effortsFor(req, c.id, entry);
      // A helper run must fit in what is left above the reserve (runs in flight counted): the efforts that do not fit are dropped,
      // and a model none of whose efforts fits waits for its reset. Interactive work has the reserve for this.
      if (!interactive) {
        const fit = efforts.map((e) => ({ e, f: fitsBudget({ model: entry, effort: e, role: req.role, size, states, calibration: inp.calibration }) }));
        const ok = fit.filter((x) => x.f.fits).map((x) => x.e);
        if (!ok.length) {
          const until = fit.map((x) => x.f.until).filter((u): u is number => u !== undefined);
          if (efforts.some((e) => marginOf(entry, bindingNeed(entry, req.needs), difficulty, e) >= -1e-9)) unfitButClears = true;
          skip(c.id, 'too little quota left above the reserve for this run', { model: entry.model, ...(until.length ? { until: Math.min(...until) } : {}), transient: true });
          continue;
        }
        efforts = ok;
      }
      // Interactive work: a run that would not fit is the last resort, not a skip (scored below anything that fits).
      const interactiveUnfit = interactive && !efforts.some((e) => fitsBudget({ model: entry, effort: e, role: req.role, size, states, calibration: inp.calibration, less: inp.committed }).fits);
      const opt = bestEffort({ model: entry, efforts, task, states, calibration: inp.calibration });
      const verified = !!inp.verified?.(c.id);
      const protect = poolsOfEntry(entry).some((pl) => states[pl]?.state === 'protect');
      const protectReported = poolsOfEntry(entry).some((pl) => states[pl]?.windows.some((w) => w.state === 'protect' && w.source === 'reported'));
      const terms: Record<string, number> = {
        price: 0, // filled in below, against the cheapest feasible option
        load: -W.loadPerAgent * inp.load(c.id),
        needs: needsFit(req.needs, entry),
        cost: -(entry.cost ?? 0),
        auth: c.authState === 'unknown' ? -W.authUnknown : 0, // sign-in unverified: usable, but prefer confirmed ones
        continuity: req.continuity === c.id ? (explicit ? W.continuity : W.switchGap) : 0,
        switchBack: !explicit && req.left?.cli === c.id && now - req.left.at < W.switchBackMs ? -W.switchBack : 0,
        requested: req.prefer === c.id ? W.requested : 0,
        verified: verified ? W.verified : 0,
        preferred: (prefersCli(c.id) ? W.preferred : 0) + (prefersModel(c.id, entry) ? W.preferred : 0),
        lowSwitch: steer && (level === 'low' || protect) ? -W.lowSwitch : 0,
        avoid: avoids(c.id, entry) ? -W.avoid : 0,
        history: -failurePenalty(inp, c.id, entry),
        escalate: req.escalateFrom && req.escalateFrom.cli === c.id && modelMatches(entry, req.escalateFrom.model) ? W.escalateSame : 0,
        unfit: interactiveUnfit ? -W.unfit : 0
      };
      const index = catalog.indexOf(entry);
      cands.push({ cli: c, entry, index: index < 0 ? catalog.length : index, score: 0, terms, level, pct: p.pct, source, projected: p.projectedPct, load: inp.load(c.id), verified, opt, efforts, protect, protectReported });
    }
  }

  const drop = (c: Cand, why: string) => skip(c.cli.id, why, { model: c.entry.model });
  // A resumed session keeps its model while it can do the work: nothing cheaper and no sibling of the same tier on its CLI.
  if (req.keep) holdModel(cands, req.keep.cli, req.keep.model, `session already runs on ${req.keep.model} (a different model would rewrite its prompt cache)`, drop);
  // A rejected run is redone on its own model at a higher effort, or on a stronger one: never on a cheaper sibling.
  if (req.escalateFrom) holdModel(cands, req.escalateFrom.cli, req.escalateFrom.model, `retry of work rejected on ${req.escalateFrom.model}: no cheaper model`, drop);

  // The capability floor: models that cannot clear it at any allowed effort are kept only when nothing can (degraded, reviewed),
  // or when the user named their CLI.
  const feasible = cands.filter((c) => c.opt.clears);
  // A helper whose capable models are only short of quota for now waits for them (the reserve and the floor both hold): degrading
  // hard work to a model below its floor just because a cheaper run still fits is what Phase 5 saw (a d=7.5 implementer on Luna).
  if (!feasible.length && unfitButClears && !interactive && !req.prefer) {
    for (const c of cands) skip(c.cli.id, 'below the capability floor while the models that clear it wait for quota', { model: c.entry.model, transient: true });
    cands.length = 0;
  }
  if (feasible.length) {
    const below = cands.filter((c) => !c.opt.clears && c.cli.id !== req.prefer);
    if (below.length) notes.push(`below the capability floor for difficulty ${difficulty}: ${below.map((c) => `${c.cli.id}/${c.entry.model}`).join(', ')}`);
    for (const c of below) cands.splice(cands.indexOf(c), 1);
  }
  // A tier ceiling (the concierge) holds while something within it can do the work.
  if (req.tier) {
    const cap = TIERS.indexOf(req.tier);
    const within = cands.filter((c) => TIERS.indexOf(c.entry.tier) <= cap && c.opt.clears);
    if (within.length) for (const c of cands.filter((x) => TIERS.indexOf(x.entry.tier) > cap)) cands.splice(cands.indexOf(c), 1);
  }
  // Fan-out helpers stay off a CLI at 'low' allowance (or a pool in protect) while another CLI is healthy: the whole job goes there.
  if (req.fanOut) {
    const healthy = cands.filter((c) => (c.level === 'plenty' || c.level === 'limited') && !c.protect);
    for (let i = cands.length - 1; i >= 0; i--) {
      const c = cands[i]!;
      const other = healthy.find((h) => h.cli.id !== c.cli.id);
      if ((c.level === 'low' || c.protect) && other) {
        skip(c.cli.id, `${c.level === 'low' ? `allowance low (~${c.pct}% used)` : 'quota pool in protect'}: ${req.role} helpers are not started on it while ${other.cli.id} is healthy`, { model: c.entry.model, transient: true });
        cands.splice(i, 1);
      }
    }
  }

  // A session does not hold on to a pool the provider says is running out (protect) while another CLI is healthy: the stickiness that
  // keeps it from moving on small price gaps would otherwise keep it there until the pool is empty. The stay-put policy keeps it.
  if (req.continuity && pol.lowAllowance !== 'reduceEffort') {
    const held = cands.filter((c) => c.cli.id === req.continuity);
    const healthy = cands.find((c) => c.cli.id !== req.continuity && !c.protect && c.opt.clears);
    if (held.length && healthy && held.every((c) => c.protectReported)) {
      for (const c of held) c.terms['continuity'] = 0;
      notes.push(`session not held on ${req.continuity}: its quota pool is in protect while ${healthy.cli.id} is healthy`);
    }
  }

  // Price term: points for being dearer than the cheapest option left. A CLI the user named in the message, and a model the settings
  // name for this role, are not judged on price (the owner chose them; only exhaustion and the hard skips stop them).
  const pool = cands.some((c) => c.opt.clears) ? cands.filter((c) => c.opt.clears) : cands;
  const cheapest = pool.length ? Math.min(...pool.map((c) => c.opt.routeTotal)) : 0;
  for (const c of cands) {
    let pts = req.prefer === c.cli.id || prefersModel(c.cli.id, c.entry) ? 0 : pricePoints(c.opt.routeTotal, cheapest);
    if (pol.lowAllowance === 'reduceEffort') pts = Math.min(pts, W.reduceEffortUsageCap);
    c.terms['price'] = pts ? -pts : 0;
    if (!c.opt.clears) c.terms['shortfall'] = -W.shortfallPerLevel * Math.max(0, -c.opt.margin);
    c.score = W.base + Object.values(c.terms).reduce((a, b) => a + b, 0);
  }

  // Total order, independent of the order the CLIs were listed in: score (tenths), price, failure risk, effort, load, verified, catalog order, ids.
  cands.sort((a, b) =>
    tenth(b.score) - tenth(a.score)
    || a.opt.routeTotal - b.opt.routeTotal
    // Equal prices happen when use-it-or-lose-it credit makes options free: then the one less likely to fail, to the whole percent
    // (Phase 5 spend-up), and of those the lower effort: Opus at low effort, not at high, for easy work paid by expiring quota.
    || riskPct(a.opt) - riskPct(b.opt)
    || EFFORT_RANK[a.opt.effort] - EFFORT_RANK[b.opt.effort]
    || a.opt.failureRisk - b.opt.failureRisk
    || a.load - b.load
    || Number(b.verified) - Number(a.verified)
    || a.index - b.index
    || (a.cli.id < b.cli.id ? -1 : a.cli.id > b.cli.id ? 1 : 0)
    || (a.entry.model < b.entry.model ? -1 : a.entry.model > b.entry.model ? 1 : 0));
  return { cands, skipped, notes, difficulty, size, urgency, interactive, states, catalog };
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

/**
 * The effort policy and an explicit low-allowance policy applied to the priced effort. A deliberate, kept or retried effort is never
 * lowered, and a step down is taken only when the work still clears at the lower effort.
 */
function adjustEffort(req: RouteRequest, inp: RouterInput, best: Cand, ev: Evaluation, notes: string[]): Effort {
  const pol = inp.policy ?? {};
  let effort = best.opt.effort;
  if (req.fixedEffort || best.efforts.length === 1) return effort;
  const clearsAt = (e: Effort) => marginOf(best.entry, best.opt.need, ev.difficulty, e) >= -1e-9 && best.efforts.includes(e);
  const down = (why: string) => {
    const lower = stepDown(effort);
    if (lower === effort) return;
    if (clearsAt(lower)) { notes.push(`effort ${effort} → ${lower}: ${why}`); effort = lower; }
    else notes.push(`${why}: effort stays ${effort} (lower would not clear difficulty ${ev.difficulty})`);
  };
  if (pol.effortPolicy === 'conserve' && !req.retry) down('conserve policy');
  if (pol.effortPolicy === 'quality' && best.efforts.includes(stepUp(effort)) && stepUp(effort) !== effort) { notes.push(`effort ${effort} → ${stepUp(effort)}: quality policy`); effort = stepUp(effort); }
  if (pol.lowAllowance !== undefined && !req.retry && (best.level === 'low' || best.protect)) down('allowance low');
  return effort;
}

/** The cheapest tier of an auto-routable model on these CLIs that would clear the floor at high effort (what a degraded choice missed). */
function wantedTier(ev: Evaluation, inp: RouterInput): Tier {
  const ids = new Set(inp.clis.map((c) => c.id));
  const ok = ev.catalog.filter((e) => ids.has(e.cli) && autoRoutable(e) && marginOf(e, ev.cands[0]!.opt.need, ev.difficulty, 'high') >= -1e-9);
  return ok.length ? TIERS[Math.min(...ok.map((e) => TIERS.indexOf(e.tier)))]! : 'strong';
}

/** Returns undefined when nothing is eligible (see explainNoRoute). Prices come from state and the editable catalog, never from code-level claims. */
export function route(req: RouteRequest, inp: RouterInput): RouteDecision | undefined {
  const ev = evaluate(req, inp);
  const { cands } = ev;
  const best = cands[0];
  if (!best) return undefined;
  const second = cands[1];
  const tied = !!second && tenth(second.score) === tenth(best.score);
  const effortNotes: string[] = [];
  const effort = adjustEffort(req, inp, best, ev, effortNotes);
  const margin = marginOf(best.entry, best.opt.need, ev.difficulty, effort);
  const clearsFinal = margin >= -1e-9;
  const needsReview = !clearsFinal || reviewNeeded(ev.difficulty, margin);
  const reviewReason = !needsReview ? undefined : !clearsFinal
    ? `${best.entry.model} at ${effort} effort is below the capability floor for difficulty ${ev.difficulty} (nothing stronger was available): review the result`
    : `${best.entry.model} at ${effort} effort only just clears difficulty ${ev.difficulty} (margin ${Math.round(margin * 100) / 100} level): review the result`;
  const degraded = !clearsFinal && req.prefer !== best.cli.id ? { wantedTier: wantedTier(ev, inp), gotTier: best.entry.tier } : undefined;
  const reason = routeReason({ req, inp, ev, best, second, effort, tied, effortNotes, degraded, reviewReason });
  const summary = routeSummary({ req, ev, best, second, effort, tied, degraded, reviewReason });
  return {
    cli: best.cli.id, model: best.entry.model, effort, reason, summary, difficulty: ev.difficulty, size: ev.size,
    price: best.opt, ...(second ? { runnerUp: second.opt } : {}),
    scored: cands.slice(0, 3).map((c) => ({ cli: c.cli.id, model: c.entry.model, score: tenth(c.score), terms: c.terms, effort: c.opt.effort, price: Math.round(c.opt.routeTotal * 1000) / 1000 })),
    margin: second ? tenth(tenth(best.score) - tenth(second.score)) : undefined,
    tied, degraded, ...(needsReview ? { needsReview: true, reviewReason } : {}), skipped: ev.skipped, request: requestRecord(req, ev)
  };
}
