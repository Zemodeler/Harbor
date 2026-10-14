import type { Id, Message, RatingSummaryRow, ResultRating, ResultRatingValue } from '../shared/api';
import type { AgentRecord } from './types';

/**
 * Quality feedback on results (rateResult). PURE. A rating is local evidence about one model's work: it is stored and aggregated, and
 * never written into capabilities.json. Whether the catalog should change stays the owner's call (or a later, explicit calibration).
 */

export const RATING_VALUES: readonly ResultRatingValue[] = ['up', 'down', 'redo-stronger'];
export const MAX_RATING_NOTE = 1000;
/** Ratings kept (newest win): enough for months of use, small enough for state.json. */
export const MAX_RATINGS = 5000;

export const isRatingValue = (v: unknown): v is ResultRatingValue => typeof v === 'string' && (RATING_VALUES as readonly string[]).includes(v);

/**
 * What a rating is about: an agent (its last run's CLI and model) or one message that carries routing details. Throws a readable error
 * for targets that ran on no model (an integrator, a plain user message).
 */
export function ratingTarget(o: { targetId: Id; agent?: AgentRecord; message?: Message; agentOf: (id: Id) => AgentRecord | undefined; conversationOf: (agentId: Id) => Id | undefined }): Omit<ResultRating, 'id' | 'time' | 'rating' | 'note'> {
  if (o.agent) {
    const a = o.agent;
    if (a.integration || a.rollback || a.cli === 'harbor') throw new Error('Harbor ran this task itself (no model): there is nothing to rate.');
    if (!a.cli || !a.model) throw new Error('This agent has not run on any model yet.');
    return {
      target: 'agent', targetId: a.id, projectId: a.projectId, agentId: a.id, role: a.role, cli: a.cli, model: a.model, effort: a.effort,
      ...(a.role === 'main' ? {} : { conversationId: a.parentConversationId }), ...(a.needs?.length ? { needs: [...a.needs] } : {}),
      ...(a.difficulty !== undefined ? { difficulty: a.difficulty } : {})
    };
  }
  const m = o.message;
  if (!m) throw new Error('Nothing to rate: no agent or message has that id.');
  const d = m.details;
  if (!d) throw new Error('Only a result produced by a routed run can be rated.');
  const a = m.agentId ? o.agentOf(m.agentId) : undefined;
  if (!a) throw new Error('The agent behind this message is no longer known.');
  const needs = d.request?.needs ?? a.needs;
  return {
    target: 'message', targetId: m.id, projectId: a.projectId, conversationId: a.role === 'main' ? m.conversationId : (a.parentConversationId ?? o.conversationOf(a.id)),
    agentId: a.id, role: a.role, cli: d.cli, model: d.model, effort: d.effort, ...(needs?.length ? { needs: [...needs] } : {}),
    ...(d.difficulty !== undefined ? { difficulty: d.difficulty } : {})
  };
}

/** Adds a rating; one rating per target (the newest replaces an earlier one), and the oldest are dropped beyond `max`. */
export function withRating(list: readonly ResultRating[], r: ResultRating, max = MAX_RATINGS): ResultRating[] {
  const out = [...list.filter((x) => x.targetId !== r.targetId), r].sort((a, b) => a.time - b.time);
  return out.length > max ? out.slice(out.length - max) : out;
}

/**
 * Ratings counted per CLI, per CLI + model (default) or per need. A rating with several needs counts once for each; one without needs
 * counts under 'unspecified'. Rows with the most ratings first.
 */
export function aggregateRatings(ratings: readonly ResultRating[], by: 'cli' | 'model' | 'need' = 'model'): RatingSummaryRow[] {
  const rows = new Map<string, RatingSummaryRow>();
  const bump = (key: string, base: Omit<RatingSummaryRow, 'up' | 'down' | 'redoStronger' | 'total' | 'approval'>, v: ResultRatingValue) => {
    const row = rows.get(key) ?? { ...base, up: 0, down: 0, redoStronger: 0, total: 0, approval: 0 };
    if (v === 'up') row.up++; else if (v === 'down') row.down++; else row.redoStronger++;
    row.total++;
    rows.set(key, row);
  };
  for (const r of ratings) {
    if (by === 'cli') bump(r.cli, { cli: r.cli }, r.rating);
    else if (by === 'model') bump(`${r.cli}/${r.model}`, { cli: r.cli, model: r.model }, r.rating);
    else for (const need of r.needs?.length ? [...new Set(r.needs)] : ['unspecified']) bump(need, { need }, r.rating);
  }
  return [...rows.entries()]
    .map(([, row]) => ({ ...row, approval: Math.round((row.up / row.total) * 1000) / 1000 }))
    .sort((a, b) => b.total - a.total || `${a.cli ?? ''}${a.model ?? ''}${a.need ?? ''}`.localeCompare(`${b.cli ?? ''}${b.model ?? ''}${b.need ?? ''}`));
}
