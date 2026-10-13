import type { Chunk } from './adapters/types';

type UsageChunk = Extract<Chunk, { kind: 'usage' }>;

/** Token fields of one run as the usage ledger stores them. `partial`: no final report arrived, so the counts are a lower bound. */
export interface RunTokens {
  inputTokens?: number; outputTokens?: number; costUsd?: number; cacheReadTokens?: number; cacheWriteTokens?: number;
  partial?: boolean;
}

const FIELDS = ['inputTokens', 'outputTokens', 'costUsd', 'cacheReadTokens', 'cacheWriteTokens'] as const;

/**
 * Collects the usage chunks of one run. The CLI's final report (Claude `result`, Codex `turn.completed`) is authoritative and wins.
 * Without one (Harbor stopped the run at its time cap, the user stopped it, the CLI died), the per-message counts that streamed
 * before the end are summed instead, so the run still counts against the quota it really used; repeated reports of one message
 * (Claude repeats a message's usage on every content block) count once, the latest wins.
 */
export class RunUsage {
  private final: RunTokens | undefined;
  private parts = new Map<string, UsageChunk>();
  private seq = 0;

  add(c: UsageChunk): void {
    if (!c.partial) {
      const next: RunTokens = { ...this.final };
      for (const k of FIELDS) if (c[k] !== undefined) next[k] = c[k];
      this.final = next;
      return;
    }
    this.parts.set(c.messageId ?? `#${this.seq++}`, c);
  }

  /**
   * What the ledger records. A run that did not finish (`finished` false: stopped, capped, failed) and has no final report is always
   * marked `partial`, even with no counts at all; a finished run that simply reported nothing records nothing, as before.
   */
  result(finished: boolean): RunTokens {
    if (this.final && FIELDS.some((k) => this.final![k] !== undefined)) return this.final;
    if (finished && !this.parts.size) return {};
    const sum: RunTokens = { partial: true };
    for (const p of this.parts.values()) for (const k of FIELDS) if (typeof p[k] === 'number') sum[k] = (sum[k] ?? 0) + p[k]!;
    return sum;
  }
}

/** A session's running totals as the CLI last reported them (SessionLink.totals). */
export type SessionTotals = Partial<Record<'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'costUsd', number>>;

/**
 * Fields a CLI reports as running totals of the whole session rather than per run. Measured on 2026-10-12 (state.json and Codex's
 * own session logs): a resumed Codex thread's `turn.completed` usage is the thread's total (3.0M, 3.6M, 8.6M ... 29.8M input tokens
 * over one conversation's lead turns), and a resumed Claude session's `total_cost_usd` grows the same way (1.24, 1.40, 1.46 ... $4.10)
 * while its token counts are per run.
 */
export const CUMULATIVE_FIELDS: Readonly<Record<string, readonly (keyof SessionTotals)[]>> = {
  codex: ['inputTokens', 'outputTokens', 'cacheReadTokens'],
  claude: ['costUsd']
};

/**
 * One run's own usage from what the CLI reported (PURE): for the fields it reports as session totals, the rise over the totals it
 * reported after the previous run of the same session (`previous`; absent for a new session). A total lower than before means a
 * new thread or a reset counter: the value is taken as it is. Partial runs (no final report) are left alone and keep `previous`.
 */
export function perRunUsage(cli: string, raw: RunTokens, previous?: SessionTotals): { tokens: RunTokens; totals?: SessionTotals } {
  const fields = CUMULATIVE_FIELDS[cli] ?? [];
  if (raw.partial || !fields.length) return { tokens: raw, ...(previous ? { totals: previous } : {}) };
  const tokens: RunTokens = { ...raw };
  const totals: SessionTotals = { ...previous };
  for (const f of fields) {
    const v = raw[f];
    if (v === undefined) continue;
    const p = previous?.[f];
    tokens[f] = p !== undefined && v >= p ? v - p : v;
    totals[f] = v;
  }
  return { tokens, totals };
}
