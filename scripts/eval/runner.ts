/**
 * Eval runner: each task of a task set runs in its own temp git repository, through Harbor (the real orchestrator: concierge, lead,
 * helpers in worktrees) and through a single-agent baseline (one CLI run in the repository), and is then judged by the task's
 * acceptance command. Scoring and the report are pure (src/main/evalScore.ts).
 *
 * Fake mode (default) scripts every CLI run from the task set (FakeAdapter): CI-safe, no CLI, network or quota. Real mode runs the
 * installed CLIs and spends subscription quota; only index.ts can start it, behind an explicit flag.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CliId, HarborEvent } from '../../src/shared/api';
import { FakeAdapter, type FakeScript } from '../../src/main/adapters/fake';
import type { Chunk, CliAdapter } from '../../src/main/adapters/types';
import { DEFAULT_CATALOG, type CatalogEntry } from '../../src/main/clis/capabilities';
import type { ResolvedCli } from '../../src/main/clis/discovery';
import { aggregateEval, type EvalArm, type EvalOutcome, type EvalReport, type EvalTask, type EvalTaskSet } from '../../src/main/evalScore';
import { RunUsage } from '../../src/main/runUsage';
import { createHarborService } from '../../src/main/service';
import { billableKTok } from '../../src/main/calibration';
import { runQuota } from '../../src/main/taskReport';

export interface EvalRunOptions {
  taskSet: EvalTaskSet;
  /** Folder fixture `dir`s are relative to (the task-set file's folder). */
  baseDir: string;
  mode: 'fake' | 'real';
  arms?: EvalArm[];
  /** Real mode only: installed CLIs and the baseline's adapter. Fake mode never touches them. */
  real?: { discover: () => Promise<ResolvedCli[]>; baselineAdapter: (cli: ResolvedCli) => CliAdapter | undefined };
  /** Baseline CLI and model (default claude, claude-sonnet-5-5 for claude, the CLI's default otherwise). */
  baselineCli?: CliId;
  baselineModel?: string;
  /** Per task and arm (default 2 minutes fake, 60 minutes real). */
  taskTimeoutMs?: number;
  tmpRoot?: string;
  /** Keep the temp repositories (for inspection). */
  keep?: boolean;
  log?: (line: string) => void;
  now?: () => number;
  catalog?: CatalogEntry[];
}

const DEFAULT_TOKENS = { input: 10_000, output: 1_000 };

