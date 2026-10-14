import { useEffect, useRef, useState } from 'react';
import type { SearchHit } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import { SearchIcon } from './Icons';
import s from '../Harbor.module.css';

export function CommandMenu({ state, history, close, settings, add, review, activity, git, openFile, openPath }: { state: HarborState; history?: boolean; close: () => void; settings: () => void; add: () => void; review: () => void; activity: () => void; git?: () => void; openFile?: () => void; openPath?: (path: string) => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const results = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    setError(''); setLoading(!!query.trim()); setHits([]);
    const timer = setTimeout(() => {
      if (!query.trim()) return;
      void state.api.searchConversations(query, history ? state.projectId : undefined).then(result => { if (active) setHits(result); }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'Search failed.'); }).finally(() => { if (active) setLoading(false); });
    }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [state.api, state.projectId, query, history, retry]);
  const projects = state.projects.filter(p => p.name.toLowerCase().includes(query.toLowerCase()));
  const conversations: SearchHit[] = query.trim() ? hits : history ? state.conversations.map(c => ({ conversation: c, projectName: state.projects.find(p => p.id === c.projectId)?.name || '' })) : [];
  const execute = (action: () => void) => { close(); action(); };
  // A typed path (with a folder separator or a file extension) can be opened directly; main checks it like any other path.
  const typedPath = openPath && /^\S.*(?:[\\/].*|\.[A-Za-z0-9]{1,8})$/.test(query.trim()) && query.trim().length <= 400 ? query.trim() : undefined;
  return <div ref={results} onKeyDown={e => {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const buttons = Array.from(results.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([hidden])') || []);
    if (!buttons.length) return;
    e.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(current + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
  }}>
    <div className={s.searchBox}><SearchIcon size={18} aria-hidden="true"/><input autoFocus className={s.search} aria-label={history ? 'Search conversation history' : 'Find a project'} placeholder={history ? 'Search titles and messages…' : 'Search projects, conversations and commands…'} value={query} onChange={e => setQuery(e.target.value)}/></div>
    {!history ? <div className={s.commandActions}>
      <button hidden={!'new conversation'.includes(query.toLowerCase())} disabled={!state.projectId} onClick={() => execute(() => void state.newConversation())}>New conversation <kbd>Ctrl N</kbd></button>
      <button hidden={!'open a project'.includes(query.toLowerCase())} onClick={() => execute(add)}>Open a project</button>
      {openFile ? <button hidden={!'open file in viewer'.includes(query.toLowerCase())} onClick={() => execute(openFile)}>Open file…</button> : null}
      {typedPath ? <button onClick={() => execute(() => openPath!(typedPath))}>Open “{typedPath}” in the viewer</button> : null}
      <button hidden={!'open settings'.includes(query.toLowerCase())} onClick={() => execute(settings)}>Open Settings</button>
      <button hidden={!'session information'.includes(query.toLowerCase())} disabled={!state.conversation} onClick={() => execute(activity)}>Session information</button>
      <button hidden={!'review changes'.includes(query.toLowerCase())} disabled={!state.conversation} onClick={() => execute(review)}>Review changes</button>
      {git ? <button hidden={!'git branches and changes'.includes(query.toLowerCase())} disabled={!state.projectId} onClick={() => execute(git)}>Git branches and changes</button> : null}
      <button hidden={!'open project folder'.includes(query.toLowerCase())} disabled={!state.projectId} onClick={() => execute(() => void state.run(() => state.api.openProjectFolder(state.projectId)))}>Open project folder</button>
      {state.api.openWorkspace ? <>
        <button hidden={!'open terminal here'.includes(query.toLowerCase())} disabled={!state.projectId} onClick={() => execute(() => void state.run(() => state.api.openWorkspace!(state.projectId, 'terminal')))}>Open terminal here</button>
        <button hidden={!'open in editor'.includes(query.toLowerCase())} disabled={!state.projectId} onClick={() => execute(() => void state.run(() => state.api.openWorkspace!(state.projectId, 'editor')))}>Open in editor</button>
      </> : null}
    </div> : null}
    {!history && projects.length ? <><h3 className={s.resultHeading}>Projects</h3><div className={s.switchList}>{projects.map(p => <button key={p.id} onClick={() => execute(() => void state.selectProject(p.id))}>{p.name}<small>{p.path}</small></button>)}</div></> : null}
    {(history || query) ? <><h3 className={s.resultHeading}>{history ? 'Conversation history' : 'Conversations'}</h3>
      {loading ? <p role="status">Searching messages…</p> : error ? <p role="alert">{error} <button onClick={() => setRetry(n => n + 1)}>Retry search</button></p> : <div className={s.switchList}>{conversations.map(hit => <button key={hit.conversation.id} onClick={() => execute(() => void state.openConversation(hit.conversation))}>{hit.conversation.title}<small>{hit.projectName}{hit.conversation.archived ? ' · Archived' : ''}{hit.conversation.pinned ? ' · Pinned' : ''}</small>{'excerpt' in hit && hit.excerpt ? <span className={s.searchExcerpt}>{hit.excerpt}</span> : null}</button>)}</div>}
      {!loading && !error && !conversations.length ? <p className={s.muted}>No matching conversations.</p> : null}
    </> : null}
  </div>;
}
