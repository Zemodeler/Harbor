import { useState } from 'react';
import type { HarborState } from '../hooks/useHarbor';
import type { WorkspaceState } from '../hooks/useWorkspace';
import s from '../Harbor.module.css';

export function WorkspaceSettings({ state, workspace }: { state: HarborState; workspace: WorkspaceState }) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const { preferences, setPreferences } = workspace;
  return <>
    <h3>Reading and navigation</h3>
    <label className={s.field}>Text size<select value={preferences.textSize} onChange={e => setPreferences(p => ({ ...p, textSize: e.target.value as 'standard' | 'large' }))}><option value="standard">Standard</option><option value="large">Large</option></select></label>
    <label className={s.field}>Navigation spacing<select value={preferences.density} onChange={e => setPreferences(p => ({ ...p, density: e.target.value as 'comfortable' | 'compact' }))}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
    <div className={s.settingsDivider}><h3>Desktop notifications</h3><p className={s.muted}>Notify when a session finishes or needs your attention while Harbor is in the background.</p><label className={s.checkboxRow}><input type="checkbox" checked={state.settings?.desktopNotifications === true} disabled={saving || !!document.documentElement.dataset.demo} onChange={e => { setSaving(true); void state.updateSettings({ desktopNotifications: e.target.checked }).finally(() => setSaving(false)); }}/> Enable desktop notifications</label>{document.documentElement.dataset.demo ? <small>Available in the desktop app.</small> : null}</div>
    <div className={s.settingsDivider}><h3>Reusable prompts</h3><p className={s.muted}>Save instructions you use often. Insert them from the composer, then edit before sending.</p>
      {preferences.templates.map(t => <div className={s.savedTemplate} key={t.id}><strong>{t.title}</strong><p>{t.text}</p><button onClick={() => setPreferences(p => ({ ...p, templates: p.templates.filter(x => x.id !== t.id) }))}>Remove {t.title}</button></div>)}
      <form onSubmit={e => { e.preventDefault(); if (!title.trim() || !text.trim()) return; setPreferences(p => ({ ...p, templates: [...p.templates, { id: crypto.randomUUID(), title: title.trim(), text: text.trim() }] })); setTitle(''); setText(''); }}>
        <label className={s.field}>Prompt name<input value={title} maxLength={80} onChange={e => setTitle(e.target.value)} placeholder="Review before finishing"/></label>
        <label className={s.field}>Prompt text<textarea value={text} rows={4} onChange={e => setText(e.target.value)} placeholder="Describe the instructions to reuse…"/></label>
        <button className={s.primary} disabled={!title.trim() || !text.trim()}>Save prompt</button>
      </form>
    </div>
    <p className={s.appearanceSaved}>{workspace.saveError ? 'Could not save workspace preferences on this device.' : 'Drafts, queued follow-ups, and prompts are saved on this device. Queued messages pause after an app restart until you resume them.'}</p>
  </>;
}
