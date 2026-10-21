import { useEffect, useState } from 'react';
import type { GithubStatus, ProjectTemplate } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import { CloneProject } from './CloneProject';
import { Modal } from './Modal';
import s from '../Harbor.module.css';
import l from './Lifecycle.module.css';

const TEMPLATES: { id: ProjectTemplate; name: string; hint: string }[] = [
  { id: 'empty', name: 'Empty', hint: 'A README, a .gitignore and an AGENTS.md.' },
  { id: 'node-ts', name: 'Node and TypeScript', hint: 'package.json, tsconfig.json and src/index.ts.' },
  { id: 'python', name: 'Python', hint: 'pyproject.toml and main.py.' },
  { id: 'static-web', name: 'Static web page', hint: 'A single index.html, no build step.' }
];
const AREA = 'newproject';

/** Where the folder will be, as far as the window can know (the desktop app resolves and checks the real path). */
const folderOf = (name: string) => name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '');

/** Start a project in one step: a name, a place, a template, optionally a private GitHub repository and a first message. */
export function NewProject({ state, close }: { state: HarborState; close: () => void }) {
  const [name, setName] = useState('');
  const [parentDir, setParentDir] = useState<string>();
  const [template, setTemplate] = useState<ProjectTemplate>('empty');
  const [github, setGithub] = useState(false);
  const [first, setFirst] = useState('');
  const [pending, setPending] = useState(false);
  const [gh, setGh] = useState<GithubStatus>();
  const [warnings, setWarnings] = useState<string[]>();
  const [tab, setTab] = useState<'new' | 'existing'>('new');
  const failure = state.areaErrors[AREA];
  useEffect(() => { void state.api.getGithubStatus?.().then(setGh).catch(() => setGh({ installed: false, loggedIn: false })); return () => state.clearError(AREA); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const ghReady = !!gh?.installed && !!gh.loggedIn;
  const ghHint = !state.api.getGithubStatus || !gh ? 'Checking for the GitHub CLI…' : !gh.installed ? 'The GitHub CLI (gh) is not installed. Install it with winget install GitHub.cli, then run gh auth login.' : !gh.loggedIn ? 'gh is not signed in. Run gh auth login in a terminal.' : `Signed in to GitHub as ${gh.account ?? 'your account'}. The repository is private and Harbor pushes the first commit.`;
  const base = parentDir ?? (state.settings?.projectsDir || undefined);
  const trimmed = name.trim();
  const where = trimmed ? `${base ?? 'your Harbor Projects folder'}\\${folderOf(trimmed)}` : base ?? 'your Harbor Projects folder';

  const create = () => {
    if (!trimmed) return;
    setPending(true);
    void state.createProject({ name: trimmed, ...(parentDir ? { parentDir } : {}), template, github: github && ghReady ? { create: true, visibility: 'private' } : { create: false }, ...(first.trim() ? { firstPrompt: first.trim() } : {}) }, AREA)
      .then(r => { if (!r) return; if (r.warnings.length) setWarnings(r.warnings); else close(); })
      .finally(() => setPending(false));
  };
  const choose = () => void state.run(async () => { const dir = await state.api.browseFolder!(); if (dir) setParentDir(dir); }, AREA);

  const canClone = !!state.api.cloneProject;
  return <Modal title="New project" close={close} dismissible={!pending}>
    {canClone && !warnings ? <div role="tablist" aria-label="How to start" className={l.tabs}>
      <button role="tab" type="button" aria-selected={tab === 'new'} disabled={pending} onClick={() => setTab('new')}>Start from scratch</button>
      <button role="tab" type="button" aria-selected={tab === 'existing'} disabled={pending} onClick={() => setTab('existing')}>Start from existing repo</button>
    </div> : null}
    {canClone && tab === 'existing' && !warnings ? <CloneProject state={state} close={close} gh={gh} base={parentDir ?? (state.settings?.projectsDir || undefined)} chooseLocation={state.api.browseFolder ? choose : undefined} parentDir={parentDir} resetLocation={() => setParentDir(undefined)}/> : warnings ? <div className={l.form}>
      <p className={l.strong}>“{trimmed}” was created, with notes:</p>
      <ul className={l.warnings} aria-label="Notes about the new project">{warnings.map(w => <li key={w}>{w}</li>)}</ul>
      <div className={s.actions}><button className={s.primary} autoFocus onClick={close}>Open project</button></div>
    </div> : <form className={l.form} onSubmit={e => { e.preventDefault(); create(); }}>
      <label className={l.field}>Project name<input autoFocus value={name} maxLength={80} placeholder="My new app" onChange={e => setName(e.target.value)}/></label>
      <p className={l.where}>Will be created in <code>{where}</code>{state.api.browseFolder ? <> · <button type="button" className={l.linkButton} disabled={pending} onClick={choose}>Change location…</button>{parentDir ? <> · <button type="button" className={l.linkButton} disabled={pending} onClick={() => setParentDir(undefined)}>Use the default</button></> : null}</> : null}</p>
      <fieldset className={l.choices}><legend>Starting point</legend>
        {TEMPLATES.map(t => <label key={t.id} className={`${l.choice} ${template === t.id ? l.choiceOn : ''}`}><input type="radio" name="project-template" checked={template === t.id} disabled={pending} onChange={() => setTemplate(t.id)}/>{t.name}<small>{t.hint}</small></label>)}
      </fieldset>
      <label className={l.check}><input type="checkbox" checked={github && ghReady} disabled={!ghReady || pending} onChange={e => setGithub(e.target.checked)}/>Create a private GitHub repository<small>{ghHint}</small></label>
      <label className={l.field}>First message (optional)<textarea value={first} disabled={pending} placeholder="What should the lead start on?" onChange={e => setFirst(e.target.value)}/></label>
      {pending ? <p role="status" className={l.hint}>Creating the folder, committing the first files{github && ghReady ? ', creating the repository' : ''}…</p> : null}
      {failure ? <p className={s.error} role="alert">{failure}</p> : null}
      <div className={s.actions}>
        <button type="button" disabled={pending} onClick={close}>Cancel</button>
        <button type="submit" className={s.primary} disabled={pending || !trimmed}>{pending ? 'Creating…' : 'Create project'}</button>
      </div>
    </form>}
  </Modal>;
}
