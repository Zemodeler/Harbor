import type { AgentRole, CliId, Id, Message, RoutingReplay, RoutingReplayChoice, RoutingReplayDecision } from '../shared/api';
import type { PoolStates } from './budget';
import type { Calibration, TaskSize } from './calibration';
import type { CatalogEntry, Need, Tier } from './clis/capabilities';
import type { ResolvedCli } from './clis/discovery';
import { complexityOf } from './difficulty';
import type { Effort } from './adapters/types';
import { route, type RouteDecision, type RouteRequest, type RoutingPolicy } from './router';
import { Store } from './store';
import type { AgentRecord } from './types';
import { UsageLedger } from './usage';

/**
 * Routing replay / what-if. PURE apart from an in-memory ledger. Recorded decisions keep what was asked (Message.details.request,
 * since 0.1.29) but not the quota state they were made in, so a replay routes every decision twice under the SAME assumed state: once
 * with the baseline catalog and settings, once with the what-if ones. The difference between the two is what the change alone does.
 * Prices are the router's own estimates (scarcity-weighted weekly-quota %), not provider figures.
 */

export interface RecordedDecision {
  messageId: Id; conversationId: Id; agentId?: Id; time: number; role: AgentRole;
  request: RouteRequest;
  /** The request was rebuilt from the agent record: the decision predates Message.details.request. */
  approximate: boolean;
  recorded: RoutingReplayChoice;
  /** Project of the agent behind it (settings are resolved per project). */
  projectId?: Id;
}

export interface ReplayScenario {
  catalog: readonly CatalogEntry[];
  /** Routing settings for one decision (project overrides and the role's preference resolved). */
  policyFor: (d: RecordedDecision) => RoutingPolicy;
  enabled?: (cli: CliId) => boolean;
  calibration?: Calibration;
}

