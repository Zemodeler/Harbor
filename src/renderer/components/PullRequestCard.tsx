import { useEffect, useState } from 'react';
import type { MergeMethod, PullRequestStatus } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import { Modal } from './Modal';
import s from '../Harbor.module.css';
import l from './Lifecycle.module.css';

const AREA = 'pullrequest';
const METHODS: { id: MergeMethod; name: string; hint: string }[] = [
  { id: 'merge', name: 'Merge commit', hint: 'Keeps every commit and adds a merge commit.' },
  { id: 'squash', name: 'Squash and merge', hint: 'One commit on the base branch.' },
  { id: 'rebase', name: 'Rebase and merge', hint: 'Replays the commits on the base branch.' }
];
const BUCKET = { pass: 'Passing', fail: 'Failing', pending: 'Running', skipped: 'Skipped', cancelled: 'Cancelled' } as const;

/** The pull request of a branch: state, check summary, re-run failed checks, and Merge (after a confirmation that names the PR). Read-only until a button is pressed. */
export function PullRequestCard({ state, branch }: { state: HarborState; branch: string }) {
  const { api, projectId } = state;
  const [pr, setPr] = useState<PullRequestStatus | null>();
  const [loadError, setLoadError] = useState('');
  const [pending, setPending] = useState(false);
  const [merging, setMerging] = useState(false);
  const [note, setNote] = useState('');
  const failure = state.areaErrors[AREA];
  const load = () => { setLoadError(''); void api.getPullRequestStatus!(projectId, branch).then(setPr).catch(e => { setPr(undefined); setLoadError(e instanceof Error ? e.message : 'Could not read the pull request.'); }); };
  useEffect(() => { setPr(undefined); setNote(''); load(); return () => state.clearError(AREA); }, [branch, projectId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const rerun = () => {
    setPending(true); setNote('');
    void state.run(async () => { const r = await api.rerunFailedChecks!(projectId, branch); setNote(`Restarted ${r.rerun} workflow run${r.rerun === 1 ? '' : 's'}. Refresh in a minute.`); }, AREA).finally(() => setPending(false));
  };

  return <section className={l.prCard} aria-label="Pull request">
    <div className={l.prHead}><strong>Pull request</strong><button disabled={pending} onClick={load}>Refresh</button></div>
    {loadError ? <p className={s.error} role="alert">{loadError}</p> : pr === undefined ? <p role="status" className={l.hint}>Reading the pull request…</p> : pr === null ? <p className={s.muted}>No pull request for this branch yet.</p> : <>
      <p><a href={pr.url} target="_blank" rel="noreferrer">#{pr.number} {pr.title}</a> <span className={l.badge}>{pr.draft ? 'Draft' : pr.state}</span></p>
      <p className={l.hint} aria-label="Check summary">{pr.checks.total ? `${pr.checks.passing} passing, ${pr.checks.failing} failing, ${pr.checks.pending} running${pr.checks.skipped ? `, ${pr.checks.skipped} skipped` : ''}` : 'No checks reported.'}</p>
      {pr.checks.items.length ? <details><summary>{pr.checks.items.length} check{pr.checks.items.length === 1 ? '' : 's'}</summary><ul className={l.list} aria-label="Checks">{pr.checks.items.map(c => <li key={`${c.workflow ?? ''}/${c.name}`}>{c.workflow ? `${c.workflow} / ` : ''}{c.name} · {BUCKET[c.bucket]}</li>)}</ul></details> : null}
      {pr.blockers.length ? <ul className={l.warnings} aria-label="Why it cannot be merged">{pr.blockers.map(b => <li key={b}>{b}</li>)}</ul> : pr.state === 'open' ? <p className={l.hint}>Ready to merge.</p> : null}
      <div className={l.row}>
        {api.rerunFailedChecks && pr.canRerun && pr.state === 'open' ? <button disabled={pending} onClick={rerun}>Re-run failed checks</button> : null}
        {api.mergePullRequest && pr.state === 'open' && (pr.canMerge || pr.checksOverridable) ? <button className={s.primary} disabled={pending} onClick={() => setMerging(true)}>Merge pull request…</button> : null}
      </div>
      {note ? <p role="status" className={l.hint}>{note}</p> : null}
      {failure ? <p className={s.error} role="alert">{failure}</p> : null}
      {merging ? <MergeDialog state={state} pr={pr} branch={branch} close={() => setMerging(false)} merged={() => { setMerging(false); load(); }}/> : null}
    </>}
  </section>;
}

function MergeDialog({ state, pr, branch, close, merged }: { state: HarborState; pr: PullRequestStatus; branch: string; close: () => void; merged: () => void }) {
  const { api, projectId } = state;
  const [method, setMethod] = useState<MergeMethod>('squash');
  const [override, setOverride] = useState(false);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<string>();
  const failure = state.areaErrors[AREA];
  const needsOverride = !pr.canMerge;
  const go = () => {
    setPending(true);
    void state.run(async () => {
      const r = await api.mergePullRequest!(projectId, { branch, number: pr.number, confirmNumber: pr.number, method, ...(needsOverride ? { overrideChecks: true } : {}) });
      setDone(r.message || 'Merged.');
    }, AREA).finally(() => setPending(false));
  };
  return <Modal title="Merge pull request" close={done ? merged : close} dismissible={!pending}>
    {done ? <div className={l.form}>
      <p role="status" className={l.strong}>Merged #{pr.number} into {pr.base}.</p>
      <p className={s.muted}>{done}</p>
      <div className={s.actions}><button className={s.primary} autoFocus onClick={merged}>Done</button></div>
    </div> : <div className={l.form}>
      <p><strong>Merge #{pr.number} “{pr.title}” into {pr.base}?</strong></p>
      <p className={s.muted}>This changes {pr.base} on GitHub. Harbor never forces a merge and does not delete the branch.</p>
      <fieldset className={l.choices} disabled={pending}><legend>How</legend>
        {METHODS.map(m => <label key={m.id} className={`${l.choice} ${method === m.id ? l.choiceOn : ''}`}><input type="radio" name="merge-method" checked={method === m.id} onChange={() => setMethod(m.id)}/>{m.name}<small>{m.hint}</small></label>)}
      </fieldset>
      {needsOverride ? <div className={`${l.alert} ${l.alertWarn}`}>
        <p className={l.strong}>Not everything is green:</p>
        <ul className={l.list}>{pr.blockers.map(b => <li key={b}>{b}</li>)}</ul>
        <label className={l.check}><input type="checkbox" checked={override} disabled={pending} onChange={e => setOverride(e.target.checked)}/>Merge anyway, I accept the failing or running checks</label>
      </div> : null}
      {failure ? <p className={s.error} role="alert">{failure}</p> : null}
      <div className={s.actions}>
        <button disabled={pending} onClick={close}>Cancel</button>
        <button className={s.primary} disabled={pending || (needsOverride && !override)} onClick={go}>{pending ? 'Merging…' : `Merge #${pr.number}`}</button>
      </div>
    </div>}
  </Modal>;
}
