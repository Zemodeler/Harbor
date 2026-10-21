import { useEffect, useState } from 'react';
import type { UserTemplate } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import s from '../Harbor.module.css';
import l from './Lifecycle.module.css';

const AREA = 'templates';

/** Settings list of the user's project templates: default checks can be edited, a template can be deleted (its own folder only). */
export function Templates({ state }: { state: HarborState }) {
  const { api } = state;
  const [list, setList] = useState<UserTemplate[]>();
  const [editing, setEditing] = useState<string>();
  const [text, setText] = useState('');
  const [deleting, setDeleting] = useState<string>();
  const [pending, setPending] = useState(false);
  const failure = state.areaErrors[AREA];
  const load = () => void api.listTemplates!().then(setList).catch(() => setList([]));
  useEffect(() => { load(); return () => state.clearError(AREA); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const saveChecks = (t: UserTemplate) => {
    setPending(true);
    void state.run(async () => { await api.updateTemplate!(t.id, { checks: text.split(/\r?\n/).map(c => c.trim()).filter(Boolean) }); setEditing(undefined); load(); }, AREA).finally(() => setPending(false));
  };
  const remove = (t: UserTemplate) => {
    setPending(true);
    void state.run(async () => { await api.deleteTemplate!(t.id); setDeleting(undefined); load(); }, AREA).finally(() => setPending(false));
  };

  return <>
    <h3>Templates</h3>
    <p className={s.muted}>Projects you saved as templates (Project settings, Save as template). New projects can start from them. Default checks are written to the new project and Harbor asks you before running them.</p>
    {!list ? <p role="status" className={l.hint}>Reading templates…</p> : !list.length ? <p className={s.muted}>No templates yet.</p> : <ul className={l.list} aria-label="Your templates">{list.map(t => <li key={t.id}>
      <strong>{t.name}</strong> · {t.files} file{t.files === 1 ? '' : 's'}{t.source ? ` · from ${t.source}` : ''}
      {t.description ? <small className={l.hint}> {t.description}</small> : null}
      <div className={l.hint}>{t.checks.length ? `Default checks: ${t.checks.join(', ')}` : 'No default checks'}</div>
      {editing === t.id ? <div className={l.field}>
        <textarea aria-label={`Default checks for ${t.name}`} value={text} onChange={e => setText(e.target.value)} placeholder={'npm test\nnpm run build'}/>
        <div className={l.row}><button disabled={pending} onClick={() => setEditing(undefined)}>Cancel</button><button className={s.primary} disabled={pending} onClick={() => saveChecks(t)}>Save checks</button></div>
      </div> : deleting === t.id ? <div className={l.row}>
        <span>Delete “{t.name}”? Projects made from it are not affected.</span>
        <button disabled={pending} onClick={() => setDeleting(undefined)}>Keep</button><button disabled={pending} onClick={() => remove(t)}>Delete template</button>
      </div> : <div className={l.row}>
        <button onClick={() => { setEditing(t.id); setText(t.checks.join('\n')); }}>Edit checks<span className={s.srOnly}> of {t.name}</span></button>
        <button onClick={() => setDeleting(t.id)}>Delete<span className={s.srOnly}> {t.name}</span></button>
      </div>}
    </li>)}</ul>}
    {failure ? <p className={s.error} role="alert">{failure}</p> : null}
  </>;
}
