import type { AgentRole, CliId } from '../shared/api';
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
}

const LEVEL_PENALTY: Record<UsageLevel, number> = { plenty: 0, limited: 10, low: 30, exhausted: 1000 };

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
  return needs.reduce((s, n) => s + (e.strengths.includes(n) ? 4 : -12), 0);
}

function baseEffort(role: AgentRole, c: Complexity): Effort {
  if (role === 'main') return 'low';
  if (role === 'planner') return c === 'low' ? 'medium' : 'high';
  return c;
}

const stepDown = (e: Effort): Effort => (e === 'high' ? 'medium' : 'low');

/** Returns undefined when nothing is eligible. Scores come from state and the editable catalog, never from code-level claims. */
export function route(req: RouteRequest, inp: RouterInput): RouteDecision | undefined {
  const notes: string[] = [];
  const catalog = inp.catalog ?? DEFAULT_CATALOG;
  const want = req.tier ?? tierFor(req.role, req.complexity);
  const cands: { cli: ResolvedCli; entry: CatalogEntry; score: number; level: UsageLevel; pct: number; projected?: number }[] = [];

  for (const c of inp.clis) {
    if (!c.installed) { notes.push(`${c.id} skipped: not installed`); continue; }
    if (!inp.hasAdapter(c.id)) { notes.push(c.id + ' skipped: no headless adapter yet'); continue; }
    if (!inp.enabled(c.id)) { notes.push(`${c.id} skipped: disabled in settings`); continue; }
    if (c.authState === 'signedOut') { notes.push(`${c.id} skipped: login required`); continue; }
    if (req.exclude?.includes(c.id)) { notes.push(`${c.id} skipped: failed earlier for this task`); continue; }
    if (req.requireCli && req.requireCli !== c.id) { notes.push(`${c.id} skipped: task needs ${req.requireCli}`); continue; }
    const entries = catalog.filter((e) => e.cli === c.id);
    // A CLI missing from the catalog is still usable with its default model.
    const usable: CatalogEntry[] = entries.length ? entries : [{ cli: c.id, model: 'default', tier: 'standard', strengths: [] }];
    for (const entry of usable) {
      // Per entry: Opus or Fable can be capped while Sonnet on the same account is fine.
      const p = inp.ledger.pressure(c.id, entry.model), level = p.level;
      if (level === 'exhausted') { notes.push(`${c.id}/${entry.model} skipped: allowance exhausted or rate limited`); continue; }
      let score = 100 - LEVEL_PENALTY[level] - 5 * inp.load(c.id) - tierPenalty(want, entry.tier) + needsFit(req.needs, entry);
      if (c.authState === 'unknown') score -= 15; // sign-in unverified: usable, but prefer confirmed ones
      if (req.continuity === c.id) score += 25;
      if (inp.verified?.(c.id)) score += 2;
      cands.push({ cli: c, entry, score, level, pct: p.pct, projected: p.projectedPct });
    }
  }

  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  if (!best) return undefined;

  let effort = req.effort ?? baseEffort(req.role, req.complexity);
  const why = [`${best.cli.id}/${best.entry.model} (${best.entry.tier}) for ${want}${req.needs?.length ? ` [${req.needs.join(', ')}]` : ''}: ${best.cli.authState === 'signedIn' ? 'signed in' : 'sign-in unverified'}, usage ${best.level} (~${best.pct}%${best.projected !== undefined ? `, pace → ~${best.projected}% at reset` : ''})`];
  if (req.continuity === best.cli.id) why.push('continues existing session');
  if (best.level === 'low' && effort !== 'low') { effort = stepDown(effort); why.push('effort lowered: allowance low'); }
  why.push(`${req.role}/${req.complexity} → effort ${effort}`);
  if (notes.length) why.push(notes.join('; '));
  return { cli: best.cli.id, model: best.entry.model, effort, reason: why.join(' · ') };
}
