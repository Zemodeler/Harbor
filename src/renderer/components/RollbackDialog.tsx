import { useEffect, useState } from 'react';
import type { Agent, HarborApi, RollbackDependent, RollbackPreview } from '../../shared/api';
import { errorText, useAction } from '../hooks/useAgentActions';
import { AgentOutcome, shortHash } from './AgentOutcome';
import { ApplyButton } from './IntegrationPanel';
import { Modal } from './ui/Modal';
import s from './Features.module.css';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const REASON: Record<RollbackDependent['reason'], string> = { dependsOn: 'waits for it', spec: 'used its spec', help: 'asked for its help', overlap: 'later work on the same files' };

function PreviewBody({ preview, agents }: { preview: RollbackPreview; agents: Agent[] }) {
  const who = (id?: string) => id ? agents.find(a => a.id === id)?.title ?? id : undefined;
  const blockers = preview.blockers ?? [], notes = preview.notes ?? [];
  return <div className={s.fxDialog}>
    <p className={s.fxSummary} aria-label="Summary">{plural(preview.merges?.length ?? 0, 'merge')}, {plural(preview.files?.length ?? 0, 'file')}</p>
    <p className={s.fxPreviewNote}>Preview only. Nothing has been changed; this is what undoing the task would do.</p>
    <section><h3>Target</h3><div><strong>{preview.target ?? 'checked-out branch'}</strong>{preview.targetHead ? <> at <span className={s.fxMono}>{shortHash(preview.targetHead)}</span></> : null}</div></section>
    <section><h3>Merge commits that would be reverted</h3>{preview.merges?.length
      ? <ul className={s.fxList}>{preview.merges.map(m => <li key={m.commit}><span className={s.fxMono}>{shortHash(m.commit)}</span>{who(m.agentId) ? <span>{who(m.agentId)}</span> : null}{m.integrationId ? <span className={s.fxMuted}>via {who(m.integrationId)}</span> : null}</li>)}</ul>
      : <p className={s.fxNote}>None found.</p>}</section>
    <section><details className={s.fxFiles}><summary>Files ({preview.files?.length ?? 0})</summary>{preview.files?.length
      ? <ul className={`${s.fxList} ${s.fxScroll}`}>{preview.files.map(f => <li key={f.path}><span className={s.fxBadge}>{f.status}</span><span className={s.fxMono}>{f.hidden ? `${f.path} (hidden: credentials)` : f.path}</span></li>)}</ul>
      : <p className={s.fxNote}>No files listed.</p>}</details></section>
    <section><h3>Later commits on the same files</h3>{preview.laterCommits?.length
      ? <ul className={s.fxList}>{preview.laterCommits.map(c => <li key={c.hash}><span className={s.fxMono}>{shortHash(c.hash)}</span><span>{c.subject}</span>{c.agentTitle ? <span className={s.fxMuted}>by {c.agentTitle}</span> : null}{c.files?.length ? <span className={`${s.fxMuted} ${s.fxMono}`}>{c.files.join(', ')}</span> : null}</li>)}</ul>
      : <p className={s.fxNote}>None.</p>}</section>
    <section><h3>Work that depends on it</h3>{preview.dependents?.length
      ? <ul className={s.fxList}>{preview.dependents.map(d => <li key={d.agentId}><span>{d.title ?? who(d.agentId)}</span>{d.state ? <span className={s.fxBadge}>{d.state}</span> : null}<span className={s.fxMuted}>{REASON[d.reason] ?? d.reason}</span></li>)}</ul>
      : <p className={s.fxNote}>None.</p>}</section>
    <section><h3>Reverting on the target</h3>{preview.clean === true ? <span className={s.fxBadge} data-tone="ok">Reverts cleanly</span>
      : preview.clean === false ? <><span className={s.fxBadge} data-tone="bad">Conflicts</span>{preview.conflicts?.length ? <ul className={s.fxList}>{preview.conflicts.map(p => <li key={p} className={s.fxMono}>{p}</li>)}</ul> : null}</>
      : <span className={s.fxBadge} data-tone="warn">Could not be simulated</span>}</section>
    {blockers.length ? <section><h3>Blockers</h3><ul className={s.fxList} role="list">{blockers.map(b => <li key={b} className={s.fxError}>{b}</li>)}</ul></section> : null}
    {notes.length ? <section><h3>Notes</h3><ul className={s.fxList}>{notes.map(n => <li key={n} className={s.fxNote}>{n}</li>)}</ul></section> : null}
  </div>;
}

