import type { Effort } from './adapters/types';
import { poolsOfEntry } from './budget';
import { describePoolLines, describeRoutePrice } from './budgetText';
import { modelMatches, type Tier } from './clis/capabilities';
import { complexityOf } from './difficulty';
import type { Cand, Evaluation, RouteRequest, RouterInput } from './router';

/**
 * The routing reason (Message.details.reason): the calculation, in plain words: a verdict line, then one bullet per fact. Chosen model and effort, the difficulty and its
 * signals, the estimated price against the runner-up, the state of every pool involved, the reserve and the deadline urgency, then
 * what else decided (session, preference, request, skips). Prices and Harbor-only readings are labelled as estimates.
 */
export function routeReason(o: {
  req: RouteRequest; inp: RouterInput; ev: Evaluation; best: Cand; second?: Cand; effort: Effort; tied: boolean;
  effortNotes: string[]; degraded?: { wantedTier: Tier; gotTier: Tier }; reviewReason?: string;
}): string {
  const { req, inp, ev, best, second, effort } = o;
  const pol = inp.policy ?? {};
  const label = complexityOf(ev.difficulty);
  const needs = req.needs?.length ? ` [${[...new Set(req.needs)].join(', ')}]` : '';
  const why = [`${best.cli.id}/${best.entry.model} (${best.entry.tier}) at ${effort} effort for ${req.role} work of difficulty ${ev.difficulty} (${label}, ${ev.size})${needs}: ${best.cli.authState === 'signedIn' ? 'signed in' : 'sign-in unverified'}, usage ${best.level} (~${best.pct}%${best.source === 'estimated' ? ' estimated' : ''}${best.projected !== undefined ? `, pace → ~${best.projected}% at reset` : ''})`];
  if (req.difficultySignals?.length) why.push(`difficulty from: ${req.difficultySignals.join('; ')}`);
  why.push(`price${req.prefer === best.cli.id ? ' (not weighed: you asked for this CLI)' : ''}: ${describeRoutePrice(best.opt)}${second ? `; runner-up ${describeRoutePrice(second.opt)}` : ''}`);
  const pools = [...new Set([best, second].flatMap((c) => (c ? poolsOfEntry(c.entry) : [])))].sort();
  for (const p of pools) if (ev.states[p]) why.push(...describePoolLines(ev.states[p]!).map((l) => `quota ${l}`));
  why.push(ev.interactive ? 'interactive work: may use the reserve' : 'helper work: the reserve stays free for interactive work');
  why.push(ev.urgency > 0 ? `deadline urgency ${Math.round(ev.urgency * 100) / 100}: reserve released in part, time priced` : 'no deadline (urgency 0)');
  if (req.continuity === best.cli.id) why.push('continues existing session');
  const prefersCli = !!pol.preference?.cli && pol.preference.cli === best.cli.id;
  if ((best.terms['preferred'] ?? 0) > 0 || prefersCli) why.push(`preferred for ${req.role} (settings)`);
  if (o.tied && second) why.push(`tied with ${second.cli.id}/${second.entry.model}; decided by tie-break (price, effort, failure risk, load, verified, catalog order, cli id)`);
  if ((best.terms['switchBack'] ?? 0) < 0) why.push('moving back to the CLI this session just left: counted against it');
  if (req.keep && best.cli.id === req.keep.cli && modelMatches(best.entry, req.keep.model)) why.push('keeps the session model');
  else if (req.keep && best.cli.id === req.keep.cli) why.push(`session model ${req.keep.model} → ${best.entry.model} (the session model cannot do this work at its effort, or is unavailable)`);
  // A flip of effort would invalidate the session's prompt cache: the price only chose among models at the kept effort.
  if (req.keep?.effort && best.cli.id === req.keep.cli && effort === req.keep.effort && best.efforts.length === 1 && !req.fixedEffort) why.push(`effort ${effort} kept for the resumed session`);
  if (req.escalateFrom) why.push(`retry of rejected work (was ${req.escalateFrom.model}${req.escalateFrom.effort ? ` at ${req.escalateFrom.effort}` : ''}): the floor was raised; more effort on the same model first, a stronger model only when cheaper`);
  if (best.level === 'low' && pol.lowAllowance === 'switch') why.push('allowance low and no healthier option to switch to');
  if (req.prefer) {
    if (req.prefer === best.cli.id) why.push(`${req.prefer} requested by you`);
    else why.push(`you asked for ${req.prefer} but it is unavailable (${ev.notes.filter((n) => n.startsWith(`${req.prefer}`)).join('; ') || 'no usable model'})`);
  }
  if ((best.terms['avoid'] ?? 0) < 0) why.push('on the avoid list but the best left');
  if ((best.terms['history'] ?? 0) < 0) why.push('recent failures on this model counted against it');
  why.push(...o.effortNotes);
  if (o.degraded) why.push(`degraded: nothing that clears difficulty ${ev.difficulty} was available (a ${o.degraded.wantedTier} model would), got ${o.degraded.gotTier}`);
  if (o.reviewReason) why.push(`needs review: ${o.reviewReason}`);
  why.push(`${req.role}/${label} → effort ${effort}`);
  why.push(...ev.notes);
  // First line is the verdict; every other fact gets its own bullet (the UI shows line breaks; collapsed, the bullets still separate them).
  return [why[0]!, ...why.slice(1).map((l) => `• ${l}`)].join('\n');
}
