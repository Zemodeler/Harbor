import type { AgentRole, CliId } from '../../src/shared/api';
import type { Effort } from '../../src/main/adapters/types';
import { poolsOfEntry, reserveFor, type BudgetPeriod, type PoolStateName } from '../../src/main/budget';
import { capabilityOf, failureRisk } from '../../src/main/budgetCost';
import { budgetRole, calibrate, type Calibration, type TaskSize } from '../../src/main/calibration';
import type { ReportedLimit } from '../../src/main/codexLimits';
import { DEFAULT_CATALOG, entryFor, type CatalogEntry } from '../../src/main/clis/capabilities';
import type { ResolvedCli } from '../../src/main/clis/discovery';
import { conversationUrgency } from '../../src/main/deadline';
import { complexityOf, raiseDifficulty, strongestLevel } from '../../src/main/difficulty';
import { helperLimitFromLedger } from '../../src/main/helperLimit';
import { route, type RouteDecision, type RouteRequest, type RouterInput } from '../../src/main/router';
import { bindingNeed, committedFor, inFlightKTokSoFar, newestReadingAt, poolInputsFromLedger, statesOf, type InFlightRun } from '../../src/main/routePrice';
import { calibrationSample, finishedRuns, overlapKTok, readingsDuring } from '../../src/main/runCalibration';
import { MAX_TASK_MINUTES, estimateTaskMinutes, gateTask } from '../../src/main/sizeGate';
import { Store } from '../../src/main/store';
import { UsageLedger, buildHistory } from '../../src/main/usage';
import { Rng } from './prng';
import { TRUE_EFFORT_THROUGHPUT, TRUE_EFFORT_TOKENS, TRUE_POOL_PCT, TRUE_THROUGHPUT, TRUE_TOKENS_K } from './truth';
import { T0, isWorkHour, workload, type TaskKind, type TaskSpec, type WorkloadName } from './workloads';
import { DAY, HOUR, MIN, QuotaWorld, SIM_POOLS, WEEK, type Cli, type OutsideUse, type PoolSpec, type ResetRecord } from './world';

/**
 * The week simulator. It drives Harbor's REAL routing: route() (router.ts) over a real UsageLedger fed by simulated provider
 * readings, the real budget, pricing and calibration code (calibrationSample + calibrate after every run), the real helper limit
 * (helperLimitFromLedger, shared with the orchestrator) and the real size gate. What it models itself is only the outside world:
 * the true quota (world.ts), what a run really costs and how long it takes (truth.ts, with noise), whether the work is accepted,
 * and the orchestrator's queue (dependencies, retries with raised difficulty, automatic reviews, a concurrency limit).
 */

export interface SimConfig {
  workload: WorkloadName;
  seed: number;
  /** Simulated days (default 7). */
  days?: number;
  /** Arrivals stop after this many days (default `days`): the rest drains the queue. */
  arrivalDays?: number;
  stepMin?: number;
  /** Provider reading lag in minutes (default 2: an assumption; Claude prints its windows with each response, Codex logs each turn). */
  lagMin?: number;
  /** True quota per token = truth * factor, per pool (e.g. 2 = the pool is twice as small as the priors think). */
  poolFactor?: Partial<Record<string, number>>;
  /** True tokens per task = truth * factor. */
  tokenFactor?: number;
  /** Lognormal token noise (default 0.4 = +-40%). */
  tokenNoise?: number;
  outside?: OutsideUse;
  /** The user's concurrency setting (default 4, as in Harbor). */
  concurrency?: number;
  /** Fold every run into the calibration (default true). */
  calibrate?: boolean;
  catalog?: CatalogEntry[];
  /** Hours before the end of the first week at which each CLI's weekly window resets (default claude 0, codex 9). */
  resetEarlyH?: Partial<Record<Cli, number>>;
  /** Workload helper-rate multiplier. */
  scale?: number;
  /** Whether the provider reports the claude:opus window (default true). */
  reportOpus?: boolean;
  /** CLIs installed (default both). */
  clis?: Cli[];
  /** Keep every decision's reason text in the log (debugging; large). */
  reasons?: boolean;
  /** Print the in-flight quota and runs at this tick (debugging). */
  debugAt?: number;
}

