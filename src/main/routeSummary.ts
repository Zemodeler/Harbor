import type { Effort } from './adapters/types';
import type { Tier } from './clis/capabilities';
import { complexityOf } from './difficulty';
import type { Cand, Evaluation, RouteRequest } from './router';

/**
 * The routing choice in a few plain sentences for a person (Message.details.summary). It never repeats the numbers of the technical
 * reason (routeReason.ts), which stays available beside it for debugging. Pure.
 */
const CLI_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
const cliName = (id: string) => CLI_NAMES[id] ?? id;
const modelName = (c: Cand) => `${cliName(c.cli.id)} ${c.entry.model}`;

const TIER_TEXT: Record<Tier, string> = {
  cheap: 'a small, inexpensive model is enough',
  standard: 'a mid-range model fits',
  strong: 'it needs one of the strongest models'
};
const HARDNESS = { low: 'simple', medium: 'moderate', high: 'demanding' } as const;

export function routeSummary(o: {
  req: RouteRequest; ev: Evaluation; best: Cand; second?: Cand; effort: Effort; tied: boolean;
  degraded?: { wantedTier: Tier; gotTier: Tier }; reviewReason?: string;
}): string {
  const { req, ev, best, second, effort } = o;
  const out: string[] = [];
  const asked = req.prefer === best.cli.id;
  out.push(`Harbor picked ${modelName(best)} at ${effort} effort${asked ? ` because you asked for ${cliName(best.cli.id)}` : ''}.`);

  const hard = HARDNESS[complexityOf(ev.difficulty)];
  out.push(o.degraded
    ? `The task looks ${hard} (${ev.difficulty} out of 10) and nothing strong enough was available, so this is the best option there was.`
    : `The task looks ${hard} (${ev.difficulty} out of 10), so ${TIER_TEXT[best.entry.tier]}.`);

  const used = `about ${best.pct}% used${best.source === 'estimated' ? ', by Harbor\'s own count' : ''}`;
  out.push(best.level === 'plenty' ? `${cliName(best.cli.id)} has plenty of quota left (${used}).`
    : best.level === 'limited' ? `${cliName(best.cli.id)} quota is getting limited (${used}).`
      : `${cliName(best.cli.id)} quota is running low (${used}), but it was still the best choice.`);

  if (best.opt.wasteCreditPct > 0) out.push('Part of that quota would expire unused, so spending it costs nothing.');

  if (second) {
    const diff = second.opt.routeTotal - best.opt.routeTotal;
    const sameCost = Math.abs(diff) <= Math.max(0.02, 0.1 * best.opt.routeTotal);
    const why = o.tied ? 'it ranked level and lost the tie-break'
      : second.protect ? 'its quota is being saved for later'
        : sameCost ? 'it costs about the same but ranked lower'
          : diff > 0 ? 'it would use more quota' : 'it is cheaper but ranked lower on other factors, such as keeping the current session';
    out.push(`Next best was ${modelName(second)}; ${why}.`);
  }

  if (req.continuity === best.cli.id) out.push('This continues the existing session, which avoids losing its context.');
  if (req.escalateFrom) out.push('The previous attempt was rejected, so Harbor raised the bar for this retry.');
  if (ev.urgency > 0) out.push('A deadline is set, so time counted for more than quota.');
  if (o.reviewReason) out.push('Because this is only a close fit for hard work, the result will be reviewed.');
  return out.join(' ');
}
