/**
 * Real measurements from this machine, 2026-10-12, copied as numbers only (no conversation text) from:
 *   - %APPDATA%\Harbor\state.json (usage events: duration, tokens, the provider's limit readings; agents: role, effort), read-only;
 *   - ~/.codex/sessions/2026/10/12/*.jsonl `token_count` events (thread-cumulative total_token_usage and rate_limits), read-only.
 * The Chronica project (e515963d-...) ran large, high-difficulty implementers; the other project (af00968b-...) ran small and
 * medium work on 2026-10-09, before Harbor recorded Claude cache tokens (durations from it are used, its tokens are not).
 * Billable k-tokens use calibration.billableKTok: input + output + cache writes + 0.1 * cache reads.
 * These are what budgetPriors.ts was tuned to reproduce (tests/realPriors.test.ts checks it within 30%).
 */

export interface MeasuredRun {
  what: string;
  cli: 'claude' | 'codex';
  model: string;
  role: 'planner' | 'implementer' | 'reviewer' | 'other' | 'main';
  effort: 'low' | 'medium' | 'high';
  /** Size the run would be judged at (difficulty.ts sizeOf): Chronica's implementers were large. */
  size: 'small' | 'medium' | 'large';
  minutes: number;
  inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number;
}

/** Complete runs with full token counts. */
export const MEASURED_RUNS: MeasuredRun[] = [
  { what: 'Chronica implementer (durable turns), ok', cli: 'claude', model: 'claude-opus-5-5', role: 'implementer', effort: 'medium', size: 'large', minutes: 29.6, inputTokens: 200, outputTokens: 76_942, cacheReadTokens: 18_002_638, cacheWriteTokens: 235_539 },
  { what: 'Chronica implementer on Fable, ok', cli: 'claude', model: 'claude-fable-5-1', role: 'implementer', effort: 'medium', size: 'large', minutes: 27.4, inputTokens: 1_330, outputTokens: 89_054, cacheReadTokens: 10_698_871, cacheWriteTokens: 295_352 },
  { what: 'Chronica reviewer at low effort, ok', cli: 'claude', model: 'claude-opus-5-5', role: 'reviewer', effort: 'low', size: 'small', minutes: 0.8, inputTokens: 14, outputTokens: 3_833, cacheReadTokens: 320_896, cacheWriteTokens: 57_360 },
  // Codex: uncached input = input - cached (Codex's input count includes the cached part).
  { what: 'Codex reviewer (gpt-6.1-sol)', cli: 'codex', model: 'gpt-6.1-sol', role: 'reviewer', effort: 'medium', size: 'small', minutes: 1.0, inputTokens: 178_381 - 158_592, outputTokens: 822, cacheReadTokens: 158_592 }
];

/** Chronica implementers Harbor stopped at its old flat 45-minute cap (unfinished; no tokens were recorded then). */
export const CAPPED_LARGE_IMPLEMENTER_MINUTES = [45, 45, 45, 45];

/** Wall minutes of finished helper runs on 2026-10-09 (small and medium work), by role and model. */
export const MINUTES_2026_10_09: Record<string, number[]> = {
  'implementer|claude-sonnet-5-5|medium': [3.2, 3.3, 4.4, 6.4, 4.5, 5.2, 4.6, 2.8, 5.1, 1.2, 1.0],
  'implementer|claude-opus-5-5|medium': [6.2, 4.7, 9.0, 10.4, 13.3, 10.1, 8.5, 31.7, 4.7, 9.4, 11.3, 2.4, 7.2],
  'implementer|claude-haiku-5-5|low': [2.6, 1.9],
  'planner|claude-opus-5-5|medium': [4.2, 3.3, 6.0, 5.3, 5.6],
  'reviewer|claude-opus-5-5|medium': [6.2, 5.0, 2.3, 2.3, 2.1, 1.0, 0.8],
  'reviewer|claude-sonnet-5-5|medium': [1.1, 0.5, 0.5, 1.1, 0.5, 0.4]
};

/**
 * Provider windows over the Chronica day. Claude: account-wide weekly and 5h readings Harbor recorded (no per-model weekly window
 * was reported on this account; the only extra key was `seven_day_overage_included`). Codex: `rate_limits` in its own session logs.
 */
export const CLAUDE_WINDOW_READINGS = [
  { at: '11:25', weeklyPct: 7, sessionPct: 1 },
  { at: '12:30', weeklyPct: 9, sessionPct: 10 },
  { at: '13:20', weeklyPct: 16, sessionPct: 51 },
  { at: '13:37', weeklyPct: 17, sessionPct: 61 },
  { at: '14:34', weeklyPct: 18, sessionPct: 68 }
];

/**
 * Claude between 11:25 and 14:34 (weekly +11, 5h +67): Harbor ran the two complete strong runs above (3,569 billable k-tokens) and four
 * capped 45-minute strong runs with no counts; those are estimated at the measured strong throughput (62 k-tokens/min), the last one
 * for the 41 minutes before the 14:34 reading. Use outside Harbor (the owner's own Claude Code session) is in the deltas too, so the
 * per-token figures are an upper bound.
 */
export const CLAUDE_SPAN = { weeklyDeltaPct: 11, sessionDeltaPct: 67, billableKTokStrong: 3_569 + 0.093e3 + 3 * 45 * 62 + 41 * 62 };

/**
 * Codex over the day (all of its session logs, gpt-6.1-sol): weekly 3% -> 15%; 5h window 0% (11:20) -> 72% (15:45). Billable
 * k-tokens for the day / up to 15:45, from the thread-cumulative totals of every session (uncached input + output + 0.1 * cached).
 */
export const CODEX_SPAN = { weeklyDeltaPct: 12, weeklyBillableKTok: 4_285, sessionDeltaPct: 72, sessionBillableKTok: 4_056 };

/** Codex lead turns of the Chronica conversation: 102.6 minutes of turn time for 3,776 billable k-tokens (one thread). */
export const CODEX_LEAD = { minutes: 102.6, billableKTok: 3_776 };
