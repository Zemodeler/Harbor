import { useEffect, useRef, useState } from 'react';
import type { Question } from '../hooks/useHarbor';
import { Modal } from './Modal';
import s from '../Harbor.module.css';


/** Selecting is separate from sending so keyboard exploration cannot accidentally answer. */
export function QuestionDialog({ q, who, pending, answer, dismiss, error }: { q: Question; who: string; pending: boolean; answer: (text: string) => void; dismiss: () => void; error?: string }) {
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string>();
  const firstChoice = useRef<HTMLInputElement>(null);
  const answerField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { (firstChoice.current || answerField.current)?.focus(); }, [q.requestId]);
  const result = selected === '__custom' || !q.options?.length ? text.trim() : selected;
  return <Modal title={`${who} has a question`} close={dismiss} dismissible={!pending}>
    <p className={s.questionPrompt}>{q.prompt}</p>
    <form onSubmit={e => { e.preventDefault(); if (result && !pending) answer(result); }}>
      {q.options?.length ? <fieldset className={s.questionChoices}><legend>Choose an answer</legend>{q.options.map((o, i) => <label key={`${o}-${i}`} className={s.questionChoice}><input ref={i === 0 ? firstChoice : undefined} type="radio" name="question-answer" disabled={pending} checked={selected === o} onChange={() => setSelected(o)}/><span>{o}</span></label>)}
        {q.allowText ? <label className={s.questionChoice}><input type="radio" name="question-answer" disabled={pending} checked={selected === '__custom'} onChange={() => setSelected('__custom')}/><span>Write my own answer</span></label> : null}
      </fieldset> : null}
      {(q.allowText || !q.options?.length) && (selected === '__custom' || !q.options?.length) ? <label className={s.field}>Your answer<textarea ref={answerField} autoFocus disabled={pending} value={text} onChange={e => setText(e.target.value)} placeholder="Add the detail the agent needs…" rows={4}/></label> : null}
      <p className={s.muted}>The agent is waiting for your response. You can also answer in the conversation.</p>
      <div className={`${s.actions} ${s.questionActions}`}><button type="button" disabled={pending} onClick={dismiss}>Answer in chat</button><button type="submit" className={s.primary} disabled={pending || !result}>{pending ? 'Sending…' : 'Send answer'}</button></div>
    </form>
    {error ? <p role="alert">{error}</p> : null}
  </Modal>;
}
