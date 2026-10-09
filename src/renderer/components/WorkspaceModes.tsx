import { useState } from 'react';
import type { Conversation as ConversationRecord } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import { boardLane, boardLanes, conversationCrew, leadState, projectTasks } from '../workspaceModes';
import { sessionStatus } from '../session';
import { SessionStatus } from './SessionStatus';
import { SessionPanel } from './SessionPanel';
import { CloseIcon, PanelIcon, PlusIcon, ToolIcon } from './Icons';
import s from '../Harbor.module.css';

export function WorkspaceSummary({ state, queued, review }: { state: HarborState; queued: number; review: () => void }) {
  const c = state.conversation;
  if (!c) return null;
  const crew = conversationCrew(c, state.agents);
  const running = crew.filter(a => a.state === 'working' || a.state === 'queued').length;
  const hasLead = ['working', 'queued'].includes(c.activity?.state || '') || state.sending.has(c.id);
  return <div className={s.workspaceSummary} aria-label="Conversation overview">
    <span><span className={s.dot} data-state={running || hasLead ? 'working' : 'idle'} aria-hidden="true"/>{running + (hasLead ? 1 : 0)} agents active</span>
    <span>{crew.length} {crew.length === 1 ? 'helper' : 'helpers'}</span>
    {queued ? <span>{queued} queued {queued === 1 ? 'follow-up' : 'follow-ups'}</span> : null}
    <button disabled={!c} onClick={review}>Review changes</button>
  </div>;
}

export function AgentDock({ state, expand }: { state: HarborState; expand: () => void }) {
  const c = state.conversation;
  if (!c) return null;
  const owner = state.agents.find(a => a.id === c.agentId);
  const crew = conversationCrew(c, state.agents).filter(a => ['working', 'queued', 'waiting'].includes(a.state));
  return <section className={s.agentDock} aria-label="Agent dock">
    <div className={s.dockLead}><strong>{c.activity?.cli || owner?.cli || 'Harbor'}</strong><small>{owner?.role === 'main' ? 'Lead agent' : owner?.title || 'Agent'}</small><SessionStatus status={leadState(state)}/></div>
    <div className={s.dockCrew}>{crew.map(a => <button key={a.id} onClick={() => void state.openAgent(a.id)} title={a.title}><strong>{a.title}</strong><SessionStatus status={a.state}/></button>)}</div>
    <button className={s.dockExpand} onClick={expand}><PanelIcon size={17} aria-hidden="true"/><span>Activity</span></button>
  </section>;
}

