import { describe, expect, it } from 'vitest';
import { DAY } from './sim/world';
import { run } from './sim/runs';
import { T0 } from './sim/workloads';

/**
 * Phase 5, property 7: the true quota per token (and the true tokens per task) are twice or half what Harbor's priors say. Calibration
 * must find the truth from provider readings around its own runs, and the governor must keep the week safe and spent after day one.
 * Half the quota per token is twice the capacity, so that week gets twice the work ("enough demand" for property 2).
 */
const ALL_POOLS = (f: number) => ({ 'claude:all': f, 'claude:opus': f, 'claude:fable': f, 'codex:all': f });
const CASES = [
  { name: 'quota per token 2x the priors', extra: { poolFactor: ALL_POOLS(2) } },
  { name: 'quota per token 0.5x the priors', extra: { poolFactor: ALL_POOLS(0.5), scale: 2 } },
  { name: 'tokens per task 2x the priors', extra: { tokenFactor: 2 } },
  { name: 'tokens per task 0.5x the priors', extra: { tokenFactor: 0.5, scale: 2 } }
];

describe('week simulator: adaptation', () => {
  it.each(CASES)('7. ADAPTATION ($name): calibration within 25% of the truth; safe and spent after the first day', ({ extra }) => {
    for (const seed of [1, 2]) {
      const { s } = run('steady', seed, extra);
      for (const k of ['claude:all|weekly', 'claude:all|session', 'claude:opus|weekly', 'codex:all|weekly', 'codex:all|session']) {
        const ratio = s.calibrationRatio[k];
        expect(ratio, `seed ${seed} ${k}`).toBeDefined();
        expect(Math.abs(ratio! - 1), `seed ${seed} ${k} estimate/truth ${ratio}`).toBeLessThanOrEqual(0.25);
      }
      const { r } = run('steady', seed, extra);
      expect(r.walls.filter((w) => w.t >= T0 + DAY), `seed ${seed}`).toEqual([]);
      for (const p of ['claude:all', 'codex:all']) expect(s.weeklyAtReset[p]![0]!, `seed ${seed} ${p}`).toBeGreaterThanOrEqual(85);
    }
  }, 180_000);
});
