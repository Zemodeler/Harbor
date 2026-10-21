import { useEffect, useMemo, useState } from 'react';
import type { CliDryRun, CliFeatures, CliStatus, CliTemplate, CustomCliDescriptor, HarborApi } from '../../shared/api';
import { errorText } from '../hooks/useAgentActions';
import s from './Features.module.css';
import { InlineConfirm } from './ui/InlineConfirm';

// The safe choice (Cancel, first in the group) takes focus when a destructive confirm opens. Module-level so it runs on mount only.
const focusSafe = (el: HTMLElement | null) => { el?.querySelector('button')?.focus(); };

const FEATURE_LABELS: Array<[keyof CliFeatures, string]> = [
  ['resume', 'resume sessions'], ['images', 'images'], ['readOnly', 'read-only mode'], ['structuredOutput', 'structured output'],
  ['permissionModes', 'permission modes'], ['mcp', 'MCP'], ['nativeSkills', 'native skills'], ['usageReadings', 'usage readings']
];

/** Which Harbor features this CLI supports; a missing one changes what Harbor does, it never blocks routing. */
export function CliFeaturesNote({ cli }: { cli: CliStatus }) {
  if (!cli.features) return null;
  const has = FEATURE_LABELS.filter(([k]) => cli.features![k]).map(([, l]) => l), missing = FEATURE_LABELS.filter(([k]) => !cli.features![k]).map(([, l]) => l);
  return <p className={s.fxNote}>{has.length ? `Supports: ${has.join(', ')}.` : 'Harbor uses none of its optional features.'}{missing.length ? ` Not available: ${missing.join(', ')}.` : ''}</p>;
}

type Draft = Omit<CustomCliDescriptor, 'id' | 'name' | 'exe' | 'acceptReadOnlyRisk' | 'approvedHash' | 'approvedAt'>;
const draftOf = (d: Partial<CustomCliDescriptor>): Draft => {
  const { id: _i, name: _n, exe: _e, acceptReadOnlyRisk: _a, approvedHash: _h, approvedAt: _t, ...rest } = d;
  return rest as Draft;
};

/**
 * Settings > Connections > Add CLI (plan 2.2): pick a template or start from your own CLI, name the program, tick the explicit OK to
 * run that file, then the dry run (version, sign-in check, one "reply OK" prompt) shows the raw output beside what Harbor parsed.
 * Saving records the file's hash; Harbor asks again if the file changes.
 */
