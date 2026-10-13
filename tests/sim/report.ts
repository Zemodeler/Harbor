import type { PoolStateName } from '../../src/main/budget';
import { DEFAULT_CATALOG, entryFor } from '../../src/main/clis/capabilities';
import type { SimResult } from './simulate';
import { HOUR } from './world';

/** Measured properties of one simulated run (what the tests assert and the script prints). */
export interface SimSummary {
  workload: string; seed: number; days: number;
  /** Times a pool window truly reached 100% while Harbor had runs on it: by helpers only, and with an interactive run among them. */
  walls: { helper: number; interactive: number; list: string[] };
  /** True weekly use at each weekly reset, per pool (%). */
  weeklyAtReset: Record<string, number[]>;
  /** Highest true use seen per window (%). */
  peak: Record<string, number>;
  /** Decisions per difficulty band: "cli/model effort" -> count. */
  mix: Record<string, Record<string, number>>;
  /** Work of difficulty <= 3 (helpers and leads, not the concierge) on a strong auto-routed model, by the binding pool's state. */
  premiumLow: Record<PoolStateName, { all: number; premium: number }>;
  /**
   * Helper work of difficulty >= 7 by what took it: a model of capability 5 for the need (Opus, Astra; Sol for code), a weaker one at
   * high effort marked for review, or anything else (should be none).
   */
  highWork: { all: number; strong: number; standardHighReviewed: number; other: number };
  /** Helper starts whose task was ready before a weekly reset and started after it (work held over a reset, not dropped). */
  heldOverReset: number;
  share: { claudeDecisions: number; codexDecisions: number; claudeKTok: number; codexKTok: number };
  queueDelayMin: { p50: number; p95: number; max: number; n: number };
  interactiveBlocked: number;
  interactiveMaxWaitMin: number;
  reserveOvershoot: Record<string, number>;
  spendUps: number;
  /** Hours one CLI's account pool sat in protect while the other's was in spend. */
  protectWhileOtherSpendsH: number;
  stateHours: Record<string, Record<PoolStateName, number>>;
  fableUsed: number;
  tasks: SimResult['tasks'];
  routeRefused: number;
  deadline?: { finishedAt?: string; deadline: string; onTime: boolean };
  /** Final calibrated quota-per-token estimate / truth, per pool window (1 = exact). */
  calibrationRatio: Record<string, number>;
}

const pct = (xs: number[], q: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]!; };
const r1 = (x: number) => Math.round(x * 10) / 10;

export function summarize(r: SimResult): SimSummary {
  const band = (d: number) => (d <= 3 ? '0-3' : d <= 6 ? '3.5-6' : '6.5-10');
  const mix: SimSummary['mix'] = {};
  const premiumLow = { spend: { all: 0, premium: 0 }, neutral: { all: 0, premium: 0 }, conserve: { all: 0, premium: 0 }, protect: { all: 0, premium: 0 } } as SimSummary['premiumLow'];
  const highWork = { all: 0, strong: 0, standardHighReviewed: 0, other: 0 };
  let fable = 0, spendUps = 0, cd = 0, xd = 0;
  for (const d of r.decisions) {
    const b = band(d.difficulty);
    const k = `${d.cli}/${d.model} ${d.effort}`;
    (mix[b] ??= {})[k] = ((mix[b] ??= {})[k] ?? 0) + 1;
    const e = entryFor(DEFAULT_CATALOG, d.cli, d.model);
    if (d.model.includes('fable')) fable++;
    if (d.credit > 0) spendUps++;
    if (d.cli === 'claude') cd++; else xd++;
    // Spend-up (use-it-or-lose-it credit) is what 'spend' allows; a resumed lead that keeps its session's model is not a choice.
    const st: PoolStateName = d.credit > 0 ? 'spend' : d.poolState;
    if (d.kind !== 'concierge' && !d.kept && d.difficulty <= 3) { premiumLow[st].all++; if (e?.tier === 'strong') premiumLow[st].premium++; }
    if (d.kind === 'helper' && d.difficulty >= 7) {
      highWork.all++;
      if (d.capability >= 5) highWork.strong++;
      else if (d.effort === 'high' && d.needsReview) highWork.standardHighReviewed++;
      else highWork.other++;
    }
  }
  const weeklyAtReset: Record<string, number[]> = {};
  for (const x of r.resets) if (x.period === 'weekly') (weeklyAtReset[x.pool] ??= []).push(r1(x.usedPct));
  const peak: Record<string, number> = {};
  for (const h of r.hours) for (const [k, v] of Object.entries(h.used)) peak[k] = Math.max(peak[k] ?? 0, v);
  const stateHours: SimSummary['stateHours'] = {};
  let pws = 0;
  for (const h of r.hours) {
    for (const [p, s] of Object.entries(h.state)) { const m = (stateHours[p] ??= { spend: 0, neutral: 0, conserve: 0, protect: 0 }); m[s]++; }
    const c = h.state['claude:all'], x = h.state['codex:all'];
    if ((c === 'protect' && x === 'spend') || (x === 'protect' && c === 'spend')) pws++;
  }
  const calibrationRatio: Record<string, number> = {};
  for (const [pool, t] of Object.entries(r.truthPct)) for (const period of ['weekly', 'session'] as const) {
    const e = r.calibration?.pctPerKTok[`${pool}|${period}`];
    if (e && e.n > 0) calibrationRatio[`${pool}|${period}`] = Math.round((e.value / t[period]) * 100) / 100;
  }
  const iso = (t: number) => new Date(t).toISOString().slice(5, 16);
  const weeklyResets = r.resets.filter((x) => x.period === 'weekly').map((x) => x.at);
  const heldOverReset = r.starts.filter((x) => weeklyResets.some((at) => x.ready < at && x.start >= at)).length;
  return {
    workload: r.config.workload, seed: r.config.seed, days: r.config.days,
    walls: { helper: r.walls.filter((w) => !w.interactive).length, interactive: r.walls.filter((w) => w.interactive > 0).length, list: r.walls.map((w) => `${iso(w.t)} ${w.pool}|${w.period} (${w.helpers} helpers, ${w.interactive} interactive)`) },
    weeklyAtReset, peak, mix, premiumLow, highWork, heldOverReset,
    share: { claudeDecisions: cd, codexDecisions: xd, claudeKTok: Math.round(r.byCli['claude']?.ktok ?? 0), codexKTok: Math.round(r.byCli['codex']?.ktok ?? 0) },
    queueDelayMin: { p50: r1(pct(r.queueDelays, 0.5)), p95: r1(pct(r.queueDelays, 0.95)), max: r1(Math.max(0, ...r.queueDelays)), n: r.queueDelays.length },
    interactiveBlocked: r.interactiveBlocked, interactiveMaxWaitMin: r1(Math.max(0, ...r.interactiveWaitMin)),
    reserveOvershoot: Object.fromEntries(Object.entries(r.reserveOvershoot).map(([k, v]) => [k, r1(v)])),
    spendUps, protectWhileOtherSpendsH: pws, stateHours, fableUsed: fable, tasks: r.tasks, routeRefused: r.routeRefused,
    ...(r.deadline ? { deadline: { ...(r.deadline.finishedAt !== undefined ? { finishedAt: iso(r.deadline.finishedAt) } : {}), deadline: iso(r.deadline.deadline), onTime: r.deadline.finishedAt !== undefined && r.deadline.finishedAt <= r.deadline.deadline } } : {}),
    calibrationRatio
  };
}

