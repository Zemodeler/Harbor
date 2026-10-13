import { summarize, type SimSummary } from './report';
import { simulate, type SimConfig, type SimResult } from './simulate';
import type { WorkloadName } from './workloads';

/** Each workload's own shape (shared by the tests and scripts/simulate-week.ts). */
export const PRESETS: Record<WorkloadName, Partial<SimConfig>> = {
  steady: {}, bursty: {}, light: {}, chronica: { days: 1 },
  // Two weeks with arrivals only in the first: the queue built up while the pools were short must drain after the reset.
  heavy: { days: 14, arrivalDays: 7 },
  deadline: { days: 3 }, 'deadline-none': { days: 3 }
};

const memo = new Map<string, { r: SimResult; s: SimSummary }>();

/** One simulation, memoised per configuration within a test file (several properties read the same weeks). */
export function run(workload: WorkloadName, seed: number, extra: Partial<SimConfig> = {}): { r: SimResult; s: SimSummary } {
  const cfg: SimConfig = { workload, seed, ...PRESETS[workload], ...extra };
  const key = JSON.stringify(cfg);
  let hit = memo.get(key);
  if (!hit) { const r = simulate(cfg); hit = { r, s: summarize(r) }; memo.set(key, hit); }
  return hit;
}
