import type { PoolState, PoolWindowState } from './budget';
import type { PriceBreakdown } from './budgetCost';
import type { RoutePrice } from './routePrice';

/**
 * Plain words for the budget governor's numbers, for the routing reason text. Pure. Harbor's own counts are always labelled as
 * estimates: they are never the provider's quota (AGENTS.md).
 */

const pct = (n: number) => `${Math.round(n)}%`;
const rate = (n: number) => `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10}%/h`;
const hours = (h: number) => (h >= 10 ? `${Math.round(h)}h` : h >= 1 ? `${Math.round(h * 10) / 10}h` : `${Math.max(1, Math.round(h * 60))}m`);
const num = (n: number) => (n >= 100 ? String(Math.round(n)) : String(Math.round(n * 100) / 100));

/**
 * One window, e.g. "claude:opus weekly: 31% unspent beyond the 20% reserve, 18h to reset, burning 0.9%/h -> spend (rho 1.6)".
 * Estimates, old readings and windows with no reading say so.
 */
export function describeBudget(w: PoolWindowState): string {
  const name = `${w.pool} ${w.period === 'session' ? '5h' : 'weekly'}`;
  if (w.source === 'unknown') return `${name}: no reading -> neutral`;
  const label = w.source === 'estimated' ? ' (estimate from Harbor runs only, not the provider\'s quota)' : '';
  const bits = [
    w.exhausted ? `${pct(w.remainingPct)} left, at or below the ${pct(w.reservePct)} reserve: held for interactive work` : `${pct(w.usablePct)} unspent beyond the ${pct(w.reservePct)} reserve`,
    `${hours(w.hoursToReset)} to reset${w.resetsAt === undefined ? ' (rolling, reset time unknown)' : ''}`,
    w.burnSource === 'none' ? 'no burn measured'
      : w.burnSource === 'pace' ? `burning ${rate(w.burnPctPerHour)} (average since the window began)`
        : w.burnSource === 'estimated' ? `burning ~${rate(w.burnPctPerHour)} (Harbor runs only)` : `burning ${rate(w.burnPctPerHour)}`
  ];
  const rho = w.rho === Infinity ? 'nothing burning' : `rho ${num(w.rho)}`;
  const trust = w.stale && w.ageMs !== undefined ? `; reading ${hours(w.ageMs / 3_600_000)} old, trusted ${pct(w.trust * 100)}, treated as neutral (raw ${w.rawState})` : '';
  return `${name}${label}: ${bits.join(', ')} -> ${w.state} (${rho}${trust})`;
}

/** Every window of a pool, plus why it is unavailable when it is. */
export function describePool(p: PoolState): string {
  const head = p.exhausted
    ? `${p.pool} unavailable for automatic work${p.unavailableUntil !== undefined ? ` until ${new Date(p.unavailableUntil).toISOString()}` : ''}; `
    : '';
  return head + (p.windows.length ? p.windows.map(describeBudget).join('; ') : `${p.pool}: no reading -> neutral`);
}

/**
 * One option as routing priced it: describePrice plus the use-it-or-lose-it credit and the automatic review, e.g.
 * "claude/claude-opus-5-5 low: ~2.4% of claude:opus weekly - 2.4% that would expire unused x scarcity 0.4 x risk 1.07 (failure 1%) = 0 (estimate)".
 */
export function describeRoutePrice(b: RoutePrice): string {
  const credit = b.wasteCreditPct > 0 ? ` - ${num(b.wasteCreditPct)}% that would expire unused` : '';
  const time = b.timeCost > 0 ? ` + time ${num(b.timeCost)} (${num(b.minutes)} min)` : '';
  const review = b.reviewPrice > 0 ? ` + review ${num(b.reviewPrice)}` : '';
  const flags = [!b.clears ? 'below the capability floor' : '', !b.available ? 'unavailable now' : ''].filter(Boolean);
  return `${b.cli}/${b.model} ${b.effort}: ~${num(b.expectedCostPct)}% of ${b.bindingPool} weekly${credit} x scarcity ${num(b.scarcity)} x risk ${num(b.failureFactor)} (failure ${pct(b.failureRisk * 100)})${time}${review} = ${num(b.routeTotal)} (estimate)${flags.length ? ` [${flags.join(', ')}]` : ''}`;
}

/** One priced option, e.g. "claude/claude-opus-5-5 low: ~1.2% of claude:opus weekly x scarcity 0.4 x risk 1.02 + time 0 = 0.49 (estimate)". */
export function describePrice(b: PriceBreakdown): string {
  const time = b.timeCost > 0 ? ` + time ${num(b.timeCost)} (${num(b.minutes)} min)` : '';
  const flags = [!b.clears ? 'below the capability floor' : '', !b.available ? 'unavailable now' : ''].filter(Boolean);
  return `${b.cli}/${b.model} ${b.effort}: ~${num(b.expectedCostPct)}% of ${b.bindingPool} weekly x scarcity ${num(b.scarcity)} x risk ${num(b.failureFactor)} (failure ${pct(b.failureRisk * 100)})${time} = ${num(b.total)} (estimate)${flags.length ? ` [${flags.join(', ')}]` : ''}`;
}
