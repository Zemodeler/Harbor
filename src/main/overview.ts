import { existsSync } from 'node:fs';
import type { CliId, GlobalUsage, Id, Project, ProjectOverview, ProjectsOverview, SearchAllHit, SearchAllOptions, SearchAllPage, UsageRow, UsageWindow } from '../shared/api';
import { billableKTok } from './calibration';
import type { Git } from './git';
import { USAGE_KEEP_MS, type Store } from './store';
import type { UsageEvent } from './types';

/**
 * Read-only views across every project (contract 0.1.50-0.1.52): the overview home screen, cross-project search and the global usage
 * numbers. Nothing here changes a file, a ref or a record. Usage is only ever what Harbor itself ran, labelled an estimate.
 */

const DAY_MS = 86_400_000;
const LIVE = ['queued', 'working'];

export interface OverviewDeps { git: Git; store: Store; now: number; windows: () => UsageWindow[] }

async function overviewOf(project: Project, d: OverviewDeps, usage: readonly UsageEvent[]): Promise<ProjectOverview> {
  const agents = d.store.listAgentRecords(project.id);
  const convs = d.store.listConversations(project.id);
  const since = d.now - 7 * DAY_MS;
  const recent = usage.filter((u) => u.projectId === project.id && u.time >= since);
  let kTok = 0, cost = 0, anyCost = false;
  for (const u of recent) { kTok += billableKTok(u) ?? 0; if (u.costUsd !== undefined) { cost += u.costUsd; anyCost = true; } }
  const o: ProjectOverview = {
    projectId: project.id,
    running: agents.filter((a) => LIVE.includes(a.state)).length,
    waiting: agents.filter((a) => a.state === 'waiting' && a.role !== 'main').length + convs.filter((c) => c.activity?.state === 'waiting').length,
    unmergedBranches: 0, unpushedCommits: 0,
    lastActivity: Math.max(project.lastOpened, ...convs.map((c) => c.updated)),
    conversations: convs.length,
    recentRuns: recent.length, recentKTok: Math.round(kTok * 10) / 10,
    ...(anyCost ? { recentCostUsd: Math.round(cost * 1e4) / 1e4 } : {})
  };
  if (!existsSync(project.path)) return { ...o, missing: true };
  try {
    if (await d.git.isRepoWithCommits(project.path)) {
      o.unmergedBranches = (await d.git.harborBranches(project.path)).filter((b) => !b.merged).length;
      o.unpushedCommits = await d.git.unpushedOnAnyBranch(project.path);
    }
  } catch { o.gitFailed = true; }
  return o;
}

/** Overview of every project; git is asked for three projects at a time so a long list does not spawn a process per project at once. */
export async function buildOverview(projects: readonly Project[], d: OverviewDeps): Promise<ProjectsOverview> {
  const usage = d.store.listUsage();
  const out: ProjectOverview[] = new Array(projects.length);
  let next = 0;
  const worker = async () => { while (next < projects.length) { const i = next++; out[i] = await overviewOf(projects[i]!, d, usage); } };
  await Promise.all(Array.from({ length: Math.min(3, projects.length) }, worker));
  return { generatedAt: d.now, projects: out, quota: d.windows() };
}

export const SEARCH_CAP = 500;
const PER_CONVERSATION = 3;

