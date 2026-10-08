import type { Agent } from '../../shared/api';
import s from '../Harbor.module.css';

export function Agents({ agents, open, stop }: { agents: Agent[]; open: (id: string) => void; stop: (id: string) => void }) {
  return <details className={s.agents} open><summary>Agents · {agents.length}</summary>
    {agents.length === 0 ? <p className={s.muted}>No agent assignments yet.</p> : agents.map(a => <div className={s.agent} key={a.id}>
      <button className={s.agentLink} onClick={() => open(a.id)}><span className={s.dot} data-state={a.state}/><span>{a.title}<small>{a.role} · {a.state} · {a.cli} / {a.model}</small></span></button>
      {['queued', 'working', 'waiting'].includes(a.state) ? <button className={s.smallButton} onClick={() => stop(a.id)} aria-label={`Stop ${a.title}`}>Stop</button> : null}
      {a.summary ? <details className={s.summary}><summary>Summary</summary><p>{a.summary}</p></details> : null}
    </div>)}
  </details>;
}
