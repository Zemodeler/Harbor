import type { QuotaEstimate, TaskReportTokens } from '../shared/api';

/**
 * Eval harness, pure half: the task-set format, one task's outcome per arm, and the aggregation and report text (scripts/eval runs
 * the tasks). Quality = the task's own acceptance command (plus the reviewer verdict where Harbor ran one); cost = Harbor's usage
 * ESTIMATE (tokens and estimated quota per pool, never the provider's figure); time = wall time of the arm. Pools of different
 * providers are never added up or compared with each other (docs/routing-and-usage.md).
 */

export type EvalArm = 'harbor' | 'baseline';
export const EVAL_ARMS: readonly EvalArm[] = ['harbor', 'baseline'];

/** What the fake CLI does for one arm (fake mode only). `solution: null` writes nothing, to script a failure. */
export interface EvalFakeArm {
  solution?: Record<string, string> | null;
  /** Tokens each fake run reports (default 10k in / 1k out). */
  tokens?: { input: number; output: number };
}

export interface EvalTask {
  id: string;
  prompt: string;
  /** The repository the task starts from: files inline, and/or a folder relative to the task-set file. */
  fixture: { files?: Record<string, string>; dir?: string };
  /** Run in the result folder without a shell; exit code 0 = accepted. `node` runs the Node that runs the harness. */
  acceptance: { command: string; args?: string[]; timeoutMs?: number };
  fake?: {
    /** Files a successful fake run writes (both arms unless an arm overrides it). */
    solution?: Record<string, string>;
    /** `delegate` (default): the lead delegates an implementer and a reviewer; `solo`: the lead edits the project folder itself. */
    harbor?: EvalFakeArm & { plan?: 'delegate' | 'solo'; verdict?: 'approve' | 'changes' };
    baseline?: EvalFakeArm;
  };
}

export interface EvalTaskSet { version: 1; name: string; tasks: EvalTask[] }

const ID = /^[A-Za-z0-9._-]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** A relative path that stays inside the fixture folder (no drive, no root, no `..`). */
const safeRel = (p: string) => !!p && !/^[A-Za-z]:|^[\\/]/.test(p) && !p.split(/[\\/]/).includes('..') && !/[\0\r\n]/.test(p);

function files(v: unknown, where: string): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) throw new Error(`${where} must map relative paths to file contents.`);
  for (const [k, c] of Object.entries(v)) {
    if (!safeRel(k)) throw new Error(`${where}: "${k}" is not a relative path inside the repository.`);
    if (typeof c !== 'string') throw new Error(`${where}: "${k}" must be text.`);
  }
  return v as Record<string, string>;
}

function fakeArm(v: unknown, where: string): EvalFakeArm & { plan?: 'delegate' | 'solo'; verdict?: 'approve' | 'changes' } {
  if (!isObj(v)) throw new Error(`${where} must be an object.`);
  const out: EvalFakeArm & { plan?: 'delegate' | 'solo'; verdict?: 'approve' | 'changes' } = {};
  if (v['solution'] === null) out.solution = null; else if (v['solution'] !== undefined) out.solution = files(v['solution'], `${where}.solution`);
  const t = v['tokens'];
  if (t !== undefined) {
    if (!isObj(t) || typeof t['input'] !== 'number' || typeof t['output'] !== 'number' || t['input'] < 0 || t['output'] < 0) throw new Error(`${where}.tokens must be { input, output } (non-negative numbers).`);
    out.tokens = { input: t['input'], output: t['output'] };
  }
  if (v['plan'] !== undefined) { if (v['plan'] !== 'delegate' && v['plan'] !== 'solo') throw new Error(`${where}.plan must be delegate or solo.`); out.plan = v['plan']; }
  if (v['verdict'] !== undefined) { if (v['verdict'] !== 'approve' && v['verdict'] !== 'changes') throw new Error(`${where}.verdict must be approve or changes.`); out.verdict = v['verdict']; }
  return out;
}

