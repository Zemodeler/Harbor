import { useEffect, useState, type CSSProperties } from 'react';
import type { CustomCliDescriptor } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import type { AppearanceState } from '../hooks/useAppearance';
import { layouts, palettes, paletteTokens } from '../appearance';
import type { WorkspaceState } from '../hooks/useWorkspace';
import { WorkspaceSettings } from './WorkspaceSettings';
import { RoutingFields, RoutingSettings } from './RoutingSettings';
import { UsageWindows } from './UsageWindows';
import { ToolRules } from './ToolRules';
import { CliPathField } from './CliPath';
import { AddCliPanel, CliFeaturesNote, CustomCliActions } from './CustomCli';
import { canExportDiagnostics, Diagnostics } from './Diagnostics';
import s from '../Harbor.module.css';

export function Settings({ state, appearanceState, workspace }: { state: HarborState; appearanceState: AppearanceState; workspace: WorkspaceState }) {
  const [tab, setTab] = useState('Connections');
  const { appearance, scheme, updateAppearance, saveError } = appearanceState;
  const [pending, setPending] = useState(false);
  const tabs = ['Connections', 'Appearance', 'Workspace', 'Routing', 'Usage', 'Project', ...(canExportDiagnostics(state.api) ? ['Diagnostics'] : [])];
  const project = state.projects.find(p => p.id === state.projectId);
  async function action(work: () => Promise<unknown>) { setPending(true); try { await work(); } finally { setPending(false); } }
  // Custom CLIs (plan 2.2): their descriptors, for Edit, and the open Add/Edit panel.
  const [customs, setCustoms] = useState<CustomCliDescriptor[]>([]);
  const [editor, setEditor] = useState<CustomCliDescriptor | 'new'>();
  const api = state.api;
  useEffect(() => {
    if (tab !== 'Connections' || !api.listCustomClis) return;
    let alive = true;
    void api.listCustomClis().then(list => { if (alive) setCustoms(list); }).catch(() => undefined);
    return () => { alive = false; };
  }, [tab, api]);
  async function afterCustomChange() { await state.refreshClis(); if (api.listCustomClis) setCustoms(await api.listCustomClis()); }
  return <section className={s.settings} aria-label="Settings">
    <div className={s.settingsHeading}><h2>{tab === 'Appearance' ? 'Make Harbor yours.' : tab === 'Routing' ? 'How work gets assigned.' : tab === 'Workspace' ? 'Your workspace, your way.' : tab === 'Usage' ? 'Your usage, at a glance.' : tab === 'Project' ? 'Settings for this project.' : tab === 'Diagnostics' ? 'Help us help you.' : 'Your tools, connected.'}</h2>{tab === 'Connections' ? <button disabled={pending} onClick={() => void action(state.refreshClis)}>{pending ? 'Checking…' : 'Refresh'}</button> : null}</div>
    <p className={s.muted}>{tab === 'Appearance' ? 'Choose how Harbor is arranged, then make the colors yours.' : tab === 'Routing' ? 'Set the defaults for your projects and conversations.' : tab === 'Workspace' ? 'Reading preferences, notifications, and reusable prompts.' : tab === 'Usage' ? 'Review available readings from your connected tools.' : tab === 'Project' ? 'Override routing for one project and manage the tools it always allows.' : tab === 'Diagnostics' ? 'Export a redacted bundle for support.' : 'Harbor discovers installed CLIs and uses their existing sign-ins.'}</p>
    <div className={s.tabs} role="tablist" aria-label="Settings sections">{tabs.map((name, i, all) => <button key={name} role="tab" id={`tab-${name}`} aria-controls="settings-panel" aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} className={tab === name ? s.tabActive : ''} onClick={() => setTab(name)} onKeyDown={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); const n = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length; setTab(all[n]); document.getElementById(`tab-${all[n]}`)?.focus(); } }}>{name}</button>)}</div>
    <div role="tabpanel" id="settings-panel" aria-labelledby={`tab-${tab}`}>
      {tab === 'Workspace' ? <WorkspaceSettings state={state} workspace={workspace}/> : tab === 'Appearance' ? <>
        <fieldset className={s.appearanceGroup}><legend>Workspace mode</legend><p className={s.muted} id="layout-help">Three ways to work. Switching keeps your conversations, drafts, and running agents.</p>
          <div className={s.layoutChoices} aria-describedby="layout-help">{layouts.map(layout => <label key={layout.id} className={s.layoutChoice}>
            <input type="radio" name="workspace-layout" aria-label={layout.name} checked={appearance.layout === layout.id} onChange={() => updateAppearance({ layout: layout.id })}/>
            <span className={s.layoutPreview} data-layout={layout.id} aria-hidden="true"><span className={s.layoutPreviewNav}/><span className={s.layoutPreviewBody}><i/><i/><i/><span/></span><span className={s.layoutPreviewDetail}><i/><i/><i/></span></span>
            <strong>{layout.name}</strong><span>{layout.description}</span>
          </label>)}</div>
          <button className={s.recommendedTheme} onClick={() => { const layout = layouts.find(l => l.id === appearance.layout)!; updateAppearance({ palette: layout.palette, mode: layout.mode }); }}>Use this mode’s original colors</button>
          <p className={s.muted}>Layout and colors are independent. Try any palette with any mode.</p>
        </fieldset>
        <fieldset className={s.appearanceGroup}><legend>Appearance</legend><p className={s.muted} id="appearance-help">Follow your device, or keep Harbor always light or dark.</p>
          <div className={s.modeChoices} aria-describedby="appearance-help">{(['system', 'light', 'dark'] as const).map(mode => <label key={mode} className={s.modeChoice}>
            <input type="radio" name="appearance-mode" checked={appearance.mode === mode} onChange={() => updateAppearance({ mode })}/><span>{mode === 'system' ? 'Use system' : mode === 'light' ? 'Light' : 'Dark'}</span>
          </label>)}</div>
        </fieldset>
        <fieldset className={s.appearanceGroup}><legend>Color palette</legend><p className={s.muted} id="palette-help">A coordinated set of colors for navigation, messages, and controls.</p>
          <div className={s.paletteGrid} aria-describedby="palette-help">{palettes.map(palette => <label key={palette.id} className={s.paletteChoice} style={paletteTokens(palette.id, scheme, '--preview-') as CSSProperties}>
            <input type="radio" name="color-palette" aria-label={palette.name} checked={appearance.palette === palette.id} onChange={() => updateAppearance({ palette: palette.id })}/>
            <span className={s.palettePreview} aria-hidden="true"><span className={s.previewRail}><i/><i/></span><span className={s.previewSidebar}><i/><i/><i/></span><span className={s.previewChat}><i/><i/><span><i/></span></span></span>
            <span className={s.paletteCaption}><strong>{palette.name}</strong><span>{palette.description}</span></span>
          </label>)}</div>
        </fieldset>
        <p className={s.appearanceSaved} role="status">{saveError ? 'Applied for this session. Harbor could not save this preference on your device.' : 'Changes apply instantly and are saved on this device.'}</p>
      </> : state.loading || !state.settings ? <p role="status">Loading settings…</p> : tab === 'Connections' ? <>
        {!state.clis.length ? <p>No CLIs detected. Install a supported CLI, then refresh.</p> : state.clis.map(cli => <div className={s.connection} key={cli.id}>
          <div className={s.connectionHeading}><h3>{cli.name}</h3><span className={cli.signedIn ? s.ready : s.muted}>{!cli.installed ? 'Not installed' : cli.authState === 'unknown' ? 'Status unknown' : cli.signedIn ? '✓ Ready' : 'Needs login'}</span></div>
          <p>{!cli.installed ? 'Install this CLI through its native installer, then refresh.' : cli.signedIn ? 'Available when enabled for routing.' : cli.authState === 'unknown' ? 'Sign-in status could not be confirmed. Open the native CLI or refresh.' : 'Installed. Sign in through its native CLI to start using it.'}</p>
          <small>{cli.version ? `Version ${cli.version}` : 'Version unavailable'}{cli.note ? ` · ${cli.note}` : ''}</small>
          <div className={s.connectionActions}>{cli.installed && !cli.signedIn && cli.authState !== 'unknown' ? <button disabled={pending} onClick={() => void action(() => state.run(() => state.api.openLogin(cli.id)))}>Sign in to {cli.name}</button> : null}
            <label><input type="checkbox" disabled={!cli.installed || pending} checked={state.settings?.cliOverrides[cli.id]?.enabled !== false} onChange={e => void action(() => state.updateSettings({ cliOverrides: { ...state.settings!.cliOverrides, [cli.id]: { enabled: e.target.checked } } }))}/> Enable {cli.name}</label></div>
          <CliFeaturesNote cli={cli}/>
          {cli.custom ? <CustomCliActions api={state.api} cli={cli} descriptor={customs.find(c => c.id === cli.id)} disabled={pending} onEdit={() => setEditor(customs.find(c => c.id === cli.id))} onRemoved={afterCustomChange}/>
            : <CliPathField key={`${cli.id}:${state.settings?.cliPaths?.[cli.id] ?? ''}`} api={state.api} cli={cli} saved={state.settings?.cliPaths?.[cli.id]} disabled={pending} onSave={path => state.saveSettings({ cliPaths: { [cli.id]: path } })}/>}
        </div>)}
        {state.api.saveCustomCli && state.api.dryRunCustomCli ? (editor
          ? <AddCliPanel key={editor === 'new' ? 'new' : editor.id} api={state.api} editing={editor === 'new' ? undefined : editor} onClose={() => setEditor(undefined)} onSaved={afterCustomChange}/>
          : <div className={s.connectionActions}><button onClick={() => setEditor('new')}>Add CLI</button><span className={s.muted}>Any local CLI that takes a prompt and prints an answer.</span></div>) : null}
      </> : tab === 'Routing' ? <>
        <h3>Routing defaults</h3><p>Choose how Harbor assigns work to your enabled connections.</p>
        <label className={s.field}>Routing<select disabled={pending} value={state.settings.routing} onChange={e => void action(() => state.updateSettings({ routing: e.target.value as 'auto' | 'manual' }))}><option value="auto">Automatic</option><option value="manual">Manual</option></select></label>
        {state.settings.routing === 'manual' ? <p className={s.muted}>Use the connection toggles to limit eligible tools. Selecting a tool per conversation is not available yet.</p> : null}
        <label className={s.field}>Optional free resets<select disabled={pending} value={state.settings.allowFreeReset} onChange={e => void action(() => state.updateSettings({ allowFreeReset: e.target.value as 'ask' | 'never' }))}><option value="ask">Ask every time</option><option value="never">Never use</option></select></label>
        <p className={s.muted}>A discretionary reset always requires your explicit approval.</p>
        <RoutingSettings state={state}/>
      </> : tab === 'Project' ? (project ? <>
        <h3>{project.name}</h3><p className={s.muted}>Fields left on “Inherit global” follow Settings → Routing.</p>
        <RoutingFields key={project.id} state={state} projectId={project.id}/>
        <ToolRules api={state.api} projectId={project.id}/>
      </> : <p>Open a project to change its settings.</p>) : tab === 'Diagnostics' ? <Diagnostics api={state.api}/> : <>
        <UsageWindows windows={state.usage} clis={state.clis}/>
      </>}
    </div>
  </section>;
}
