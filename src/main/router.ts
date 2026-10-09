import type { AgentRole, CliId, EffortPolicy, LowAllowancePolicy, RolePreference } from '../shared/api';
import type { ResolvedCli } from './clis/discovery';
import type { Effort } from './adapters/types';
import { DEFAULT_CATALOG, TIERS, type CatalogEntry, type Need, type Tier } from './clis/capabilities';
import type { UsageLedger, UsageLevel } from './usage';

export type Complexity = 'low' | 'medium' | 'high';

export interface RouteRequest {
  role: AgentRole;
  complexity: Complexity;
  /** Explicit tier (concierge, lead). Derived from role and complexity when absent. */
  tier?: Tier;
  /** What the work needs; matched against catalog strengths. */
  needs?: Need[];
  effort?: Effort;
  /** CLI that holds this agent's native session; preferred to avoid a context-losing switch. */
  continuity?: CliId;
  /** CLIs already tried and failed for this assignment. */
  exclude?: CliId[];
  /** CLIs needed by an explicit extension request; restricts the choice when present. */
  requireCli?: CliId;
  /** CLI the user asked for by name. Strong preference, not a requirement: if it is unavailable, another CLI takes over and the reason says so. */
  prefer?: CliId;
  /** Retry of failed or rejected work: worth the highest effort. */
  retry?: boolean;
  /** `effort` is a deliberate choice (the concierge, a user's /deep) that the effort policy must not shift. */
  fixedEffort?: boolean;
}

/** User routing settings already resolved for the project (see effectiveSettings in store.ts). Absent fields keep the defaults. */
export interface RoutingPolicy {
  /** Per CLI, the catalog models that may be picked; absent or empty = all. */
  allowedModels?: Record<CliId, string[]>;
  /** The preference for this request's role. */
  preference?: RolePreference;
  effortPolicy?: EffortPolicy;
  lowAllowance?: LowAllowancePolicy;
  /** Percent of allowance kept free: a model at or above 100 - reserve % used is skipped. */
  reserve?: number;
}

export interface RouteDecision { cli: CliId; model: string; effort: Effort; reason: string }

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
}

const LEVEL_PENALTY: Record<UsageLevel, number> = { plenty: 0, limited: 10, low: 30, exhausted: 1000 };
/**
 * Between otherwise equal options the less used subscription wins: 2 points per full 10% used. Steps, not a smooth
 * slope, so one extra run does not flip the choice back and forth between two CLIs.
 */
const usagePenalty = (pct: number) => 2 * Math.floor(pct / 10);
/** A missing strength must cost less than overspending a tier (8), or one unmet need buys the strongest model. */
const MISSING_NEED = 4;
/**
 * A user preference outweighs continuity (25) and one tier step either way, so it decides between usable options;
 * it is a bonus, never a bypass of the hard skips above.
 */
const PREFERRED = 30;
/** A CLI the user asked for by name in this message ("use codex"): stronger than a standing settings preference. */
const REQUESTED = 60;
/** With lowAllowance 'switch', a model at low allowance loses to any healthy option of similar fit. */
const LOW_SWITCH_PENALTY = 40;

export function tierFor(role: AgentRole, c: Complexity): Tier {
  if (role === 'planner' || c === 'high') return 'strong';
  return c === 'low' ? 'cheap' : 'standard';
}

/** Overspending a tier costs a little; an underpowered model costs more. */
function tierPenalty(want: Tier, have: Tier): number {
  const d = TIERS.indexOf(have) - TIERS.indexOf(want);
  return d === 0 ? 0 : d > 0 ? 8 * d : -25 * d;
}

