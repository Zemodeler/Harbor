import { useState } from 'react';
import type { CliStatus, HarborApi } from '../../shared/api';
import { errorText } from '../hooks/useAgentActions';
import s from './Features.module.css';

const statusText = (r: CliStatus) => !r.installed ? 'Not found' : r.authState === 'signedOut' ? 'Found, login required' : r.signedIn ? 'Found and signed in' : 'Found, sign-in status unknown';

/**
 * Settings > Connections: point Harbor at a CLI's executable. "Test" runs only the CLI's version and sign-in checks on the typed path
 * without saving; "Save" stores it (main rejects a path that is not an existing file) and discovery re-runs.
 */
export function CliPathField({ api, cli, saved, disabled, onSave }: { api: HarborApi; cli: CliStatus; saved?: string; disabled?: boolean; onSave: (path: string) => Promise<void> }) {
  const [path, setPath] = useState(saved ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CliStatus>();
  const [error, setError] = useState('');
  if (!api.testCliPath) return null;
  const id = `cli-path-${cli.id}`;
  async function act(work: () => Promise<void>) {
    setBusy(true); setError('');
    try { await work(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  const test = () => act(async () => { setResult(undefined); setResult(await api.testCliPath!(cli.id, path.trim())); });
  const browse = () => act(async () => { const p = await api.browseCliPath!(); if (p) { setPath(p); setResult(undefined); } });
  return <div className={s.fxField}>
    <label htmlFor={id}>Executable path for {cli.name} <span className={s.fxMuted}>(optional: used before PATH)</span></label>
    <div className={s.fxRow}>
      <input id={id} className={s.fxMono} style={{ flex: '1 1 260px', minWidth: 0 }} value={path} placeholder="C:\path\to\cli.exe" spellCheck={false} disabled={disabled || busy} onChange={e => { setPath(e.target.value); setResult(undefined); }}/>
      {api.browseCliPath ? <button disabled={disabled || busy} onClick={() => void browse()}>Browse…</button> : null}
      <button disabled={disabled || busy || !path.trim()} onClick={() => void test()}>Test</button>
      <button className={s.fxPrimary} disabled={disabled || busy || !path.trim() || path.trim() === saved} onClick={() => void act(() => onSave(path.trim()))}>Save path</button>
      {saved ? <button disabled={disabled || busy} onClick={() => void act(async () => { await onSave(''); setPath(''); setResult(undefined); })}>Use PATH again</button> : null}
    </div>
    {busy ? <p className={s.fxNote} role="status">Working…</p> : null}
    {result ? <p className={s.fxNote} role="status">{statusText(result)}{result.version ? ` · version ${result.version}` : ''}{result.note ? ` · ${result.note}` : ''}</p> : null}
    {error ? <p className={s.fxError} role="alert">{error}</p> : null}
  </div>;
}
