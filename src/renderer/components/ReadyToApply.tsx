import { useState } from 'react';
import type { Agent, HarborApi } from '../../shared/api';
import { Modal } from './ui/Modal';
import { ApplyButton } from './IntegrationPanel';
import { shortHash } from './AgentOutcome';
import s from './Features.module.css';

/** A finished integration or rollback that Harbor could apply right now: done, not applied, every branch merged (or every merge reverted). */
export function readyToApply(a: Agent): boolean {
  if (a.state !== 'done') return false;
  if (a.integration) return !a.integration.applied && a.integration.sources.length > 0 && a.integration.sources.every(x => x.state === 'merged');
  if (a.rollback) return !a.rollback.applied && a.rollback.merges.length > 0 && a.rollback.merges.every(m => m.state === 'reverted');
  return false;
}

/**
 * Pops up when an integration or rollback of the open project is ready, so Apply is one click away instead of being found in the
 * session details. "Later" hides it for this agent until the app restarts; the card in the session details keeps the button.
 */
export function ReadyToApplyPrompt({ api, agents, projectId }: { api: HarborApi; agents: Agent[]; projectId: string }) {
  const [later, setLater] = useState<string[]>([]);
  const ready = agents.filter(a => a.projectId === projectId && readyToApply(a) && !later.includes(a.id));
  const agent = ready.at(-1);
  if (!agent) return null;
  const job = agent.integration ?? agent.rollback!;
  const sources = agent.integration?.sources.map(x => agents.find(h => h.id === x.agentId)?.title ?? x.agentId) ?? [];
  const hide = () => setLater(l => [...l, agent.id]);
  return <Modal title="Ready to apply" close={hide} size="sm" footer={<><button onClick={hide}>Later</button><ApplyButton api={api} agent={agent} target={job.target}/></>}>
    <div className={s.fxWrap}>
      <p><strong>{agent.title}</strong> is finished{agent.integration ? ' and its branches are merged' : ' and its merges are reverted'}. Applying moves <strong>{job.target ?? 'the checked-out branch'}</strong>{job.head ? <> to <span className={s.fxMono}>{shortHash(job.head)}</span></> : null} as a fast-forward. Nothing is pushed.</p>
      {job.base && job.head ? <p className={s.fxBeforeAfter} aria-label="Branch change"><span className={s.fxMono}>{shortHash(job.base)}</span><span aria-hidden="true"> → </span><span className={s.fxMono}>{shortHash(job.head)}</span><span className={s.fxMuted}> on {job.target ?? 'the checked-out branch'}</span></p> : null}
      {sources.length ? <ul className={s.fxList} aria-label="Merged work">{sources.map(t => <li key={t}>{t}</li>)}</ul> : null}
      {ready.length > 1 ? <p className={s.fxNote}>{ready.length - 1} more {ready.length === 2 ? 'is' : 'are'} waiting after this one.</p> : null}
    </div>
  </Modal>;
}
