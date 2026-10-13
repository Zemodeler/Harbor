import type { CliId } from '../../src/shared/api';
import type { ReportedLimit } from '../../src/main/codexLimits';

/**
 * asOf is a minute old: a reading stamped "now" can be a few ms ahead of the clock the budget reads and is then not trusted (flaky).
 * Without any provider-reported window a pool runs one helper at a time (helperLimit.ts), so tests that need parallel helpers give
 * their ledger a reading: `ledger: { reported: calmReported }`.
 *
 * calmReported: plenty of room (10% of the week and 5% of the 5h window used, resets far away). Room for three helpers; routing may
 * prefer stronger models because the allowance is abundant, so tests that assert the chosen model use onPaceReported.
 */
export const calmReported = (_cli: CliId): ReportedLimit[] => {
  const now = Date.now();
  return [
    { period: 'weekly', usedPct: 10, resetsAt: now + 4 * 24 * 3_600_000, asOf: now - 60_000 },
    { period: 'session', usedPct: 5, resetsAt: now + 4 * 3_600_000, asOf: now - 60_000 }
  ];
};

/** On pace (43% of the week used with 4 of 7 days left, 20% of the 5h window with 4 of 5 hours left): neutral pools, usual model choices. */
export const onPaceReported = (_cli: CliId): ReportedLimit[] => {
  const now = Date.now();
  return [
    { period: 'weekly', usedPct: 43, resetsAt: now + 4 * 24 * 3_600_000, asOf: now - 60_000 },
    { period: 'session', usedPct: 20, resetsAt: now + 4 * 3_600_000, asOf: now - 60_000 }
  ];
};
