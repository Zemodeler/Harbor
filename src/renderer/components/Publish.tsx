import { useEffect, useState } from 'react';
import type { PushPreview, PushResult } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import { Modal } from './Modal';
import s from '../Harbor.module.css';
import l from './Lifecycle.module.css';

const AREA = 'publish';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Push a branch, or push it and open a pull request, from the Git view. Shows exactly what would leave this machine (commits and the
 * secret scan of those commits) before anything is sent. The default branch needs its own confirmation naming the commits, a scan
 * finding needs an explicit "push anyway", and nothing is ever forced.
 */
export function Publish({ state, branch, mode, close, changed }: { state: HarborState; branch: string; mode: 'push' | 'pr'; close: () => void; changed: () => void }) {
  const { api, projectId } = state;
  const [preview, setPreview] = useState<PushPreview>();
  const [loadError, setLoadError] = useState('');
  const [pending, setPending] = useState(false);
  const [confirmDefault, setConfirmDefault] = useState(false);
  const [overrideSecrets, setOverrideSecrets] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [title, setTitle] = useState(branch.replace(/^harbor\//, '').replace(/[-_]+/g, ' '));
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [done, setDone] = useState<{ push?: PushResult; url?: string }>();
  const failure = state.areaErrors[AREA];
  const load = () => { setPreview(undefined); setLoadError(''); void api.previewPush!(projectId, branch).then(setPreview).catch(e => setLoadError(e instanceof Error ? e.message : 'Could not read the branch.')); };
  useEffect(() => { load(); return () => state.clearError(AREA); }, [branch]);   // eslint-disable-line react-hooks/exhaustive-deps

  const findings = preview?.secretScan?.findings ?? [];
  const scanFailed = !!preview?.secretScan?.failed;
  const ready = !!preview && !preview.needsRemote && !preview.busy && !scanFailed
    && (!preview.isDefaultBranch || confirmDefault) && (!findings.length || overrideSecrets) && (mode === 'push' || !preview.isDefaultBranch) && (mode === 'push' || !!title.trim());
  const nothing = !!preview && !preview.commits.length && !!preview.upstream;

  const submit = () => {
    if (!preview) return;
    setPending(true);
    void state.run(async () => {
      const opts = { ...(preview.upstream ? {} : { setUpstream: true }), ...(confirmDefault ? { allowDefaultBranch: true } : {}), ...(overrideSecrets && preview.secretScan?.fingerprint ? { secretOverride: preview.secretScan.fingerprint } : {}) };
      if (mode === 'pr') {
        const r = await api.createPullRequest!(projectId, { branch, title: title.trim(), ...(body.trim() ? { body } : {}), ...(draft ? { draft: true } : {}) });
        setDone({ url: r.url });
      } else {
        const r = await api.pushBranch!(projectId, branch, opts);
        if (!r.ok) throw new Error(r.output);
        setDone({ push: r });
      }
      changed();
    }, AREA).finally(() => setPending(false));
  };
  const attach = () => {
    setPending(true);
    void state.run(async () => { await api.setRemote!(projectId, remoteUrl.trim()); load(); }, AREA).finally(() => setPending(false));
  };

  return <Modal title={mode === 'pr' ? 'Open pull request' : 'Push branch'} close={close} dismissible={!pending}>
    {done ? <div className={l.form}>
      {done.url ? <p>Pull request opened: <a className={l.link} href={done.url} target="_blank" rel="noreferrer">{done.url}</a></p> : <p role="status">Pushed <strong>{done.push!.branch}</strong> to {done.push!.remote}.</p>}
      <div className={s.actions}><button className={s.primary} autoFocus onClick={close}>Done</button></div>
    </div> : <div className={l.form}>
      <p>Branch <strong>{branch}</strong>{preview?.remote ? <> → <code>{preview.remote}</code></> : null}</p>
      {loadError ? <p className={s.error} role="alert">{loadError}</p> : !preview ? <p role="status" className={l.hint}>Reading the branch…</p> : <>
        {preview.busy ? <p className={`${l.alert}`} role="alert">An agent is still working on this branch. Stop it or wait until it finishes before pushing.</p> : null}
        {preview.needsRemote ? <div className={l.form}>
          <p className={`${l.alert} ${l.alertWarn}`}>This project has no remote yet. Paste the repository URL (https or ssh), or create a GitHub repository for new projects in “New project”.</p>
          {api.setRemote ? <div className={l.row}><input aria-label="Remote URL" value={remoteUrl} placeholder="https://github.com/you/project.git" onChange={e => setRemoteUrl(e.target.value)}/><button disabled={pending || !remoteUrl.trim()} onClick={attach}>Set remote</button></div> : null}
        </div> : <>
          {preview.isDefaultBranch ? <label className={`${l.alert} ${l.check}`}><input type="checkbox" checked={confirmDefault} onChange={e => setConfirmDefault(e.target.checked)}/><span>{mode === 'pr' ? 'This is the default branch: pick a working branch to open a pull request.' : `I understand this publishes ${branch}, the default branch, with ${plural(preview.commits.length, 'commit')}.`}</span></label> : null}
          {preview.behind > 0 ? <p className={`${l.alert} ${l.alertWarn}`}>The remote has {plural(preview.behind, 'commit')} this branch does not. The push will be refused until you merge or rebase them; Harbor never force-pushes.</p> : null}
          <div><p className={l.strong}>{nothing ? 'Nothing new to push.' : `${plural(preview.commits.length, 'commit')} to push`}</p>
            {preview.commits.length ? <ul className={l.list} aria-label="Commits to push">{preview.commits.map(c => <li key={c.hash}><code>{c.hash.slice(0, 7)}</code> {c.subject}</li>)}</ul> : null}</div>
          {scanFailed ? <p className={l.alert} role="alert">The secret scan could not read every commit, so pushing is off. Try again.</p>
            : findings.length ? <div className={l.alert} role="alert"><p className={l.strong}>The secret scan found {plural(preview.secretScan!.total, 'possible secret')} in these commits</p>
              <ul className={l.list} aria-label="Secret scan findings">{findings.map(f => <li key={`${f.file}:${f.line}:${f.type}`}>{f.type} in <code>{f.file}{f.line > 0 ? `:${f.line}` : ''}</code></li>)}</ul>
              <p className={l.hint}>Only the type and place are shown, never the value. Remove it from history, add the path to the secret allowlist, or push anyway if it is a false alarm.</p>
              <label className={l.check}><input type="checkbox" checked={overrideSecrets} onChange={e => setOverrideSecrets(e.target.checked)}/><span>Push anyway; I checked these findings</span></label></div>
            : <p className={l.hint}>Secret scan of these commits: nothing found{preview.secretScan?.allowed ? ` (${plural(preview.secretScan.allowed, 'finding')} covered by your allowlist)` : ''}.</p>}
          {mode === 'pr' ? <>
            <label className={l.field}>Title<input value={title} maxLength={256} onChange={e => setTitle(e.target.value)}/></label>
            <label className={l.field}>Description (optional)<textarea value={body} onChange={e => setBody(e.target.value)}/></label>
            <label className={l.check}><input type="checkbox" checked={draft} onChange={e => setDraft(e.target.checked)}/><span>Open as a draft</span></label>
          </> : null}
        </>}
      </>}
      {failure ? <p className={s.error} role="alert">{failure}</p> : null}
      <div className={s.actions}>
        <button disabled={pending} onClick={close}>Cancel</button>
        <button className={s.primary} disabled={pending || !ready || (mode === 'push' && nothing)} onClick={submit}>{pending ? (mode === 'pr' ? 'Opening…' : 'Pushing…') : mode === 'pr' ? 'Push and open pull request' : preview?.isDefaultBranch ? `Push ${branch}` : 'Push branch'}</button>
      </div>
    </div>}
  </Modal>;
}