export interface DecisionLog {
  t: number; task: string; kind: TaskKind; role: AgentRole; difficulty: number; size: TaskSize; urgency: number;
  cli: CliId; model: string; effort: Effort;
  /** State (helper view, or interactive view for interactive turns) of the pool that bound the chosen option's price. */
  poolState: PoolStateName; pool: string;
  credit: number; needsReview: boolean; price: number; retry: boolean;
  /** A resumed lead session kept its model (RouteRequest.keep: changing it would rewrite the prompt cache). */
  kept: boolean;
  /** The chosen model's capability (1-5) for the need it was judged on. */
  capability: number;
  /** The router's reason text (only with SimConfig.reasons). */
  reason?: string;
}

export interface WallLog { t: number; pool: string; period: BudgetPeriod; interactive: number; helpers: number; runs: string[] }

export interface HourSample {
  t: number;
  used: Record<string, number>;
  /** Helper-view state of each pool. */
  state: Record<string, PoolStateName>;
  queued: number; running: number;
}

export interface SimResult {
  config: Required<Pick<SimConfig, 'workload' | 'seed' | 'days'>>;
  decisions: DecisionLog[];
  walls: WallLog[];
  resets: ResetRecord[];
  hours: HourSample[];
  /** Helper queue delay (start - ready) in minutes per started helper run. */
  queueDelays: number[];
  /** Every helper start: when the task was ready and when it started. */
  starts: Array<{ ready: number; start: number }>;
  /** Interactive turns that found no model while some pool still truly had quota (should be 0), and how long they waited. */
  interactiveBlocked: number;
  interactiveWaitMin: number[];
  /** Max (true used - (100 - reserve)) over steps where a helper without urgency was running on the pool. */
  reserveOvershoot: Record<string, number>;
  /** Helper tasks: arrived, completed, gave up after repeated failures, still queued or running at the end. */
  tasks: { arrived: number; completed: number; gaveUp: number; pending: number; retries: number; reviews: number; splits: number };
  /** Helper starts route() refused although the helper limit allowed one (work held, retried later). */
  routeRefused: number;
  /** Completion time of the deadline conversation's last task (when the workload has one) and its deadline. */
  deadline?: { finishedAt?: number; deadline: number };
  /** Finish of the deadline conversation's tasks (also for the no-deadline variant): when the last one ended. */
  convFinish: Record<string, number>;
  calibration?: Calibration;
  truthPct: Record<string, Record<BudgetPeriod, number>>;
  /** Billable k-tokens and true quota % by CLI (Harbor's runs only). */
  byCli: Record<string, { runs: number; ktok: number }>;
}

interface TaskState extends TaskSpec {
  ready?: number;
  /** Routing held it for quota: as in the orchestrator (heldUntil), it is not tried again before this. */
  heldUntil?: number;
  attempts: number;
  retry?: boolean;
  escalateFrom?: { cli: CliId; model: string; effort?: Effort };
  done?: boolean;
  gaveUp?: boolean;
  running?: boolean;
}

interface Run {
  task: TaskState; d: RouteDecision; entry: CatalogEntry; interactive: boolean; urgency: number;
  start: number; end: number; tokensK: number;
  costs: Array<{ pool: string; period: BudgetPeriod; pct: number }>;
  burnedTo: number; before: ReportedLimit[];
}

const cliOf = (id: string): ResolvedCli => ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'] }) as ResolvedCli;
const WEEKLY_TO_SESSION: Record<Cli, number> = { claude: 0.0023 / 0.00038, codex: 0.022 / 0.0035 };
const MAX_ATTEMPTS = 4;

