import { useState } from 'react';
import type { GithubRepo, GithubStatus } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import s from '../Harbor.module.css';
import l from './Lifecycle.module.css';

const AREA = 'cloneproject';
/** The repository name at the end of a git URL, as the desktop app will name the folder. */
const nameOfUrl = (url: string) => (url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').split(/[/:]/).pop() ?? '').replace(/\.git$/i, '');

/** "Start from existing repo": a git URL, or a pick from the signed-in GitHub account's repositories. Clones into the projects folder. */
export function CloneProject({ state, close, gh, base, parentDir, chooseLocation, resetLocation }: { state: HarborState; close: () => void; gh?: GithubStatus; base?: string; parentDir?: string; chooseLocation?: () => void; resetLocation: () => void }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [repos, setRepos] = useState<GithubRepo[]>();
  const [filter, setFilter] = useState('');
  const [listError, setListError] = useState<string>();
  const [warnings, setWarnings] = useState<string[]>();
  const failure = state.areaErrors[AREA];
  const trimmed = url.trim();
  const folder = (name.trim() || nameOfUrl(trimmed)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '');
  const where = `${base ?? 'your Harbor Projects folder'}${folder ? `\\${folder}` : ''}`;
  const canList = !!state.api.listGithubRepos && !!gh?.installed && !!gh.loggedIn;

  const load = (refresh: boolean) => {
    setListError(undefined);
    void state.api.listGithubRepos!({ refresh }).then(setRepos).catch(e => setListError(e instanceof Error ? e.message : 'Could not list your repositories.'));
  };
  const pick = (r: GithubRepo) => { setUrl(r.url); setName(r.name); };
  const clone = () => {
    if (!trimmed) return;
    setPending(true);
    void state.cloneProject({ url: trimmed, ...(name.trim() ? { name: name.trim() } : {}), ...(parentDir ? { parentDir } : {}) }, AREA)
      .then(r => { if (!r) return; if (r.warnings.length) setWarnings(r.warnings); else close(); })
      .finally(() => setPending(false));
  };
  const shown = (repos ?? []).filter(r => !filter.trim() || r.slug.toLowerCase().includes(filter.trim().toLowerCase()) || (r.description ?? '').toLowerCase().includes(filter.trim().toLowerCase()));

  if (warnings) return <div className={l.form}>
    <p className={l.strong}>“{folder}” was cloned, with notes:</p>
    <ul className={l.warnings} aria-label="Notes about the cloned project">{warnings.map(w => <li key={w}>{w}</li>)}</ul>
    <div className={s.actions}><button className={s.primary} autoFocus onClick={close}>Open project</button></div>
  </div>;
  return <form className={l.form} onSubmit={e => { e.preventDefault(); clone(); }}>
    <label className={l.field}>Repository URL<input autoFocus value={url} maxLength={500} placeholder="https://github.com/owner/name.git" onChange={e => setUrl(e.target.value)}/></label>
    <label className={l.field}>Project name (optional)<input value={name} maxLength={80} placeholder={nameOfUrl(trimmed) || 'Same as the repository'} onChange={e => setName(e.target.value)}/></label>
    <p className={l.where}>Will be cloned into <code>{where}</code>{chooseLocation ? <> · <button type="button" className={l.linkButton} disabled={pending} onClick={chooseLocation}>Change location…</button>{parentDir ? <> · <button type="button" className={l.linkButton} disabled={pending} onClick={resetLocation}>Use the default</button></> : null}</> : null}</p>
    {state.api.listGithubRepos ? <div className={l.field}>
      <span>Or pick one of your GitHub repositories</span>
      {!canList ? <small className={l.hint}>{!gh ? 'Checking for the GitHub CLI…' : !gh.installed ? 'The GitHub CLI (gh) is not installed. Install it with winget install GitHub.cli, then run gh auth login.' : 'gh is not signed in. Run gh auth login in a terminal.'}</small>
        : !repos ? <div><button type="button" disabled={pending} onClick={() => load(false)}>Load my repositories</button></div>
        : <>
          <input aria-label="Filter repositories" value={filter} placeholder="Filter by name" onChange={e => setFilter(e.target.value)}/>
          {shown.length ? <ul className={l.repoList} aria-label="Your GitHub repositories">{shown.map(r => <li key={r.slug}><button type="button" aria-pressed={url === r.url} onClick={() => pick(r)}>{r.slug}{r.isPrivate ? ' (private)' : ''}{r.description ? <small>{r.description}</small> : null}</button></li>)}</ul> : <small className={l.hint}>No repositories match.</small>}
          <div><button type="button" className={l.linkButton} onClick={() => load(true)}>Refresh list</button></div>
        </>}
      {listError ? <p className={s.error} role="alert">{listError}</p> : null}
    </div> : null}
    {pending ? <p role="status" className={l.hint}>Cloning the repository…</p> : null}
    {failure ? <p className={s.error} role="alert">{failure}</p> : null}
    <div className={s.actions}>
      <button type="button" disabled={pending} onClick={close}>Cancel</button>
      <button type="submit" className={s.primary} disabled={pending || !trimmed}>{pending ? 'Cloning…' : 'Clone project'}</button>
    </div>
  </form>;
}