/** Validates a parsed task-set file; throws a readable error naming the first problem. */
export function parseTaskSet(j: unknown): EvalTaskSet {
  if (!isObj(j)) throw new Error('A task set is an object { version: 1, name, tasks: [...] }.');
  if (j['version'] !== 1) throw new Error('Unsupported task-set version (expected 1).');
  if (typeof j['name'] !== 'string' || !j['name'].trim()) throw new Error('The task set needs a name.');
  if (!Array.isArray(j['tasks']) || !j['tasks'].length) throw new Error('The task set needs at least one task.');
  const seen = new Set<string>();
  const tasks = j['tasks'].map((t: unknown, i): EvalTask => {
    const where = `tasks[${i}]`;
    if (!isObj(t)) throw new Error(`${where} must be an object.`);
    const id = t['id'];
    if (typeof id !== 'string' || !ID.test(id)) throw new Error(`${where}.id must be 1-64 letters, digits, dots, dashes or underscores.`);
    if (seen.has(id)) throw new Error(`Duplicate task id ${id}.`);
    seen.add(id);
    if (typeof t['prompt'] !== 'string' || !t['prompt'].trim()) throw new Error(`${id}: prompt is required.`);
    const fx = t['fixture'];
    if (!isObj(fx)) throw new Error(`${id}: fixture must be { files?, dir? }.`);
    if (fx['dir'] !== undefined && (typeof fx['dir'] !== 'string' || !safeRel(fx['dir']))) throw new Error(`${id}: fixture.dir must be a relative folder.`);
    const fixture = { ...(fx['files'] !== undefined ? { files: files(fx['files'], `${id}.fixture.files`)! } : {}), ...(typeof fx['dir'] === 'string' ? { dir: fx['dir'] } : {}) };
    if (!fixture.files && !fixture.dir) throw new Error(`${id}: fixture needs files or a dir.`);
    const ac = t['acceptance'];
    if (!isObj(ac) || typeof ac['command'] !== 'string' || !ac['command'].trim()) throw new Error(`${id}: acceptance.command is required.`);
    if (ac['args'] !== undefined && (!Array.isArray(ac['args']) || !ac['args'].every((a) => typeof a === 'string'))) throw new Error(`${id}: acceptance.args must be a list of strings.`);
    if (ac['timeoutMs'] !== undefined && (typeof ac['timeoutMs'] !== 'number' || !(ac['timeoutMs'] > 0))) throw new Error(`${id}: acceptance.timeoutMs must be a positive number.`);
    const acceptance = { command: ac['command'], ...(ac['args'] ? { args: ac['args'] as string[] } : {}), ...(typeof ac['timeoutMs'] === 'number' ? { timeoutMs: ac['timeoutMs'] } : {}) };
    let fake: EvalTask['fake'];
    if (t['fake'] !== undefined) {
      const f = t['fake'];
      if (!isObj(f)) throw new Error(`${id}: fake must be an object.`);
      fake = {
        ...(f['solution'] !== undefined ? { solution: files(f['solution'], `${id}.fake.solution`)! } : {}),
        ...(f['harbor'] !== undefined ? { harbor: fakeArm(f['harbor'], `${id}.fake.harbor`) } : {}),
        ...(f['baseline'] !== undefined ? { baseline: fakeArm(f['baseline'], `${id}.fake.baseline`) } : {})
      };
    }
    return { id, prompt: t['prompt'], fixture, acceptance, ...(fake ? { fake } : {}) };
  });
  return { version: 1, name: j['name'].trim(), tasks };
}