/** A compact readable table of one summary. */
export function table(s: SimSummary): string {
  const lines: string[] = [];
  lines.push(`== ${s.workload} seed ${s.seed} (${s.days} days)`);
  lines.push(`  walls: helper ${s.walls.helper}, interactive ${s.walls.interactive}${s.walls.list.length ? `  [${s.walls.list.join('; ')}]` : ''}`);
  lines.push(`  weekly use at reset: ${Object.entries(s.weeklyAtReset).map(([p, v]) => `${p} ${v.join('/')}%`).join(', ')}`);
  lines.push(`  peak: ${Object.entries(s.peak).filter(([k]) => !k.includes('fable')).map(([k, v]) => `${k} ${v}%`).join(', ')}`);
  lines.push(`  reserve overshoot (true use above the helper reserve line while non-urgent helpers ran): ${Object.entries(s.reserveOvershoot).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  lines.push(`  tasks: ${JSON.stringify(s.tasks)}, routeRefused ${s.routeRefused}, interactive blocked ${s.interactiveBlocked} (max wait ${s.interactiveMaxWaitMin} min)`);
  lines.push(`  queue delay (min): p50 ${s.queueDelayMin.p50}, p95 ${s.queueDelayMin.p95}, max ${s.queueDelayMin.max} (n ${s.queueDelayMin.n})`);
  lines.push(`  share: claude ${s.share.claudeDecisions} decisions / ${s.share.claudeKTok} ktok, codex ${s.share.codexDecisions} / ${s.share.codexKTok} ktok`);
  lines.push(`  premium on low work: ${Object.entries(s.premiumLow).map(([st, v]) => `${st} ${v.premium}/${v.all}`).join(', ')}; spend-ups ${s.spendUps}; fable ${s.fableUsed}`);
  lines.push(`  high work: ${JSON.stringify(s.highWork)}; held over a weekly reset: ${s.heldOverReset}`);
  lines.push(`  state hours: ${Object.entries(s.stateHours).filter(([p]) => !p.includes('fable')).map(([p, m]) => `${p} ${Object.entries(m).map(([k, v]) => `${k[0]}${v}`).join(' ')}`).join(' | ')}; protect-while-other-spends ${s.protectWhileOtherSpendsH} h`);
  for (const [b, m] of Object.entries(s.mix)) lines.push(`  d ${b}: ${Object.entries(m).sort((a, b2) => b2[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (s.deadline) lines.push(`  deadline ${s.deadline.deadline}: finished ${s.deadline.finishedAt ?? 'not finished'} (${s.deadline.onTime ? 'on time' : 'LATE'})`);
  lines.push(`  calibration (estimate/truth): ${Object.entries(s.calibrationRatio).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return lines.join('\n');
}

export const HOURS = HOUR;
