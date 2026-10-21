import { useState } from 'react';
import type { Agent, Conversation, GitFileChange, HarborApi, SessionMergeResult } from '../../shared/api';
import { useAction } from '../hooks/useAgentActions';
import { AgentOutcome, shortHash } from './AgentOutcome';
import { OpenFileButton } from '../documents/DocumentLinks';
import s from './Features.module.css';

const SOURCE_STATE = { merged: 'merged', conflict: 'conflict', pending: 'not merged' } as const;

/** Helpers that own a branch Harbor could merge: edit helpers with a worktree, not integrators or rollbacks. */
export const integrable = (a: Agent) => a.role !== 'main' && !!a.worktree && !a.integration && !a.rollback;

/** Multi-select of a conversation's helpers; Harbor queues an integrator that merges the approved ones. */
export function IntegrateAction({ api, projectId, helpers }: { api: HarborApi; projectId: string; helpers: Agent[] }) {
  const { busy, error, run } = useAction();
  const [picked, setPicked] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [queued, setQueued] = useState<Agent>();
  const list = helpers.filter(integrable);
  if (!list.length) return null;
  const toggle = (id: string, on: boolean) => setPicked(p => on ? [...p, id] : p.filter(x => x !== id));
  async function go() {
    const r = await run(() => api.integrateBranches(projectId, picked, target.trim() || undefined));
    if (r.ok) { setQueued(r.value); setPicked([]); }
  }
  return <details className={s.fxBlock}>
    <summary>Integrate branches</summary>
    <p className={s.fxNote}>Pick helpers whose work should be merged together. Harbor only merges branches a reviewer has approved, then runs the checks. Nothing reaches your branch until you apply it.</p>
    <div className={s.fxChoices} role="group" aria-label="Helpers to integrate">{list.map(a => <label key={a.id}><input type="checkbox" checked={picked.includes(a.id)} onChange={e => toggle(a.id, e.target.checked)}/>{a.title}<span className={s.fxMuted}>{a.state}</span></label>)}</div>
    <div className={s.fxRow}>
      <label className={s.fxRow}>Target branch<input value={target} placeholder="checked-out branch" onChange={e => setTarget(e.target.value)}/></label>
      <button className={s.fxPrimary} disabled={busy || !picked.length} onClick={() => void go()}>{busy ? 'Queuing…' : `Integrate ${picked.length || ''} ${picked.length === 1 ? 'helper' : 'helpers'}`}</button>
    </div>
    {queued ? <p className={s.fxNote} role="status">Queued “{queued.title}”. Its card shows progress and the Apply button when it is done.</p> : null}
    {error ? <p className={s.fxError} role="alert">{error}</p> : null}
  </details>;
}

/**
 * A session that works in its own git worktree (it would otherwise have waited for the session editing the project folder). Its
 * changes stay on its branch until the user merges it: Harbor merges the checked-out branch into the session first, then
 * fast-forwards. A conflict is a normal result (nothing changed); other refusals show inline.
 */
export function MergeSessionAction({ api, conversation, working }: { api: HarborApi; conversation: Conversation; working: boolean }) {
  const { busy, error, run } = useAction();
  const [result, setResult] = useState<SessionMergeResult>();
  const ws = conversation.workspace;
  if (!ws || !api.mergeSession) return null;
  async function go() {
    const r = await run(() => api.mergeSession!(conversation.id));
    if (r.ok) setResult(r.value);
  }
  return <div className={s.fxBlock} aria-label="Session branch">
    <div>This session works in its own branch <span className={s.fxMono}>{ws.branch}</span>{ws.base ? <> · from <span className={s.fxMono}>{shortHash(ws.base)}</span></> : null}</div>
    <p className={s.fxNote}>Another session was editing your project folder, so this one has its own copy. Nothing reaches your branch until you merge it. Harbor merges your branch into this session first, and your branch moves only as a fast-forward. Nothing is pushed.</p>
    <button className={s.fxPrimary} disabled={busy || working} title={working ? 'Wait until the lead has finished its turn.' : undefined} onClick={() => void go()}>{busy ? 'Merging…' : 'Merge into your branch'}</button>
    {result ? <p className={result.merged ? s.fxNote : s.fxError} role={result.merged ? 'status' : 'alert'}>{result.message}</p> : null}
    {error ? <p className={s.fxError} role="alert">{error}</p> : null}
  </div>;
}

