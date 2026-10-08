import { useState } from 'react';
import type { HarborState } from '../hooks/useHarbor';
import s from '../Harbor.module.css';

export function Settings({ state }: { state: HarborState }) {
  const [tab, setTab] = useState('Connections');
  const [pending, setPending] = useState(false);
  async function action(work: () => Promise<unknown>) { setPending(true); try { await work(); } finally { setPending(false); } }
  return <section className={s.settings} aria-label="Settings">
    <div className={s.settingsHeading}><h2>Your tools, connected.</h2><button disabled={pending} onClick={() => void action(state.refreshClis)}>{pending ? 'Checking…' : 'Refresh'}</button></div>
    <p className={s.muted}>Harbor discovers installed CLIs and uses their existing sign-ins.</p>
    <div className={s.tabs} role="tablist" aria-label="Settings sections">{['Connections', 'Routing', 'Usage'].map((name, i, all) => <button key={name} role="tab" id={`tab-${name}`} aria-controls="settings-panel" aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} className={tab === name ? s.tabActive : ''} onClick={() => setTab(name)} onKeyDown={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); const n = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length; setTab(all[n]); document.getElementById(`tab-${all[n]}`)?.focus(); } }}>{name}</button>)}</div>
    <div role="tabpanel" id="settings-panel" aria-labelledby={`tab-${tab}`}>
      {state.loading || !state.settings ? <p role="status">Loading settings…</p> : tab === 'Connections' ? <>
        {!state.clis.length ? <p>No CLIs detected. Install a supported CLI, then refresh.</p> : state.clis.map(cli => <div className={s.connection} key={cli.id}>
          <div className={s.connectionHeading}><h3>{cli.name}</h3><span className={cli.signedIn ? s.ready : s.muted}>{!cli.installed ? 'Not installed' : cli.authState === 'unknown' ? 'Status unknown' : cli.signedIn ? '✓ Ready' : 'Needs login'}</span></div>
          <p>{!cli.installed ? 'Install this CLI through its native installer, then refresh.' : cli.signedIn ? 'Available when enabled for routing.' : cli.authState === 'unknown' ? 'Sign-in status could not be confirmed. Open the native CLI or refresh.' : 'Installed. Sign in through its native CLI to start using it.'}</p>
          <small>{cli.version ? `Version ${cli.version}` : 'Version unavailable'}{cli.note ? ` · ${cli.note}` : ''}</small>
          <div className={s.connectionActions}>{cli.installed && !cli.signedIn && cli.authState !== 'unknown' ? <button disabled={pending} onClick={() => void action(() => state.run(() => state.api.openLogin(cli.id)))}>Sign in to {cli.name}</button> : null}
            <label><input type="checkbox" disabled={!cli.installed || pending} checked={state.settings?.cliOverrides[cli.id]?.enabled !== false} onChange={e => void action(() => state.updateSettings({ cliOverrides: { ...state.settings!.cliOverrides, [cli.id]: { enabled: e.target.checked } } }))}/> Enable {cli.name}</label></div>
        </div>)}
      </> : tab === 'Routing' ? <>
        <h3>Routing defaults</h3><p>Choose how Harbor assigns work to your enabled connections.</p>
        <label className={s.field}>Routing<select disabled={pending} value={state.settings.routing} onChange={e => void action(() => state.updateSettings({ routing: e.target.value as 'auto' | 'manual' }))}><option value="auto">Automatic</option><option value="manual">Manual</option></select></label>
        {state.settings.routing === 'manual' ? <p className={s.muted}>Use the connection toggles to limit eligible tools. Selecting a tool per conversation is not available yet.</p> : null}
        <label className={s.field}>Optional free resets<select disabled={pending} value={state.settings.allowFreeReset} onChange={e => void action(() => state.updateSettings({ allowFreeReset: e.target.value as 'ask' | 'never' }))}><option value="ask">Ask every time</option><option value="never">Never use</option></select></label>
        <p className={s.muted}>A discretionary reset always requires your explicit approval.</p>
      </> : <>
        <h3>Subscription windows</h3><p className={s.muted}>Each window belongs to its provider. Missing readings mean usage is unknown.</p>
        {!state.usage.length ? <p>Usage is unavailable. No allowance estimate is assumed.</p> : state.usage.map((w, i) => <div className={s.connection} key={`${w.cli}-${w.label}-${i}`}>
          <div className={s.connectionHeading}><h3>{w.cli}</h3><span>{Number.isFinite(w.usedPct) ? `${Math.round(w.usedPct)}% used` : 'Usage unknown'}</span></div><p>{w.label}</p>
          {Number.isFinite(w.usedPct) ? <progress aria-label={`${w.cli} ${w.label} usage`} max={100} value={Math.max(0, Math.min(100, w.usedPct))}/> : null}
          <small>{w.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString()}` : 'Reset time unknown'}{w.freeResetAvailable ? ' · Optional reset available (approval required)' : ''}</small>
        </div>)}
      </>}
    </div>
  </section>;
}