/** One task on one arm. */
export interface EvalOutcome {
  taskId: string;
  arm: EvalArm;
  accepted: boolean;
  acceptance: { exitCode: number | null; timedOut?: boolean; output: string };
  /** The reviewer's verdict on the work Harbor kept ('none' = no reviewer ran; the baseline never has one). */
  verdict: 'approve' | 'changes' | 'none';
  /** How the result reached the folder the acceptance ran in. */
  integration: 'in-place' | 'harbor' | 'harness-merge' | 'none';
  runs: number;
  failedRuns: number;
  tokens: TaskReportTokens;
  /** ESTIMATED share of each provider window (Harbor's usage estimate). */
  quota: QuotaEstimate[];
  wallMs: number;
  agentMinutes: number;
  /** cli/model of every run, in order. */
  models: string[];
  /** Why the arm did not complete normally (timeout, crash, merge conflict). */
  error?: string;
}

export interface EvalArmSummary {
  arm: EvalArm;
  tasks: number;
  accepted: number;
  acceptRate: number;
  reviewed: number;
  approved: number;
  runs: number;
  meanBillableKTok: number;
  /** Mean ESTIMATED weekly % per pool, over the tasks of this arm. */
  meanWeeklyQuota: Array<{ pool: string; pct: number }>;
  meanWallSec: number;
}

