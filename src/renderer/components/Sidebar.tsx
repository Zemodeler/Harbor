import { useState } from 'react';
import type { HarborState } from '../hooks/useHarbor';
import { Brand } from './Brand';
import { Agents } from './Agents';
import s from '../Harbor.module.css';

export function Sidebar({ state, settings, add, close }: { state: HarborState; settings: () => void; add: () => void; close: () => void }) {
  const [query, setQuery] = useState('');
  return <nav aria-label="Projects and conversations" className={s.sidebar}>
    <div className={s.brandRow}><Brand/><button className={s.mobileClose} onClick={close} aria-label="Close project menu">×</button></div>
    <input className={s.search} aria-label="Search projects" placeholder="Search projects…" value={query} onChange={e => setQuery(e.target.value)}/>
    <div className={s.sectionLabel}><span>Projects</span><button onClick={add} aria-label="Add project">+</button></div>
    <div className={s.projectList}>
      {state.loading ? <p role="status" className={s.muted}>Loading projects…</p> : null}
      {state.projects.filter(p => p.name.toLowerCase().includes(query.toLowerCase())).map(p => <div key={p.id}>
        <button className={`${s.project} ${state.projectId === p.id ? s.projectActive : ''}`} aria-expanded={state.projectId === p.id} title={p.path} onClick={() => { void state.selectProject(p.id); close(); }}><span aria-hidden="true">{state.projectId === p.id ? '⌄' : '›'}</span>{p.name}</button>
        {state.projectId === p.id ? <>
          <button className={s.newConversation} onClick={() => { void state.newConversation(); close(); }}>+ New conversation</button>
          {state.projectLoading ? <p role="status" className={s.muted}>Loading conversations…</p> : null}
          {state.conversations.map(c => <div key={c.id}><button className={`${s.conversationLink} ${state.conversation?.id === c.id ? s.selected : ''}`} aria-current={state.conversation?.id === c.id ? 'page' : undefined} onClick={() => { void state.selectConversation(c); close(); }}>{c.title}</button>
            {state.conversation?.id === c.id ? <Agents agents={state.agents.filter(a => a.id === c.agentId || a.parentId === c.agentId)} open={id => { void state.openAgent(id); close(); }} stop={id => { void state.run(() => state.api.stopAgent(id)); }}/>: null}
          </div>)}
        </> : null}
      </div>)}
      {!state.loading && !state.projects.length ? <p className={s.muted}>Your projects will appear here.</p> : null}
      {query && !state.projects.some(p => p.name.toLowerCase().includes(query.toLowerCase())) ? <p className={s.muted}>No matching projects.</p> : null}
    </div>
    <footer className={s.sidebarFooter}><button onClick={add}>+ Add project</button><button onClick={() => { settings(); close(); }}>Settings</button><small>Local workspace{document.documentElement.dataset.demo ? ' · Demo' : ''}</small></footer>
  </nav>;
}
