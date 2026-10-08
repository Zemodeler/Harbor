import { useEffect, useRef, useState } from 'react';
import type { HarborState } from '../hooks/useHarbor';
import { Brand } from './Brand';
import { Markdown } from './Markdown';
import s from '../Harbor.module.css';

export function Conversation({ state, openProject }: { state: HarborState; openProject: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const stream = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const c = state.conversation;
  const agent = state.agents.find(a => a.id === c?.agentId);
  const project = state.projects.find(p => p.id === state.projectId);
  const busy = !!c && (state.sending.has(c.id) || state.agents.some(a => (a.id === c.agentId || a.parentId === c.agentId) && ['working', 'queued'].includes(a.state)));
  const draft = c ? drafts[c.id] || '' : '';
  useEffect(() => { follow.current = true; }, [c?.id]);
  useEffect(() => { if (follow.current && stream.current) stream.current.scrollTop = stream.current.scrollHeight; }, [state.messages, c?.id]);
  function send() {
    if (!c || !draft.trim() || busy) return;
    const id = c.id, text = draft;
    setDrafts(d => ({ ...d, [id]: '' }));
    void state.send(text).then(ok => { if (!ok) setDrafts(d => ({ ...d, [id]: d[id] || text })); });
  }
  if (!project) return <div className={s.empty}><Brand/><h1>A home for your projects.</h1><p>Open a project, start a conversation, and let Harbor coordinate the work.</p><button className={s.primary} onClick={openProject}>Open a project</button></div>;
  if (!c) return <div className={s.empty}><h1>{project.name}</h1><p>{state.projectLoading ? 'Loading conversations…' : 'Start a conversation to begin working in this project.'}</p><button className={s.primary} disabled={state.projectLoading} onClick={() => void state.newConversation()}>New conversation</button></div>;
  return <>
    <div className={s.stream} ref={stream} onScroll={() => { const el = stream.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; }}>
      <div className={s.messageColumn}>
        {state.messagesLoading ? <p role="status">Loading conversation…</p> : !state.messages.length ? <div className={s.emptyConversation}><Brand/><h2>What shall we work on?</h2><p>Describe the next step for {project.name}.</p></div> : <>
          <p className={s.date}>{new Date(state.messages[0].time).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}</p>
          {state.messages.map(m => <article className={`${s.message} ${m.role === 'user' ? s.user : s.assistant}`} key={m.id}>
            <div className={s.byline}>{m.role === 'assistant' ? <Brand compact/> : null}<strong>{m.role === 'user' ? 'You' : m.role === 'assistant' ? state.agents.find(a => a.id === m.agentId)?.title || 'Harbor' : m.role === 'tool' ? 'Tool activity' : 'Activity'}</strong><time dateTime={new Date(m.time).toISOString()}>{new Date(m.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time></div>
            {m.role === 'tool' ? <details><summary>Tool activity</summary><Markdown text={m.text}/></details> : <Markdown text={m.text || 'Working…'}/>}
            {m.details ? <details className={s.execution}><summary>Execution details</summary><p>{m.details.cli} / {m.details.model} · {m.details.effort} effort</p><p>{m.details.reason}</p></details> : null}
          </article>)}
        </>}
        {busy ? <p role="status" className={s.muted}>An agent is working on this conversation…</p> : null}
      </div>
    </div>
    <div className={s.composerArea}><div className={s.composer}>
      <div className={s.recipient}>To <strong>{project.name} · {agent?.title || 'Main agent'}</strong></div>
      <textarea aria-label={agent?.role !== 'main' ? `Message ${agent?.title || 'agent'}` : 'Message Harbor'} placeholder={agent?.role !== 'main' ? `Message ${agent?.title || 'agent'}…` : 'Message Harbor…'} value={draft} onChange={e => setDrafts(d => ({ ...d, [c.id]: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}/>
      <div className={s.composerTools}><span className={s.muted}>{busy ? 'You can draft your next message.' : 'Your project, in focus.'}</span>{busy ? <button onClick={() => void state.run(() => state.api.stopAgent(c.agentId))}>Stop {agent?.role === 'main' ? 'task' : 'agent'}</button> : <button className={s.primary} disabled={!draft.trim() || state.messagesLoading} onClick={send}>Send ↑</button>}</div>
    </div><p className={s.composeHint}>Enter to send · Shift + Enter for a new line</p></div>
  </>;
}
