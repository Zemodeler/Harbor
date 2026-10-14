import type { AgentRole, Conversation, Id, Message, QuotaEstimate, TaskReport, TaskReportAgent, TaskReportDecision, TaskReportModel, TaskReportRun, TaskReportTokens } from '../shared/api';
import { BUDGET_PERIODS, poolsOfEntry } from './budget';
import { costPerKTokOf, poolPctPrior } from './budgetPriors';
import { billableKTok, calibrated, pctKey, type Calibration } from './calibration';
import { entryFor, type CatalogEntry } from './clis/capabilities';
import type { AgentRecord, UsageEvent } from './types';

/**
 * Per-conversation cost and time report (getTaskReport). PURE: built from what Harbor already records (usage events, agent records,
 * the routing details on messages). Quota figures are ESTIMATES from token counts, the catalog's cost per token and the calibrated
 * quota per token (the same figures routing prices with); they are never presented as the provider's quota.
 */

export interface TaskReportInput {
  conversation: Conversation;
  /** The project's agent records (the lead and every helper). */
  agents: readonly AgentRecord[];
  usage: readonly UsageEvent[];
  /** Messages of the conversation and of its helpers' own conversations (routing decisions are read from their details). */
  messages: readonly Message[];
  catalog: readonly CatalogEntry[];
  calibration?: Calibration;
  now: number;
  /** How long usage events are kept before they are folded into totals (store.USAGE_KEEP_MS). */
  keepMs?: number;
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const r1 = (n: number) => Math.round(n * 10) / 10;
const zero = (): TaskReportTokens => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, billableKTok: 0 });

/**
 * Estimated share of each window of each pool the run's model draws on, from the run's own billable tokens. Undefined when the CLI
 * reported no tokens: then the quota is unknown, never zero.
 */
export function runQuota(e: Pick<UsageEvent, 'cli' | 'model' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>, catalog: readonly CatalogEntry[], calibration?: Calibration): QuotaEstimate[] | undefined {
  const k = billableKTok(e);
  if (k === undefined) return undefined;
  const entry = entryFor(catalog, e.cli, e.model);
  return poolsOfEntry(entry ?? { cli: e.cli }).flatMap((pool) => BUDGET_PERIODS.map((period) => ({
    pool, period, pct: k * costPerKTokOf(entry) * calibrated(poolPctPrior(pool, period), calibration?.pctPerKTok[pctKey(pool, period)], false)
  })));
}

/** Adds quota estimates per pool and period, in place. */
function addQuota(into: QuotaEstimate[], q: readonly QuotaEstimate[] | undefined): void {
  for (const x of q ?? []) {
    const cur = into.find((y) => y.pool === x.pool && y.period === x.period);
    if (cur) cur.pct += x.pct; else into.push({ ...x });
  }
}
const roundQuota = (q: QuotaEstimate[]): QuotaEstimate[] =>
  q.map((x) => ({ ...x, pct: r4(x.pct) })).sort((a, b) => (a.pool === b.pool ? (a.period < b.period ? 1 : -1) : a.pool < b.pool ? -1 : 1));

function addTokens(into: TaskReportTokens, r: TaskReportTokens): void {
  into.inputTokens += r.inputTokens; into.outputTokens += r.outputTokens;
  into.cacheReadTokens += r.cacheReadTokens; into.cacheWriteTokens += r.cacheWriteTokens; into.billableKTok += r.billableKTok;
}