/** Committed files of a helper branch or an integration (credential files are listed as hidden, never diffed). */
export function ChangedFiles({ api, agent }: { api: HarborApi; agent: Agent }) {
  const { busy, error, run } = useAction();
  const [files, setFiles] = useState<GitFileChange[]>();
  async function load() { const r = await run(() => api.getChanges(agent.id)); if (r.ok) setFiles(r.value); }
  return <div>
    <button disabled={busy} aria-expanded={files !== undefined} onClick={() => files ? setFiles(undefined) : void load()}>{busy ? 'Loading…' : files ? 'Hide changed files' : 'Show changed files'}</button>
    {error ? <p className={s.fxError} role="alert">{error}</p> : null}
    {files ? files.length ? <ul className={`${s.fxList} ${s.fxScroll}`} aria-label={`Files changed by ${agent.title}`}>{files.map(f => <li key={f.path}>
      <span className={s.fxBadge}>{f.status}</span><span className={s.fxMono}>{f.hidden ? `${f.path} (hidden: credentials)` : <OpenFileButton path={f.path} agentId={agent.worktree ? agent.id : undefined} disabled={f.status === 'deleted'}>{f.path}</OpenFileButton>}</span>
      {f.additions !== undefined || f.deletions !== undefined ? <span className={s.fxMuted}>+{f.additions ?? 0} −{f.deletions ?? 0}</span> : null}
    </li>)}</ul> : <p className={s.fxNote}>No committed changes.</p> : null}
  </div>;
}

/** Apply works for integrators and rollback agents alike: Harbor fast-forwards the target and never pushes. */
export function ApplyButton({ api, agent, target }: { api: HarborApi; agent: Agent; target?: string }) {
  const { busy, error, run } = useAction();
  const applied = agent.integration?.applied ?? agent.rollback?.applied;
  if (applied) return <p className={s.fxNote}>Applied to {target ?? 'the target branch'}.</p>;
  if (agent.state !== 'done') return null;
  return <div>
    <button className={s.fxPrimary} disabled={busy} onClick={() => void run(() => api.applyIntegration(agent.id))}>{busy ? 'Applying…' : `Apply to ${target ?? 'the checked-out branch'}`}</button>
    {error ? <p className={s.fxError} role="alert">{error}</p> : null}
  </div>;
}

export function IntegrationCard({ api, agent, agents }: { api: HarborApi; agent: Agent; agents: Agent[] }) {
  const i = agent.integration;
  if (!i) return null;
  const title = (id: string) => agents.find(a => a.id === id)?.title ?? id;
  return <div className={s.fxBlock} aria-label={`Integration ${agent.title}`}>
    <div className={s.fxHead}><span>Integrator</span><span className={s.fxBadge}>{agent.state}</span>{i.applied ? <span className={s.fxBadge} data-tone="ok">applied</span> : null}<span className={s.fxMuted}>run by Harbor, no CLI</span></div>
    <div>Target: <strong>{i.target ?? 'checked-out branch'}</strong>{i.base ? <> · base <span className={s.fxMono}>{shortHash(i.base)}</span></> : null}{i.head ? <> · head <span className={s.fxMono}>{shortHash(i.head)}</span></> : null}{i.branch ? <> · <span className={s.fxMono}>{i.branch}</span></> : null}</div>
    <ul className={s.fxList} aria-label="Sources">{i.sources.map(src => <li key={src.agentId}>
      <span className={s.fxBadge} data-tone={src.state === 'merged' ? 'ok' : src.state === 'conflict' ? 'bad' : 'warn'}>{SOURCE_STATE[src.state] ?? src.state}</span>
      <span>{title(src.agentId)}</span>{src.branch ? <span className={s.fxMono}>{src.branch}</span> : null}{src.commit ? <span className={s.fxMono}>@ {shortHash(src.commit)}</span> : null}
    </li>)}</ul>
    {i.conflicts?.length ? <div><div className={s.fxHead}>Conflicting paths</div><ul className={s.fxList}>{i.conflicts.map(p => <li key={p} className={s.fxMono}>{p}</li>)}</ul></div> : null}
    {agent.state === 'failed' && agent.summary ? <p className={s.fxError}>{agent.summary}</p> : null}
    <AgentOutcome agent={agent}/>
    <ApplyButton api={api} agent={agent} target={i.target}/>
    <ChangedFiles api={api} agent={agent}/>
  </div>;
}
