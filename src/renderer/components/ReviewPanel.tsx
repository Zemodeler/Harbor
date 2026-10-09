import { useEffect, useState } from 'react';
import type { ReviewSnapshot } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import { CloseIcon } from './Icons';
import s from '../Harbor.module.css';

export function ReviewPanel({ state, close }: { state: HarborState; close: () => void }) {
  const [snapshot, setSnapshot] = useState<ReviewSnapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const id = state.conversation?.id;
  useEffect(() => {
    let active = true; setLoading(true); setError(''); setSnapshot(undefined);
    if (!id) { setLoading(false); return; }
    void state.api.getReview(id).then(result => { if (active) setSnapshot(result); }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'Could not read changes.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [state.api, id, revision]);
  return <><div className={s.panelHeading}><h2>Review changes</h2><button className={s.iconButton} onClick={close} aria-label="Close change review"><CloseIcon size={18} aria-hidden="true"/></button></div>
    <button disabled={loading} onClick={() => setRevision(n => n + 1)}>{loading ? 'Reading changes…' : 'Refresh snapshot'}</button>
    {error ? <p className={s.error} role="alert">{error}</p> : null}
    {snapshot ? <><p className={s.reviewSummary}>{snapshot.files.length} changed {snapshot.files.length === 1 ? 'file' : 'files'}<small>Snapshot at {new Date(snapshot.capturedAt).toLocaleTimeString()}</small></p>
      <p className={s.muted}>Changes are a snapshot. Refresh after work continues. Verification applies only when its report matches the current changes.</p>
      {snapshot.notes.map((note, i) => <p key={i} className={s.reviewNote}>{note}</p>)}
      {!snapshot.files.length ? <p>No previewable changes in this snapshot.</p> : snapshot.files.map((file, i) => <details className={s.diffFile} key={`${file.source}-${file.path}`} open={i === 0}><summary>{file.path}<small>{file.source}{file.untracked ? ' · New file' : ''}</small></summary><pre>{file.patch.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? s.diffAdded : line.startsWith('-') && !line.startsWith('---') ? s.diffRemoved : undefined}>{line}{'\n'}</span>)}</pre></details>)}
    </> : null}
  </>;
}
