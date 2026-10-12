import { useEffect, useMemo, useRef, useState } from 'react';
import type { GitBranch, GitFileChange, GitTarget } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import { layoutGraph, type GraphRow } from '../gitGraph';
import { Clipped } from './Clipped';
import { SessionStatus } from './SessionStatus';
import { BranchIcon, RefreshIcon } from './Icons';
import s from '../Harbor.module.css';

const PAGE = 300, WINDOW = 100, LANE = 14, ROW = 40;
const COLORS = ['var(--accent)', '#d08a3a', '#7b6fd0', '#3d8fd1', '#c45a8c', '#6f9c45'];
const STATUS: Record<GitFileChange['status'], [string, string]> = { added: ['A', 'Added'], modified: ['M', 'Modified'], deleted: ['D', 'Deleted'], renamed: ['R', 'Renamed'], untracked: ['U', 'New, not committed'], other: ['?', 'Changed'] };
const color = (lane: number) => COLORS[lane % COLORS.length];
const short = (hash: string) => hash.slice(0, 7);
const when = (t: number) => Date.now() - t < 86400000 ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : new Date(t).toLocaleDateString();
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

type Selection = { kind: 'local' } | { kind: 'branch'; name: string } | { kind: 'commit'; hash: string; subject: string };
interface Loaded<T> { data?: T; error?: string; loading: boolean }

/**
 * Runs `load` whenever `key` or `tick` changes; `key === undefined` disables it. A refresh of the same
 * key keeps the old data on screen until the new data arrives, a new key clears it, and answers to
 * superseded requests are dropped.
 */
function useLoad<T>(key: string | undefined, tick: number, load: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ loading: key !== undefined });
  const shown = useRef<string>(undefined), loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    if (key === undefined) { shown.current = undefined; setState({ loading: false }); return; }
    let active = true;
    const same = shown.current === key; shown.current = key;
    setState(prev => ({ data: same ? prev.data : undefined, loading: true }));
    loader.current().then(data => { if (active) setState({ data, loading: false }); }, e => { if (active) setState({ error: e instanceof Error ? e.message : 'Could not read the repository.', loading: false }); });
    return () => { active = false; };
  }, [key, tick]);
  return state;
}