export interface ReplayOptions {
  base: ReplayScenario;
  alt: ReplayScenario;
  /** Pool states both sides are judged under; default none (every pool neutral). */
  poolStates?: PoolStates;
  now: number;
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Routing decisions recorded on messages, oldest first; one per run (a run can post several messages with the same details). */
export function recordedDecisions(messages: readonly Message[], agentOf: (id: Id) => AgentRecord | undefined): RecordedDecision[] {
  const seen = new Set<string>();
  const out: RecordedDecision[] = [];
  for (const m of [...messages].sort((a, b) => a.time - b.time)) {
    const d = m.details;
    if (!d) continue;
    const key = `${m.agentId ?? ''}|${d.cli}|${d.model}|${d.effort}|${d.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const agent = m.agentId ? agentOf(m.agentId) : undefined;
    const price = d.scored?.find((s) => s.cli === d.cli && s.model === d.model)?.price;
    const recorded: RoutingReplayChoice = { cli: d.cli, model: d.model, effort: d.effort, ...(price !== undefined ? { price } : {}) };
    const base = { messageId: m.id, conversationId: m.conversationId, ...(m.agentId ? { agentId: m.agentId } : {}), time: m.time, recorded, ...(agent ? { projectId: agent.projectId } : {}) };
    const q = d.request;
    if (q) {
      const difficulty = q.difficulty ?? d.difficulty;
      out.push({
        ...base, role: q.role, approximate: false,
        request: {
          role: q.role, complexity: difficulty !== undefined ? complexityOf(difficulty) : 'medium', ...(difficulty !== undefined ? { difficulty } : {}),
          ...(q.size ? { size: q.size as TaskSize } : {}), ...(q.needs ? { needs: q.needs as Need[] } : {}), ...(q.required ? { required: q.required as Need[] } : {}),
          ...(q.tier ? { tier: q.tier as Tier } : {}), ...(q.fixedEffort && q.effort ? { effort: q.effort as Effort, fixedEffort: true } : {}),
          ...(q.interactive ? { interactive: true } : {}), ...(q.urgency ? { urgency: q.urgency } : {}), ...(q.retry ? { retry: true } : {}),
          ...(q.prefer ? { prefer: q.prefer } : {}), ...(q.continuity ? { continuity: q.continuity } : {})
        }
      });
      continue;
    }
    // Before 0.1.29: rebuilt from the agent record and the recorded difficulty. The concierge's cheap ceiling and fixed effort are lost.
    const role: AgentRole = agent?.role ?? 'main';
    const difficulty = d.difficulty ?? agent?.difficulty;
    out.push({
      ...base, role, approximate: true,
      request: {
        role, complexity: difficulty !== undefined ? complexityOf(difficulty) : agent?.complexity ?? 'medium', ...(difficulty !== undefined ? { difficulty } : {}),
        ...(agent?.size ? { size: agent.size } : {}), ...(agent?.needs?.length ? { needs: agent.needs } : {}), ...(role === 'main' ? { interactive: true } : {}),
        ...(agent?.retry ? { retry: true } : {}), ...(agent?.pinnedCli ? { prefer: agent.pinnedCli } : {})
      }
    });
  }
  return out;
}

const cliOf = (id: CliId): ResolvedCli => ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'] }) as ResolvedCli;

function choiceOf(d: RouteDecision | undefined): RoutingReplayChoice | undefined {
  if (!d) return undefined;
  return { cli: d.cli, model: d.model, effort: d.effort, ...(d.price ? { price: r4(d.price.routeTotal), costPct: r4(d.price.expectedCostPct) } : {}) };
}

const same = (a?: RoutingReplayChoice, b?: RoutingReplayChoice) => (!a && !b) || (!!a && !!b && a.cli === b.cli && a.model === b.model && a.effort === b.effort);
const label = (c?: RoutingReplayChoice) => (c ? `${c.cli}/${c.model}` : 'nothing eligible');

/** Routes every recorded decision under both scenarios and reports where the choice differs and what that does to the price. */
export function replayDecisions(decisions: readonly RecordedDecision[], o: ReplayOptions): RoutingReplay {
  // Every CLI either side knows, plus the recorded ones, counts as installed and signed in: the replay is about catalog and settings.
  const ids = [...new Set([...o.base.catalog, ...o.alt.catalog].map((e) => e.cli).concat(decisions.map((d) => d.recorded.cli)))].sort();
  const routeUnder = (s: ReplayScenario, d: RecordedDecision): RouteDecision | undefined => {
    const ledger = new UsageLedger(new Store(undefined, { now: () => o.now }), { now: () => o.now, catalog: [...s.catalog] });
    return route(d.request, {
      clis: ids.map(cliOf), ledger, enabled: s.enabled ?? (() => true), hasAdapter: () => true, load: () => 0, catalog: [...s.catalog], now: () => o.now,
      policy: s.policyFor(d), poolStates: o.poolStates ?? {}, ...(s.calibration ? { calibration: s.calibration } : {})
    });
  };
  const rows: RoutingReplayDecision[] = decisions.map((d) => {
    const baseline = choiceOf(routeUnder(o.base, d)), alternative = choiceOf(routeUnder(o.alt, d));
    const changed = !same(baseline, alternative);
    return {
      messageId: d.messageId, conversationId: d.conversationId, ...(d.agentId ? { agentId: d.agentId } : {}), time: d.time, role: d.role, approximate: d.approximate,
      recorded: d.recorded, ...(baseline ? { baseline } : {}), ...(alternative ? { alternative } : {}), changed,
      ...(baseline?.price !== undefined && alternative?.price !== undefined ? { priceDelta: r4(alternative.price - baseline.price) } : {}),
      ...(baseline?.costPct !== undefined && alternative?.costPct !== undefined ? { costPctDelta: r4(alternative.costPct - baseline.costPct) } : {})
    };
  });
  const moves = new Map<string, number>();
  for (const r of rows) if (r.changed) { const k = `${label(r.baseline)}\u0000${label(r.alternative)}`; moves.set(k, (moves.get(k) ?? 0) + 1); }
  const notes = [
    'Prices are the router\'s estimates (scarcity-weighted weekly-quota %); costPct is the expected weekly-quota % of the binding pool. Neither is a provider figure.',
    'Session holds (a resumed session keeping its model, retries escalating from a rejected model, CLIs excluded after a failure) are not replayed.'
  ];
  const approx = rows.filter((r) => r.approximate).length;
  if (approx) notes.push(`${approx} decision(s) predate recorded requests: their request was rebuilt from the agent record (the concierge's cheap ceiling and fixed effort are lost).`);
  return {
    generatedAt: o.now,
    assumption: o.poolStates
      ? 'Both sides were judged under the pool states supplied with the replay.'
      : 'Both sides were judged with every quota pool neutral (no readings, nothing exhausted), no load and no failure history: the recorded quota state is not stored, so differences come from the catalog and settings alone.',
    decisions: rows,
    summary: {
      decisions: rows.length, changed: rows.filter((r) => r.changed).length, unroutable: rows.filter((r) => !r.alternative).length,
      baselineMatchesRecorded: rows.filter((r) => r.baseline && r.baseline.cli === r.recorded.cli && r.baseline.model === r.recorded.model).length,
      priceDelta: r4(rows.reduce((s, r) => s + (r.priceDelta ?? 0), 0)), costPctDelta: r4(rows.reduce((s, r) => s + (r.costPctDelta ?? 0), 0)),
      moves: [...moves.entries()].map(([k, count]) => { const [from, to] = k.split('\u0000'); return { from: from!, to: to!, count }; }).sort((a, b) => b.count - a.count)
    },
    notes
  };
}
