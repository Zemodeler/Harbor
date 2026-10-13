/**
 * Week simulator report (Phase 5). Runs Harbor's real router, budget governor and calibration against simulated accounts and
 * workloads (tests/sim) and prints what happened. No CLI, network or quota is touched.
 *
 *   npx tsx scripts/simulate-week.ts                    # every workload, seeds 1-3: one table each, then a property overview
 *   npx tsx scripts/simulate-week.ts steady 1 2         # chosen workloads and seeds
 *   npx tsx scripts/simulate-week.ts --json out.json    # also write every summary with its hourly pool curves as JSON
 */
import { writeFileSync } from 'node:fs';
import { run } from '../tests/sim/runs';
import { table, type SimSummary } from '../tests/sim/report';
import type { WorkloadName } from '../tests/sim/workloads';

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonPath = jsonAt >= 0 ? args[jsonAt + 1] : undefined;
const rest = args.filter((_, i) => jsonAt < 0 || (i !== jsonAt && i !== jsonAt + 1));
const ALL: WorkloadName[] = ['steady', 'bursty', 'heavy', 'light', 'deadline', 'deadline-none', 'chronica'];
const names = rest.filter((a) => (ALL as string[]).includes(a)) as WorkloadName[];
const seeds = rest.filter((a) => /^\d+$/.test(a)).map(Number);

const out: unknown[] = [];
const all: SimSummary[] = [];
for (const w of names.length ? names : ALL) {
  for (const seed of seeds.length ? seeds : [1, 2, 3]) {
    const t0 = Date.now();
    const { r, s } = run(w, seed);
    console.log(table(s));
    console.log(`  (${Date.now() - t0} ms)`);
    all.push(s);
    out.push({ summary: s, hourly: r.hours, queueDelaysMin: r.queueDelays });
  }
}

// One line per workload over its seeds: the numbers the properties are judged on.
const range = (xs: number[]) => (xs.length ? `${Math.min(...xs)}-${Math.max(...xs)}` : '-');
console.log('\n== overview (min-max over seeds)');
for (const w of [...new Set(all.map((s) => s.workload))]) {
  const ss = all.filter((s) => s.workload === w);
  const at = (p: string) => ss.flatMap((s) => (s.weeklyAtReset[p]?.length ? [s.weeklyAtReset[p]![0]!] : []));
  const prem = (st: 'spend' | 'neutral' | 'conserve' | 'protect') => ss.reduce((a, s) => a + s.premiumLow[st].premium, 0) + '/' + ss.reduce((a, s) => a + s.premiumLow[st].all, 0);
  console.log(`${w.padEnd(14)} walls ${ss.reduce((a, s) => a + s.walls.helper + s.walls.interactive, 0)} | weekly at reset claude:all ${range(at('claude:all'))}% codex:all ${range(at('codex:all'))}% claude:opus ${range(at('claude:opus'))}%`
    + ` | reserve overshoot max ${Math.max(...ss.flatMap((s) => Object.values(s.reserveOvershoot)))} | premium-low spend ${prem('spend')} neutral ${prem('neutral')} conserve ${prem('conserve')} protect ${prem('protect')}`
    + ` | high work other ${ss.reduce((a, s) => a + s.highWork.other, 0)}/${ss.reduce((a, s) => a + s.highWork.all, 0)} | protect-while-other-spends ${range(ss.map((s) => s.protectWhileOtherSpendsH))} h`
    + ` | claude share ${range(ss.map((s) => Math.round((100 * s.share.claudeDecisions) / Math.max(1, s.share.claudeDecisions + s.share.codexDecisions))))}%`
    + ` | queue p95 ${range(ss.map((s) => s.queueDelayMin.p95))} min | interactive blocked ${ss.reduce((a, s) => a + s.interactiveBlocked, 0)} | fable ${ss.reduce((a, s) => a + s.fableUsed, 0)}`
    + (ss[0]!.deadline ? ` | on time ${ss.filter((s) => s.deadline?.onTime).length}/${ss.length}` : ''));
}
if (jsonPath) { writeFileSync(jsonPath, JSON.stringify(out, null, 1)); console.log(`JSON written to ${jsonPath}`); }
