import { useId, useState } from 'react';
import type { Message } from '../../shared/api';
import { ComplexityBadge } from './SessionStatus';
import s from './Features.module.css';

type Details = NonNullable<Message['details']>;
type Scored = NonNullable<Details['scored']>[number];

const REASON_PREVIEW = 220;
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n) >= 10 ? Math.abs(n).toFixed(0) : Math.abs(n).toFixed(1)}`;
const when = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** The routing reason carries the whole calculation and can be long: show its start and let the user open the rest. */
export function RoutingReason({ reason }: { reason: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const text = reason.trim();
  if (text.length <= REASON_PREVIEW) return <span className={s.fxPre}>{text}</span>;
  const cut = text.slice(0, REASON_PREVIEW).replace(/\s+\S*$/, '');
  return <span>
    <span id={id} className={s.fxPre}>{open ? text : `${cut}…`}</span>{' '}
    <button type="button" className={s.fxLink} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show full reasoning'}</button>
  </span>;
}

function Candidate({ c, chosen }: { c: Scored; chosen: boolean }) {
  const terms = Object.entries(c.terms).filter(([, v]) => Number.isFinite(v) && Math.abs(v) >= 0.05).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return <li data-candidate={`${c.cli}/${c.model}`}>
    <div className={s.fxRow}>
      <strong className={s.fxMono}>{c.cli} / {c.model}</strong>
      {chosen ? <span className={s.fxBadge} data-tone="ok">chosen</span> : null}
      <span className={s.fxMuted}>score {Number.isFinite(c.score) ? c.score.toFixed(1) : '?'}</span>
      {c.effort ? <span className={s.fxMuted}>{c.effort} effort</span> : null}
      {c.price !== undefined && Number.isFinite(c.price) ? <span className={s.fxMuted} title="Harbor's estimate of this run's share of the weekly quota, weighted by how scarce the quota is. Not a provider figure.">price ≈ {c.price < 0.1 ? c.price.toFixed(2) : c.price.toFixed(1)}% weekly (estimate)</span> : null}
    </div>
    {terms.length ? <p className={s.fxNote}>{terms.map(([k, v]) => `${k} ${signed(v)}`).join(' · ')}</p> : null}
    {c.headroom?.windows.length ? <p className={s.fxNote}>Room: {c.headroom.windows.map(w => `${w.period === 'session' ? '5h' : 'week'}${w.scope ? ` (${w.scope})` : ''} ${Math.round(w.remainingPct)}% left${w.projectedPct !== undefined ? `, projected ${Math.round(w.projectedPct)}%` : ''}${w.resetsAt ? `, resets ${when(w.resetsAt)}` : ''} [${w.source === 'reported' ? 'reported' : 'estimate'}]`).join(' · ')}</p> : null}
  </li>;
}

/**
 * "Why this model": the chosen CLI/model, difficulty, the best three candidates with their per-term points, what was
 * skipped (and until when), and the full reason text behind a toggle. Prices and headroom are Harbor's estimates.
 */
export function RoutingDetails({ details, complexity }: { details: Details; complexity?: 'low' | 'medium' | 'high' }) {
  const top = [...(details.scored ?? [])].sort((a, b) => b.score - a.score).slice(0, 3);
  const chosenKey = `${details.cli}/${details.model}`;
  return <div className={s.fxRouting}>
    <p className={s.fxRow}>
      <span>{details.cli} / {details.model} · {details.effort} effort</span>
      {complexity ? <ComplexityBadge complexity={complexity}/> : null}
      {details.difficulty !== undefined && Number.isFinite(details.difficulty) ? <span className={s.fxBadge} title="Harbor's difficulty estimate for this request, 0 (trivial) to 10 (hardest).">difficulty {Math.round(details.difficulty)}/10</span> : null}
      {details.needsReview ? <span className={s.fxBadge} data-tone="warn" title={details.reviewReason}>needs review</span> : null}
      {details.tied ? <span className={s.fxBadge} data-tone="warn">close call</span> : null}
    </p>
    {details.needsReview && details.reviewReason ? <p className={s.fxNote}>Review suggested: {details.reviewReason}</p> : null}
    {details.degraded ? <p className={s.fxNote}>Wanted a {details.degraded.wantedTier} model; used a {details.degraded.gotTier} one because nothing better was available.</p> : null}
    {top.length ? <div>
      <h4 className={s.fxHead}>Best candidates{details.margin !== undefined && Number.isFinite(details.margin) ? <span className={s.fxMuted}>margin {details.margin.toFixed(1)} points</span> : null}</h4>
      <ol className={s.fxList}>{top.map(c => <Candidate key={`${c.cli}/${c.model}`} c={c} chosen={`${c.cli}/${c.model}` === chosenKey}/>)}</ol>
    </div> : null}
    {details.skipped?.length ? <div>
      <h4 className={s.fxHead}>Skipped</h4>
      <ul className={s.fxList}>{details.skipped.map((k, i) => <li key={`${k.cli}-${k.model ?? ''}-${i}`}><span className={s.fxMono}>{k.cli}{k.model ? ` / ${k.model}` : ''}</span><span className={s.fxMuted}>{k.why}{k.until ? ` · until about ${when(k.until)}` : ''}{k.transient ? ' · temporary' : ''}</span></li>)}</ul>
    </div> : null}
    {details.reason ? <p className={s.fxNote}><RoutingReason reason={details.reason}/></p> : null}
  </div>;
}
