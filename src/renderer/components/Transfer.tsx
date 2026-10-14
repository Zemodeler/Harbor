import { useEffect, useState } from 'react';
import type { BundleExportPreview, BundleImportResult, BundlePreview, ChatImportPreview, ChatImportResult, ChatImportSourceInfo, Conversation, HarborApi, Skill } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import { errorText } from '../hooks/useAgentActions';
import { formatBytes } from './Skills';
import s from './Features.module.css';

/**
 * Settings > Import & export (plan section 6): export a project as a Harbor bundle, import a bundle, and import chats from other tools.
 * Every dialog shows exactly what goes in or comes out before anything is written; imported chats arrive as read-only history.
 */
export const canTransfer = (api: HarborApi) => !!(api.previewBundleExport || api.previewBundle || api.previewImport);
const day = (t?: number) => (t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export function TransferPanel({ state }: { state: HarborState }) {
  const project = state.projects.find(p => p.id === state.projectId);
  const api = state.api;
  return <div>
    {!project ? <p className={s.fxNote}>Open a project first: bundles are exported from a project, and imports go into one.</p> : <>
      {api.previewBundleExport && api.exportBundle ? <ExportBundle key={`e-${project.id}`} state={state} projectId={project.id} projectName={project.name}/> : null}
      {api.previewBundle && api.importBundle ? <ImportBundle key={`b-${project.id}`} state={state} projectId={project.id} projectName={project.name}/> : null}
      {api.listImportSources && api.previewImport && api.importConversation ? <ImportChats key={`c-${project.id}`} state={state} projectId={project.id} projectName={project.name}/> : null}
    </>}
  </div>;
}

function useAct() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function act(work: () => Promise<void>) { setBusy(true); setError(''); try { await work(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }
  return { busy, error, act, setError };
}

function ExportBundle({ state, projectId, projectName }: { state: HarborState; projectId: string; projectName: string }) {
  const api = state.api;
  const { busy, error, act } = useAct();
  const leadId = state.agents.find(a => a.projectId === projectId && a.role === 'main')?.id;
  const conversations = state.conversations.filter(c => c.projectId === projectId && (!leadId || c.agentId === leadId));
  const [skills, setSkills] = useState<Skill[]>([]);
  const [opts, setOpts] = useState({ settings: true, toolRules: true, skillChoices: true, images: false });
  const [convs, setConvs] = useState<Record<string, boolean>>({});
  const [chosenSkills, setChosenSkills] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<BundleExportPreview>();
  const [secretChoice, setSecretChoice] = useState<'redact' | 'keep' | ''>('');
  const [saved, setSaved] = useState('');
  useEffect(() => { let alive = true; void api.listSkills?.(projectId).then(list => { if (alive) setSkills(list.filter(x => !x.problems?.length)); }).catch(() => undefined); return () => { alive = false; }; }, [api, projectId]);
  const changed = () => { setPreview(undefined); setSecretChoice(''); setSaved(''); };
  const selection = () => ({ ...opts, conversations: conversations.filter(c => convs[c.id]).map(c => c.id), skills: skills.filter(x => chosenSkills[x.id]).map(x => x.id) });
  const check = () => act(async () => { changed(); setPreview(await api.previewBundleExport!(projectId, selection())); });
  const save = () => act(async () => {
    const r = await api.exportBundle!(preview!.token, secretChoice === 'redact' ? { redactSecrets: true } : secretChoice === 'keep' ? { keepSecrets: true } : {});
    if (!r) return;
    setPreview(undefined); setSecretChoice('');
    setSaved(`Saved ${r.items} item${r.items === 1 ? '' : 's'} (${formatBytes(r.bytes)}) to ${r.path}${r.redacted ? `; ${r.redacted} secret-looking string${r.redacted === 1 ? '' : 's'} removed` : ''}.`);
  });
  const box = (label: string, key: keyof typeof opts) => <label><input type="checkbox" checked={opts[key]} disabled={busy} onChange={e => { setOpts(o => ({ ...o, [key]: e.target.checked })); changed(); }}/> {label}</label>;
  return <div className={s.fxSettingsGroup} role="group" aria-label="Export a Harbor bundle">
    <h3>Export {projectName} as a Harbor bundle</h3>
    <p className={s.fxNote}>A .harbor.zip someone else can import into their copy of the project. Paths of this machine are rewritten to project-relative ones; credentials, CLI paths, run logs and session ids are never included.</p>
    <div className={s.fxChoices}>{box('Routing preferences (and the checks file reference)', 'settings')}{box('Tool rules ("always allow" for this project)', 'toolRules')}{box('Skill choices for this project', 'skillChoices')}{box('Include images (screenshots and attached images)', 'images')}</div>
    <fieldset className={s.fxChoices}><legend>Conversations</legend>
      {conversations.length ? conversations.map(c => <label key={c.id}><input type="checkbox" checked={!!convs[c.id]} disabled={busy} onChange={e => { setConvs(x => ({ ...x, [c.id]: e.target.checked })); changed(); }}/> {c.title}{c.imported ? <span className={s.fxBadge}>imported</span> : null}</label>) : <span className={s.fxMuted}>No conversations yet.</span>}
    </fieldset>
    {skills.length ? <fieldset className={s.fxChoices}><legend>Skills</legend>
      {skills.map(x => <label key={x.id}><input type="checkbox" checked={!!chosenSkills[x.id]} disabled={busy} onChange={e => { setChosenSkills(v => ({ ...v, [x.id]: e.target.checked })); changed(); }}/> {x.name} <span className={s.fxMuted}>{formatBytes(x.bytes)}</span></label>)}
    </fieldset> : null}
    <div className={s.fxRow}><button disabled={busy} onClick={() => void check()}>{busy && !preview ? 'Checking…' : 'Check what goes in'}</button></div>
    {preview ? <div className={s.fxDialog} role="status" aria-label="Bundle contents">
      <p className={s.fxNote}>{preview.fileName} · {formatBytes(preview.bytes)} · {preview.items.length} item{preview.items.length === 1 ? '' : 's'}</p>
      <ul className={s.fxList} aria-label="Goes into the bundle">{preview.items.map(i => <li key={`${i.kind}:${i.key}`}><strong>{i.label}</strong>{i.detail ? <span className={s.fxMuted}>{i.detail}</span> : null}{i.bytes ? <span className={s.fxMuted}>{formatBytes(i.bytes)}</span> : null}</li>)}</ul>
      <section><h3>Never included</h3><ul className={s.fxList} aria-label="Never included">{preview.excluded.map(x => <li key={x}>{x}</li>)}</ul></section>
      {preview.notes?.length ? <ul className={s.fxList} aria-label="Notes">{preview.notes.map(n => <li key={n} className={s.fxMuted}>{n}</li>)}</ul> : null}
      {preview.secrets.length ? <div className={s.fxConfirm} role="group" aria-label="Possible secrets">
        <p>The secret scan found {preview.secrets.length} possible secret{preview.secrets.length === 1 ? '' : 's'}. Check them before sharing the bundle:</p>
        <ul className={s.fxList}>{preview.secrets.map((x, i) => <li key={i}><span className={s.fxBadge} data-tone="bad">{x.kind}</span> {x.where} <span className={s.fxMono}>{x.excerpt}</span></li>)}</ul>
        <div className={s.fxChoices}>
          <label><input type="radio" name="secret-choice" checked={secretChoice === 'redact'} onChange={() => setSecretChoice('redact')}/> Remove them (replaced by [redacted])</label>
          <label><input type="radio" name="secret-choice" checked={secretChoice === 'keep'} onChange={() => setSecretChoice('keep')}/> Keep them: they are not secrets</label>
        </div>
      </div> : null}
      <div className={s.fxRow}><button className={s.fxPrimary} disabled={busy || (preview.secrets.length > 0 && !secretChoice)} onClick={() => void save()}>Save bundle…</button></div>
    </div> : null}
    {saved ? <p className={s.fxNote} role="status">{saved}</p> : null}
    {error ? <p className={s.fxError} role="alert">{error}</p> : null}
  </div>;
}

function ImportBundle({ state, projectId, projectName }: { state: HarborState; projectId: string; projectName: string }) {
  const api = state.api;
  const { busy, error, act } = useAct();
  const [path, setPath] = useState('');
  const [preview, setPreview] = useState<BundlePreview>();
  const [pick, setPick] = useState({ settings: false, replaceSettings: false, toolRules: false, skillChoices: false });
  const [convs, setConvs] = useState<Record<string, boolean>>({});
  const [skillsChosen, setSkillsChosen] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<BundleImportResult>();
  const reset = () => { setPreview(undefined); setResult(undefined); };
  const accept = (p: BundlePreview) => { setPreview(p); setPick({ settings: false, replaceSettings: false, toolRules: false, skillChoices: false }); setConvs(Object.fromEntries(p.conversations.map(c => [c.key, true]))); setSkillsChosen(Object.fromEntries((p.skills?.skills ?? []).map(x => [x.name, !x.problems?.length]))); };
  const browse = () => act(async () => { const p = await api.browseImportFile?.('bundle'); if (p) { setPath(p); reset(); } });
  const check = () => act(async () => { reset(); accept(await api.previewBundle!(path.trim())); });
  const hasOwn = !!Object.keys(state.settings?.projectOverrides?.[projectId] ?? {}).length;
  const doImport = () => act(async () => {
    const r = await api.importBundle!(preview!.token!, { projectId, ...pick, conversations: Object.keys(convs).filter(k => convs[k]), skills: Object.keys(skillsChosen).filter(k => skillsChosen[k]) });
    setPreview(undefined); setResult(r);
  });
  const p = preview;
  return <div className={s.fxSettingsGroup} role="group" aria-label="Import a Harbor bundle">
    <h3>Import a Harbor bundle into {projectName}</h3>
    <p className={s.fxNote}>Checking reads the bundle and writes nothing. Nothing in it is run; conversations arrive as read-only history and nothing the project already has is replaced without your tick.</p>
    <div className={s.fxField}><label htmlFor="bundle-path">Bundle file</label><div className={s.fxRow}>
      <input id="bundle-path" className={s.fxMono} style={{ flex: '1 1 260px', minWidth: 0 }} value={path} spellCheck={false} disabled={busy} placeholder={'C:\\Downloads\\project.harbor.zip'} onChange={e => { setPath(e.target.value); reset(); }}/>
      {api.browseImportFile ? <button disabled={busy} onClick={() => void browse()}>Browse…</button> : null}
      <button disabled={busy || !path.trim()} onClick={() => void check()}>Check bundle</button>
    </div></div>
    {p ? <div className={s.fxDialog} role="status" aria-label="Bundle preview">
      {p.problems?.length ? <ul className={s.fxList} aria-label="Problems">{p.problems.map(x => <li key={x} className={s.fxError}>{x}</li>)}</ul> : null}
      {p.token ? <>
        <p className={s.fxNote}>From {p.projectName}{p.createdAt ? `, made ${day(p.createdAt)}` : ''}{p.appVersion ? ` with Harbor ${p.appVersion}` : ''} · bundle version {p.version}</p>
        {p.warnings?.length ? <ul className={s.fxList} aria-label="Warnings">{p.warnings.map(w => <li key={w} className={s.fxMuted}>{w}</li>)}</ul> : null}
        {p.secrets.length ? <p className={s.fxError}>The secret scan found {p.secrets.length} possible secret{p.secrets.length === 1 ? '' : 's'} in this bundle ({[...new Set(p.secrets.map(x => x.where))].slice(0, 3).join(', ')}). Importing keeps them as written.</p> : null}
        <div className={s.fxChoices}>
          {p.settings ? <label><input type="checkbox" checked={pick.settings} onChange={e => setPick(x => ({ ...x, settings: e.target.checked }))}/> Routing preferences <span className={s.fxMuted}>{Object.entries(p.settings).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ')}</span></label> : null}
          {p.settings && pick.settings && hasOwn ? <label><input type="checkbox" checked={pick.replaceSettings} onChange={e => setPick(x => ({ ...x, replaceSettings: e.target.checked }))}/> Replace them: {projectName} already has its own routing preferences</label> : null}
          {p.toolRules?.length ? <label><input type="checkbox" checked={pick.toolRules} onChange={e => setPick(x => ({ ...x, toolRules: e.target.checked }))}/> Tool rules <span className={s.fxMuted}>{p.toolRules.map(r => `${r.prefix ? `${r.tool}(${r.prefix} ...)` : r.tool}${r.allowed ? '' : ' (refused: never always allowed)'}`).join(', ')}</span></label> : null}
          {p.skillChoices ? <label><input type="checkbox" checked={pick.skillChoices} onChange={e => setPick(x => ({ ...x, skillChoices: e.target.checked }))}/> Skill choices <span className={s.fxMuted}>{Object.entries(p.skillChoices).map(([k, v]) => `${k.replace(/^bundle:/, '')} ${v ? 'on' : 'off'}`).join(', ')}</span></label> : null}
          {p.checksFile ? <p className={s.fxNote}>The project used {p.checksFile}. Its commands stay in the repository and run only after you approve them here.</p> : null}
        </div>
        {p.conversations.length ? <fieldset className={s.fxChoices}><legend>Conversations (read-only history)</legend>{p.conversations.map(c => <label key={c.key}><input type="checkbox" checked={!!convs[c.key]} onChange={e => setConvs(x => ({ ...x, [c.key]: e.target.checked }))}/> {c.title} <span className={s.fxMuted}>{c.messages} messages{c.decisions ? `, ${c.decisions} decisions` : ''}{c.images ? `, ${c.images} images` : ''}</span></label>)}</fieldset> : null}
        {p.skills?.skills.length ? <fieldset className={s.fxChoices}><legend>Skills (into Harbor's library)</legend>
          {p.skills.warnings?.map(w => <p key={w} className={s.fxNote}><span className={s.fxBadge} data-tone="warn">contains scripts</span> {w}</p>)}
          {p.skills.skills.map(x => <label key={x.dir || x.name}><input type="checkbox" checked={!!skillsChosen[x.name]} disabled={!!x.problems?.length} onChange={e => setSkillsChosen(v => ({ ...v, [x.name]: e.target.checked }))}/> {x.name}{x.targetName && x.targetName !== x.name ? <span className={s.fxMuted}>saved as {x.targetName} (the name is taken; both are kept)</span> : null}{x.problems?.length ? <span className={s.fxError}>{x.problems.join(' ')}</span> : null}</label>)}
        </fieldset> : null}
        <div className={s.fxRow}><button className={s.fxPrimary} disabled={busy || (pick.settings && hasOwn && !pick.replaceSettings)} onClick={() => void doImport()}>Import into {projectName}</button></div>
      </> : null}
    </div> : null}
    {result ? <div className={s.fxDialog} role="status" aria-label="Bundle imported">
      <p>Imported: {result.applied.length ? result.applied.join(', ') : 'nothing'}.</p>
      {result.skipped.length ? <ul className={s.fxList} aria-label="Not imported">{result.skipped.map(x => <li key={x} className={s.fxMuted}>{x}</li>)}</ul> : null}
      {result.conversations.length ? <div className={s.fxRow}>{result.conversations.map(c => <button key={c.id} onClick={() => void state.openConversation(c)}>Open “{c.title}”</button>)}</div> : null}
    </div> : null}
    {error ? <p className={s.fxError} role="alert">{error}</p> : null}
  </div>;
}

function ImportChats({ state, projectId, projectName }: { state: HarborState; projectId: string; projectName: string }) {
  const api = state.api;
  const { busy, error, act } = useAct();
  const [sources, setSources] = useState<ChatImportSourceInfo[]>();
  const [source, setSource] = useState<ChatImportSourceInfo>();
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<ChatImportPreview>();
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');
  const [result, setResult] = useState<ChatImportResult>();
  useEffect(() => { let alive = true; void api.listImportSources!().then(list => { if (alive) setSources(list); }).catch(() => undefined); return () => { alive = false; }; }, [api]);
  const reset = () => { setListing(undefined); setChosen({}); setResult(undefined); };
  const list = () => act(async () => { reset(); setListing(await api.previewImport!(source!.id, source!.kind === 'file' ? { path: path.trim() } : {})); });
  const browse = () => act(async () => { const p = await api.browseImportFile?.('chatExport'); if (p) { setPath(p); reset(); } });
  const ids = Object.keys(chosen).filter(k => chosen[k]);
  const doImport = () => act(async () => { const r = await api.importConversation!(projectId, listing!.token!, ids); setResult(r); setChosen({}); });
  const shown = (listing?.entries ?? []).filter(e => !filter.trim() || `${e.title} ${e.detail ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 300);
  return <div className={s.fxSettingsGroup} role="group" aria-label="Import chats from other tools">
    <h3>Import chats from other tools into {projectName}</h3>
    <p className={s.fxNote}>An imported chat is read-only history tagged “imported”. To work on it, use “Continue with…” in the chat: the lead gets Harbor’s summary of it, never a replay of the other tool’s session. Harbor reads a transcript only when you import it.</p>
    {!sources ? <p className={s.fxNote} role="status">Loading sources…</p> : <div className={s.fxChoices} role="radiogroup" aria-label="Import chats from">
      {sources.map(x => <label key={x.id}><input type="radio" name="chat-source" checked={source?.id === x.id} disabled={busy || !x.available} onChange={() => { setSource(x); setPath(''); reset(); }}/> {x.name}{x.verified ? null : <span className={s.fxBadge} data-tone="warn">format not yet verified</span>}<span className={s.fxMuted}>{x.available ? x.location ?? x.note : 'not found on this computer'}</span></label>)}
    </div>}
    {source?.note ? <p className={s.fxNote}>{source.note}</p> : null}
    {source?.kind === 'file' ? <div className={s.fxField}><label htmlFor="chat-export-path">Export file</label><div className={s.fxRow}>
      <input id="chat-export-path" className={s.fxMono} style={{ flex: '1 1 260px', minWidth: 0 }} value={path} spellCheck={false} disabled={busy} placeholder={'C:\\Downloads\\conversations.json'} onChange={e => { setPath(e.target.value); reset(); }}/>
      {api.browseImportFile ? <button disabled={busy} onClick={() => void browse()}>Browse…</button> : null}
    </div></div> : null}
    {source ? <div className={s.fxRow}><button disabled={busy || (source.kind === 'file' && !path.trim())} onClick={() => void list()}>{busy && !listing ? 'Looking…' : 'List chats'}</button></div> : null}
    {listing ? <div className={s.fxDialog} role="status" aria-label="Chats found">
      <p className={s.fxNote}>{listing.label}: {listing.entries.length} chat{listing.entries.length === 1 ? '' : 's'}{listing.truncated ? ' (the newest are listed; more exist)' : ''}</p>
      {listing.problems?.length ? <ul className={s.fxList} aria-label="Problems">{listing.problems.map(x => <li key={x} className={s.fxError}>{x}</li>)}</ul> : null}
      {listing.skipped?.length ? <p className={s.fxNote}>Left out of the listing: {listing.skipped.join(', ')}.</p> : null}
      {listing.entries.length > 8 ? <input aria-label="Filter chats" placeholder="Filter" value={filter} onChange={e => setFilter(e.target.value)}/> : null}
      {listing.token ? <ul className={s.fxList} aria-label="Chats to import">{shown.map(e => <li key={e.id}><label><input type="checkbox" checked={!!chosen[e.id]} disabled={busy} onChange={ev => setChosen(x => ({ ...x, [e.id]: ev.target.checked }))}/> {e.title}</label><span className={s.fxMuted}>{[e.detail, day(e.updated ?? e.started), e.messages !== undefined ? `${e.messages} entries` : '', e.bytes !== undefined ? formatBytes(e.bytes) : ''].filter(Boolean).join(' · ')}</span></li>)}</ul> : null}
      {listing.token ? <div className={s.fxRow}><button className={s.fxPrimary} disabled={busy || !ids.length} onClick={() => void doImport()}>Import {ids.length} chat{ids.length === 1 ? '' : 's'}</button></div> : null}
    </div> : null}
    {result ? <div className={s.fxDialog} role="status" aria-label="Chats imported">
      <p>Imported {result.conversations.length} chat{result.conversations.length === 1 ? '' : 's'} as read-only history.</p>
      {result.skipped.length ? <ul className={s.fxList} aria-label="Import notes">{result.skipped.map(x => <li key={x} className={s.fxMuted}>{x}</li>)}</ul> : null}
      {result.conversations.length ? <div className={s.fxRow}>{result.conversations.slice(0, 6).map((c: Conversation) => <button key={c.id} onClick={() => void state.openConversation(c)}>Open “{c.title}”</button>)}</div> : null}
    </div> : null}
    {error ? <p className={s.fxError} role="alert">{error}</p> : null}
  </div>;
}

/** Shown instead of the message box in an imported conversation: where it came from, that it is read-only, and "Continue with…". */
export function ImportedNotice({ state, conversation }: { state: HarborState; conversation: Conversation }) {
  const info = conversation.imported!;
  const ready = state.clis.filter(c => c.installed && c.authState !== 'signedOut' && state.settings?.cliOverrides[c.id]?.enabled !== false);
  const [cli, setCli] = useState(ready[0]?.id ?? '');
  const { busy, error, act } = useAct();
  const go = () => act(async () => { const c = await state.api.continueImported!(conversation.id, { cli }); await state.openConversation(c); });
  return <div className={s.fxBlock} role="region" aria-label="Imported conversation" style={{ margin: '0 auto 12px', maxWidth: 760, display: 'grid', gap: 8 }}>
    <div className={s.fxHead}><span className={s.fxBadge}>imported</span><span>From {info.label} · read-only history</span></div>
    <p className={s.fxNote}>{info.messages} message{info.messages === 1 ? '' : 's'}{info.started ? `, ${day(info.started)}${info.ended && day(info.ended) !== day(info.started) ? ` to ${day(info.ended)}` : ''}` : ''}. Written outside Harbor: agents only ever see it as quoted history.{info.skipped?.length ? ` Left out on import: ${info.skipped.join(', ')}.` : ''}</p>
    {state.api.continueImported ? <div className={s.fxRow}>
      <label htmlFor="continue-cli">Continue with</label>
      <select id="continue-cli" value={cli} disabled={busy || !ready.length} onChange={e => setCli(e.target.value)}>{ready.length ? ready.map(c => <option key={c.id} value={c.id}>{c.name}</option>) : <option value="">No CLI is ready</option>}</select>
      <button className={s.fxPrimary} disabled={busy || !cli} onClick={() => void go()}>Continue in a new conversation</button>
    </div> : null}
    <p className={s.fxNote}>Harbor starts a new conversation and gives its lead a summary of this chat (the first request, the latest exchange and its decisions), never a replay of the other tool’s session.</p>
    {error ? <p className={s.fxError} role="alert">{error}</p> : null}
  </div>;
}
