import { describe, expect, it } from 'vitest';
import { expectedMinutes, expectedTokens } from '../src/main/budgetCost';
import { THROUGHPUT_KTOK_PER_MIN, poolPctPrior } from '../src/main/budgetPriors';
import { billableKTok, budgetRole } from '../src/main/calibration';
import { DEFAULT_CATALOG, entryFor } from '../src/main/clis/capabilities';
import { difficultyOf } from '../src/main/difficulty';
import { MAX_TASK_MINUTES, describeDrivers, estimateTaskMinutes, gateSize, gateTask } from '../src/main/sizeGate';
import {
  CAPPED_LARGE_IMPLEMENTER_MINUTES, CLAUDE_SPAN, CODEX_LEAD, CODEX_SPAN, MEASURED_RUNS, MINUTES_2026_10_09
} from './fixtures/realUsage';

/**
 * Phase 5, part B: the priors reproduce what was measured on the owner's machine on 2026-10-12 (tests/fixtures/realUsage.ts) within
 * 30%, and the size gate splits a Chronica-sized task while a small precise one passes.
 */
const within = (prior: number, measured: number, tol = 0.3) => Math.abs(prior / measured - 1) <= tol;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2; };
const model = (cli: string, id: string) => entryFor(DEFAULT_CATALOG, cli, id)!;

describe('priors vs real measurements (2026-10-12)', () => {
  it('quota per token: Claude and Codex account windows, weekly and 5h', () => {
    // Claude: Opus/Fable tokens count at costPerKTok 2.
    expect(within(poolPctPrior('claude:all', 'weekly'), CLAUDE_SPAN.weeklyDeltaPct / (CLAUDE_SPAN.billableKTokStrong * 2))).toBe(true);
    expect(within(poolPctPrior('claude:all', 'session'), CLAUDE_SPAN.sessionDeltaPct / (CLAUDE_SPAN.billableKTokStrong * 2))).toBe(true);
    // Codex: gpt-6.1-sol tokens count at costPerKTok 0.8.
    expect(within(poolPctPrior('codex:all', 'weekly'), CODEX_SPAN.weeklyDeltaPct / (CODEX_SPAN.weeklyBillableKTok * 0.8))).toBe(true);
    expect(within(poolPctPrior('codex:all', 'session'), CODEX_SPAN.sessionDeltaPct / (CODEX_SPAN.sessionBillableKTok * 0.8))).toBe(true);
  });

  it('throughput: strong and standard tiers', () => {
    const strong = MEASURED_RUNS.filter((r) => r.role === 'implementer').map((r) => billableKTok(r)! / r.minutes);
    expect(within(THROUGHPUT_KTOK_PER_MIN.strong, strong.reduce((a, b) => a + b) / strong.length)).toBe(true);
    expect(within(THROUGHPUT_KTOK_PER_MIN.standard, CODEX_LEAD.billableKTok / CODEX_LEAD.minutes)).toBe(true);
  });

  it('a large implementer: tokens of the complete run, and minutes against the median of all six (four were cut off at 45)', () => {
    const opus = MEASURED_RUNS[0]!;
    expect(within(expectedTokens('implementer', 'large', 'medium'), billableKTok(opus)!)).toBe(true);
    const all = [...MEASURED_RUNS.filter((r) => r.role === 'implementer').map((r) => r.minutes), ...CAPPED_LARGE_IMPLEMENTER_MINUTES];
    expect(within(expectedMinutes({ role: 'implementer', size: 'large', effort: 'medium', model: model('claude', 'claude-opus-5-5') }), median(all))).toBe(true);
    // The old priors (600 k-tokens at 15 k-tokens/min) said 40 minutes too, but from a token count 3.5x too small and a rate 4x too slow.
  });

  // Sizes these 2026-10-09 runs would get (their records predate sizes): ordinary medium-complexity Sonnet work was small, the
  // "high" Opus implementers, planners and Opus reviews medium, the Sonnet reviews small.
  it.each([
    ['implementer|claude-sonnet-5-5|medium', 'small'],
    ['implementer|claude-opus-5-5|medium', 'medium'],
    ['planner|claude-opus-5-5|medium', 'medium'],
    ['reviewer|claude-opus-5-5|medium', 'medium'],
    ['reviewer|claude-sonnet-5-5|medium', 'small']
  ] as const)('minutes of %s (%s) within 30%% of the measured median', (key, size) => {
    const [role, id, effort] = key.split('|') as ['implementer' | 'planner' | 'reviewer', string, 'medium'];
    const prior = expectedMinutes({ role: budgetRole(role), size, effort, model: model('claude', id) });
    expect(within(prior, median(MINUTES_2026_10_09[key]!)), `${prior} vs ${median(MINUTES_2026_10_09[key]!)}`).toBe(true);
  });
});

