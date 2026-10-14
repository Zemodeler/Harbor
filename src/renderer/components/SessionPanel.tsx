import { useEffect, useState } from 'react';
import type { HarborState } from '../hooks/useHarbor';
import { elapsed, sessionStatus } from '../session';
import { ComplexityBadge, SessionStatus } from './SessionStatus';
import { modes } from './ModePicker';
import { CloseIcon } from './Icons';
import { HelperDetails } from './HelperDetails';
import { IntegrateAction } from './IntegrationPanel';
import s from '../Harbor.module.css';

export function SessionPanel({ state, close }: { state: HarborState; close: () => void }) {
  const [now, setNow] = useState(Date.now);
  const c = state.conversation;
  const status = sessionStatus(c, state.agents, state.sending);
  const agent = state.agents.find(a => a.id === c?.agentId);
  const crew = state.agents.filter(a => a.conversationId === c?.id && a.role !== 'main');
  const latestMessage = state.messages.filter(m => m.details).at(-1);
  const model = c?.activity?.model || latestMessage?.details?.model || agent?.model;
  const cli = c?.activity?.cli || latestMessage?.details?.cli || agent?.cli;
  // The reason must explain the model shown: the concierge's reply (haiku) is newer than the lead's until the lead speaks.
  const reasonFrom = state.messages.filter(m => m.details?.reason && m.details.model === model && m.details.cli === cli).at(-1);
  const routed = reasonFrom?.details ?? (model && latestMessage?.details?.model && latestMessage.details.model !== model ? undefined : latestMessage?.details);
  const reason = routed?.reason, summary = routed?.summary;
  useEffect(() => {
    if (!['working', 'queued'].includes(status)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status]);
  if (!c) return <p>Open a conversation to see its activity.</p>;
  const last = state.lastActivity[c.id] || c.activity?.updated;
  return <>
    <div className={s.panelHeading}><h2>Session information</h2><button className={s.iconButton} aria-label="Close session information" onClick={close}><CloseIcon size={18} aria-hidden="true"/></button></div>
    <SessionStatus status={status}/><p className={s.sessionTitle}>{c.title}</p>
    <dl className={s.sessionFacts}>
      <dt>Current step</dt><dd>{c.activity?.detail || (status === 'waiting' ? 'Waiting for a response or dependency.' : 'No active lead step.')}</dd>
      <dt>Connection</dt><dd>{cli === 'claude' ? 'Claude Code' : cli === 'codex' ? 'Codex' : cli || 'Not assigned'}</dd><dt>Model</dt><dd>{model === 'default' ? 'Connection default' : model && model !== 'auto' ? model : 'Assigned when work starts'}</dd>
      {model?.toLowerCase().includes('haiku') ? <><dt>Why this model?</dt><dd>Haiku is a lightweight Claude model. Harbor uses it for the first pass and smaller tasks.</dd></> : null}
      {reason ? <><dt>Why this model</dt><dd>{summary ? <>{summary}<details className={s.technical}><summary>Technical details</summary><span className={s.routeReason}>{reason}</span></details></> : <span className={s.routeReason}>{reason}</span>}</dd></> : null}
      {c.activity?.complexity ? <><dt>Complexity</dt><dd><ComplexityBadge complexity={c.activity.complexity}/></dd></> : null}
      {c.activity?.effort ? <><dt>Effort</dt><dd>{c.activity.effort}</dd></> : null}
      {c.mode && c.mode !== 'default' ? <><dt>Mode</dt><dd>{modes.find(m => m.id === c.mode)?.label}{c.mode === 'goal' && c.goal ? `: ${c.goal}` : ''}</dd></> : null}
      {c.activity?.started ? <><dt>{status === 'working' ? 'Run time' : 'Latest lead turn'}</dt><dd>{elapsed((status === 'working' ? now : c.activity.updated) - c.activity.started)}</dd></> : null}
      {last ? <><dt>Last activity</dt><dd>{['working', 'queued'].includes(status) ? `${elapsed(now - last)} ago` : new Date(last).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</dd></> : null}
    </dl>
    <h3 className={s.resultHeading}>Subagents · {crew.length}</h3>
    {!crew.length ? <p className={s.muted}>The lead is handling this session directly.</p> : crew.map(a => <div className={s.agentEntry} key={a.id}><button className={s.agentEntryTitle} onClick={() => void state.openAgent(a.id)}>{a.title}</button><SessionStatus status={a.state}/><small>{a.role} · {a.cli} / {a.model}</small>{a.summary ? <p>{a.summary}</p> : null}{['working', 'queued', 'waiting'].includes(a.state) ? <button onClick={() => void state.run(() => state.api.stopAgent(a.id))}>Stop this agent</button> : null}<HelperDetails state={state} agent={a}/></div>)}
    <IntegrateAction api={state.api} projectId={c.projectId} helpers={crew}/>
    {['working', 'queued', 'waiting'].includes(status) ? <button className={s.stopSession} onClick={() => void state.run(() => state.api.stopConversation(c.id))}>Stop this session</button> : null}
  </>;
}