/** Read-only preview first; "Roll back" only queues Harbor's rollback agent (it never touches the target itself). */
export function RollbackAction({ api, agent, agents }: { api: HarborApi; agent: Agent; agents: Agent[] }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<RollbackPreview>();
  const [loadError, setLoadError] = useState('');
  const [queued, setQueued] = useState<Agent>();
  const [target, setTarget] = useState('');
  const act = useAction();
  async function load(t: string) {
    setPreview(undefined); setLoadError('');
    try { setPreview(await api.previewRollback(agent.id, t.trim() || undefined)); } catch (e) { setLoadError(errorText(e)); }
  }
  useEffect(() => { if (open) { setQueued(undefined); void load(target); } /* target changes only reload on "Preview again" */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const blocked = !!preview && ((preview.blockers?.length ?? 0) > 0 || preview.supported === false);
  async function rollBack() {
    const r = await act.run(() => api.rollbackTask(agent.id, target.trim() || undefined));
    if (r.ok) setQueued(r.value);
  }
  return <>
    <button onClick={() => setOpen(true)}>Preview rollback</button>
    {open ? <Modal title={`Preview rollback: ${agent.title}`} close={() => setOpen(false)} size="lg" footer={<><button onClick={() => setOpen(false)}>Close</button>
        <button className={s.fxPrimary} disabled={!preview || blocked || act.busy || !!queued} title={blocked ? 'Resolve the blockers first' : undefined} onClick={() => void rollBack()}>{act.busy ? 'Queuing…' : 'Roll back'}</button></>}>
      <div className={s.fxRow}><label className={s.fxRow}>Target branch<input value={target} placeholder="checked-out branch" onChange={e => setTarget(e.target.value)}/></label><button onClick={() => void load(target)}>Preview again</button></div>
      {loadError ? <p className={s.fxError} role="alert">{loadError}</p> : !preview ? <p role="status">Simulating the rollback…</p> : <PreviewBody preview={preview} agents={agents}/>}
      {preview?.supported === false && !(preview.blockers?.length) ? <p className={s.fxNote}>Harbor cannot reverse this task automatically.</p> : null}
      {queued ? <p className={s.fxNote} role="status">Rollback queued as “{queued.title}”. Its card shows progress and an Apply button when it is done.</p> : null}
      {act.error ? <p className={s.fxError} role="alert">{act.error}</p> : null}
    </Modal> : null}
  </>;
}

const REVERT_STATE = { pending: 'pending', reverted: 'reverted', conflict: 'conflict' } as const;

export function RollbackCard({ api, agent, agents }: { api: HarborApi; agent: Agent; agents: Agent[] }) {
  const r = agent.rollback;
  if (!r) return null;
  const title = (id?: string) => id ? agents.find(a => a.id === id)?.title ?? id : undefined;
  return <div className={s.fxBlock} aria-label={`Rollback ${agent.title}`}>
    <div className={s.fxHead}><span>Rollback of {title(r.taskId) ?? 'a task'}</span><span className={s.fxBadge}>{agent.state}</span>{r.applied ? <span className={s.fxBadge} data-tone="ok">applied</span> : null}<span className={s.fxMuted}>run by Harbor, no CLI</span></div>
    <div>Target: <strong>{r.target ?? 'checked-out branch'}</strong>{r.base ? <> · base <span className={s.fxMono}>{shortHash(r.base)}</span></> : null}{r.head ? <> · head <span className={s.fxMono}>{shortHash(r.head)}</span></> : null}</div>
    <ul className={s.fxList} aria-label="Merges">{r.merges.map(m => <li key={m.commit}>
      <span className={s.fxBadge} data-tone={m.state === 'reverted' ? 'ok' : m.state === 'conflict' ? 'bad' : 'warn'}>{REVERT_STATE[m.state] ?? m.state}</span>
      <span className={s.fxMono}>{shortHash(m.commit)}</span>{title(m.agentId) ? <span>{title(m.agentId)}</span> : null}{m.revert ? <span className={s.fxMuted}>revert <span className={s.fxMono}>{shortHash(m.revert)}</span></span> : null}
    </li>)}</ul>
    {r.conflicts?.length ? <div><div className={s.fxHead}>Conflicting paths</div><ul className={s.fxList}>{r.conflicts.map(p => <li key={p} className={s.fxMono}>{p}</li>)}</ul></div> : null}
    {agent.state === 'failed' && agent.summary ? <p className={s.fxError}>{agent.summary}</p> : null}
    <AgentOutcome agent={agent}/>
    <ApplyButton api={api} agent={agent} target={r.target}/>
  </div>;
}
