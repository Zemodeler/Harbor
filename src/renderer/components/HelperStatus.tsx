import type { Agent } from '../../shared/api';
import s from './Features.module.css';

/**
 * What a helper is doing or why it stopped, in words the user can act on. Harbor carries most of this in
 * `Agent.summary` (its error text while queued, waiting, failed or stopped). `stopKind` is read only when the core
 * starts sending it (it is not in the contract yet); until then the loop guard is recognised by its message.
 */
const LOOP_TEXT = /going in circles|kept repeating/i;
const WAITING_LEAD = /^Waiting for the lead's answer/;
const WAITING_YOU = /^Waiting for your answer/;
const QUOTA_HOLD = /^Waiting: .*(quota|allowance).* until about /i;   // holdForQuota: "Waiting: <reason> until about HH:MM; it starts then"
const TIME_LIMIT = /time limit/i;

export type HelperFlag = { id: string; label: string; tone?: 'ok' | 'bad' | 'warn'; note?: string };

export function helperFlags(agent: Agent): HelperFlag[] {
  const summary = agent.summary ?? '';
  const stopKind = (agent as Agent & { stopKind?: string }).stopKind;
  const out: HelperFlag[] = [];
  // The cards that list helpers already print `summary` (for a loop stop: what repeated and how often), so it is not repeated here.
  if (agent.state === 'stopped') {
    if (stopKind === 'loop' || (stopKind === undefined && LOOP_TEXT.test(summary))) out.push({ id: 'loop', label: 'Stopped: looping', tone: 'bad', note: 'Harbor stopped it because it kept repeating the same steps (not your Stop, not the time limit). The lead decides what happens next.' });
    else if (stopKind === 'cap' || (stopKind === undefined && TIME_LIMIT.test(summary))) out.push({ id: 'cap', label: 'Stopped: time limit', tone: 'warn', note: 'Harbor stopped it at its time limit. The lead decides whether to continue it.' });
  }
  if (summary === 'possibly stuck') out.push({ id: 'stuck', label: 'Possibly stuck', tone: 'warn', note: 'No output for a while. Harbor has not stopped it; you can stop it yourself.' });
  if (agent.state === 'waiting' && WAITING_LEAD.test(summary)) out.push({ id: 'lead', label: 'Waiting on the lead', note: 'It asked the lead a question. Nothing is needed from you.' });
  if (agent.state === 'waiting' && WAITING_YOU.test(summary)) out.push({ id: 'you', label: 'Waiting on you', tone: 'bad', note: 'It needs your answer. Look for its question above the conversation.' });
  if (agent.state === 'queued' && QUOTA_HOLD.test(summary)) out.push({ id: 'quota', label: 'Held for quota', tone: 'warn', note: 'Not failed: it starts by itself at the time Harbor gives in its queue note.' });
  if (agent.estimatedMinutes !== undefined && Number.isFinite(agent.estimatedMinutes) && ['queued', 'working', 'waiting'].includes(agent.state)) {
    const m = Math.max(1, Math.round(agent.estimatedMinutes));
    out.push({ id: 'estimate', label: `about ${m} min (estimate)`, note: undefined });
  }
  return out;
}

export function HelperStatus({ agent }: { agent: Agent }) {
  const flags = helperFlags(agent);
  if (!flags.length) return null;
  const notes = flags.filter(f => f.note);
  // A lone estimate is a small badge; a status that needs explaining gets a framed block.
  return <div className={notes.length ? s.fxBlock : undefined} aria-label={`Status of ${agent.title}`} data-helper-status>
    <div className={s.fxRow}>{flags.map(f => <span key={f.id} className={s.fxBadge} data-tone={f.tone} data-flag={f.id} title={f.id === 'estimate' ? 'Harbor’s estimate of its running time when it was delegated, not a promise.' : undefined}>{f.label}</span>)}</div>
    {notes.map(f => <p key={f.id} className={s.fxNote}>{f.note}</p>)}  </div>;
}
