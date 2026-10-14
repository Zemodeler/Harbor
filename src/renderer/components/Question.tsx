import { useState } from 'react';
import type { Question } from '../hooks/useHarbor';
import s from '../Harbor.module.css';

interface Part { prompt: string; options?: string[]; allowText?: boolean; multiSelect?: boolean }
interface Pick { chosen: string[]; custom: boolean; text: string }
const CUSTOM = '__custom';

/** What one part of the card answers, or '' while it is incomplete. */
function resultOf(p: Part, v: Pick): string {
  const hasOptions = !!p.options?.length;
  const own = v.text.trim();
  if (!hasOptions) return own;
  const parts = [...v.chosen, ...(v.custom && own ? [own] : [])];
  return (p.multiSelect ? parts.join('; ') : v.custom ? own : v.chosen[0] ?? '');
}

/**
 * A question from an agent as a card above the workspace, not a dialog: other dialogs, shortcuts and the composer
 * keep working, and what is typed here stays while the user does something else. Selecting is separate from
 * sending so keyboard exploration cannot accidentally answer. Failures show on this card only.
 * One card can carry several questions (answered together, one message back) and multi-select ones (checkboxes).
 */
export function QuestionCard({ q, who, pending, answer, dismiss, error }: { q: Question; who: string; pending: boolean; answer: (text: string) => void; dismiss: () => void; error?: string }) {
  const parts: Part[] = [{ prompt: q.prompt, options: q.options, allowText: q.allowText, multiSelect: q.multiSelect }, ...(q.questions ?? [])];
  const [picks, setPicks] = useState<Pick[]>(() => parts.map(() => ({ chosen: [], custom: false, text: '' })));
  const update = (i: number, f: (v: Pick) => Pick) => setPicks(ps => ps.map((v, k) => k === i ? f(v) : v));
  const results = parts.map((p, i) => resultOf(p, picks[i] ?? { chosen: [], custom: false, text: '' }));
  const ready = results.every(Boolean);
  const text = parts.length === 1 ? results[0]! : parts.map((p, i) => `${p.prompt}\n${results[i]}`).join('\n\n');
  return <section className={s.hqQuestion} aria-label={`${who} has a question`} data-request={q.requestId}>
    <h2 className={s.hqQuestionTitle}>{who} has {parts.length > 1 ? `${parts.length} questions` : 'a question'}</h2>
    <form onSubmit={e => { e.preventDefault(); if (ready && !pending) answer(text); }}>
      {parts.map((p, i) => {
        const v = picks[i] ?? { chosen: [], custom: false, text: '' };
        const name = `question-answer-${q.requestId}-${i}`;
        const multi = !!p.multiSelect;
        const type = multi ? 'checkbox' : 'radio';
        const toggle = (o: string) => update(i, x => multi ? { ...x, chosen: x.chosen.includes(o) ? x.chosen.filter(c => c !== o) : [...x.chosen, o] } : { ...x, chosen: [o], custom: false });
        const showText = (p.allowText || !p.options?.length) && (v.custom || !p.options?.length);
        return <div key={i}>
          <p className={s.questionPrompt}>{p.prompt}</p>
          {p.options?.length ? <fieldset className={s.questionChoices}><legend>{multi ? 'Choose all that apply' : 'Choose an answer'}</legend>{p.options.map((o, k) => <label key={`${o}-${k}`} className={s.questionChoice}><input type={type} name={name} disabled={pending} checked={v.chosen.includes(o)} onChange={() => toggle(o)}/><span>{o}</span></label>)}
            {p.allowText ? <label className={s.questionChoice}><input type={type} name={name} value={CUSTOM} disabled={pending} checked={v.custom} onChange={() => update(i, x => multi ? { ...x, custom: !x.custom } : { ...x, custom: true, chosen: [] })}/><span>Write my own answer</span></label> : null}
          </fieldset> : null}
          {showText ? <label className={s.field}>Your answer<textarea disabled={pending} value={v.text} onChange={e => update(i, x => ({ ...x, text: e.target.value }))} placeholder="Add the detail the agent needs…" rows={4}/></label> : null}
        </div>;
      })}
      <p className={s.muted}>The agent is waiting for your response. You can also answer in the conversation.</p>
      <div className={`${s.actions} ${s.questionActions}`}><button type="button" disabled={pending} onClick={dismiss}>Answer in chat</button><button type="submit" className={s.primary} disabled={pending || !ready}>{pending ? 'Sending…' : 'Send answer'}</button></div>
    </form>
    {error ? <p className={s.error} role="alert">{error}</p> : null}
  </section>;
}