function git(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = resolve(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

/** A fresh repository on `main` holding the task's fixture, committed. */
export function makeRepo(task: EvalTask, baseDir: string, root: string): string {
  const repo = mkdtempSync(join(root, `${task.id}-`));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'eval@harbor.local');
  git(repo, 'config', 'user.name', 'Harbor eval');
  if (task.fixture.dir) cpSync(resolve(baseDir, task.fixture.dir), repo, { recursive: true });
  if (task.fixture.files) writeFiles(repo, task.fixture.files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'eval fixture');
  return repo;
}

/** The task's acceptance command in `cwd`, without a shell. */
export function runAcceptance(task: EvalTask, cwd: string): EvalOutcome['acceptance'] & { ok: boolean } {
  const cmd = task.acceptance.command === 'node' ? process.execPath : task.acceptance.command;
  const r = spawnSync(cmd, task.acceptance.args ?? [], { cwd, encoding: 'utf8', timeout: task.acceptance.timeoutMs ?? 120_000, windowsHide: true });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error.message) : ''}`.trim().slice(-2000);
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  return { ok: r.status === 0 && !timedOut, exitCode: r.status, ...(timedOut ? { timedOut: true } : {}), output };
}

const say = (text: string): Chunk => ({ kind: 'text', text });
const usage = (t: { input: number; output: number }): Chunk => ({ kind: 'usage', inputTokens: t.input, outputTokens: t.output });
const resultLine = (r: object) => `HARBOR_RESULT: ${JSON.stringify(r)}`;

/** The scripted CLI for the Harbor arm: concierge escalates, the lead delegates (or edits itself), helpers write the solution. */
export function harborFakeScript(task: EvalTask): FakeScript {
  const arm = task.fake?.harbor ?? {};
  const solution = arm.solution !== undefined ? arm.solution : task.fake?.solution;
  const tokens = arm.tokens ?? DEFAULT_TOKENS;
  let delegated = false;
  return (prompt, o) => {
    const sys = o.systemPrompt ?? '';
    if (sys.includes('front desk')) return [say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } })), usage(tokens)];
    if (sys.includes('LEAD agent')) {
      if (delegated) return [say('All helpers reported; the task is done.'), usage(tokens)];
      delegated = true;
      if (arm.plan === 'solo') {
        if (solution) writeFiles(o.cwd, solution);
        return [say('I made the change myself.'), usage(tokens)];
      }
      const files = Object.keys(solution ?? {});
      return [say(['Plan: one implementer, then a review.',
        `HARBOR_DELEGATE: ${JSON.stringify({ ref: 'impl', title: `Implement ${task.id}`, role: 'implementer', instructions: `Make this change: ${task.prompt}`, complexity: 'low', ...(files.length ? { files } : {}) })}`,
        `HARBOR_DELEGATE: ${JSON.stringify({ ref: 'review', title: `Review ${task.id}`, role: 'reviewer', instructions: 'Review the implementer\'s change against the request.', complexity: 'low', dependsOn: ['impl'] })}`
      ].join('\n')), usage(tokens)];
    }
    if (o.permission !== 'read-only') {
      if (solution) writeFiles(o.cwd, solution);
      return [say(['Done.', resultLine({ outcome: solution ? 'done' : 'blocked', summary: solution ? 'Implemented.' : 'Could not do it.', checks: [] })].join('\n')), usage(tokens)];
    }
    return [say(['Reviewed.', resultLine({ outcome: 'done', summary: 'Reviewed.', verdict: arm.verdict ?? 'approve', checks: [] })].join('\n')), usage(tokens)];
  };
}

/** The scripted CLI for the baseline: one run that writes the solution. */
export function baselineFakeScript(task: EvalTask): FakeScript {
  const arm = task.fake?.baseline ?? {};
  const solution = arm.solution !== undefined ? arm.solution : task.fake?.solution;
  return (_prompt, o) => {
    if (solution) writeFiles(o.cwd, solution);
    return [say(solution ? 'Done.' : 'I could not finish this.'), usage(arm.tokens ?? DEFAULT_TOKENS)];
  };
}

const FAKE_CLI: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' } as ResolvedCli;
const zeroTokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, billableKTok: 0 };

async function runHarbor(task: EvalTask, repo: string, o: EvalRunOptions, root: string): Promise<EvalOutcome> {
  const now = o.now ?? Date.now;
  const fake = o.mode === 'fake' ? new FakeAdapter('claude', harborFakeScript(task)) : undefined;
  const svc = createHarborService({
    // Real mode gets its own data folder: the eval never reads or writes the owner's Harbor state.
    ...(o.mode === 'real' ? { dataDir: mkdtempSync(join(root, 'data-')) } : {}),
    discover: fake ? async () => [FAKE_CLI] : o.real!.discover,
    ...(fake ? { adapterFor: () => fake } : {}),
    worktreesRoot: join(root, `wt-${task.id}`), autoApproveChecks: true, ...(o.catalog ? { catalog: o.catalog } : {})
  });
  // Nobody is at the keyboard: questions get a fixed answer and any permission request (free reset, conflict) is declined.
  const off = svc.onEvent((e: HarborEvent) => {
    if (e.type === 'question') void svc.answerQuestion(e.requestId, 'No one can answer during this evaluation: use your best judgement and keep going.').catch(() => {});
    if (e.type === 'permission') void svc.answerPermission(e.requestId, false).catch(() => {});
  });
  const t0 = now();
  let error: string | undefined;
  let convId = '';
  try {
    const project = (await svc.addProject(repo))!;
    const [conv] = await svc.listConversations(project.id);
    convId = conv!.id;
    // Auto mode: no tool-permission prompts (the baseline runs with full permission too).
    await svc.setConversationMode(convId, 'auto');
    await svc.send(convId, task.prompt);
    try { await svc.whenIdle(o.taskTimeoutMs ?? (o.mode === 'fake' ? 120_000 : 60 * 60_000)); }
    catch (e) { error = `Timed out: ${(e as Error).message}`; await svc.stopConversation(convId); }
    const wallMs = now() - t0;

    const agents = svc.store.listAgentRecords(project.id).filter((a) => a.role !== 'main' && a.parentConversationId === convId);
    const reviewers = agents.filter((a) => a.role === 'reviewer' && a.result?.verdict).sort((a, b) => (a.updated ?? a.created) - (b.updated ?? b.created));
    const verdict = reviewers.length ? reviewers[reviewers.length - 1]!.result!.verdict! : 'none';

    // Bring the kept work into the project folder: Harbor's own integration when the lead made one, else a plain merge of every
    // finished edit helper's branch (this repository is the harness's own temp copy).
    let integration: EvalOutcome['integration'] = 'none';
    const integrator = agents.find((a) => a.integration && a.state === 'done');
    if (git(repo, 'status', '--porcelain').out) { git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'eval: lead edits'); integration = 'in-place'; }
    if (integrator) {
      try { await svc.applyIntegration(integrator.id); integration = 'harbor'; } catch (e) { error = `Integration not applied: ${(e as Error).message}`; }
    } else {
      for (const a of agents.filter((x) => x.branch && !x.readOnly && x.role !== 'reviewer' && !x.integration && x.state === 'done').sort((x, y) => x.created - y.created)) {
        const m = git(repo, 'merge', '--no-ff', '--no-edit', a.branch!);
        if (m.ok) integration = 'harness-merge';
        else { git(repo, 'merge', '--abort'); error = `Merge of ${a.branch} failed: ${m.out.slice(0, 300)}`; }
      }
    }
    const acc = runAcceptance(task, repo);
    const report = await svc.getTaskReport(convId);
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, billableKTok: k } = report.totals;
    return {
      taskId: task.id, arm: 'harbor', accepted: acc.ok, acceptance: { exitCode: acc.exitCode, ...(acc.timedOut ? { timedOut: true } : {}), output: acc.output },
      verdict, integration, runs: report.totals.runs, failedRuns: report.totals.failedRuns, tokens: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, billableKTok: k },
      quota: report.totals.quota, wallMs, agentMinutes: report.totals.agentMinutes, models: report.runs.map((r) => `${r.cli}/${r.model}`), ...(error ? { error } : {})
    };
  } catch (e) {
    return { taskId: task.id, arm: 'harbor', accepted: false, acceptance: { exitCode: null, output: '' }, verdict: 'none', integration: 'none', runs: 0, failedRuns: 0, tokens: zeroTokens, quota: [], wallMs: now() - t0, agentMinutes: 0, models: [], error: `Harbor arm crashed: ${(e as Error).message}` };
  } finally {
    off();
    await svc.shutdown();
  }
}

async function runBaseline(task: EvalTask, repo: string, o: EvalRunOptions): Promise<EvalOutcome> {
  const now = o.now ?? Date.now;
  const cliId = o.baselineCli ?? 'claude';
  const model = o.baselineModel ?? (cliId === 'claude' ? 'claude-sonnet-5-5' : 'default');
  let adapter: CliAdapter | undefined;
  if (o.mode === 'fake') adapter = new FakeAdapter(cliId, baselineFakeScript(task));
  else {
    const cli = (await o.real!.discover()).find((c) => c.id === cliId && c.installed);
    adapter = cli && o.real!.baselineAdapter(cli);
  }
  const t0 = now();
  if (!adapter) return { taskId: task.id, arm: 'baseline', accepted: false, acceptance: { exitCode: null, output: '' }, verdict: 'none', integration: 'none', runs: 0, failedRuns: 0, tokens: zeroTokens, quota: [], wallMs: 0, agentMinutes: 0, models: [], error: `${cliId} is not installed or has no adapter` };
  const u = new RunUsage();
  let ok = false, error: string | undefined;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.taskTimeoutMs ?? (o.mode === 'fake' ? 120_000 : 60 * 60_000));
  try {
    for await (const c of adapter.run(task.prompt, { cwd: repo, model, effort: 'medium', permission: 'full', signal: ctl.signal })) {
      if (c.kind === 'usage') u.add(c);
      else if (c.kind === 'done') { ok = c.ok; if (!c.ok) error = c.error; }
    }
  } catch (e) { error = (e as Error).message; }
  finally { clearTimeout(timer); }
  const wallMs = now() - t0;
  const t = u.result(ok);
  const k = billableKTok(t);
  const acc = runAcceptance(task, repo);
  return {
    taskId: task.id, arm: 'baseline', accepted: acc.ok, acceptance: { exitCode: acc.exitCode, ...(acc.timedOut ? { timedOut: true } : {}), output: acc.output },
    verdict: 'none', integration: 'in-place', runs: 1, failedRuns: ok ? 0 : 1,
    tokens: { inputTokens: t.inputTokens ?? 0, outputTokens: t.outputTokens ?? 0, cacheReadTokens: t.cacheReadTokens ?? 0, cacheWriteTokens: t.cacheWriteTokens ?? 0, billableKTok: Math.round((k ?? 0) * 1e4) / 1e4 },
    quota: (runQuota({ cli: cliId, model, ...t }, o.catalog ?? DEFAULT_CATALOG) ?? []).map((q) => ({ ...q, pct: Math.round(q.pct * 1e4) / 1e4 })),
    wallMs, agentMinutes: Math.round((wallMs / 60_000) * 10) / 10, models: [`${cliId}/${model}`], ...(error ? { error: `Baseline run failed: ${error}` } : {})
  };
}

export async function runEval(o: EvalRunOptions): Promise<EvalReport> {
  if (o.mode === 'real' && !o.real) throw new Error('Real mode needs the installed CLIs (index.ts passes them).');
  const root = mkdtempSync(join(o.tmpRoot ?? tmpdir(), 'harbor-eval-'));
  const arms = o.arms ?? ['harbor', 'baseline'];
  const outcomes: EvalOutcome[] = [];
  try {
    for (const task of o.taskSet.tasks) {
      for (const arm of arms) {
        o.log?.(`${task.id}: ${arm}...`);
        const repo = makeRepo(task, o.baseDir, root);
        const out = arm === 'harbor' ? await runHarbor(task, repo, o, root) : await runBaseline(task, repo, o);
        o.log?.(`${task.id}: ${arm} ${out.accepted ? 'accepted' : 'NOT accepted'}${out.error ? ` (${out.error})` : ''}`);
        outcomes.push(out);
      }
    }
  } finally {
    if (!o.keep && existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    else if (o.keep) o.log?.(`Temp repositories kept in ${root}`);
  }
  return aggregateEval({ name: o.taskSet.name, mode: o.mode, generatedAt: (o.now ?? Date.now)(), outcomes });
}
