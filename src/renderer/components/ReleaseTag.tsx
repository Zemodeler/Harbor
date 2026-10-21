import { useEffect, useState } from 'react';
import type { ReleaseTagPreview, ReleaseTagResult } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import { Modal } from './Modal';
import s from '../Harbor.module.css';
import l from './Lifecycle.module.css';

const AREA = 'releasetag';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** Tag the default branch's head (annotated, never replacing a tag) and optionally push that one tag. */
export function ReleaseTag({ state, close }: { state: HarborState; close: () => void }) {
  const { api, projectId } = state;
  const [preview, setPreview] = useState<ReleaseTagPreview>();
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [push, setPush] = useState(false);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<ReleaseTagResult>();
  const failure = state.areaErrors[AREA];
  useEffect(() => {
    void api.previewReleaseTag!(projectId).then(p => { setPreview(p); if (p.suggested) setName(p.suggested); }).catch(e => setLoadError(e instanceof Error ? e.message : 'Could not read the project.'));
    return () => state.clearError(AREA);
  }, [projectId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const canPush = !!preview?.remote && preview.headOnRemote;
  const valid = NAME.test(name) && !name.includes('..') && !/[./-]$/.test(name) && !/(^|\/)\./.test(name);
  const submit = () => {
    setPending(true);
    void state.run(async () => { setDone(await api.createReleaseTag!(projectId, { name, ...(message.trim() ? { message: message.trim() } : {}), ...(push && canPush ? { push: true } : {}) })); }, AREA).finally(() => setPending(false));
  };

  return <Modal title="Release tag" close={close} dismissible={!pending}>
    {done ? <div className={l.form}>
      <p role="status" className={l.strong}>{done.pushed ? `Created and pushed ${done.name}.` : `Created ${done.name} here.`}</p>
      {done.output ? <p className={s.error} role="alert">{done.output}</p> : !done.pushed ? <p className={s.muted}>It is not on GitHub yet. Push it from here later, or with git.</p> : null}
      <div className={s.actions}><button className={s.primary} autoFocus onClick={close}>Done</button></div>
    </div> : <form className={l.form} onSubmit={e => { e.preventDefault(); if (valid) submit(); }}>
      {loadError ? <p className={s.error} role="alert">{loadError}</p> : !preview ? <p role="status" className={l.hint}>Reading the project…</p> : <>
        <p className={s.muted}>Tags <code>{preview.defaultBranch ?? 'the default branch'}</code>{preview.head ? <> at <code>{preview.head.slice(0, 7)}</code> “{preview.headSubject}”</> : null}. Harbor never moves, replaces or deletes a tag.</p>
        {preview.recent.length ? <p className={l.hint}>Recent tags: {preview.recent.join(', ')}</p> : <p className={l.hint}>No tags yet.</p>}
      </>}
      <label className={l.field}>Tag name<input autoFocus value={name} maxLength={100} placeholder="v1.0.0" onChange={e => setName(e.target.value)}/></label>
      {name && !valid ? <p className={s.error} role="alert">Use letters, digits and . _ - / only, starting with a letter or digit.</p> : null}
      <label className={l.field}>Message (optional)<input value={message} maxLength={500} onChange={e => setMessage(e.target.value)}/></label>
      <label className={l.check}><input type="checkbox" checked={push && canPush} disabled={!canPush || pending} onChange={e => setPush(e.target.checked)}/>Also push this tag to GitHub<small>{!preview ? '' : !preview.remote ? 'This project has no remote yet.' : !preview.headOnRemote ? 'The tagged commit is not on GitHub yet. Push the branch first (Harbor scans it for secrets there).' : 'Only this tag is pushed.'}</small></label>
      {failure ? <p className={s.error} role="alert">{failure}</p> : null}
      <div className={s.actions}>
        <button type="button" disabled={pending} onClick={close}>Cancel</button>
        <button type="submit" className={s.primary} disabled={pending || !preview || !valid}>{pending ? 'Creating…' : 'Create tag'}</button>
      </div>
    </form>}
  </Modal>;
}
