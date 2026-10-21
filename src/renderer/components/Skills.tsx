import { useCallback, useEffect, useState } from 'react';
import type { HarborApi, Skill, SkillDetail, SkillImportPreview, SkillImportSource } from '../../shared/api';
import { errorText } from '../hooks/useAgentActions';
import s from './Features.module.css';
import { InlineConfirm } from './ui/InlineConfirm';

// The safe choice (Cancel, first in the group) takes focus when a destructive confirm opens. Module-level so it runs on mount only.
const focusSafe = (el: HTMLElement | null) => { el?.querySelector('button')?.focus(); };

const SOURCE_LABEL: Record<Skill['source'], string> = { library: 'Harbor library', project: 'Project', claude: 'From Claude Code', codex: 'From Codex' };
export const formatBytes = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);
const shortHash = (h?: string) => (h ? h.slice(0, 12) : '');

/**
 * Settings > Skills (plan section 3): every skill Harbor can give an agent, with its source, whether this project uses it, and its
 * SKILL.md. A skill is text (and maybe scripts) written by someone else: Harbor never runs anything in it.
 */
export function SkillsPanel({ api, projectId, projectName }: { api: HarborApi; projectId?: string; projectName?: string }) {
  const [skills, setSkills] = useState<Skill[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Record<string, SkillDetail | undefined>>({});
  const [confirm, setConfirm] = useState<string>();
  const [importer, setImporter] = useState<SkillImportSource | 'new'>();

  const load = useCallback(async () => {
    try { setSkills(await api.listSkills!(projectId)); setError(''); } catch (e) { setError(errorText(e)); }
  }, [api, projectId]);
  useEffect(() => { void load(); }, [load]);

  async function act(work: () => Promise<unknown>) { setBusy(true); setError(''); try { await work(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }
  const toggle = (sk: Skill, on: boolean) => act(async () => setSkills(await api.setSkillEnabled!(sk.id, on, projectId)));
  const view = (sk: Skill) => act(async () => { if (open[sk.id]) setOpen(o => ({ ...o, [sk.id]: undefined })); else { const d = await api.readSkill!(sk.id, projectId); setOpen(o => ({ ...o, [sk.id]: d })); } });
  const remove = (sk: Skill) => act(async () => { await api.removeSkill!(sk.id); setConfirm(undefined); await load(); });
  const where = projectName ? `in ${projectName}` : 'by default';

  return <div className={s.fxSettingsGroup} role="group" aria-label="Skills">
    <p className={s.fxNote}>A skill is a folder with a SKILL.md. Harbor tells the lead and its helpers each enabled skill’s name, description and path; an agent reads the SKILL.md only when its task matches. Skills are written by others: they never override Harbor’s rules, and Harbor never runs their scripts.</p>
    <p className={s.fxNote}>{projectName ? `Ticks apply to ${projectName}. Without a choice, a skill follows its default: library and project skills on, Claude Code and Codex skills off.` : 'Open a project to choose skills for it. Ticks here set the default for every project.'}</p>
    <div className={s.fxRow}>
      {api.previewSkillImport && api.importSkills ? <button disabled={busy} onClick={() => setImporter('new')}>Import skill</button> : null}
      <button disabled={busy} onClick={() => void act(load)}>Refresh</button>
    </div>
    {importer ? <SkillImportPanel key={importer === 'new' ? 'new' : JSON.stringify(importer)} api={api} initial={importer === 'new' ? undefined : importer} onClose={() => setImporter(undefined)} onImported={async () => { setImporter(undefined); await load(); }}/> : null}
    {error ? <p className={s.fxError} role="alert">{error}</p> : null}
    {!skills ? <p className={s.fxNote} role="status">Loading skills…</p> : !skills.length ? <p className={s.fxNote}>No skills yet. Import one from a folder, a .zip file or GitHub, or add folders to the project’s .harbor\skills.</p> :
      <ul className={s.fxList} aria-label="Skills list" style={{ gap: 10 }}>{skills.map(sk => <li key={sk.id} className={s.fxBlock} style={{ display: 'grid', gap: 4 }}>
        <div className={s.fxHead}><span>{sk.name}</span><span className={s.fxBadge}>{SOURCE_LABEL[sk.source]}</span>{sk.hasScripts ? <span className={s.fxBadge} data-tone="warn">contains scripts</span> : null}{sk.problems?.length ? <span className={s.fxBadge} data-tone="bad">cannot be used</span> : null}</div>
        <span>{sk.description || <span className={s.fxMuted}>No description.</span>}</span>
        <span className={s.fxMuted}>{sk.files} file{sk.files === 1 ? '' : 's'} · {formatBytes(sk.bytes)}{sk.hash ? ` · hash ${shortHash(sk.hash)}` : ''}{sk.importedFrom ? ` · imported from ${sk.importedFrom}` : ''}{sk.readOnly ? ' · read-only' : ''}</span>
        <span className={`${s.fxMono} ${s.fxMuted}`}>{sk.path}</span>
        {sk.problems?.length ? <p className={s.fxError}>{sk.problems.join(' ')}</p> : null}
        <div className={s.fxRow}>
          <label><input type="checkbox" checked={sk.enabled} disabled={busy || !!sk.problems?.length} onChange={e => void toggle(sk, e.target.checked)} aria-label={`Use ${sk.name} ${where}`}/> Use {where}</label>
          <button disabled={busy} onClick={() => void view(sk)} aria-expanded={!!open[sk.id]}>{open[sk.id] ? 'Hide SKILL.md' : 'View SKILL.md'}</button>
          {sk.source !== 'library' && api.previewSkillImport ? <button disabled={busy} onClick={() => setImporter({ kind: 'folder', path: sk.path })}>Copy to library</button> : null}
          {sk.source === 'library' && api.removeSkill ? <button disabled={busy} onClick={() => setConfirm(sk.id)}>Remove</button> : null}
        </div>
        {confirm === sk.id ? <div ref={focusSafe}><InlineConfirm label={`Remove ${sk.name}`} confirmLabel={`Remove ${sk.name}`} cancelLabel="Keep it" pending={busy} onConfirm={() => void remove(sk)} onCancel={() => setConfirm(undefined)}>Remove {sk.name} from Harbor’s library? Its folder is deleted; projects stop using it.</InlineConfirm></div> : null}
        {open[sk.id] ? <SkillText detail={open[sk.id]!}/> : null}
      </li>)}</ul>}
  </div>;
}

function SkillText({ detail }: { detail: SkillDetail }) {
  return <div className={s.fxDialog}>
    {detail.modified ? <p className={s.fxError}>Its files changed since it was imported (hash {shortHash(detail.currentHash)}, recorded {shortHash(detail.hash)}).</p> : null}
    {detail.truncated ? <p className={s.fxNote}>SKILL.md is too large to show.</p> : <pre className={`${s.fxMono} ${s.fxScroll}`} style={{ maxHeight: 320, whiteSpace: 'pre-wrap' }} aria-label={`SKILL.md of ${detail.name}`}>{detail.text}</pre>}
    <ul className={s.fxList} aria-label={`Files of ${detail.name}`}>{detail.fileList.map(f => <li key={f.path}><span className={s.fxMono}>{f.path}</span><span className={s.fxMuted}>{formatBytes(f.bytes)}{f.script ? ' · script' : ''}</span></li>)}</ul>
  </div>;
}

/**
 * Import dialog: choose a folder, a .zip or a GitHub address, check it (nothing is written; GitHub lists names and sizes only), for
 * GitHub download exactly what was listed after a second click, review the files, SKILL.md and any scripts, then import.
 */
export function SkillImportPanel({ api, initial, onClose, onImported }: { api: HarborApi; initial?: SkillImportSource; onClose: () => void; onImported: () => Promise<void> }) {
  const [kind, setKind] = useState<SkillImportSource['kind']>(initial?.kind ?? 'folder');
  const [value, setValue] = useState(initial ? (initial.kind === 'github' ? initial.ref : initial.path) : '');
  const [preview, setPreview] = useState<SkillImportPreview>();
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const source = (): SkillImportSource => (kind === 'github' ? { kind, ref: value.trim() } : { kind, path: value.trim() });

  function reset() { setPreview(undefined); setChosen({}); setShown({}); setError(''); }
  async function act(work: () => Promise<void>) { setBusy(true); setError(''); try { await work(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }
  const accept = (p: SkillImportPreview) => { setPreview(p); setChosen(Object.fromEntries(p.skills.map(c => [c.name, !c.problems?.length]))); };
  const check = () => act(async () => { reset(); accept(await api.previewSkillImport!(source())); });
  const download = () => act(async () => { accept(await api.previewSkillImport!(source(), { confirmDownload: preview!.token! })); });
  const browse = () => act(async () => { const p = await api.browseSkillSource!(kind === 'zip' ? 'zip' : 'folder'); if (p) { setValue(p); reset(); } });
  const names = preview ? preview.skills.filter(c => chosen[c.name] && !c.problems?.length).map(c => c.name) : [];
  const doImport = () => act(async () => { await api.importSkills!(preview!.token!, { names }); await onImported(); });
  const label = kind === 'github' ? 'GitHub address' : kind === 'zip' ? '.zip file path' : 'Folder path';

  return <div className={s.fxSettingsGroup} role="group" aria-label="Import a skill">
    <h3>Import a skill</h3>
    <p className={s.fxNote}>Importing copies files into Harbor’s library. Nothing in them is run, now or later. Links, paths that leave the folder, and anything over 200 files or 5 MB are refused.</p>
    <div className={s.fxChoices} role="radiogroup" aria-label="Import from">
      {(['folder', 'zip', 'github'] as const).map(k => <label key={k}><input type="radio" name="skill-source" checked={kind === k} disabled={busy} onChange={() => { setKind(k); setValue(''); reset(); }}/> {k === 'folder' ? 'Folder' : k === 'zip' ? '.zip file' : 'GitHub'}</label>)}
    </div>
    <div className={s.fxField}>
      <label htmlFor="skill-source-value">{label}</label>
      <div className={s.fxRow}>
        <input id="skill-source-value" className={s.fxMono} style={{ flex: '1 1 260px', minWidth: 0 }} value={value} spellCheck={false} disabled={busy}
          placeholder={kind === 'github' ? 'owner/repo/path or https://github.com/owner/repo/tree/main/path' : kind === 'zip' ? 'C:\\Downloads\\skill.zip' : 'C:\\path\\to\\skill'} onChange={e => { setValue(e.target.value); reset(); }}/>
        {kind !== 'github' && api.browseSkillSource ? <button disabled={busy} onClick={() => void browse()}>Browse…</button> : null}
      </div>
    </div>
    {kind === 'github' ? <p className={s.fxNote}>Check asks GitHub for the file list and sizes only. Harbor downloads the files after you confirm what it found.</p> : null}
    <div className={s.fxRow}>
      <button disabled={busy || !value.trim()} onClick={() => void check()}>{busy && !preview ? 'Checking…' : 'Check'}</button>
      <button disabled={busy} onClick={onClose}>Cancel</button>
    </div>
    {preview ? <div className={s.fxDialog} role="status" aria-label="Import preview">
      <p className={s.fxNote}>Source: <span className={s.fxMono}>{preview.source}</span> · {preview.fileCount} file{preview.fileCount === 1 ? '' : 's'} · {formatBytes(preview.totalBytes)}</p>
      {preview.problems?.length ? <ul className={s.fxList} aria-label="Problems">{preview.problems.map(p => <li key={p} className={s.fxError}>{p}</li>)}</ul> : null}
      {preview.needsDownload && preview.token ? <div className={s.fxConfirm}>
        <p>Nothing has been downloaded yet. Download {preview.fileCount} file{preview.fileCount === 1 ? '' : 's'} ({formatBytes(preview.totalBytes)}) from {preview.source}?</p>
        <div className={s.fxRow}><button className={s.fxPrimary} disabled={busy} onClick={() => void download()}>Download {preview.fileCount} file{preview.fileCount === 1 ? '' : 's'} ({formatBytes(preview.totalBytes)})</button></div>
      </div> : null}
      {preview.warnings?.length ? <ul className={s.fxList} aria-label="Warnings">{preview.warnings.map(w => <li key={w}><span className={s.fxBadge} data-tone="warn">contains scripts</span> {w}</li>)}</ul> : null}
      {preview.skills.map(c => <section key={c.dir || c.name} className={s.fxBlock}>
        <div className={s.fxHead}>
          {!preview.needsDownload ? <input type="checkbox" checked={!!chosen[c.name]} disabled={busy || !!c.problems?.length} aria-label={`Import ${c.name}`} onChange={e => setChosen(x => ({ ...x, [c.name]: e.target.checked }))}/> : null}
          <span>{c.name}</span>{c.hasScripts ? <span className={s.fxBadge} data-tone="warn">contains scripts</span> : null}
          {c.targetName && c.targetName !== c.name ? <span className={s.fxMuted}>saved as {c.targetName} (the name is taken; both are kept)</span> : null}
        </div>
        {c.description ? <p className={s.fxNote}>{c.description}</p> : null}
        {c.problems?.length ? <p className={s.fxError}>{c.problems.join(' ')}</p> : null}
        <ul className={s.fxList} aria-label={`Files in ${c.name}`}>{c.files.map(f => <li key={f.path}><span className={s.fxMono}>{f.path}</span><span className={s.fxMuted}>{formatBytes(f.bytes)}{f.script ? ' · script' : ''}</span></li>)}</ul>
        {c.hash ? <p className={s.fxNote}>Hash <span className={s.fxMono}>{c.hash}</span></p> : null}
        {c.text !== undefined ? <><button disabled={busy} onClick={() => setShown(x => ({ ...x, [c.name]: !x[c.name] }))}>{shown[c.name] ? 'Hide SKILL.md' : 'Show SKILL.md'}</button>
          {shown[c.name] ? <pre className={`${s.fxMono} ${s.fxScroll}`} style={{ maxHeight: 320, whiteSpace: 'pre-wrap' }} aria-label={`SKILL.md of ${c.name}`}>{c.text}</pre> : null}</> : null}
      </section>)}
      {!preview.needsDownload && preview.token ? <div className={s.fxRow}><button className={s.fxPrimary} disabled={busy || !names.length} onClick={() => void doImport()}>Import {names.length} skill{names.length === 1 ? '' : 's'}</button></div> : null}
    </div> : null}
    {error ? <p className={s.fxError} role="alert">{error}</p> : null}
  </div>;
}