describe('size gate on real-sized work', () => {
  it('a Chronica-sized task (durable turns + migrations) is estimated over the limit and split; a small precise task passes', () => {
    const chronica = 'Implement durable turns: persist every turn in a new turns table with a schema migration, write the turn log in one transaction, and take a lease lock so two resumes of one conversation cannot run concurrently. Update the store, the runner and the migration tests.';
    const files = ['src/store/turns.ts', 'src/store/migrations/0007_turns.sql', 'src/runner/resume.ts', 'src/runner/lease.ts', 'tests/turns.test.ts', 'tests/migrations.test.ts'];
    const big = difficultyOf({ role: 'implementer', text: chronica, files, hint: 'high', verify: true });
    expect(big.size).toBe('large');
    expect(big.difficulty).toBeGreaterThanOrEqual(7.5);
    const bigMinutes = estimateTaskMinutes({ role: 'implementer', size: big.size, difficulty: big.difficulty, needs: ['code'], catalog: DEFAULT_CATALOG });
    expect(bigMinutes).toBeGreaterThan(MAX_TASK_MINUTES);
    expect(gateTask({ title: 'Durable turns', instructions: chronica, access: 'edit', files, minutes: bigMinutes })).toMatch(/estimated at about \d+ minutes/);
    const small = 'Rename parseTurn to parseTurnLine in src/runner/parse.ts and update its two call sites.';
    const little = difficultyOf({ role: 'implementer', text: small, files: ['src/runner/parse.ts'], hint: 'low' });
    expect(little.size).toBe('small');
    const littleMinutes = estimateTaskMinutes({ role: 'implementer', size: little.size, difficulty: little.difficulty, needs: ['code'], catalog: DEFAULT_CATALOG });
    expect(littleMinutes).toBeLessThan(MAX_TASK_MINUTES);
    expect(gateTask({ title: 'Rename', instructions: small, access: 'edit', files: ['src/runner/parse.ts'], minutes: littleMinutes })).toBeUndefined();
  });

  // Review finding: size 'large' from a long spec alone priced every task at ~30 minutes, so a one-file task with a precise spec was refused for ever.
  it('a long precise spec for one file passes; a refusal names its drivers; many files stay refused', () => {
    const long = `Rename parseTurn to parseTurnLine in src/runner/parse.ts. ${'Keep the behaviour identical and update the callers. '.repeat(70)}`;
    const est = difficultyOf({ role: 'implementer', text: long, files: ['src/runner/parse.ts'], hint: 'medium' });
    expect(est.size).toBe('large'); // by length alone
    const size = gateSize(est.size, est.drivers);
    expect(size).toBe('medium');
    const minutes = estimateTaskMinutes({ role: 'implementer', size, difficulty: est.difficulty, needs: ['code'], catalog: DEFAULT_CATALOG });
    expect(gateTask({ title: 'Rename', instructions: long, access: 'edit', files: ['src/runner/parse.ts'], minutes })).toBeUndefined();
    const files = Array.from({ length: 9 }, (_, i) => `src/m${i}.ts`);
    const many = difficultyOf({ role: 'implementer', text: 'Add retry to each module.', files, hint: 'high' });
    const manySize = gateSize(many.size, many.drivers);
    expect(manySize).toBe('large');
    const why = gateTask({ title: 'Retry', instructions: 'Add retry to each module.', access: 'edit', files, minutes: estimateTaskMinutes({ role: 'implementer', size: manySize, difficulty: many.difficulty, needs: ['code'], catalog: DEFAULT_CATALOG }), detail: describeDrivers(many.drivers, manySize) });
    expect(why).toMatch(/9 files.*fewer than 8/s);
  });
});