/** Titles and messages of every project's conversations (the lead's, as in the sidebar), newest first; the result is cut at SEARCH_CAP hits. */
export function searchAll(query: string, opts: SearchAllOptions | undefined, d: { store: Store; projects: readonly Project[] }): SearchAllPage {
  const term = String(query ?? '').trim().toLocaleLowerCase();
  const limit = Math.min(100, Math.max(1, Math.floor(opts?.limit ?? 25)));
  const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
  if (!term) return { hits: [], total: 0, hasMore: false };
  const hits: SearchAllHit[] = [];
  let capped = false;
  outer: for (const p of d.projects) {
    if (opts?.projectId && p.id !== opts.projectId) continue;
    const mainId = d.store.mainAgent(p.id)?.id;
    for (const c of d.store.listConversations(p.id)) {
      if (c.agentId !== mainId) continue;
      const base = { projectId: p.id, projectName: p.name, ...(p.archived ? { projectArchived: true as const } : {}), conversation: { ...c } };
      if (c.title.toLocaleLowerCase().includes(term)) {
        hits.push({ ...base, kind: 'title', time: c.updated });
        if (hits.length >= SEARCH_CAP) { capped = true; break outer; }
      }
      let n = 0;
      for (const m of d.store.listMessages(c.id)) {
        if (m.role === 'tool') continue;
        const at = m.text.toLocaleLowerCase().indexOf(term);
        if (at < 0) continue;
        hits.push({ ...base, kind: 'message', messageId: m.id, time: m.time, excerpt: m.text.slice(Math.max(0, at - 50), at + 150) });
        if (hits.length >= SEARCH_CAP) { capped = true; break outer; }
        if (++n >= PER_CONVERSATION) break;
      }
    }
  }
  hits.sort((a, b) => b.time - a.time);
  return { hits: hits.slice(offset, offset + limit), total: hits.length, hasMore: offset + limit < hits.length, ...(capped ? { capped: true } : {}) };
}

const emptyRow = (): UsageRow => ({ runs: 0, failedRuns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, billableKTok: 0, minutes: 0 });
function add(row: UsageRow, u: UsageEvent): void {
  row.runs += 1; if (!u.ok) row.failedRuns += 1;
  row.inputTokens += u.inputTokens ?? 0; row.outputTokens += u.outputTokens ?? 0;
  row.cacheReadTokens += u.cacheReadTokens ?? 0; row.cacheWriteTokens += u.cacheWriteTokens ?? 0;
  row.billableKTok += billableKTok(u) ?? 0; row.minutes += (u.durationMs || 0) / 60_000;
  if (u.costUsd !== undefined) row.costUsd = (row.costUsd ?? 0) + u.costUsd;
}
const rounded = (r: UsageRow): UsageRow => ({ ...r, billableKTok: Math.round(r.billableKTok * 10) / 10, minutes: Math.round(r.minutes * 10) / 10, ...(r.costUsd !== undefined ? { costUsd: Math.round(r.costUsd * 1e4) / 1e4 } : {}) });

/** Harbor's own usage records (kept 8 days) grouped per CLI and per project, plus the folded totals of older runs. An estimate by construction. */
export function globalUsage(d: { store: Store; projects: readonly Project[]; now: number; windows: UsageWindow[] }): GlobalUsage {
  const total = emptyRow();
  const byCli = new Map<CliId, UsageRow>(), byProject = new Map<Id, UsageRow>();
  let noTokens = 0, partial = 0;
  for (const u of d.store.listUsage()) {
    add(total, u);
    add(byCli.get(u.cli) ?? (byCli.set(u.cli, emptyRow()), byCli.get(u.cli)!), u);
    add(byProject.get(u.projectId) ?? (byProject.set(u.projectId, emptyRow()), byProject.get(u.projectId)!), u);
    if (billableKTok(u) === undefined) noTokens++;
    if (u.partial) partial++;
  }
  const names = new Map(d.projects.map((p) => [p.id, p.name]));
  const archive = d.store.usageArchive();
  const notes = [
    'These numbers count only what Harbor ran, from its own records of the last 8 days. They are an estimate and not your provider\'s quota or bill.',
    ...(noTokens ? [`${noTokens} run${noTokens === 1 ? '' : 's'} reported no token counts (quota unknown, not zero).`] : []),
    ...(partial ? [`${partial} run${partial === 1 ? ' was' : 's were'} stopped before the final usage report, so those figures are lower bounds.`] : [])
  ];
  return {
    estimate: true, since: d.now - USAGE_KEEP_MS, total: rounded(total),
    byCli: [...byCli].map(([cli, r]) => ({ cli, ...rounded(r) })).sort((a, b) => b.billableKTok - a.billableKTok),
    byProject: [...byProject].map(([projectId, r]) => ({ projectId, ...(names.has(projectId) ? { projectName: names.get(projectId)! } : { removed: true as const }), ...rounded(r) })).sort((a, b) => b.billableKTok - a.billableKTok),
    lifetime: { runs: archive.runs, inputTokens: archive.inputTokens, outputTokens: archive.outputTokens, costUsd: Math.round(archive.costUsd * 1e4) / 1e4 },
    windows: d.windows, notes
  };
}