export function GitPanel({ state, openAgent }: { state: HarborState; openAgent: (agentId: string) => void }) {
  const { api, projectId } = state;
  const [tick, setTick] = useState(0);
  const [selection, setSelection] = useState<Selection>({ kind: 'local' });
  const [logBranch, setLogBranch] = useState<string>();
  const [limit, setLimit] = useState(PAGE);
  const [shown, setShown] = useState(WINDOW);
  const [file, setFile] = useState<string>();
  const refresh = () => setTick(t => t + 1);

  // A helper changing state may have committed or finished its branch, so re-read when that happens.
  const helpers = state.agents.filter(a => a.projectId === projectId && a.role !== 'main').map(a => `${a.id}:${a.state}`).join();
  const seenHelpers = useRef(helpers);
  useEffect(() => { if (seenHelpers.current !== helpers) { seenHelpers.current = helpers; refresh(); } }, [helpers]);

  const target: GitTarget = selection.kind === 'branch' ? { branch: selection.name } : selection.kind === 'commit' ? { commit: selection.hash } : {};
  const targetKey = JSON.stringify(target);
  const overview = useLoad(projectId || undefined, tick, () => api.getGitOverview(projectId));
  const o = overview.data, repo = !!o?.worktrees.length;
  const log = useLoad(repo ? `${logBranch ?? ''}|${limit}` : undefined, tick, () => api.getGitLog(projectId, { ...(logBranch ? { branch: logBranch } : {}), limit }));
  const changes = useLoad(repo ? targetKey : undefined, tick, () => api.getGitChanges(projectId, target));
  const open = changes.data?.find(f => f.path === file);
  const diff = useLoad(open && !open.hidden ? `${targetKey}|${open.path}` : undefined, tick, () => api.getGitDiff(projectId, open!.path, target));
  const graph = useMemo(() => layoutGraph(log.data ?? []), [log.data]);

  // Branches can disappear between refreshes (a helper's branch was removed); fall back instead of erroring.
  useEffect(() => {
    if (!o) return;
    const names = new Set(o.branches.map(b => b.name));
    if (selection.kind === 'branch' && !names.has(selection.name)) setSelection({ kind: 'local' });
    if (logBranch && !names.has(logBranch)) setLogBranch(undefined);
  }, [o]);

  function select(next: Selection) { setSelection(next); setFile(undefined); }
  function selectBranch(name: string) { select({ kind: 'branch', name }); setLogBranch(name); setLimit(PAGE); setShown(WINDOW); }

  if (!projectId) return <div className={s.empty}><p>Open a project to see its branches and changes.</p></div>;
  if (overview.error && !o) return <div className={s.empty}><p role="alert">{overview.error}</p><button onClick={refresh}>Try again</button></div>;
  if (!o) return <div className={s.empty} role="status">Reading the repository…</div>;
  if (!repo) return <div className={s.empty}>{o.notes.map(n => <p key={n}>{n}</p>)}<button onClick={refresh}>Check again</button></div>;

  const main = o.worktrees.find(w => w.main);
  const helperBranches = o.branches.filter(b => b.name.startsWith('harbor/'));
  const otherBranches = o.branches.filter(b => !b.name.startsWith('harbor/'));
  const chosen = selection.kind === 'branch' ? o.branches.find(b => b.name === selection.name) : undefined;
  const branchRow = (b: GitBranch) => <li key={b.name} className={s.gitBranch}>
    <button className={selection.kind === 'branch' && selection.name === b.name ? `${s.gitItem} ${s.gitItemOn}` : s.gitItem} aria-pressed={selection.kind === 'branch' && selection.name === b.name} onClick={() => selectBranch(b.name)}>
      <span className={s.gitName}><BranchIcon size={14} aria-hidden="true"/><span>{b.name}</span>{b.current ? <span className={s.gitBadge}>current</span> : null}</span>
      <small>{b.name === o.base ? 'Base branch' : b.ahead !== undefined ? `${b.ahead} ahead · ${b.behind} behind ${o.base}` : 'Not compared'} · {when(b.updated)}</small>
      <small className={s.gitSubjectLine}>{b.subject}</small>
    </button>
    {b.agentId ? <div className={s.gitAgent}><SessionStatus status={b.agentState ?? 'done'}/><button className={s.agentEntryTitle} onClick={() => openAgent(b.agentId!)}>{b.agentTitle || 'Open helper'}</button></div> : null}
  </li>;

  return <section className={s.gitView} aria-label="Git">
    <div className={s.gitColumn}>
      <div className={s.panelHeading}><h2>Branches</h2><button className={s.iconButton} aria-label="Refresh Git view" disabled={overview.loading} onClick={refresh}><RefreshIcon size={17} aria-hidden="true" className={overview.loading ? s.spinner : undefined}/></button></div>
      {overview.error ? <p className={s.reviewNote} role="alert">{overview.error}</p> : null}
      {o.notes.map(n => <p key={n} className={s.reviewNote}>{n}</p>)}
      <button className={selection.kind === 'local' ? `${s.gitItem} ${s.gitItemOn}` : s.gitItem} aria-pressed={selection.kind === 'local'} onClick={() => select({ kind: 'local' })}>
        <span className={s.gitName}>Uncommitted changes</span><small>{plural(main?.changed ?? 0, 'file')} in the project folder</small>
      </button>
      <h3 className={s.resultHeading}>Branches · {otherBranches.length}</h3>
      <ul className={s.gitList}>{otherBranches.map(branchRow)}</ul>
      {helperBranches.length ? <><h3 className={s.resultHeading}>Helper branches · {helperBranches.length}</h3><ul className={s.gitList}>{helperBranches.map(branchRow)}</ul></> : null}
      <h3 className={s.resultHeading}>Worktrees · {o.worktrees.length}</h3>
      <ul className={s.gitList}>{o.worktrees.map(w => <li key={w.path} className={s.gitWorktree}><span>{w.branch ?? 'Detached HEAD'}{w.main ? ' · project folder' : ''}</span><small title={w.path}>{w.path}</small><small>{w.changed ? `${plural(w.changed, 'uncommitted file')}` : 'No uncommitted changes'}</small></li>)}</ul>
    </div>

    <div className={s.gitColumn}>
      <div className={s.panelHeading}><h2>History</h2><select aria-label="History scope" value={logBranch ?? ''} onChange={e => { setLogBranch(e.target.value || undefined); setLimit(PAGE); setShown(WINDOW); }}><option value="">All branches</option>{o.branches.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}</select></div>
      {log.error ? <p className={s.reviewNote} role="alert">{log.error}</p> : null}
      {log.loading && !log.data ? <p role="status" className={s.muted}>Reading history…</p> : null}
      {log.data && !log.data.length ? <p className={s.muted}>No commits yet.</p> : null}
      <ol className={s.gitLog}>{(log.data ?? []).slice(0, shown).map((c, i) => {
        const on = selection.kind === 'commit' && selection.hash === c.hash;
        return <li key={c.hash}><button className={on ? `${s.gitCommit} ${s.gitItemOn}` : s.gitCommit} aria-pressed={on} title={`${c.hash}\n${c.author}, ${new Date(c.time).toLocaleString()}`} onClick={() => select({ kind: 'commit', hash: c.hash, subject: c.subject })}>
          <GraphCell row={graph.rows[i]!} width={graph.width} hash={c.hash} merge={c.parents.length > 1}/>
          <span className={s.gitCommitText}><span className={s.gitSubject}><span>{c.subject || '(no message)'}</span>{c.refs.slice(0, 3).map(r => <span key={r} className={s.gitBadge}>{r.replace(/^HEAD -> /, '')}</span>)}</span><small>{short(c.hash)} · {c.author} · {when(c.time)}</small></span>
        </button></li>;
      })}</ol>
      {/* Only a window of the loaded commits is in the DOM; "Show more" widens it, then older commits are fetched. */}
      {log.data && log.data.length > shown ? <button onClick={() => setShown(n => n + WINDOW)}>Show more commits ({log.data.length - shown} loaded)</button> : null}
      {log.data?.length === limit && log.data.length <= shown ? <button onClick={() => { setLimit(l => l + PAGE); setShown(n => n + WINDOW); }}>Show older commits</button> : null}
    </div>

    <div className={s.gitColumn}>
      <div className={s.panelHeading}><h2>Changes</h2>{changes.data ? <small>{plural(changes.data.length, 'file')}</small> : null}</div>
      <p className={s.gitTarget}>{selection.kind === 'local' ? 'Uncommitted changes in the project folder.' : selection.kind === 'commit' ? <><code>{short(selection.hash)}</code> {selection.subject}</> : <><strong>{selection.name}</strong> since it split from {o.base ?? 'its base'}{chosen?.worktree && chosen.agentId ? ', including work the helper has not committed yet' : ''}.</>}</p>
      {changes.error ? <p className={s.reviewNote} role="alert">{changes.error}</p> : null}
      {changes.loading && !changes.data ? <p role="status" className={s.muted}>Reading changes…</p> : null}
      {changes.data && !changes.data.length ? <p className={s.muted}>No changes.</p> : null}
      <ul className={s.gitList}>{(changes.data ?? []).map(f => <li key={f.path} className={s.gitFile}>
        <button className={file === f.path ? `${s.gitFileButton} ${s.gitItemOn}` : s.gitFileButton} aria-expanded={file === f.path} onClick={() => setFile(file === f.path ? undefined : f.path)}>
          <span className={s.gitStatus} data-status={f.status} title={STATUS[f.status][1]}>{STATUS[f.status][0]}</span>
          <span className={s.gitPath}>{f.oldPath ? `${f.oldPath} → ` : ''}{f.path}</span>
          {f.additions !== undefined ? <small><span className={s.gitAdd}>+{f.additions}</span> <span className={s.gitDel}>−{f.deletions}</span></small> : null}
        </button>
        {file === f.path ? f.hidden ? <p className={s.reviewNote}>Credential file: Harbor never shows its contents.</p>
          : diff.error ? <p className={s.reviewNote} role="alert">{diff.error}</p>
          : diff.data === undefined ? <p role="status" className={s.muted}>Reading diff…</p>
          : <Clipped key={`${targetKey}|${f.path}`} text={diff.data}>{lines => <pre className={s.gitDiff}>{lines.map((line, i) => <span key={i} className={line.startsWith('@@') ? s.gitHunk : line.startsWith('+') && !line.startsWith('+++') ? s.diffAdded : line.startsWith('-') && !line.startsWith('---') ? s.diffRemoved : undefined}>{line}{'\n'}</span>)}</pre>}</Clipped> : null}
      </li>)}</ul>
    </div>
  </section>;
}

function GraphCell({ row, width, hash, merge }: { row: GraphRow; width: number; hash: string; merge: boolean }) {
  const x = (lane: number) => LANE / 2 + lane * LANE, mid = ROW / 2;
  return <svg className={s.gitGraph} width={width * LANE} height={ROW} aria-hidden="true">
    {row.before.map((h, j) => h === null ? null : h === hash
      ? <line key={`in${j}`} x1={x(j)} y1={0} x2={x(row.lane)} y2={mid} stroke={color(j)}/>
      : <line key={`through${j}`} x1={x(j)} y1={0} x2={x(j)} y2={ROW} stroke={color(j)}/>)}
    {row.parentLanes.map(k => <line key={`out${k}`} x1={x(row.lane)} y1={mid} x2={x(k)} y2={ROW} stroke={color(k)}/>)}
    <circle cx={x(row.lane)} cy={mid} r={merge ? 3.5 : 4} fill={merge ? 'var(--bg)' : color(row.lane)} stroke={color(row.lane)} strokeWidth={2}/>
  </svg>;
}
