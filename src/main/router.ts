import type { AgentRole, CliId } from '../shared/api';
import type { ResolvedCli } from './clis/discovery';
import type { Effort } from './adapters/types';
import type { UsageLedger, UsageLevel } from './usage';

export type Complexity = 'low' | 'medium' | 'high';

export interface RouteRequest {
  role: AgentRole;
  complexity: Complexity;
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
}

const LEVEL_PENALTY: Record<UsageLevel, number> = { plenty: 0, limited: 10, low: 30, exhausted: 1000 };

/** Model per CLI. Only Claude exposes model aliases we rely on; others use their own default. */
export function pickModel(cli: CliId, role: AgentRole, c: Complexity): string {
  if (cli === 'claude') {
    if (role === 'planner' || c === 'high') return 'opus';
    return c === 'low' ? 'haiku' : 'sonnet';
  }
  return 'default';
}

function baseEffort(role: AgentRole, c: Complexity): Effort {
  if (role === 'main') return 'low';
  if (role === 'planner') return c === 'low' ? 'medium' : 'high';
  return c;
}

const stepDown = (e: Effort): Effort => (e === 'high' ? 'medium' : 'low');

/** Returns undefined when nothing is eligible. Never makes provider superiority claims: scores come from state only. */
export function route(req: RouteRequest, inp: RouterInput): RouteDecision | undefined {
  const notes: string[] = [];
  const cands: { cli: ResolvedCli; score: number; level: UsageLevel; pct: number }[] = [];

  for (const c of inp.clis) {
    if (!c.installed) { notes.push(`${c.id} skipped: not installed`); continue; }
    if (!inp.hasAdapter(c.id)) { notes.push(c.id + ' skipped: no headless adapter yet'); continue; }
    if (!inp.enabled(c.id)) { notes.push(`${c.id} skipped: disabled in settings`); continue; }
    if (c.authState === 'signedOut') { notes.push(`${c.id} skipped: login required`); continue; }
    if (req.exclude?.includes(c.id)) { notes.push(`${c.id} skipped: failed earlier for this task`); continue; }
    if (req.requireCli && req.requireCli !== c.id) { notes.push(`${c.id} skipped: task needs ${req.requireCli}`); continue; }
    const level = inp.ledger.level(c.id);
    if (level === 'exhausted') { notes.push(`${c.id} skipped: allowance exhausted or rate limited`); continue; }
    let score = 100 - LEVEL_PENALTY[level] - 5 * inp.load(c.id);
    if (c.authState === 'unknown') score -= 15; // sign-in unverified: usable, but prefer confirmed ones
    if (req.continuity === c.id) score += 25;
    if (inp.verified?.(c.id)) score += 2;
    cands.push({ cli: c, score, level, pct: inp.ledger.usedPct(c.id) });
  }

  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  if (!best) return undefined;

  let effort = baseEffort(req.role, req.complexity);
  const why = [`${best.cli.id}: ${best.cli.authState === 'signedIn' ? 'signed in' : 'sign-in unverified'}, usage ${best.level} (~${best.pct}% est.)`];
  if (req.continuity === best.cli.id) why.push('continues existing session');
  if ((best.level === 'low') && effort !== 'low') { effort = stepDown(effort); why.push('effort lowered: allowance low'); }
  why.push(`${req.role}/${req.complexity} → effort ${effort}`);
  if (notes.length) why.push(notes.join('; '));
  return { cli: best.cli.id, model: pickModel(best.cli.id, req.role, req.complexity), effort, reason: why.join(' · ') };
}
