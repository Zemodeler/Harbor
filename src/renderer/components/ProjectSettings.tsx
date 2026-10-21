import { useRef, useState } from 'react';
import type { Project } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import { Modal } from './Modal';
import { InlineConfirm } from './ui/InlineConfirm';
import { initials, toIcon } from './projectIcon';
import s from '../Harbor.module.css';
import p from './ProjectSettings.module.css';

// The safe choice (Keep project, first in the group) takes focus; module-level so it runs on mount only.
const focusSafe = (el: HTMLElement | null) => { el?.querySelector('button')?.focus(); };

/** Name, image and removal of one project. Removal only drops Harbor's records, so it is a second step inside the dialog, not a click away. */
export function ProjectSettings({ state, project, close }: { state: HarborState; project: Project; close: () => void }) {
  const [name, setName] = useState(project.name);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const dismiss = () => { state.clearError('project'); close(); };
  const trimmed = name.trim();
  const dirty = trimmed !== project.name;
  const failure = state.areaErrors.project;

  const save = () => {
    if (!trimmed || !dirty) return;
    setPending(true);
    void state.renameProject(project.id, trimmed, 'project').then(ok => { if (ok) dismiss(); }).finally(() => setPending(false));
  };
  const remove = () => {
    setPending(true);
    void state.removeProject(project.id, 'project').then(ok => { if (ok) dismiss(); }).finally(() => setPending(false));
  };

  return <Modal title="Project settings" close={dismiss} dismissible={!pending}>
    {confirming ? <div ref={focusSafe}>
      <InlineConfirm label={`Remove ${project.name}`} cancelLabel="Keep project" confirmLabel={pending ? 'Removing…' : 'Remove project'} pending={pending} onCancel={() => { setConfirming(false); state.clearError('project'); }} onConfirm={remove}>
        <strong>Remove “{project.name}” from Harbor?</strong><br/>Its conversations and agent records are deleted and running work is stopped. The folder, its files and git branches stay on disk. This cannot be undone.
      </InlineConfirm>
      {failure ? <p className={s.error} role="alert">{failure}</p> : null}
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
      <section className={p.danger_zone} aria-labelledby="project-danger">
        <div><h3 id="project-danger">Remove from Harbor</h3><p className={s.muted}>Forgets this project and its conversations. Your files stay where they are.</p></div>
        <button type="button" className={p.dangerOutline} onClick={() => setConfirming(true)}>Remove…</button>
      </section>
    </>}
  </Modal>;
}