function needsFit(needs: Need[] | undefined, e: CatalogEntry): number {
  if (!needs?.length) return 0;
  return needs.reduce((s, n) => s + (e.strengths.includes(n) ? 4 : -MISSING_NEED), 0);
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

/** Applies the effort policy. Conserve never weakens a retry: that is the verification a tight budget must keep. */
export function applyEffortPolicy(e: Effort, policy: EffortPolicy | undefined, retry = false): Effort {
  if (policy === 'conserve' && !retry) return stepDown(e);
  if (policy === 'quality') return stepUp(e);
  return e;
}

/** Returns undefined when nothing is eligible. Scores come from state and the editable catalog, never from code-level claims. */
export function route(req: RouteRequest, inp: RouterInput): RouteDecision | undefined {
  const notes: string[] = [];
  const catalog = inp.catalog ?? DEFAULT_CATALOG;
  const want = req.tier ?? tierFor(req.role, req.complexity);
  const cands: { cli: ResolvedCli; entry: CatalogEntry; score: number; level: UsageLevel; pct: number; projected?: number }[] = [];
  const pol = inp.policy ?? {};
  const reserve = pol.reserve ?? 0, pref = pol.preference;
  const prefersCli = (id: CliId) => !!pref?.cli && pref.cli === id;
  // A model preference without a CLI applies to that model name on any CLI.
  const prefersModel = (id: CliId, model: string) => !!pref?.model && pref.model === model && (!pref.cli || pref.cli === id);

  for (const c of inp.clis) {
    if (!c.installed) { notes.push(`${c.id} skipped: not installed`); continue; }
    if (!inp.hasAdapter(c.id)) { notes.push(c.id + ' skipped: no headless adapter yet'); continue; }
    if (!inp.enabled(c.id)) { notes.push(`${c.id} skipped: disabled in settings`); continue; }
    if (c.authState === 'signedOut') { notes.push(`${c.id} skipped: login required`); continue; }
    if (req.exclude?.includes(c.id)) { notes.push(`${c.id} skipped: failed earlier for this task`); continue; }
    if (req.requireCli && req.requireCli !== c.id) { notes.push(`${c.id} skipped: task needs ${req.requireCli}`); continue; }
    const entries = catalog.filter((e) => e.cli === c.id);
    // A CLI missing from the catalog is still usable with its default model.
    const known: CatalogEntry[] = entries.length ? entries : [{ cli: c.id, model: 'default', tier: 'standard', strengths: [] }];
    // Allowed models only narrow the catalog: a model the catalog does not know is never invented here.
    const allowed = pol.allowedModels?.[c.id];
    const usable = allowed?.length ? known.filter((e) => allowed.includes(e.model)) : known;
    if (!usable.length) { notes.push(`${c.id} skipped: no allowed model (settings)`); continue; }
    for (const entry of usable) {
      // Per entry: Opus or Fable can be capped while Sonnet on the same account is fine.
      const p = inp.ledger.pressure(c.id, entry.model), level = p.level;
      if (level === 'exhausted') { notes.push(`${c.id}/${entry.model} skipped: allowance exhausted or rate limited`); continue; }
      if (reserve > 0 && p.pct >= 100 - reserve) { notes.push(`${c.id}/${entry.model} skipped: ~${p.pct}% used, inside the ${reserve}% subscription reserve`); continue; }
      let score = 100 - LEVEL_PENALTY[level] - usagePenalty(p.pct) - 5 * inp.load(c.id) - tierPenalty(want, entry.tier) + needsFit(req.needs, entry) - (entry.cost ?? 0);
      if (c.authState === 'unknown') score -= 15; // sign-in unverified: usable, but prefer confirmed ones
      if (req.continuity === c.id) score += 25;
      if (req.prefer === c.id) score += REQUESTED; // outweighs continuity (25) and a tier miss; not an exhausted allowance (skipped above)
      if (inp.verified?.(c.id)) score += 2;
      if (prefersCli(c.id)) score += PREFERRED;
      if (prefersModel(c.id, entry.model)) score += PREFERRED;
      if (level === 'low' && pol.lowAllowance === 'switch') score -= LOW_SWITCH_PENALTY;
      cands.push({ cli: c, entry, score, level, pct: p.pct, projected: p.projectedPct });
    }
  }

  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  if (!best) return undefined;

  let effort = req.effort ?? effortFor(req.role, req.complexity, req.retry);
  const why = [`${best.cli.id}/${best.entry.model} (${best.entry.tier}) for ${want}${req.needs?.length ? ` [${req.needs.join(', ')}]` : ''}: ${best.cli.authState === 'signedIn' ? 'signed in' : 'sign-in unverified'}, usage ${best.level} (~${best.pct}%${best.projected !== undefined ? `, pace → ~${best.projected}% at reset` : ''})`];
  if (req.continuity === best.cli.id) why.push('continues existing session');
  if (prefersCli(best.cli.id) || prefersModel(best.cli.id, best.entry.model)) why.push(`preferred for ${req.role} (settings)`);
  if (!req.fixedEffort && pol.effortPolicy && pol.effortPolicy !== 'adaptive') {
    const shifted = applyEffortPolicy(effort, pol.effortPolicy, req.retry);
    if (shifted !== effort) why.push(`effort ${effort} → ${shifted}: ${pol.effortPolicy} policy`);
    effort = shifted;
  }
  // 'switch' already steered away from low allowance in scoring; when nothing healthier exists, still spend less.
  if (best.level === 'low' && pol.lowAllowance === 'switch') why.push('allowance low and no healthier option to switch to');
  if (req.prefer) {
    if (req.prefer === best.cli.id) why.push(`${req.prefer} requested by you`);
    else why.push(`you asked for ${req.prefer} but it is unavailable (${notes.filter((n) => n.startsWith(`${req.prefer}`)).join('; ') || 'no usable model'})`);
  }
  if (best.level === 'low' && effort !== 'low') { effort = stepDown(effort); why.push('effort lowered: allowance low'); }
  why.push(`${req.role}/${req.complexity} → effort ${effort}`);
  if (notes.length) why.push(notes.join('; '));
  return { cli: best.cli.id, model: best.entry.model, effort, reason: why.join(' · ') };
}
