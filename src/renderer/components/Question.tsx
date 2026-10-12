import { useState } from 'react';
import type { Question } from '../hooks/useHarbor';
import s from '../Harbor.module.css';

/**
 * A question from an agent as a card above the workspace, not a dialog: other dialogs, shortcuts and the composer
 * keep working, and what is typed here stays while the user does something else. Selecting is separate from
 * sending so keyboard exploration cannot accidentally answer. Failures show on this card only.
 */
export function QuestionCard({ q, who, pending, answer, dismiss, error }: { q: Question; who: string; pending: boolean; answer: (text: string) => void; dismiss: () => void; error?: string }) {
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string>();
  const result = selected === '__custom' || !q.options?.length ? text.trim() : selected;
  const name = `question-answer-${q.requestId}`;
  return <section className={s.hqQuestion} aria-label={`${who} has a question`} data-request={q.requestId}>
    <h2 className={s.hqQuestionTitle}>{who} has a question</h2>
    <p className={s.questionPrompt}>{q.prompt}</p>
    <form onSubmit={e => { e.preventDefault(); if (result && !pending) answer(result); }}>
      {q.options?.length ? <fieldset className={s.questionChoices}><legend>Choose an answer</legend>{q.options.map((o, i) => <label key={`${o}-${i}`} className={s.questionChoice}><input type="radio" name={name} disabled={pending} checked={selected === o} onChange={() => setSelected(o)}/><span>{o}</span></label>)}
        {q.allowText ? <label className={s.questionChoice}><input type="radio" name={name} disabled={pending} checked={selected === '__custom'} onChange={() => setSelected('__custom')}/><span>Write my own answer</span></label> : null}
      </fieldset> : null}
      {(q.allowText || !q.options?.length) && (selected === '__custom' || !q.options?.length) ? <label className={s.field}>Your answer<textarea disabled={pending} value={text} onChange={e => setText(e.target.value)} placeholder="Add the detail the agent needs…" rows={4}/></label> : null}
      <p className={s.muted}>The agent is waiting for your response. You can also answer in the conversation.</p>
      <div className={`${s.actions} ${s.questionActions}`}><button type="button" disabled={pending} onClick={dismiss}>Answer in chat</button><button type="submit" className={s.primary} disabled={pending || !result}>{pending ? 'Sending…' : 'Send answer'}</button></div>
    </form>
    {error ? <p className={s.error} role="alert">{error}</p> : null}
  </section>;
}
