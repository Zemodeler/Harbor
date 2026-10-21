import { useEffect, useRef, useState } from 'react';
import type { DeletePreview, DeleteScope, Project } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import { Modal } from './Modal';
import { SaveTemplate } from './SaveTemplate';
import { initials, toIcon } from './projectIcon';
import s from '../Harbor.module.css';
import p from './ProjectSettings.module.css';
import l from './Lifecycle.module.css';

const size = (bytes?: number) => bytes === undefined ? 'size unknown' : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : bytes < 1024 ** 3 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Name, image and removal of one project. Removal only drops Harbor's records, so it is a second step inside the dialog, not a click away. */
export function ProjectSettings({ state, project, close }: { state: HarborState; project: Project; close: () => void }) {
  const [name, setName] = useState(project.name);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [templating, setTemplating] = useState(false);
  const [level, setLevel] = useState<DeleteScope>('forget');
  const [preview, setPreview] = useState<DeletePreview>();
  const [typed, setTyped] = useState('');
  const [leftover, setLeftover] = useState<string[]>();
  const picker = useRef<HTMLInputElement>(null);
  const canLevels = !!state.api.previewDeleteProject && !!state.api.deleteProject;
  // The preview is read once the confirmation opens; it changes nothing.
  useEffect(() => {
    if (!confirming || !canLevels) return;
    let alive = true;
    void state.api.previewDeleteProject!(project.id).then(r => { if (alive) setPreview(r); }).catch(() => undefined);
    return () => { alive = false; };
  }, [confirming]);   // eslint-disable-line react-hooks/exhaustive-deps
  const dismiss = () => { state.clearError('project'); close(); };
  const trimmed = name.trim();
  const dirty = trimmed !== project.name;
  const failure = state.areaErrors.project;

  const save = () => {
    if (!trimmed || !dirty) return;
    setPending(true);
    void state.renameProject(project.id, trimmed, 'project').then(ok => { if (ok) dismiss(); }).finally(() => setPending(false));
  };
  const needsName = level === 'folder' || (level === 'worktrees' && !!preview?.needsTypedName.worktrees);
  const blocked = level === 'folder' && !!preview?.blockers.length;
  const nameOk = !needsName || typed === project.name;
  const remove = () => {
    setPending(true);
    if (level === 'forget') { void state.removeProject(project.id, 'project').then(ok => { if (ok) dismiss(); }).finally(() => setPending(false)); return; }
    void state.deleteProject(project.id, level, needsName ? typed : undefined, 'project').then(r => {
      if (!r) return;
      if (r.removed.records) dismiss(); else setLeftover(r.warnings);
    }).finally(() => setPending(false));
  };
  const actionLabel = level === 'forget' ? 'Remove project' : level === 'worktrees' ? 'Delete worktrees and branches' : 'Delete folder and project';

  return <Modal title="Project settings" close={dismiss} dismissible={!pending}>
    {templating ? <SaveTemplate state={state} project={project} back={() => setTemplating(false)} done={dismiss}/> : confirming ? <div className={p.confirm}>
      <p><strong>Remove “{project.name}” from Harbor?</strong></p>
      <p className={s.muted}>Its conversations and agent records are deleted and running work is stopped. By default the folder, its files and git branches stay on disk. This cannot be undone.</p>
      {canLevels ? <fieldset className={`${l.choices} ${level !== 'forget' ? l.danger : ''}`} disabled={pending}><legend>What else should go?</legend>
        <label className={`${l.choice} ${level === 'forget' ? l.choiceOn : ''}`}><input type="radio" name="delete-level" checked={level === 'forget'} onChange={() => setLevel('forget')}/>Remove from Harbor only<small>Your folder, files, branches and worktrees stay where they are.</small></label>
        <label className={`${l.choice} ${level === 'worktrees' ? l.choiceOn : ''}`}><input type="radio" name="delete-level" checked={level === 'worktrees'} onChange={() => setLevel('worktrees')}/>Also remove Harbor’s worktrees and branches{preview ? ` (${preview.worktrees.length + preview.branches.length})` : ''}<small>Deletes the working copies and harbor/* branches Harbor made. Your own branches and the folder stay.</small></label>
        <label className={`${l.choice} ${level === 'folder' ? l.choiceOn : ''}`}><input type="radio" name="delete-level" checked={level === 'folder'} onChange={() => setLevel('folder')}/>Also delete the folder{preview ? ` (${size(preview.folder.sizeBytes)}, ${preview.path})` : ''}<small>Permanently deletes every file in the project folder. GitHub is not touched.</small></label>
      </fieldset> : null}
      {level !== 'forget' && preview ? <div className={`${l.alert} ${l.alertWarn}`} aria-label="What will be deleted">
        {preview.running ? <p>{plural(preview.running, 'running session')} will be stopped.</p> : null}
        {preview.worktrees.length ? <><p className={l.strong}>{plural(preview.worktrees.length, 'worktree')}</p><ul className={l.list}>{preview.worktrees.map(w => <li key={w.path}><code>{w.branch ?? w.path}</code>{w.dirty ? ' · uncommitted changes' : ''}{w.unmergedCommits ? ` · ${plural(w.unmergedCommits, 'commit')} not merged` : ''}</li>)}</ul></> : <p>No Harbor worktrees.</p>}
        {preview.branches.length ? <><p className={l.strong}>{plural(preview.branches.length, 'harbor branch')}</p><ul className={l.list}>{preview.branches.map(b => <li key={b.name}><code>{b.name}</code>{b.merged ? ' · merged' : ' · not merged'}{b.unpushed ? ` · ${plural(b.unpushed, 'commit')} not on any remote` : ''}</li>)}</ul></> : null}
        {level === 'folder' ? <>
          {preview.folder.dirty ? <p>The folder has uncommitted changes that will be lost.</p> : null}
          {preview.folder.unpushedCommits ? <p>{plural(preview.folder.unpushedCommits, 'commit')} exist nowhere else: no remote has {preview.folder.unpushedCommits === 1 ? 'it' : 'them'}.</p> : null}
          {!preview.folder.hasRemote ? <p>This project has no remote, so nothing is backed up on GitHub.</p> : null}
          {preview.folder.outsideProjectsDir ? <p>This folder is outside your projects folder, so it may hold files that were not made by Harbor.</p> : null}
        </> : null}
      </div> : null}
      {blocked ? <p className={s.error} role="alert">{preview!.blockers.join(' ')}</p> : null}
      {needsName ? <label className={l.field}>Type “{project.name}” to confirm<input value={typed} autoComplete="off" disabled={pending} onChange={e => setTyped(e.target.value)}/></label> : null}
      {failure ? <p className={s.error} role="alert">{failure}</p> : null}
      {leftover?.length ? <ul className={l.warnings} aria-label="Left behind">{leftover.map(w => <li key={w}>{w}</li>)}</ul> : null}
      <div className={s.actions}>
        <button disabled={pending} onClick={() => { setConfirming(false); setLevel('forget'); setTyped(''); setLeftover(undefined); state.clearError('project'); }}>Keep project</button>
        <button className={p.danger} disabled={pending || !nameOk || blocked} onClick={remove}>{pending ? 'Removing…' : actionLabel}</button>
      </div>
    </div> : <>
      <form onSubmit={e => { e.preventDefault(); save(); }}>
        <div className={p.identity}>
          <span className={p.avatar} aria-hidden="true">{project.image ? <img src={project.image} alt=""/> : initials(project.name)}</span>
          <div className={p.imageActions}>
            <input ref={picker} type="file" hidden accept=".png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.ico,image/png,image/jpeg,image/*" aria-label="Project image file" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void state.run(async () => state.setProjectImage(project.id, await toIcon(f)), 'project'); }}/>
            <button type="button" onClick={() => picker.current?.click()}>{project.image ? 'Change image' : 'Choose image'}</button>
            {project.image ? <button type="button" className={p.quiet} onClick={() => void state.setProjectImage(project.id, null)}>Remove image</button> : null}
          </div>
        </div>
        <label className={p.field}>Project name<input autoFocus value={name} maxLength={120} onChange={e => setName(e.target.value)}/></label>
        <p className={`${p.path} ${s.muted}`} title={project.path}>{project.path}</p>
        {failure ? <p className={s.error} role="alert">{failure}</p> : null}
        <div className={s.actions}>
          <button type="button" disabled={pending} onClick={dismiss}>Close</button>
          <button type="submit" className={s.primary} disabled={pending || !trimmed || !dirty}>{pending ? 'Saving…' : 'Save name'}</button>
        </div>
      </form>
      {state.api.saveProjectAsTemplate && state.api.previewTemplate ? <section className={p.danger_zone} aria-labelledby="project-template" style={{ borderColor: 'var(--line)' }}>
        <div><h3 id="project-template">Use as a template</h3><p className={s.muted}>Copies the tracked files so new projects can start from this one.</p></div>
        <button type="button" onClick={() => setTemplating(true)}>Save as template…</button>
      </section> : null}
      <section className={p.danger_zone} aria-labelledby="project-danger">
        <div><h3 id="project-danger">Remove from Harbor</h3><p className={s.muted}>Forgets this project and its conversations. Your files stay where they are.</p></div>
        <button type="button" className={p.dangerOutline} onClick={() => setConfirming(true)}>Remove…</button>
      </section>
    </>}
  </Modal>;
}