export function AddCliPanel({ api, editing, onClose, onSaved }: { api: HarborApi; editing?: CustomCliDescriptor; onClose: () => void; onSaved: () => Promise<void> }) {
  const [templates, setTemplates] = useState<CliTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [name, setName] = useState(editing?.name ?? '');
  const [id, setId] = useState(editing?.id ?? '');
  const [exe, setExe] = useState(editing?.exe ?? '');
  const [json, setJson] = useState(editing ? JSON.stringify(draftOf(editing), null, 2) : '');
  const [accept, setAccept] = useState(editing?.acceptReadOnlyRisk === true);
  const [trusted, setTrusted] = useState(false);
  const [dry, setDry] = useState<{ key: string; result: CliDryRun }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (editing || !api.listCliTemplates) return;
    let alive = true;
    void api.listCliTemplates().then(ts => {
      if (!alive) return;
      setTemplates(ts);
      if (ts[0]) choose(ts[0]);
    }).catch(e => { if (alive) setError(errorText(e)); });
    return () => { alive = false; };
  }, [api, editing]);
  function choose(t: CliTemplate) {
    setTemplateId(t.id); setName(t.descriptor.name); setId(t.descriptor.id); setJson(JSON.stringify(draftOf(t.descriptor), null, 2));
    setAccept(t.descriptor.acceptReadOnlyRisk === true); setDry(undefined);
  }
  const parsed = useMemo((): { descriptor?: CustomCliDescriptor; error?: string } => {
    let rest: unknown;
    try { rest = JSON.parse(json || '{}'); } catch (e) { return { error: `The settings are not valid JSON: ${errorText(e)}` }; }
    if (!rest || typeof rest !== 'object' || Array.isArray(rest)) return { error: 'The settings must be a JSON object.' };
    return { descriptor: { ...(rest as Draft), id: id.trim(), name: name.trim(), exe: exe.trim(), ...(accept ? { acceptReadOnlyRisk: true } : {}) } };
  }, [json, id, name, exe, accept]);
  const key = JSON.stringify(parsed.descriptor ?? null);
  const noReadOnly = !!parsed.descriptor && !parsed.descriptor.run?.permissions?.['read-only'];
  const ranCurrent = dry?.key === key;
  async function act(work: () => Promise<void>) { setBusy(true); setError(''); try { await work(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }
  const dryRun = () => act(async () => { setDry(undefined); setDry({ key, result: await api.dryRunCustomCli!(parsed.descriptor!, { confirmExe: exe.trim() }) }); });
  const save = () => act(async () => { await api.saveCustomCli!(parsed.descriptor!, { confirmExe: exe.trim(), ...(editing ? { replace: true } : {}) }); await onSaved(); onClose(); });
  const browse = () => act(async () => { const p = await api.browseCliPath!(); if (p) { setExe(p); setTrusted(false); } });

  return <div className={s.fxSettingsGroup} role="group" aria-label={editing ? `Edit ${editing.name}` : 'Add a CLI'}>
    <h3>{editing ? `Edit ${editing.name}` : 'Add a CLI'}</h3>
    <p className={s.fxNote}>Describe how Harbor runs your CLI. The prompt always goes on standard input (or a temporary file), never on the command line. Check its flags with its own <span className={s.fxMono}>--help</span> first.</p>
    {!editing && templates.length ? <label className={s.fxField}>Start from<select value={templateId} disabled={busy} onChange={e => { const t = templates.find(x => x.id === e.target.value); if (t) choose(t); }}>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label> : null}
    {!editing && templates.find(t => t.id === templateId) ? <p className={s.fxNote}>{templates.find(t => t.id === templateId)!.description}</p> : null}
    <label className={s.fxField}>Name<input value={name} disabled={busy} onChange={e => setName(e.target.value)}/></label>
    <label className={s.fxField}><span>Id <span className={s.fxMuted}>(lowercase letters, digits, dashes)</span></span><input className={s.fxMono} value={id} disabled={busy || !!editing} onChange={e => setId(e.target.value)}/></label>
    <div className={s.fxField}>
      <label htmlFor="custom-cli-exe">Program</label>
      <div className={s.fxRow}>
        <input id="custom-cli-exe" className={s.fxMono} style={{ flex: '1 1 260px', minWidth: 0 }} value={exe} placeholder="C:\path\to\cli.exe" spellCheck={false} disabled={busy} onChange={e => { setExe(e.target.value); setTrusted(false); }}/>
        {api.browseCliPath ? <button disabled={busy} onClick={() => void browse()}>Browse…</button> : null}
      </div>
    </div>
    <label className={s.fxField}>How to run it (JSON: version, status, login, run, models)
      <textarea className={s.fxDiag} style={{ minHeight: 180 }} spellCheck={false} value={json} disabled={busy} onChange={e => setJson(e.target.value)} aria-label="CLI settings JSON"/>
    </label>
    {parsed.error ? <p className={s.fxError} role="alert">{parsed.error}</p> : null}
    {noReadOnly ? <label className={s.fxChoices}><span><input type="checkbox" checked={accept} disabled={busy} onChange={e => setAccept(e.target.checked)}/> This CLI has no read-only mode. Use it for planners, reviewers and plan mode anyway (it may write files there).</span></label> : null}
    {exe.trim() ? <div className={s.fxConfirm}>
      <label><input type="checkbox" checked={trusted} disabled={busy} onChange={e => setTrusted(e.target.checked)}/> I trust <span className={s.fxMono}>{exe.trim()}</span> and allow Harbor to run it: for the dry run now, and for real work once saved.</label>
    </div> : null}
    <div className={s.fxRow}>
      <button disabled={busy || !trusted || !parsed.descriptor} onClick={() => void dryRun()}>{busy ? 'Working…' : 'Dry run'}</button>
      <button className={s.fxPrimary} disabled={busy || !trusted || !parsed.descriptor || !ranCurrent} onClick={() => void save()}>{ranCurrent && !dry!.result.ok ? 'Save anyway' : editing ? 'Save and approve' : 'Save CLI'}</button>
      <button disabled={busy} onClick={onClose}>Cancel</button>
    </div>
    {!ranCurrent && trusted && parsed.descriptor ? <p className={s.fxNote}>Run the dry run on these settings before saving.</p> : null}
    {dry && ranCurrent ? <DryRunResult result={dry.result}/> : null}
    {error ? <p className={s.fxError} role="alert">{error}</p> : null}
  </div>;
}

function DryRunResult({ result }: { result: CliDryRun }) {
  if (result.problems?.length) return <div role="status"><p className={s.fxError}>Fix these first (nothing was run):</p><ul className={s.fxList} aria-label="Problems">{result.problems.map(p => <li key={p}>{p}</li>)}</ul></div>;
  const p = result.parsed;
  return <div className={s.fxDialog} role="status" aria-label="Dry run result">
    <p className={result.ok ? s.fxNote : s.fxError}>{result.ok ? `Dry run passed${result.version ? ` (version ${result.version})` : ''}.` : 'Dry run failed: compare the raw output with the settings.'}</p>
    {p ? <section><h3>What Harbor understood</h3><p className={s.fxNote}>{p.text ? `Answer: “${p.text.slice(0, 300)}”` : 'No answer text.'}{p.sessionId ? ` · session ${p.sessionId}` : ' · no session id (no resume)'}{p.inputTokens !== undefined || p.outputTokens !== undefined ? ` · tokens in ${p.inputTokens ?? '?'}, out ${p.outputTokens ?? '?'}` : ''}{result.authState ? ` · sign-in ${result.authState === 'signedIn' ? 'confirmed' : result.authState === 'signedOut' ? 'required' : 'unknown'}` : ''}{p.error ? ` · error: ${p.error}` : ''}</p></section> : null}
    {result.steps.map(st => <section key={st.name}>
      <h3>{st.name === 'version' ? 'Version' : st.name === 'status' ? 'Sign-in check' : 'Prompt'} <span className={s.fxMuted}>exit {st.exitCode ?? 'none'} · {Math.round(st.durationMs)} ms{st.error ? ` · ${st.error}` : ''}</span></h3>
      <p className={s.fxMono}>{st.command}</p>
      {st.stdout ? <pre className={`${s.fxMono} ${s.fxScroll}`} aria-label={`${st.name} output`}>{st.stdout}</pre> : null}
      {st.stderr ? <pre className={`${s.fxMono} ${s.fxScroll}`} aria-label={`${st.name} errors`}>{st.stderr}</pre> : null}
    </section>)}
  </div>;
}

/** Edit (re-approve) and remove for a custom CLI's card. */
export function CustomCliActions({ api, cli, descriptor, disabled, onEdit, onRemoved }: { api: HarborApi; cli: CliStatus; descriptor?: CustomCliDescriptor; disabled?: boolean; onEdit: () => void; onRemoved: () => Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function remove() {
    setBusy(true); setError('');
    try { await api.removeCustomCli!(cli.id); await onRemoved(); } catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return <>
    <div className={s.fxRow}>
      {descriptor ? <button disabled={disabled || busy} onClick={onEdit}>Edit or approve again</button> : null}
      {api.removeCustomCli ? <button disabled={disabled || busy} onClick={() => setConfirm(true)}>Remove</button> : null}
    </div>
    {confirm ? <div ref={focusSafe}><InlineConfirm label={`Remove ${cli.name}`} confirmLabel={`Remove ${cli.name}`} cancelLabel="Keep it" pending={busy} onConfirm={() => void remove()} onCancel={() => setConfirm(false)}>Remove {cli.name}? Harbor stops routing work to it. The program itself is not touched.</InlineConfirm></div> : null}
    {error ? <p className={s.fxError} role="alert">{error}</p> : null}
  </>;
}
