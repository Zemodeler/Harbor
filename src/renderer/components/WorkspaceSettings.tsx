import { useState } from 'react';
import type { EditorId } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import type { WorkspaceState } from '../hooks/useWorkspace';
import { setNotificationPrefs, useNotificationPrefs } from '../notificationPrefs';
import s from '../Harbor.module.css';

/** Renderer-side notifications (this device only). The clickable Windows notification is off while the background one is on, so nothing arrives twice. */
function NotificationChoices({ basicOn }: { basicOn: boolean }) {
  const prefs = useNotificationPrefs();
  const [denied, setDenied] = useState(false);
  const supported = typeof Notification === 'function';
  async function toggleSystem(on: boolean) {
    setDenied(false);
    if (on && supported && Notification.permission !== 'granted') {
      const answer = await Notification.requestPermission().catch(() => 'denied' as NotificationPermission);
      if (answer !== 'granted') { setDenied(true); return; }
    }
    setNotificationPrefs({ system: on });
  }
  return <>
    <label className={s.checkboxRow}><input type="checkbox" checked={prefs.inApp} onChange={e => setNotificationPrefs({ inApp: e.target.checked })}/> Show in-app notifications (needs your answer, finished, failed)</label>
    <label className={s.checkboxRow}><input type="checkbox" checked={prefs.system && !basicOn} disabled={basicOn || !supported} onChange={e => void toggleSystem(e.target.checked)}/> Clickable Windows notifications that open the conversation</label>
    <small>{!supported ? 'Not available here.' : basicOn ? 'Turn off the desktop notifications above to use these instead; otherwise each event would notify twice.' : 'Shown only while the Harbor window is open in the background. When Harbor is hidden to the tray, use the desktop notifications above.'}{denied ? ' Windows did not allow notifications for Harbor.' : ''}</small>
  </>;
}

export function WorkspaceSettings({ state, workspace }: { state: HarborState; workspace: WorkspaceState }) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const { preferences, setPreferences } = workspace;
  return <>
    <h3>Reading and navigation</h3>
    <label className={s.field}>Text size<select value={preferences.textSize} onChange={e => setPreferences(p => ({ ...p, textSize: e.target.value as 'standard' | 'large' }))}><option value="standard">Standard</option><option value="large">Large</option></select></label>
    <label className={s.field}>Navigation spacing<select value={preferences.density} onChange={e => setPreferences(p => ({ ...p, density: e.target.value as 'comfortable' | 'compact' }))}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
    <div className={s.settingsDivider}><h3>Desktop notifications</h3><p className={s.muted}>Notify when a session finishes or needs your attention while Harbor is in the background.</p><label className={s.checkboxRow}><input type="checkbox" checked={state.settings?.desktopNotifications === true} disabled={saving || !!document.documentElement.dataset.demo} onChange={e => { setSaving(true); void state.updateSettings({ desktopNotifications: e.target.checked }).finally(() => setSaving(false)); }}/> Enable desktop notifications</label>{document.documentElement.dataset.demo ? <small>Available in the desktop app.</small> : null}<NotificationChoices basicOn={state.settings?.desktopNotifications === true}/></div>
    <div className={s.settingsDivider}><h3>Editor</h3><p className={s.muted}>Used by "Open in editor". The editor must be installed; Harbor opens it through its own link, so nothing is run in a shell.</p>
      <label className={s.field}>Open files and folders in<select value={state.settings?.editor ?? 'code'} disabled={saving || !!document.documentElement.dataset.demo} onChange={e => { setSaving(true); void state.updateSettings({ editor: e.target.value as EditorId }).finally(() => setSaving(false)); }}>
        <option value="code">VS Code</option><option value="code-insiders">VS Code Insiders</option><option value="cursor">Cursor</option><option value="windsurf">Windsurf</option>
      </select></label>
    </div>
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