export function simulate(cfg: SimConfig): SimResult {
  const days = cfg.days ?? 7, stepMs = (cfg.stepMin ?? 5) * MIN, end = T0 + days * DAY;
  const clis: Cli[] = cfg.clis ?? ['claude', 'codex'];
  // The simulated accounts are the CLIs listed; a catalog entry of an unlisted CLI (Gemini) must not shape their difficulty or pricing.
  const catalog = cfg.catalog ?? DEFAULT_CATALOG.filter((e) => clis.includes(e.cli as Cli));
  const rng = new Rng(cfg.seed * 1_000_003 + 17);
  let now = T0;
  const clock = () => now;
  const pools: PoolSpec[] = SIM_POOLS.filter((p) => clis.includes(p.cli)).map((p) => (p.pool === 'claude:opus' && cfg.reportOpus === false ? { ...p, reported: false } : p));
  const early = { claude: 0, codex: 9, ...cfg.resetEarlyH };
  const world = new QuotaWorld(T0, { weeklyResetAt: { claude: T0 + WEEK - early.claude * HOUR, codex: T0 + WEEK - early.codex * HOUR }, pools, lagMin: cfg.lagMin ?? 2, outside: cfg.outside, rng: new Rng(cfg.seed * 31 + 5), isWorkHour });
  const truthPct = Object.fromEntries(pools.map((p) => [p.pool, { weekly: TRUE_POOL_PCT[p.pool]!.weekly * (cfg.poolFactor?.[p.pool] ?? 1), session: TRUE_POOL_PCT[p.pool]!.session * (cfg.poolFactor?.[p.pool] ?? 1) }])) as Record<string, Record<BudgetPeriod, number>>;

  // How Harbor sees the providers, as in the app: Claude prints its windows during Harbor's own runs (rate_limit_event, observed by
  // the ledger as they arrive); Codex writes them to its session logs, whose LATEST reading the ledger reads at any time.
  const codexLog = new Map<CliId, ReportedLimit[]>();
  const store = new Store(undefined, { now: clock });
  const ledger = new UsageLedger(store, { now: clock, reported: (c) => codexLog.get(c) ?? [], catalog });
  const lastClaude: ReportedLimit[] = [];
  const publish = (cli: Cli) => {
    const rs = world.reading(cli, now);
    if (cli === 'claude') { ledger.observe(cli, rs); lastClaude.splice(0, lastClaude.length, ...rs); } else codexLog.set(cli, rs);
  };
  let cal: Calibration | undefined;
  const seenAt = newestReadingAt(ledger);

  const wl = workload(cfg.workload, { days: cfg.arrivalDays ?? days, seed: cfg.seed, scale: cfg.scale });
  const pendingArrivals: TaskState[] = wl.tasks.map((t) => ({ ...t, attempts: 0 }));
  const byId = new Map<string, TaskState>(pendingArrivals.map((t) => [t.id, t]));
  const queue: TaskState[] = [];
  const interactiveWaiting: TaskState[] = [];
  const runs: Run[] = [];
  const convSession = new Map<string, { cli: CliId; model: string; effort: Effort; at: number }>();
  const res: SimResult = {
    config: { workload: cfg.workload, seed: cfg.seed, days }, decisions: [], walls: [], resets: world.resets, hours: [], queueDelays: [], starts: [],
    interactiveBlocked: 0, interactiveWaitMin: [], reserveOvershoot: {}, tasks: { arrived: 0, completed: 0, gaveUp: 0, pending: 0, retries: 0, reviews: 0, splits: 0 },
    routeRefused: 0, convFinish: {}, truthPct, byCli: {}
  };
  if (wl.deadlines['deadline'] !== undefined) res.deadline = { deadline: wl.deadlines['deadline'] };
  let extraId = 0;
  const lastPublish: Record<string, number> = {};

  // As the orchestrator does (committedNow): runs that ended in the last half hour, by their measured tokens.
  const recentRuns = () => finishedRuns(store.listUsage().filter((u) => u.time > now - 30 * MIN), (c, m) => entryFor(catalog, c, m));
  const inFlight = (except?: Run): InFlightRun[] => runs.filter((r) => r !== except).map((r) => ({ entry: r.entry, role: r.task.role, size: r.d.size, effort: r.d.effort, startedAt: r.start }));
  const routerInput = (): RouterInput => ({
    clis: clis.map(cliOf), ledger, enabled: () => true, hasAdapter: () => true,
    load: (c) => runs.filter((r) => r.d.cli === c).length, catalog, now: clock, history: buildHistory(store.listUsage(), now),
    committed: committedFor(inFlight(), now, cal, seenAt, recentRuns()), ...(cal ? { calibration: cal } : {})
  });
  const urgencyOf = (t: TaskState): number => {
    const deadline = wl.deadlines[t.conv];
    if (deadline === undefined) return 0;
    const work = [...queue, ...runs.map((r) => r.task)].filter((x) => x.conv === t.conv && x.kind === 'helper').map((x) => ({ role: x.role, size: x.size }));
    return conversationUrgency({ deadline, now, work: work.length ? work : [{ role: 'main' as const }], catalog, ...(cal ? { calibration: cal } : {}) }).urgency;
  };

  const start = (t: TaskState, d: RouteDecision, interactive: boolean, urgency: number, kept?: { cli: CliId; model: string }) => {
    const entry = entryFor(catalog, d.cli, d.model)!;
    const role = budgetRole(t.role);
    const tokensK = TRUE_TOKENS_K[role][d.size] * TRUE_EFFORT_TOKENS[d.effort] * (cfg.tokenFactor ?? 1) * rng.lognormal(cfg.tokenNoise ?? 0.4);
    const minutes = tokensK / (TRUE_THROUGHPUT[entry.tier] * TRUE_EFFORT_THROUGHPUT[d.effort]) * rng.lognormal(0.15);
    const costs = poolsOfEntry(entry).flatMap((pool) => (['weekly', 'session'] as const)
      .filter((period) => world.windows.has(`${pool}|${period}`))
      .map((period) => ({ pool, period, pct: tokensK * (entry.costPerKTok ?? 1) * truthPct[pool]![period] })));
    // The CLI's first reading of the run (Claude's first rate_limit_event) is the fresh "before" of its calibration sample.
    publish(d.cli as Cli);
    lastPublish[d.cli] = now;
    const r: Run = { task: t, d, entry, interactive, urgency, start: now, end: now + Math.max(MIN, minutes * MIN), tokensK, costs, burnedTo: now, before: ledger.readings(d.cli) };
    runs.push(r);
    t.running = true;
    // Log with the pool state the router saw for this kind of work.
    const states = statesOf(poolInputsFromLedger(ledger, catalog, clis, interactive ? undefined : committedFor(inFlight(r), now, cal, seenAt, recentRuns())), now, urgency, interactive);
    const pool = d.price?.bindingPool ?? poolsOfEntry(entry)[0]!;
    res.decisions.push({
      t: now, task: t.id, kind: t.kind, role: t.role, difficulty: d.difficulty, size: d.size, urgency: Math.round(urgency * 100) / 100,
      cli: d.cli, model: d.model, effort: d.effort, poolState: states[pool]?.state ?? 'neutral', pool,
      credit: Math.round((d.price?.wasteCreditPct ?? 0) * 1e4) / 1e4, needsReview: !!d.needsReview, price: Math.round((d.price?.routeTotal ?? 0) * 1e4) / 1e4, retry: !!t.retry,
      kept: !!kept && kept.cli === d.cli && kept.model === d.model, capability: capabilityOf(entry, bindingNeed(entry, t.needs)), ...(cfg.reasons ? { reason: d.reason } : {})
    });
  };

  const request = (t: TaskState, urgency: number): RouteRequest => {
    if (t.kind === 'concierge') return { role: 'main', complexity: 'low', tier: 'cheap', effort: 'low', fixedEffort: true, needs: ['chat'], interactive: true, size: 'small' };
    if (t.kind === 'lead') {
      const s = convSession.get(t.conv);
      const resume = s && now - s.at < 3 * HOUR;
      return {
        role: 'main', complexity: complexityOf(t.difficulty), difficulty: t.difficulty, size: t.size, needs: t.needs, interactive: true,
        ...(resume ? { keep: { cli: s.cli, model: s.model, effort: s.effort }, continuity: s.cli } : {}), ...(urgency > 0 ? { urgency } : {})
      };
    }
    return {
      role: t.role, complexity: complexityOf(t.difficulty), difficulty: t.difficulty, size: t.size, needs: t.needs,
      fanOut: t.role === 'planner' || t.role === 'implementer' || t.role === 'reviewer',
      ...(t.retry ? { retry: true } : {}), ...(t.escalateFrom ? { escalateFrom: t.escalateFrom } : {}), ...(urgency > 0 ? { urgency } : {})
    };
  };

  const addHelper = (t: TaskState) => {
    res.tasks.arrived++;
    t.ready = undefined;
    // The size gate: an edit task estimated over the limit is split by the lead into parts (one concern each).
    if (t.role === 'implementer' && !t.retry) {
      const minutes = estimateTaskMinutes({ role: t.role, size: t.size, difficulty: t.difficulty, needs: t.needs, catalog, ...(cal ? { calibration: cal } : {}) });
      if (gateTask({ title: t.id, instructions: 'x'.repeat(400), access: 'edit', files: ['a.ts'], minutes })) {
        const parts = Math.min(4, Math.ceil(minutes / MAX_TASK_MINUTES));
        const smaller: TaskSize = t.size === 'large' ? 'medium' : 'small';
        const ids: string[] = [];
        for (let i = 0; i < parts; i++) {
          const p: TaskState = { ...t, id: `${t.id}.${i + 1}`, size: smaller, difficulty: Math.max(0, t.difficulty - 0.5), attempts: 0 };
          byId.set(p.id, p); queue.push(p); ids.push(p.id);
        }
        res.tasks.splits++;
        res.tasks.arrived += parts - 1;
        // Whatever depended on the big task now depends on every part.
        for (const x of [...queue, ...pendingArrivals]) if (x.dependsOn.includes(t.id)) x.dependsOn = [...x.dependsOn.filter((d) => d !== t.id), ...ids];
        return;
      }
    }
    byId.set(t.id, t);
    queue.push(t);
  };

  const finish = (r: Run, outcome: 'ok' | 'rejected' | 'wall') => {
    runs.splice(runs.indexOf(r), 1);
    const t = r.task;
    t.running = false;
    const share = outcome === 'wall' ? Math.min(1, (now - r.start) / Math.max(1, r.end - r.start)) : 1;
    const k = r.tokensK * share;
    // Token fields shaped like a Claude run (cache reads dominate; Codex reports the same split as cached input).
    const out = 0.04 * k, cw = 0.1 * k, inp = 0.01 * k, cr = (k - out - cw - inp) / 0.1;
    publish(r.d.cli as Cli);
    lastPublish[r.d.cli] = now;
    // The run's limits as the orchestrator stores them: Claude's last in-run reading, Codex's log readings taken during the run.
    const limits = r.d.cli === 'claude' ? [...lastClaude] : readingsDuring(ledger.readings(r.d.cli), r.start);
    const event = ledger.record({
      // A run whose work is rejected later (review, checks) still ended normally: the ledger records it as ok, as the app does.
      cli: r.d.cli, model: r.d.model, projectId: 'p', agentId: t.id, durationMs: now - r.start, ok: outcome !== 'wall', limits,
      inputTokens: Math.round(inp * 1000), outputTokens: Math.round(out * 1000), cacheReadTokens: Math.round(cr * 1000), cacheWriteTokens: Math.round(cw * 1000),
      ...(outcome === 'wall' ? { rateLimited: true, cliWide: true, partial: true } : {})
    });
    const bc = (res.byCli[r.d.cli] ??= { runs: 0, ktok: 0 });
    bc.runs++; bc.ktok += k;
    if (cfg.calibrate !== false) {
      // As the orchestrator does (learnFrom): other runs on the CLI meanwhile, finished ones by their counts, running ones estimated.
      const finished = finishedRuns(store.listUsage().filter((u) => u.id !== event.id && u.cli === event.cli && u.time > r.start), (c, m) => entryFor(catalog, c, m));
      const running = inFlight().map((x) => ({ entry: x.entry, start: x.startedAt, end: now, kTok: inFlightKTokSoFar(x, now, cal) }));
      const overlap = overlapKTok({ cli: event.cli, start: r.start, end: now, others: [...finished, ...running] });
      cal = calibrate([calibrationSample({ event, role: t.role, size: r.d.size, effort: r.d.effort, before: r.before, start: r.start, overlap })], cal, catalog);
    }
    if (t.kind !== 'helper') {
      if (outcome === 'wall') { interactiveWaiting.push(t); return; }
      if (t.kind === 'lead') convSession.set(t.conv, { cli: r.d.cli, model: r.d.model, effort: r.d.effort, at: now });
      t.done = true;
      return;
    }
    if (outcome === 'wall') { t.ready = now; queue.push(t); return; }
    if (outcome === 'rejected') {
      t.attempts++;
      if (t.attempts >= MAX_ATTEMPTS) { t.gaveUp = true; res.tasks.gaveUp++; settle(t); return; }
      res.tasks.retries++;
      t.retry = true;
      t.escalateFrom = { cli: r.d.cli, model: r.d.model, effort: r.d.effort };
      t.difficulty = raiseDifficulty(t.difficulty, strongestLevel(catalog, t.needs));
      t.ready = now;
      queue.push(t);
      return;
    }
    t.done = true;
    settle(t);
    // Routing said the model only just clears hard work: Harbor schedules one reviewer after it (Phase 4).
    if (r.d.needsReview && t.role === 'implementer') {
      const rv: TaskState = { id: `rv${++extraId}`, conv: t.conv, arrival: now, kind: 'helper', role: 'reviewer', difficulty: Math.min(5, t.difficulty), size: t.size, needs: ['review'], dependsOn: [], attempts: 0 };
      res.tasks.reviews++;
      addHelper(rv);
    }
  };
  const settle = (t: TaskState) => {
    res.tasks.completed += t.done ? 1 : 0;
    res.convFinish[t.conv] = Math.max(res.convFinish[t.conv] ?? 0, now);
  };

  const readyOf = (t: TaskState) => t.dependsOn.every((id) => { const d = byId.get(id); return !d || d.done || d.gaveUp; });

  const outcomeOf = (r: Run): 'ok' | 'rejected' => {
    const need = bindingNeed(r.entry, r.task.needs);
    const p = Math.min(0.95, failureRisk(r.entry, r.task.difficulty, r.d.effort, need) + (r.task.flaky ?? 0));
    return rng.chance(p) ? 'rejected' : 'ok';
  };

  for (; now <= end; now += stepMs) {
    // Quota burned since the last tick (each run up to its own end), use outside Harbor, then the provider's view of it.
    world.roll(now);
    for (const r of runs) {
      const to = Math.min(now, r.end);
      if (to <= r.burnedTo) continue;
      const frac = (to - r.burnedTo) / Math.max(1, r.end - r.start);
      r.burnedTo = to;
      for (const c of r.costs) world.burn(c.pool, c.period, c.pct * frac, now);
    }
    world.outside(now, stepMs, WEEKLY_TO_SESSION);
    world.snapshot(now);
    // A run that meets a full window is refused by the provider (rate limited): it ends now, partial.
    const fullNow = new Map<string, BudgetPeriod>();
    for (const w of world.windows.values()) if (w.used >= 100 - 1e-9) fullNow.set(w.pool.pool, w.period);
    if (fullNow.size) {
      const hit = runs.filter((r) => r.costs.some((c) => fullNow.has(c.pool)));
      for (const [pool, period] of fullNow) {
        const on = hit.filter((r) => r.costs.some((c) => c.pool === pool));
        if (on.length && !res.walls.some((w) => w.pool === pool && w.period === period && now - w.t < 5 * HOUR)) {
          res.walls.push({
            t: now, pool, period, interactive: on.filter((r) => r.interactive).length, helpers: on.filter((r) => !r.interactive).length,
            runs: on.map((r) => `${r.task.kind}:${r.task.role}/${r.d.size} ${r.d.model} ${r.d.effort} started ${Math.round((now - r.start) / MIN)}m ago, true ${Math.round((r.costs.find((c) => c.pool === pool && c.period === period)?.pct ?? 0) * 10) / 10}%`)
          });
        }
      }
      for (const r of hit) finish(r, 'wall');
    }
    // Reserve check: helpers without deadline urgency must not carry a pool into its reserve.
    for (const w of world.windows.values()) {
      if (!runs.some((r) => !r.interactive && r.urgency === 0 && r.costs.some((c) => c.pool === w.pool.pool))) continue;
      const hours = w.resetsAt !== undefined ? (w.resetsAt - now) / HOUR : 5;
      const k = `${w.pool.pool}|${w.period}`;
      res.reserveOvershoot[k] = Math.max(res.reserveOvershoot[k] ?? -100, w.used - (100 - reserveForTruth(w.period, hours)));
    }
    // Runs that ended by now.
    for (const r of [...runs]) if (r.end <= now) finish(r, outcomeOf(r));
    // Readings: while a CLI has runs in flight its readings refresh every 15 minutes (Claude's rate_limit_event, Codex's logs).
    for (const c of clis) if ((runs.some((r) => r.d.cli === c) || (c === 'codex' && (cfg.outside?.codexWeeklyPctPerHour ?? 0) > 0 && isWorkHour(now))) && now - (lastPublish[c] ?? 0) >= 15 * MIN) { publish(c); lastPublish[c] = now; }
    // Arrivals.
    while (pendingArrivals.length && pendingArrivals[0]!.arrival <= now) {
      const t = pendingArrivals.shift()!;
      if (t.kind === 'helper') addHelper(t); else interactiveWaiting.push(t);
    }
    // Interactive turns run at once (the owner is waiting); they may use the reserve.
    for (const t of [...interactiveWaiting]) {
      const urgency = urgencyOf(t);
      const req = request(t, urgency);
      const d = route(req, routerInput());
      if (!d) {
        if (!clis.every((c) => world.full([`${c}:all`]))) res.interactiveBlocked++;
        continue;
      }
      interactiveWaiting.splice(interactiveWaiting.indexOf(t), 1);
      res.interactiveWaitMin.push((now - t.arrival) / MIN);
      start(t, d, true, urgency, req.keep);
    }
    if (cfg.debugAt !== undefined && now === cfg.debugAt) {
      const c = committedFor(inFlight(), now, cal, seenAt, recentRuns());
      console.log('DEBUG', new Date(now).toISOString(), JSON.stringify(c), runs.map((r) => `${r.d.cli}/${r.d.model} ${r.task.role} ${r.d.size} ${r.d.effort} start ${new Date(r.start).toISOString().slice(11, 16)}`), 'seen', new Date(seenAt('codex') ?? 0).toISOString(), 'true', world.used('codex:all', 'session'));
    }
    // Helpers: the user's concurrency limit and the quota budget's limit.
    for (const t of queue) if (t.ready === undefined && readyOf(t)) t.ready = Math.max(t.arrival, now);
    const helpersRunning = () => runs.filter((r) => r.task.kind === 'helper').length;
    if (queue.some((t) => readyOf(t)) && helpersRunning() < (cfg.concurrency ?? 4)) {
      const lim = helperLimitFromLedger({ catalog, clis, ledger, now, running: runs.filter((r) => r.task.kind === 'helper').map((r) => r.entry), committed: committedFor(inFlight(), now, cal, seenAt, recentRuns()), ...(cal ? { calibration: cal } : {}) });
      const max = Math.min(cfg.concurrency ?? 4, lim.limit);
      let refused = 0;
      // As the orchestrator's pump: work of a conversation whose deadline is closer to its estimate first, then oldest first.
      const urg = new Map<string, number>();
      const u = (t: TaskState) => { let x = urg.get(t.conv); if (x === undefined) { x = urgencyOf(t); urg.set(t.conv, x); } return x; };
      const order = wl.deadlines && Object.keys(wl.deadlines).length ? [...queue].sort((a, b) => u(b) - u(a)) : [...queue];
      for (const t of order) {
        if (helpersRunning() >= max || refused >= 3) break;
        if (!readyOf(t) || (t.heldUntil ?? 0) > now) continue;
        const urgency = urgencyOf(t);
        const d = route(request(t, urgency), routerInput());
        // Held for quota (the orchestrator re-queues it until the earliest reset; this re-checks every 15 minutes). After three in a
        // row the rest of the queue waits for the next tick too: the same pools are short for all of it.
        if (!d) { res.routeRefused++; refused++; t.heldUntil = now + 15 * MIN; continue; }
        queue.splice(queue.indexOf(t), 1);
        res.queueDelays.push((now - (t.ready ?? now)) / MIN);
        res.starts.push({ ready: t.ready ?? now, start: now });
        start(t, d, false, urgency);
      }
    }
    if ((now - T0) % HOUR === 0) {
      const states = statesOf(poolInputsFromLedger(ledger, catalog, clis, committedFor(inFlight(), now, cal, seenAt, recentRuns())), now, 0, false);
      res.hours.push({
        t: now, used: Object.fromEntries([...world.windows.values()].map((w) => [`${w.pool.pool}|${w.period}`, Math.round(w.used * 10) / 10])),
        state: Object.fromEntries(Object.entries(states).map(([p, s]) => [p, s.state])), queued: queue.length, running: runs.length
      });
    }
  }
  res.tasks.pending = queue.length + runs.filter((r) => r.task.kind === 'helper').length + pendingArrivals.filter((t) => t.kind === 'helper').length;
  if (res.deadline) res.deadline.finishedAt = queue.some((t) => t.conv === 'deadline') || runs.some((r) => r.task.conv === 'deadline') ? undefined : res.convFinish['deadline'];
  res.calibration = cal;
  return res;
}

/** The reserve the governor keeps for helpers without a deadline (budget.reserveFor at urgency 0). */
const reserveForTruth = (period: BudgetPeriod, hoursToReset: number): number => reserveFor(0, hoursToReset, period);