/** Routing decisions recorded on messages. One run can post several messages with the same details: those count once. */
export function decisionsOf(messages: readonly Message[]): TaskReportDecision[] {
  const seen = new Set<string>();
  const out: TaskReportDecision[] = [];
  for (const m of [...messages].sort((a, b) => a.time - b.time)) {
    const d = m.details;
    if (!d) continue;
    const key = `${m.agentId ?? ''}|${d.cli}|${d.model}|${d.effort}|${d.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const price = d.scored?.find((s) => s.cli === d.cli && s.model === d.model)?.price;
    out.push({
      messageId: m.id, ...(m.agentId ? { agentId: m.agentId } : {}), time: m.time, cli: d.cli, model: d.model, effort: d.effort,
      ...(d.difficulty !== undefined ? { difficulty: d.difficulty } : {}), ...(price !== undefined ? { price } : {}), ...(d.needsReview ? { needsReview: true } : {})
    });
  }
  return out;
}

export function buildTaskReport(i: TaskReportInput): TaskReport {
  const conv = i.conversation;
  const byId = new Map(i.agents.map((a) => [a.id, a]));
  // A helper's own conversation reports that helper alone; a lead conversation reports the lead's turns there and every helper of it.
  const owner = byId.get(conv.agentId);
  const helpers = owner && owner.role !== 'main' ? [owner] : i.agents.filter((a) => a.role !== 'main' && a.parentConversationId === conv.id);
  const helperIds = new Set(helpers.map((a) => a.id));
  // The lead is shared by every conversation of the project: only its runs for this conversation count. Helpers count whole.
  const events = i.usage
    .filter((u) => u.projectId === conv.projectId && (helperIds.has(u.agentId) || (owner?.role === 'main' && u.conversationId === conv.id && u.agentId === owner.id)))
    .sort((a, b) => a.time - b.time);

  const runs: TaskReportRun[] = events.map((u) => {
    const k = billableKTok(u);
    const q = runQuota(u, i.catalog, i.calibration);
    return {
      id: u.id, time: u.time, agentId: u.agentId, role: byId.get(u.agentId)?.role ?? 'other', cli: u.cli, model: u.model, durationMs: u.durationMs, ok: u.ok,
      inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, cacheReadTokens: u.cacheReadTokens ?? 0, cacheWriteTokens: u.cacheWriteTokens ?? 0,
      billableKTok: r4(k ?? 0), ...(u.partial ? { partial: true } : {}), ...(u.rateLimited ? { rateLimited: true } : {}), ...(k === undefined ? { noTokens: true } : {}),
      ...(u.costUsd !== undefined ? { costUsd: u.costUsd } : {}), quota: roundQuota(q ?? [])
    };
  });

  const totals: TaskReport['totals'] = { ...zero(), runs: runs.length, failedRuns: 0, partialRuns: 0, runsWithoutTokens: 0, agentMinutes: 0, wallMinutes: 0, quota: [] };
  let cost: number | undefined;
  const agentRows = new Map<Id, TaskReportAgent>();
  const modelRows = new Map<string, TaskReportModel>();
  for (const r of runs) {
    addTokens(totals, r);
    if (!r.ok) totals.failedRuns++;
    if (r.partial) totals.partialRuns++;
    if (r.noTokens) totals.runsWithoutTokens++;
    totals.agentMinutes += r.durationMs / 60_000;
    addQuota(totals.quota, r.quota);
    if (r.costUsd !== undefined) cost = (cost ?? 0) + r.costUsd;

    const a = byId.get(r.agentId);
    let row = agentRows.get(r.agentId);
    if (!row) {
      row = { agentId: r.agentId, title: a ? (a.role === 'main' ? 'Lead' : a.title) : 'Unknown agent', role: a?.role ?? 'other', state: a?.state ?? 'done', runs: 0, minutes: 0, ...zero(), quota: [], models: [] };
      agentRows.set(r.agentId, row);
    }
    row.runs++; row.minutes += r.durationMs / 60_000; addTokens(row, r); addQuota(row.quota, r.quota);
    if (r.costUsd !== undefined) row.costUsd = (row.costUsd ?? 0) + r.costUsd;
    const used = row.models.find((m) => m.cli === r.cli && m.model === r.model);
    if (used) used.runs++; else row.models.push({ cli: r.cli, model: r.model, runs: 1 });

    const mk = `${r.cli}/${r.model}`;
    let mr = modelRows.get(mk);
    if (!mr) { mr = { cli: r.cli, model: r.model, runs: 0, minutes: 0, roles: [], ...zero(), quota: [] }; modelRows.set(mk, mr); }
    mr.runs++; mr.minutes += r.durationMs / 60_000; addTokens(mr, r); addQuota(mr.quota, r.quota);
    if (!mr.roles.includes(r.role)) mr.roles.push(r.role);
    if (r.costUsd !== undefined) mr.costUsd = (mr.costUsd ?? 0) + r.costUsd;
  }
  if (runs.length) {
    const start = Math.min(...runs.map((r) => r.time - r.durationMs)), end = Math.max(...runs.map((r) => r.time));
    totals.wallMinutes = r1((end - start) / 60_000);
  }
  totals.agentMinutes = r1(totals.agentMinutes);
  totals.billableKTok = r4(totals.billableKTok);
  totals.quota = roundQuota(totals.quota);
  if (cost !== undefined) totals.costUsd = r4(cost);
  // Helpers that never ran (queued, refused, stopped before a CLI started) still belong to the task.
  for (const h of helpers) if (!agentRows.has(h.id)) agentRows.set(h.id, { agentId: h.id, title: h.title, role: h.role, state: h.state, runs: 0, minutes: 0, ...zero(), quota: [], models: [] });
  const tidy = <T extends TaskReportTokens & { minutes: number; quota: QuotaEstimate[]; costUsd?: number }>(x: T): T =>
    ({ ...x, minutes: r1(x.minutes), billableKTok: r4(x.billableKTok), quota: roundQuota(x.quota), ...(x.costUsd !== undefined ? { costUsd: r4(x.costUsd) } : {}) });

  const roleOrder: AgentRole[] = ['main', 'planner', 'implementer', 'reviewer', 'other'];
  const notes = [
    "Quota figures are Harbor's estimates (billable tokens x the catalog's cost per token x the calibrated quota per token), not the provider's own quota readings."
  ];
  if (runs.some((r) => r.role === 'main')) notes.push("Lead runs include the concierge's first pass: both run as the project's lead agent.");
  if (totals.runsWithoutTokens) notes.push(`${totals.runsWithoutTokens} run(s) reported no token counts: their quota is unknown and not included.`);
  if (totals.partialRuns) notes.push(`${totals.partialRuns} run(s) ended before the CLI's final usage report: their tokens are a lower bound.`);
  if (totals.costUsd !== undefined) notes.push('costUsd is what the CLI itself reported for its runs (subscription runs are not billed per run).');
  const keep = i.keepMs;
  const earliest = Math.min(...i.messages.filter((m) => m.conversationId === conv.id).map((m) => m.time), ...helpers.map((h) => h.created));
  if (keep !== undefined && earliest < i.now - keep) notes.push(`Harbor keeps run records for ${Math.round(keep / 86_400_000)} days: runs before ${new Date(i.now - keep).toISOString().slice(0, 10)} are missing from this report.`);

  return {
    conversationId: conv.id, projectId: conv.projectId, generatedAt: i.now, totals,
    agents: [...agentRows.values()].map(tidy).sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role) || (a.title < b.title ? -1 : 1)),
    byModel: [...modelRows.values()].map(tidy).sort((a, b) => b.billableKTok - a.billableKTok || (a.cli + a.model < b.cli + b.model ? -1 : 1)),
    runs, decisions: decisionsOf(i.messages), notes
  };
}
