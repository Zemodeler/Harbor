import { useEffect, useState } from 'react';
import type { Agent, HarborApi } from '../../shared/api';
import { useAction } from '../hooks/useAgentActions';
import s from './Features.module.css';

/** Pause/Resume, priority and Cancel for an agent that is still waiting in the queue. Pause never stops a running agent. */
export function QueueControls({ api, agent, agents }: { api: HarborApi; agent: Agent; agents: Agent[] }) {
  const { busy, error, run } = useAction();
  const priority = agent.priority ?? 0;
  const [draft, setDraft] = useState(String(priority));
  useEffect(() => setDraft(String(priority)), [priority]);
  if (agent.state !== 'queued') return null;
  const top = Math.max(0, ...agents.filter(a => a.projectId === agent.projectId && a.id !== agent.id).map(a => a.priority ?? 0));
  const commit = () => {
    const n = Number(draft);
    if (!draft.trim() || !Number.isInteger(n)) { setDraft(String(priority)); return; }
    if (n !== priority) void run(() => api.setAgentPriority(agent.id, n));
  };
  return <div className={s.fxBlock} aria-label={`Queue controls for ${agent.title}`}>
    <div className={s.fxHead}>Waiting in the queue{agent.paused ? <span className={s.fxBadge} data-tone="warn">Paused</span> : null}</div>
    <div className={s.fxRow}>
      {agent.paused ? <button disabled={busy} onClick={() => void run(() => api.resumeAgent(agent.id))}>Resume</button> : <button disabled={busy} onClick={() => void run(() => api.pauseAgent(agent.id))}>Pause</button>}
      <label className={s.fxRow}>Priority<input type="number" step={1} value={draft} disabled={busy} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}/></label>
      <button disabled={busy || priority > top} title="Start this before the other queued work" onClick={() => void run(() => api.setAgentPriority(agent.id, top + 1))}>Do this next</button>
      <button disabled={busy} aria-label={`Cancel ${agent.title}`} onClick={() => void run(() => api.stopAgent(agent.id))}>Cancel</button>
    </div>
    {agent.summary ? <p className={s.fxNote}>{agent.summary}</p> : null}
    {error ? <p className={s.fxError} role="alert">{error}</p> : null}
  </div>;
}

/** A stopped helper can continue in its saved CLI session; if it has none, Harbor refuses and a message is the way forward. */
export function ResumeControl({ api, agent, openAgent }: { api: HarborApi; agent: Agent; openAgent: (id: string) => void }) {
  const { busy, error, run } = useAction();
  if (agent.state !== 'stopped' || agent.role === 'main') return null;
  return <div className={s.fxRow}>
    <button disabled={busy} onClick={() => void run(() => api.resumeAgentSession(agent.id))}>{busy ? 'Resuming…' : 'Resume'}</button>
    {error ? <p className={s.fxError} role="alert">{error} Send a message to this helper instead. <button onClick={() => openAgent(agent.id)}>Open its chat</button></p> : null}
  </div>;
}
