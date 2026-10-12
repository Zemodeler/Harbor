import { useState } from 'react';
import type { HarborApi } from '../../shared/api';
import { useAction } from '../hooks/useAgentActions';
import s from './Features.module.css';

export const canExportDiagnostics = (api: HarborApi) => typeof api.exportDiagnostics === 'function';

/** Save text as a file through a Blob; the URL is released right after the click. */
export function saveTextFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function Diagnostics({ api }: { api: HarborApi }) {
  const { busy, error, run } = useAction();
  const [text, setText] = useState<string>();
  const [note, setNote] = useState('');
  async function make() { setNote(''); const r = await run(async () => api.exportDiagnostics!()); if (r.ok) setText(r.value); }
  async function copy() {
    try { await navigator.clipboard.writeText(text ?? ''); setNote('Copied to the clipboard.'); }
    catch { setNote('Could not copy. Select the text above and copy it by hand.'); }
  }
  return <div className={s.fxSettingsGroup}>
    <h3>Diagnostics</h3>
    <p className={s.fxNote}>A plain-text support bundle: versions, CLI states, counts and recent log lines. It contains no message text, prompts or credentials. Look it over before you share it.</p>
    <div className={s.fxRow}><button className={s.fxPrimary} disabled={busy} onClick={() => void make()}>{busy ? 'Collecting…' : 'Export diagnostics'}</button></div>
    {error ? <p className={s.fxError} role="alert">{error}</p> : null}
    {text !== undefined ? <>
      <textarea className={s.fxDiag} readOnly aria-label="Diagnostics text" value={text}/>
      <div className={s.fxRow}><button onClick={() => void copy()}>Copy</button><button onClick={() => saveTextFile(`harbor-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`, text)}>Save as file</button></div>
      <p className={s.fxNote} role="status">{note}</p>
    </> : null}
  </div>;
}
