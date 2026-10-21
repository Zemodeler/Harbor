import { useEffect, useState } from 'react';
import type { WorktreeInfo } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import s from '../Harbor.module.css';
import l from './Lifecycle.module.css';

export const canManageProjects = (api: HarborState['api']) => typeof api.createProject === 'function' || typeof api.listWorktrees === 'function';

const size = (bytes?: number) => bytes === undefined ? '—' : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : bytes < 1024 ** 3 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const AREA = 'storage';

/** Where new projects go, and the worktrees Harbor keeps for all projects, with a clean-up for the merged, stale and orphaned ones. */
export function ProjectsStorage({ state }: { state: HarborState }) {
  const { api, settings } = state;
  const [dir, setDir] = useState(settings?.projectsDir ?? '');
  const [saved, setSaved] = useState('');
  const [list, setList] = useState<WorktreeInfo[]>();
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState('');
  const failure = state.areaErrors[AREA];
  const load = () => void api.listWorktrees?.().then(setList).catch(() => setList([]));
  useEffect(() => { load(); return () => state.clearError(AREA); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const save = (value: string) => {
    setPending(true); setSaved('');
    void state.run(async () => { await state.updateSettings({ projectsDir: value.trim() }); setDir(value.trim()); setSaved(value.trim() ? 'Saved.' : 'Back to the default folder.'); }, AREA).finally(() => setPending(false));
  };
  const browse = () => void state.run(async () => { const picked = await api.browseFolder!(); if (picked) setDir(picked); }, AREA);
  const clean = () => {
    setPending(true); setNote('');
    void state.run(async () => {
      const r = await api.cleanupWorktrees!();
      setNote(r.removed ? `Removed ${r.removed} worktree${r.removed === 1 ? '' : 's'}${r.branchesDeleted ? ` and ${r.branchesDeleted} merged branch${r.branchesDeleted === 1 ? '' : 'es'}` : ''}.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}` : r.warnings.join(' ') || 'Nothing to clean up.');
      load();
    }, AREA).finally(() => setPending(false));
  };
  const removable = (list ?? []).filter(w => w.removable);
  const total = (list ?? []).reduce((n, w) => n + (w.sizeBytes ?? 0), 0);

  return <>
    {api.createProject ? <>
      <h3>Projects folder</h3>
      <p className={s.muted}>New projects are created here unless you choose another place in the New project dialog. Leave it empty for Documents\Harbor Projects.</p>
      <div className={l.row}>
        <input aria-label="Projects folder" value={dir} placeholder="Documents\Harbor Projects" onChange={e => { setDir(e.target.value); setSaved(''); }}/>
        {api.browseFolder ? <button disabled={pending} onClick={browse}>Browse…</button> : null}
        <button className={s.primary} disabled={pending || dir.trim() === (settings?.projectsDir ?? '')} onClick={() => save(dir)}>Save</button>
      </div>
      {saved ? <p role="status" className={l.hint}>{saved}</p> : null}
    </> : null}
    {api.listWorktrees ? <>
      <h3>Worktrees</h3>
      <p className={s.muted}>Helpers work in separate git worktrees under Harbor’s own folder. Merged, stale (idle for two weeks) and orphaned ones can be removed; running or uncommitted work is never touched, and only merged harbor/* branches are deleted with them.</p>
      {!list ? <p role="status" className={l.hint}>Reading worktrees…</p> : !list.length ? <p className={s.muted}>No worktrees.</p> : <table className={l.table}>
        <caption className={l.hint}>{list.length} worktree{list.length === 1 ? '' : 's'}, {size(total)} in all</caption>
        <thead><tr><th scope="col">Project</th><th scope="col">Branch</th><th scope="col">Age</th><th scope="col">Size</th><th scope="col">State</th></tr></thead>
        <tbody>{list.map(w => <tr key={w.path}>
          <td>{w.projectName ?? 'No project'}</td>
          <td className={l.path} title={w.path}>{w.branch ?? w.path}</td>
          <td>{w.ageDays} d</td><td>{size(w.sizeBytes)}</td>
          <td>{w.orphan ? 'Orphaned' : w.active ? 'In use' : w.dirty ? 'Uncommitted changes' : w.merged ? 'Merged' : w.removable ? 'Stale' : 'Unmerged work'}</td>
        </tr>)}</tbody>
      </table>}
      <div className={l.row}><button disabled={pending || !removable.length || !api.cleanupWorktrees} onClick={clean}>{pending ? 'Cleaning…' : `Clean up merged and stale${removable.length ? ` (${removable.length})` : ''}`}</button><button disabled={pending} onClick={load}>Refresh</button></div>
      {note ? <p role="status" className={l.hint}>{note}</p> : null}
    </> : null}
    {failure ? <p className={s.error} role="alert">{failure}</p> : null}
  </>;
}