export interface EvalReport {
  name: string;
  mode: 'fake' | 'real';
  generatedAt: number;
  outcomes: EvalOutcome[];
  summary: EvalArmSummary[];
  /** Harbor against the baseline, on tasks both arms ran. Ratios are harbor / baseline (undefined when the baseline is 0). */
  comparison?: { tasks: number; acceptDelta: number; tokensRatio?: number; wallRatio?: number; onlyHarbor: string[]; onlyBaseline: string[] };
  notes: string[];
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function summarizeArm(arm: EvalArm, outs: readonly EvalOutcome[]): EvalArmSummary {
  const pools = [...new Set(outs.flatMap((o) => o.quota.filter((q) => q.period === 'weekly').map((q) => q.pool)))].sort();
  return {
    arm, tasks: outs.length, accepted: outs.filter((o) => o.accepted).length, acceptRate: round(outs.length ? outs.filter((o) => o.accepted).length / outs.length : 0),
    reviewed: outs.filter((o) => o.verdict !== 'none').length, approved: outs.filter((o) => o.verdict === 'approve').length,
    runs: outs.reduce((s, o) => s + o.runs, 0), meanBillableKTok: round(mean(outs.map((o) => o.tokens.billableKTok))),
    meanWeeklyQuota: pools.map((pool) => ({ pool, pct: round(mean(outs.map((o) => o.quota.find((q) => q.pool === pool && q.period === 'weekly')?.pct ?? 0)), 4) })),
    meanWallSec: round(mean(outs.map((o) => o.wallMs / 1000)), 1)
  };
}

export function aggregateEval(o: { name: string; mode: 'fake' | 'real'; generatedAt: number; outcomes: EvalOutcome[] }): EvalReport {
  const arms = EVAL_ARMS.filter((a) => o.outcomes.some((x) => x.arm === a));
  const summary = arms.map((a) => summarizeArm(a, o.outcomes.filter((x) => x.arm === a)));
  const notes = [
    "Cost is Harbor's usage estimate: tokens the CLIs reported and the estimated share of each provider window. It is not the provider's quota, and pools of different providers are not comparable.",
    'Quality is the task\'s acceptance command (exit code 0) and, for Harbor, the reviewer verdict when one ran.'
  ];
  if (o.mode === 'fake') notes.unshift('FAKE MODE: every CLI run was scripted by the task set (fake adapters). The numbers test the harness and Harbor\'s orchestration path, not model quality or real cost.');
  let comparison: EvalReport['comparison'];
  if (arms.length === 2) {
    const h = new Map(o.outcomes.filter((x) => x.arm === 'harbor').map((x) => [x.taskId, x]));
    const b = new Map(o.outcomes.filter((x) => x.arm === 'baseline').map((x) => [x.taskId, x]));
    const both = [...h.keys()].filter((k) => b.has(k));
    const sum = (m: Map<string, EvalOutcome>, f: (x: EvalOutcome) => number) => both.reduce((s, k) => s + f(m.get(k)!), 0);
    const ratio = (x: number, y: number) => (y > 0 ? round(x / y) : undefined);
    const tokensRatio = ratio(sum(h, (x) => x.tokens.billableKTok), sum(b, (x) => x.tokens.billableKTok));
    const wallRatio = ratio(sum(h, (x) => x.wallMs), sum(b, (x) => x.wallMs));
    comparison = {
      tasks: both.length, acceptDelta: sum(h, (x) => Number(x.accepted)) - sum(b, (x) => Number(x.accepted)),
      ...(tokensRatio !== undefined ? { tokensRatio } : {}), ...(wallRatio !== undefined ? { wallRatio } : {}),
      onlyHarbor: both.filter((k) => h.get(k)!.accepted && !b.get(k)!.accepted), onlyBaseline: both.filter((k) => !h.get(k)!.accepted && b.get(k)!.accepted)
    };
  }
  return { name: o.name, mode: o.mode, generatedAt: o.generatedAt, outcomes: o.outcomes, summary, ...(comparison ? { comparison } : {}), notes };
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** The report as markdown: summary per arm, the comparison, then one row per task and arm. */
export function evalMarkdown(r: EvalReport): string {
  const L: string[] = [`# Eval: ${r.name}`, '', `Mode: **${r.mode}** · generated ${new Date(r.generatedAt).toISOString()}`, ''];
  for (const n of r.notes) L.push(`> ${n}`);
  L.push('', '## Summary', '', '| Arm | Accepted | Reviewed (approved) | Runs | Mean billable k-tokens | Mean weekly quota (estimate) | Mean wall (s) |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of r.summary) {
    const q = s.meanWeeklyQuota.map((x) => `${x.pool} ${x.pct}%`).join(', ') || 'unknown';
    L.push(`| ${s.arm} | ${s.accepted}/${s.tasks} (${Math.round(s.acceptRate * 100)}%) | ${s.reviewed} (${s.approved}) | ${s.runs} | ${s.meanBillableKTok} | ${q} | ${s.meanWallSec} |`);
  }
  if (r.comparison) {
    const c = r.comparison;
    L.push('', '## Harbor vs single agent', '', `- Tasks compared: ${c.tasks}`, `- Accepted: Harbor ${c.acceptDelta >= 0 ? '+' : ''}${c.acceptDelta} vs baseline`,
      `- Billable tokens (Harbor / baseline): ${c.tokensRatio ?? 'n/a'}`, `- Wall time (Harbor / baseline): ${c.wallRatio ?? 'n/a'}`);
    if (c.onlyHarbor.length) L.push(`- Only Harbor passed: ${c.onlyHarbor.join(', ')}`);
    if (c.onlyBaseline.length) L.push(`- Only the baseline passed: ${c.onlyBaseline.join(', ')}`);
  }
  L.push('', '## Tasks', '', '| Task | Arm | Accepted | Verdict | Integration | Runs (failed) | Billable k-tokens | Quota (estimate) | Wall (s) | Models | Error |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const o of r.outcomes) {
    const q = o.quota.filter((x) => x.period === 'weekly').map((x) => `${x.pool} ${round(x.pct, 4)}%`).join(', ') || 'unknown';
    L.push(`| ${cell(o.taskId)} | ${o.arm} | ${o.accepted ? 'yes' : 'no'}${o.acceptance.timedOut ? ' (timed out)' : ''} | ${o.verdict} | ${o.integration} | ${o.runs} (${o.failedRuns}) | ${round(o.tokens.billableKTok)} | ${q} | ${round(o.wallMs / 1000, 1)} | ${cell([...new Set(o.models)].join(', ')) || '-'} | ${cell(o.error ?? '')} |`);
  }
  return L.join('\n') + '\n';
}
