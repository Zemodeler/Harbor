import { useCallback, useEffect, useState } from 'react';
import type { Conversation, GlobalUsage, ProjectOverview, ProjectsOverview, SearchAllHit, UsageRow } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import s from '../Harbor.module.css';
import o from './Overview.module.css';

const AREA = 'overview';
const PAGE = 10;
const when = (t: number) => (t ? new Date(t).toLocaleString() : 'never');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The home screen: every project at a glance, search across all of them, and Harbor's own usage numbers (always labelled an estimate). */
export function Overview({ state, openProject, openConversation }: { state: HarborState; openProject: (id: string) => void; openConversation: (projectId: string, c: Conversation) => void }) {
  const api = state.api;
  const [data, setData] = useState<ProjectsOverview>();
  const [loadError, setLoadError] = useState<string>();
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchAllHit[]>();
  const [more, setMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string>();
  const [usage, setUsage] = useState<GlobalUsage>();
  const [usageError, setUsageError] = useState<string>();
  const failure = state.areaErrors[AREA];

  const load = useCallback(() => {
    setLoadError(undefined);
    void api.getProjectsOverview!().then(setData).catch(e => setLoadError(e instanceof Error ? e.message : 'Could not load the overview.'));
  }, [api]);
  useEffect(() => { load(); return () => state.clearError(AREA); }, [load, state.projects.length]);   // eslint-disable-line react-hooks/exhaustive-deps

  const byId = new Map((data?.projects ?? []).map(p => [p.projectId, p]));
  const row = (id: string): ProjectOverview | undefined => byId.get(id);
  const flag = (id: string, patch: { archived?: boolean; pinned?: boolean }) => void state.setProjectFlags(id, patch, AREA).then(ok => { if (ok) load(); });

  const runSearch = (offset: number) => {
    if (!api.searchAll || !query.trim()) return;
    setSearching(true); setSearchError(undefined);
    void api.searchAll(query.trim(), { offset, limit: PAGE })
      .then(r => { setHits(h => offset ? [...(h ?? []), ...r.hits] : r.hits); setMore(r.hasMore); })
      .catch(e => setSearchError(e instanceof Error ? e.message : 'The search failed.'))
      .finally(() => setSearching(false));
  };
  const loadUsage = () => { setUsageError(undefined); void api.getGlobalUsage!().then(setUsage).catch(e => setUsageError(e instanceof Error ? e.message : 'Could not load usage.')); };

  const live = state.projects.filter(p => !p.archived), archived = state.projects.filter(p => p.archived);
  const card = (p: typeof state.projects[number]) => {
    const r = row(p.id);
    return <li key={p.id} className={o.card}>
      <div className={o.cardHead}>
        <button className={o.name} onClick={() => openProject(p.id)} aria-label={`Open ${p.name}`}>{p.name}</button>
        {p.pinned ? <span className={o.badge}>Pinned</span> : null}
        {r?.missing ? <span className={`${o.badge} ${o.warn}`}>Folder missing</span> : null}
      </div>
      <small className={o.path}>{p.path}</small>
      {r ? <ul className={o.stats} aria-label={`${p.name} status`}>
        <li>{r.running ? plural(r.running, 'agent') + ' running' : 'Nothing running'}{r.waiting ? `, ${r.waiting} waiting for you` : ''}</li>
        <li>{r.gitFailed ? 'Git status unavailable' : `${plural(r.unmergedBranches, 'unmerged branch', 'unmerged branches')}, ${plural(r.unpushedCommits, 'unpushed commit')}`}</li>
        <li>Last activity {when(r.lastActivity)}</li>
        <li>{r.recentRuns ? `${plural(r.recentRuns, 'run')} in 7 days, about ${r.recentKTok} k-tokens (estimate)` : 'No runs in 7 days'}</li>
      </ul> : <small className={o.path}>{loadError ? '' : 'Loading…'}</small>}
      {api.setProjectFlags ? <div className={o.actions}>
        <button onClick={() => flag(p.id, { pinned: !p.pinned })}>{p.pinned ? 'Unpin' : 'Pin'}<span className={s.srOnly}> {p.name}</span></button>
        <button onClick={() => flag(p.id, { archived: !p.archived })}>{p.archived ? 'Unarchive' : 'Archive'}<span className={s.srOnly}> {p.name}</span></button>
      </div> : null}
    </li>;
  };

  return <section className={o.page} aria-label="All projects">
    {failure ? <p className={s.error} role="alert">{failure}</p> : null}
    {loadError ? <p className={s.error} role="alert">{loadError} <button onClick={load}>Retry</button></p> : null}
    {data?.quota?.length ? <p className={o.quota} aria-label="Usage windows">{data.quota.map(w => `${w.cli} ${w.label}: ${Math.round(w.usedPct)}% used${w.source === 'estimated' ? ' (estimate)' : ''}`).join(' · ')}</p> : null}
    <h2 className={o.h}>Projects</h2>
    {live.length ? <ul className={o.list}>{live.map(card)}</ul> : <p className={s.muted}>Every project is archived. Show them below.</p>}
    {archived.length ? <>
      <button className={o.link} aria-expanded={showArchived} onClick={() => setShowArchived(v => !v)}>{showArchived ? 'Hide' : 'Show'} archived projects ({archived.length})</button>
      {showArchived ? <ul className={o.list} aria-label="Archived projects">{archived.map(card)}</ul> : null}
    </> : null}

    {api.searchAll ? <>
      <h2 className={o.h}>Search every project</h2>
      <form className={o.search} role="search" onSubmit={e => { e.preventDefault(); runSearch(0); }}>
        <input aria-label="Search all projects" value={query} placeholder="Conversation titles and messages" onChange={e => { setQuery(e.target.value); if (!e.target.value.trim()) setHits(undefined); }}/>
        <button type="submit" disabled={searching || !query.trim()}>{searching ? 'Searching…' : 'Search'}</button>
      </form>
      {searchError ? <p className={s.error} role="alert">{searchError}</p> : null}
      {hits ? hits.length ? <>
        <ul className={o.hits} aria-label="Search results">{hits.map(h => <li key={`${h.conversation.id}-${h.messageId ?? 'title'}`}>
          <button onClick={() => openConversation(h.projectId, h.conversation)}><strong>{h.conversation.title}</strong> <small>{h.projectName}{h.projectArchived ? ' (archived)' : ''} · {when(h.time)}</small>{h.excerpt ? <span className={o.excerpt}>{h.excerpt}</span> : null}</button>
        </li>)}</ul>
        {more ? <button disabled={searching} onClick={() => runSearch(hits.length)}>Show more results</button> : null}
      </> : <p className={s.muted}>Nothing found for “{query.trim()}”.</p> : null}
    </> : null}

    {api.getGlobalUsage ? <>
      <h2 className={o.h}>Usage</h2>
      {!usage ? <div><button onClick={loadUsage}>Show usage</button></div> : <UsageTables usage={usage}/>}
      {usageError ? <p className={s.error} role="alert">{usageError}</p> : null}
    </> : null}
  </section>;
}

const kt = (r: UsageRow) => `${Math.round(r.billableKTok * 10) / 10}`;
function UsageTables({ usage }: { usage: GlobalUsage }) {
  const cost = (r: UsageRow) => (r.costUsd === undefined ? '–' : `$${r.costUsd.toFixed(2)}`);
  const table = (label: string, first: string, rows: Array<UsageRow & { key: string; name: string }>) => <table className={o.table} aria-label={label}>
    <thead><tr><th scope="col">{first}</th><th scope="col">Runs</th><th scope="col">Failed</th><th scope="col">k-tokens</th><th scope="col">Minutes</th><th scope="col">Reported cost</th></tr></thead>
    <tbody>{rows.map(r => <tr key={r.key}><th scope="row">{r.name}</th><td>{r.runs}</td><td>{r.failedRuns}</td><td>{kt(r)}</td><td>{Math.round(r.minutes)}</td><td>{cost(r)}</td></tr>)}</tbody>
  </table>;
  return <div aria-label="Usage">
    <p className={o.estimate} role="note">Estimate: {usage.notes[0]}</p>
    <p>Last 8 days, all projects: {plural(usage.total.runs, 'run')}, about {kt(usage.total)} k-tokens, {Math.round(usage.total.minutes)} agent-minutes. Older runs: {plural(usage.lifetime.runs, 'run')}.</p>
    {table('Usage per CLI', 'CLI', usage.byCli.map(r => ({ ...r, key: r.cli, name: r.cli })))}
    {table('Usage per project', 'Project', usage.byProject.map(r => ({ ...r, key: r.projectId, name: r.projectName ?? (r.removed ? 'Removed project' : r.projectId) })))}
    {usage.notes.slice(1).map(n => <p key={n} className={s.muted}>{n}</p>)}
  </div>;
}
