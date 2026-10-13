import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG, entryFor } from '../src/main/clis/capabilities';
import { run } from './sim/runs';

/**
 * Phase 5, property 6: a conversation with a deadline six hours out and a backlog of twelve plan -> implement -> review chains, while
 * other conversations keep the pools busy. Urgency (deadline vs. the backlog's estimate) orders the queue, releases reserve and
 * prices time; the same week without the deadline is the comparison.
 */
const SEEDS = [1, 2, 3, 4, 5, 6];

describe('week simulator: deadline', () => {
  it('6. DEADLINE: more backlogs finish on time than without the deadline, and no strong model takes easy work before urgency rises', () => {
    let on = 0, onWithout = 0;
    for (const seed of SEEDS) {
      const { r, s } = run('deadline', seed);
      const none = run('deadline-none', seed);
      const deadline = r.deadline!.deadline;
      if (s.deadline?.onTime) on++;
      if ((none.r.convFinish['deadline'] ?? Infinity) <= deadline) onWithout++;
      expect(s.walls.list, `seed ${seed}`).toEqual([]);
      // Urgency shows up in the decisions of the deadline's work, and only there.
      expect(r.decisions.some((d) => d.urgency > 0), `seed ${seed}`).toBe(true);
      expect(none.r.decisions.every((d) => d.urgency === 0), `seed ${seed}`).toBe(true);
      // Without urgency (every other conversation, and the deadline's own work while its slack is large) easy work never goes to a
      // strong model unless a pool is spending expiring quota or a resumed lead keeps its session's model.
      const strongEasyCalm = r.decisions.filter((d) => d.urgency === 0 && d.difficulty <= 3 && d.kind !== 'concierge' && !d.kept && d.credit === 0
        && entryFor(DEFAULT_CATALOG, d.cli, d.model)?.tier === 'strong');
      expect(strongEasyCalm, `seed ${seed}`).toEqual([]);
    }
    expect(on).toBeGreaterThanOrEqual(onWithout);
    expect(on).toBeGreaterThanOrEqual(SEEDS.length - 1);
  }, 180_000);
});
