import { useEffect, useState } from 'react';
import type { Project, TemplatePreview } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import s from '../Harbor.module.css';
import l from './Lifecycle.module.css';

const AREA = 'template';
const size = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Save a project's tracked files as a template: shows what is copied and left out, blocks on secret findings, takes default checks. */
export function SaveTemplate({ state, project, back, done }: { state: HarborState; project: Project; back: () => void; done: () => void }) {
  const [name, setName] = useState(`${project.name} starter`);
  const [description, setDescription] = useState('');
  const [checks, setChecks] = useState('');
  const [preview, setPreview] = useState<TemplatePreview>();
  const [loadError, setLoadError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState<string>();
  const failure = state.areaErrors[AREA];

  useEffect(() => {
    let alive = true;
    void state.api.previewTemplate!(project.id).then(r => { if (alive) { setPreview(r); setChecks(r.suggestedChecks.join('\n')); } }).catch(e => { if (alive) setLoadError(e instanceof Error ? e.message : 'Could not read the project.'); });
    return () => { alive = false; state.clearError(AREA); };
  }, [project.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const list = checks.split(/\r?\n/).map(c => c.trim()).filter(Boolean);
  const save = () => {
    setPending(true);
    void state.run(async () => {
      const t = await state.api.saveProjectAsTemplate!(project.id, { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), checks: list });
      setSaved(t.name);
    }, AREA).finally(() => setPending(false));
  };

  if (saved) return <div className={l.form}>
    <p role="status" className={l.strong}>Saved the template “{saved}”.</p>
    <p className={s.muted}>It is now listed under “Starting point” in New project. Its default checks are written to the new project, which asks you before running them.</p>
    <div className={s.actions}><button className={s.primary} autoFocus onClick={done}>Done</button></div>
  </div>;
  return <form className={l.form} onSubmit={e => { e.preventDefault(); save(); }}>
    <p><strong>Save “{project.name}” as a template</strong></p>
    {loadError ? <p className={s.error} role="alert">{loadError}</p> : !preview ? <p role="status" className={l.hint}>Reading the project…</p> : <>
      <p className={s.muted}>{preview.files} tracked file{preview.files === 1 ? '' : 's'} ({size(preview.bytes)}) will be copied. Ignored files are not.</p>
      {preview.excluded.length ? <details><summary>{preview.excluded.length} left out</summary><ul className={l.list} aria-label="Left out of the template">{preview.excluded.map(e => <li key={e.path}><code>{e.path}</code> · {e.reason}</li>)}</ul></details> : null}
      {preview.findingsTotal ? <div className={`${l.alert} ${l.alertWarn}`} role="alert">
        <p className={l.strong}>The secret scan found {preview.findingsTotal} possible secret{preview.findingsTotal === 1 ? '' : 's'}. Remove or allowlist them, then try again.</p>
        <ul className={l.list} aria-label="Secret scan findings">{preview.findings.map(f => <li key={`${f.file}:${f.line}:${f.type}`}>{f.type} in <code>{f.file}{f.line > 0 ? `:${f.line}` : ''}</code></li>)}</ul>
      </div> : null}
    </>}
    <label className={l.field}>Template name<input autoFocus value={name} maxLength={60} onChange={e => setName(e.target.value)}/></label>
    <label className={l.field}>Description (optional)<input value={description} maxLength={300} onChange={e => setDescription(e.target.value)}/></label>
    <label className={l.field}>Default checks (one command per line)<textarea value={checks} placeholder={'npm test\nnpm run build'} onChange={e => setChecks(e.target.value)}/><small className={l.hint}>New projects get these as their project checks. Harbor asks you before it runs them the first time.</small></label>
    {failure ? <p className={s.error} role="alert">{failure}</p> : null}
    <div className={s.actions}>
      <button type="button" disabled={pending} onClick={back}>Back</button>
      <button type="submit" className={s.primary} disabled={pending || !preview || preview.blocked || !name.trim() || list.length > 10}>{pending ? 'Saving…' : 'Save template'}</button>
    </div>
  </form>;
}
