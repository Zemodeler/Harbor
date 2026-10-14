import { useEffect, useId, useState } from 'react';
import type { Conversation, HarborApi } from '../../shared/api';
import { useAction } from '../hooks/useAgentActions';
import s from './Features.module.css';

/** `datetime-local` works in local wall time without a zone: convert both ways here, never through ISO strings. */
const pad = (n: number) => String(n).padStart(2, '0');
export function toLocalInput(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(v: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return undefined;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  return Number.isFinite(t) ? t : undefined;
}

/**
 * When the owner needs this conversation's work. Routing turns a near deadline into urgency (its helpers go first and
 * it may spend the reserve), so the hint says that. Hidden when the core does not offer the method.
 */
export function DeadlineControl({ api, conversation }: { api: HarborApi; conversation: Conversation }) {
  const { busy, error, run } = useAction();
  const id = useId();
  const [draft, setDraft] = useState(conversation.deadline ? toLocalInput(conversation.deadline) : '');
  const [editing, setEditing] = useState(false);
  useEffect(() => { setDraft(conversation.deadline ? toLocalInput(conversation.deadline) : ''); setEditing(false); }, [conversation.id, conversation.deadline]);
  if (typeof api.setConversationDeadline !== 'function') return null;
  const set = api.setConversationDeadline.bind(api);
  const when = draft ? fromLocalInput(draft) : undefined;
  const past = when !== undefined && when <= Date.now();
  const save = () => { if (when !== undefined && !past) void run(() => set(conversation.id, when)).then(r => { if (r.ok) setEditing(false); }); };
  const clear = () => void run(() => set(conversation.id, null)).then(r => { if (r.ok) { setDraft(''); setEditing(false); } });
  return <div className={s.fxBlock} aria-labelledby={`${id}-title`} role="group">
    <div className={s.fxHead} id={`${id}-title`}>Deadline</div>
    {conversation.deadline && !editing ? <div className={s.fxRow}>
      <span>Needed by <time dateTime={new Date(conversation.deadline).toISOString()}>{new Date(conversation.deadline).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time></span>
      <button disabled={busy} onClick={() => setEditing(true)}>Change</button>
      <button disabled={busy} onClick={clear}>Clear deadline</button>
    </div> : <form className={s.fxRow} onSubmit={e => { e.preventDefault(); save(); }}>
      <label htmlFor={`${id}-input`} className={s.fxMuted}>Needed by</label>
      <input id={`${id}-input`} type="datetime-local" value={draft} disabled={busy} aria-describedby={`${id}-hint`} aria-invalid={past || undefined} onChange={e => setDraft(e.target.value)}/>
      <button type="submit" disabled={busy || when === undefined || past}>{busy ? 'Saving…' : 'Set deadline'}</button>
      {editing ? <button type="button" disabled={busy} onClick={() => { setEditing(false); setDraft(conversation.deadline ? toLocalInput(conversation.deadline) : ''); }}>Cancel</button> : null}
    </form>}
    <p className={s.fxNote} id={`${id}-hint`}>{past ? 'Pick a time in the future.' : 'A near deadline lets Harbor start this conversation’s helpers first and use the reserve or faster options. Optional.'}</p>
    {error ? <p className={s.fxError} role="alert">{error}</p> : null}
  </div>;
}