export function LiveActivity({ state, close, review }: { state: HarborState; close: () => void; review: () => void }) {
  const [details, setDetails] = useState(false);
  const c = state.conversation;
  const crew = conversationCrew(c, state.agents);
  const activeCrew = crew.filter(a => ['working', 'queued', 'waiting'].includes(a.state));
  const pastCrew = crew.filter(a => !activeCrew.includes(a));
  const owner = state.agents.find(a => a.id === c?.agentId);
  const latest = state.messages.filter(m => m.details).at(-1);
  const cli = c?.activity?.cli || latest?.details?.cli || owner?.cli;
  const recent = state.messages.filter(m => m.role === 'tool').slice(-4).reverse();
  const helper = (a: typeof crew[number]) => <div className={s.activityAgent} key={a.id}><button onClick={() => void state.openAgent(a.id)}><strong>{a.title}</strong><small>{a.role} / {a.cli}</small></button><SessionStatus status={a.state}/>{a.summary ? <p>{a.summary}</p> : null}{['working', 'queued', 'waiting'].includes(a.state) ? <button className={s.activityStop} aria-label={`Stop ${a.title}`} onClick={() => void state.run(() => state.api.stopAgent(a.id))}>Stop agent</button> : null}</div>;
  if (details) return <SessionPanel state={state} close={() => setDetails(false)}/>;
  return <>
    <div className={s.panelHeading}><h2>Live activity</h2><button className={s.iconButton} aria-label="Close live activity" onClick={close}><CloseIcon size={18} aria-hidden="true"/></button></div>
    {!c ? <p className={s.muted}>Open a conversation to follow its agents.</p> : <>
      <div className={s.currentStep}><SessionStatus status={sessionStatus(c, state.agents, state.sending)}/><p>{c.activity?.detail || 'Agent activity and updates appear here as work progresses.'}</p></div>
      <h3 className={s.activitySectionTitle}>Agents <span>{1 + crew.length}</span></h3>
      <div className={s.activityAgent}><div><strong>{cli === 'claude' ? 'Claude Code' : cli === 'codex' ? 'Codex' : cli || 'Harbor'}</strong><small>{owner?.role === 'main' ? 'Lead agent' : owner?.title || 'Current agent'}</small></div><SessionStatus status={leadState(state)}/></div>
      {activeCrew.map(helper)}
      {pastCrew.length ? <details className={s.pastAgents}><summary>Past helpers <span>{pastCrew.length}</span></summary>{pastCrew.map(helper)}</details> : null}
      <h3 className={s.activitySectionTitle}>Recent tool activity</h3>
      {recent.length ? <ol className={s.recentActivity}>{recent.map(m => <li key={m.id}><ToolIcon size={15} aria-hidden="true"/><span>{m.text.split('\n')[0] || 'Tool activity'}<time dateTime={new Date(m.time).toISOString()}>{new Date(m.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time></span></li>)}</ol> : <p className={s.muted}>Tool activity appears when an agent uses a tool.</p>}
      <div className={s.activityActions}><button onClick={review}>Review current changes</button><button onClick={() => setDetails(true)}>Execution details</button></div>
    </>}
  </>;
}

export function MissionBoard({ state, select, openConversation }: { state: HarborState; select: (c: ConversationRecord) => void; openConversation: () => void }) {
  const tasks = projectTasks(state);
  const groups = Object.fromEntries([...boardLanes.map(l => l.id), 'finished'].map(id => [id, tasks.filter(c => boardLane(c, state.agents, state.sending) === id)]));
  const selected = state.conversation;
  const card = (c: ConversationRecord) => {
    const crew = conversationCrew(c, state.agents);
    return <button key={c.id} className={s.missionCard} aria-pressed={c.id === selected?.id} onClick={() => select(c)}>
      <strong>{c.title}</strong><SessionStatus status={sessionStatus(c, state.agents, state.sending)}/>
      {c.activity?.detail ? <p>{c.activity.detail}</p> : null}
      <span className={s.missionCardMeta}>{crew.length} {crew.length === 1 ? 'helper' : 'helpers'}<time dateTime={new Date(c.updated).toISOString()}>Updated {new Date(c.updated).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</time></span>
    </button>;
  };
  return <section className={s.missionBoard} aria-label="Mission Board">
    <div className={s.boardHeading}><div><h2>Mission Board</h2><p>{tasks.length} {tasks.length === 1 ? 'conversation' : 'conversations'} in this project</p></div><button className={s.primary} disabled={!state.projectId || state.projectLoading} onClick={() => void state.newConversation()}><PlusIcon size={16} aria-hidden="true"/>New conversation</button></div>
    {state.projectLoading ? <p role="status">Loading conversations…</p> : <>
      <div className={s.boardColumns}>{boardLanes.map(lane => <section key={lane.id} className={s.boardLane} data-lane={lane.id} aria-label={lane.title}><h3>{lane.title}<span>{groups[lane.id].length}</span></h3><div className={s.boardCards}>{groups[lane.id].length ? groups[lane.id].map(card) : <p className={s.boardEmpty}>{lane.empty}</p>}</div></section>)}</div>
      <details className={s.finishedTasks}><summary>Finished conversations <span>{groups.finished.length}</span></summary><div className={s.finishedGrid}>{groups.finished.length ? groups.finished.map(card) : <p className={s.boardEmpty}>Finished work stays accessible here.</p>}</div></details>
    </>}
    {selected ? <div className={s.boardSelection}><small>Selected conversation</small><strong>{selected.title}</strong><button onClick={openConversation}>Open full conversation</button></div> : !state.projectId ? <p className={s.boardEmpty}>Open a project to organize its conversations.</p> : null}
  </section>;
}
