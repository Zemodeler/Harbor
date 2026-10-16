import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Conversation } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import { Brand } from './Brand';
import { Modal } from './Modal';
import { ProjectSettings } from './ProjectSettings';
import { initials } from './projectIcon';
import { sessionStatus } from '../session';
import { SessionStatus } from './SessionStatus';
import { CloseIcon, MoreIcon, PlusIcon, SearchIcon, SettingsIcon } from './Icons';
import { tagCounts } from '../conversationMeta';
import s from '../Harbor.module.css';
import n from './Navigation.module.css';

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Arrow keys move between conversations (Home/End to the ends); Tab still reaches each row's menu and delete button. */
function listKeys(e: ReactKeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || !(e.target as HTMLElement).matches?.('[data-conversation-link]')) return;
  const links = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-conversation-link]')];
  const at = links.indexOf(e.target as HTMLButtonElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? links.length - 1 : Math.max(0, Math.min(links.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
  e.preventDefault(); links[next]?.focus();
}

export function Sidebar({ state, settings, add, close, search, history, rename, queuedFor, forget, tags, editTags, archivedOpen, setArchivedOpen }: { state: HarborState; settings: () => void; add: () => void; close: () => void; search: () => void; history: () => void; rename: (c: Conversation) => void; queuedFor?: (conversationId: string) => number; forget?: (conversationId: string) => void; tags?: Record<string, string[]>; editTags?: (c: Conversation) => void; archivedOpen?: boolean; setArchivedOpen?: (open: boolean) => void }) {
  const [tagFilter, setTagFilter] = useState<string>();
  const [deleting, setDeleting] = useState<Conversation>();
  const [deletePending, setDeletePending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  // Escape or a click elsewhere closes an open conversation menu; Escape returns focus to its button.
  useEffect(() => {
    const open = () => [...list.current?.querySelectorAll<HTMLDetailsElement>('details[open]') ?? []];
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const menus = open();
      if (!menus.length) return;
      menus.forEach(d => { d.removeAttribute('open'); d.querySelector('summary')?.focus(); });
    };
    const click = (e: PointerEvent) => open().forEach(d => { if (!d.contains(e.target as Node)) d.removeAttribute('open'); });
    document.addEventListener('keydown', key); document.addEventListener('pointerdown', click);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', click); };
  }, []);
  const project = state.projects.find(p => p.id === state.projectId);
  const roleOf = (c: Conversation) => state.agents.find(a => a.id === c.agentId)?.role;
  // Subagent conversations are reached from the chat with the main agent, not from here.
  const allMains = state.conversations.filter(c => roleOf(c) === undefined || roleOf(c) === 'main');
  const tagsOf = (c: Conversation) => tags?.[c.id] || [];
  const mainIds = allMains.map(c => c.id).join('\n');
  const projectTags = useMemo(() => tagCounts(tags || {}, mainIds.split('\n')).slice(0, 10), [tags, mainIds]);
  const activeFilter = tagFilter && projectTags.some(t => t.tag === tagFilter) ? tagFilter : undefined;
  const mains = allMains.filter(c => !c.archived && (!activeFilter || tagsOf(c).includes(activeFilter)));
  const archived = allMains.filter(c => c.archived && (!activeFilter || tagsOf(c).includes(activeFilter)));
  const viewing = state.agents.find(a => a.id === state.conversation?.agentId);
  const activeAgentId = viewing && viewing.role !== 'main' ? viewing.parentId : viewing?.id;
  // From a subagent's chat, keep its main conversation marked (when that is unambiguous).
  const owners = mains.filter(c => c.agentId === activeAgentId);
  const isActive = (c: Conversation) => c.id === state.conversation?.id || (viewing?.role !== 'main' && owners.length === 1 && owners[0].id === c.id);
  // The main agent is shared by every conversation of a project, so a conversation counts as running only when its own subagents are, or when it is the one open.
  const isBusy = (c: Conversation) => ['working', 'queued', 'waiting'].includes(sessionStatus(c, state.agents, state.sending)) || (queuedFor?.(c.id) ?? 0) > 0;
  const isWorking = (c: Conversation) => ['working', 'queued'].includes(sessionStatus(c, state.agents, state.sending));
  const running = mains.find(c => isActive(c) && isWorking(c));
  const runningAgent = state.agents.find(a => a.id === running?.agentId);
  const today = startOfToday();
  const groups = [{ label: 'Pinned', items: mains.filter(c => c.pinned) }, { label: 'Today', items: mains.filter(c => !c.pinned && c.updated >= today) }, { label: 'Earlier', items: mains.filter(c => !c.pinned && c.updated < today) }, ...(archivedOpen ? [{ label: 'Archived', items: archived }] : [])].filter(g => g.items.length);
  return <nav aria-label="Projects and conversations" className={s.sidebar}>
    <div className={s.rail}>
      <Brand compact/>
      {state.projects.map(p => <button key={p.id} className={`${s.chip} ${state.projectId === p.id ? s.chipOn : ''}`} aria-label={p.name} aria-pressed={state.projectId === p.id} title={`${p.name}\n${p.path}`} onClick={() => { void state.selectProject(p.id); close(); }}>{p.image ? <img className={s.chipImg} src={p.image} alt=""/> : initials(p.name)}</button>)}
      <button className={s.chip} aria-label="Add project" title="Add project" onClick={add}><PlusIcon size={19} aria-hidden="true"/></button>
      <span className={s.railSpace}/>
      <button className={s.chip} aria-label="Open settings" title="Settings" onClick={settings}><SettingsIcon size={19} aria-hidden="true"/></button>
      <button className={s.mobileClose} onClick={close} aria-label="Close project menu"><CloseIcon size={18} aria-hidden="true"/></button>
    </div>
    <div className={s.panel}>
      {state.loading ? <p role="status" className={s.muted}>Loading projects…</p> : null}
      {project ? <>
        <div className={s.projectHead}>
          <span className={s.projectAvatar} aria-hidden="true">{project.image ? <img src={project.image} alt=""/> : initials(project.name)}</span>
          <div className={s.projectHeadText}><h2 className={s.panelTitle} title={project.path}>{project.name}</h2><p className={s.panelSub}>{mains.length === 1 ? '1 conversation' : `${mains.length} conversations`}</p></div>
          <button className={s.projectGear} aria-label="Project options" title="Project options" onClick={() => setSettingsOpen(true)}><SettingsIcon size={18} aria-hidden="true"/></button>
        </div>
        <button className={s.sidebarSearch} onClick={search}><SearchIcon size={16} aria-hidden="true"/> Search <kbd>Ctrl K</kbd></button>
        {runningAgent && running ? <div className={s.live} role="status"><SessionStatus status={sessionStatus(running, state.agents, state.sending)}/><button className={s.stopLink} aria-label={`Stop ${runningAgent.title}`} onClick={() => { void state.stopConversation(running.id); }}>Stop</button></div> : null}
        <button className={s.newConversation} onClick={() => { void state.newConversation(); close(); }}>New conversation</button>
        {state.projectLoading ? <div className={s.skeletonList} role="status"><span className={s.srOnly}>Loading conversations…</span>{[0, 1, 2].map(i => <span key={i} className={s.skeletonRow} aria-hidden="true"/>)}</div> : null}
        {projectTags.length ? <div className={n.tagFilter} role="group" aria-label="Filter by tag">{projectTags.map(({ tag, count }) => <button key={tag} aria-pressed={activeFilter === tag} title={`${count} conversation${count === 1 ? '' : 's'}`} onClick={() => setTagFilter(activeFilter === tag ? undefined : tag)}>#{tag}</button>)}</div> : null}
        <div className={s.conversationList} ref={list} onKeyDown={listKeys}>
          {groups.map(g => <div key={g.label}><p className={s.group}>{g.label}</p>
            {g.items.map(c => <div key={c.id} className={s.conversationRow}>
              <button data-conversation-link className={`${s.conversationLink} ${isActive(c) ? s.selected : ''}`} aria-current={isActive(c) ? 'page' : undefined} onClick={() => { void state.selectConversation(c); close(); }}><span className={s.conversationText}><span className={s.conversationTitle}>{c.title}</span>{c.imported ? <small className={s.muted} title={`Imported from ${c.imported.label}: read-only history`}>imported</small> : null}{sessionStatus(c, state.agents, state.sending) !== 'idle' ? <SessionStatus status={sessionStatus(c, state.agents, state.sending)}/> : null}{tagsOf(c).length ? <span className={n.tags}>{tagsOf(c).map(t => <span key={t} className={n.tag}><span className={n.visuallyHidden}>tag </span>#{t}</span>)}</span> : null}</span></button>
              <details className={s.conversationMenu}><summary aria-label={`Options for ${c.title}`} title="Conversation options"><MoreIcon size={20} aria-hidden="true"/></summary><div className={s.conversationMenuItems}>
                <button onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); void state.updateConversation(c, { pinned: !c.pinned }); }}>{c.pinned ? 'Unpin' : 'Pin conversation'}</button>
                <button onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); rename(c); }}>Rename</button>
                {editTags ? <button onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); editTags(c); }}>Edit tags</button> : null}
                {c.archived ? <button onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); void state.updateConversation(c, { archived: false }); }}>Restore</button>
                  : <button disabled={['working', 'queued', 'waiting'].includes(sessionStatus(c, state.agents, state.sending))} onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); void state.updateConversation(c, { archived: true }); }}>Archive</button>}
                <button className={s.menuDelete} aria-label={`Delete conversation ${c.title}`} disabled={isBusy(c)} title={isBusy(c) ? 'Stop this session or clear its queue before deleting it' : 'Delete conversation'} onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); setDeleting(c); }}>Delete…</button>
              </div></details>
            </div>)}
          </div>)}
          {activeFilter && !groups.length ? <p className={s.panelSub}>No conversation has #{activeFilter}.</p> : null}
        </div>
        {setArchivedOpen && archived.length ? <button className={n.archivedToggle} aria-expanded={!!archivedOpen} onClick={() => setArchivedOpen(!archivedOpen)}>{archivedOpen ? 'Hide archived' : `Show archived (${archived.length})`}</button> : null}
      </> : !state.loading ? <p className={s.muted}>Your projects will appear here.</p> : null}
      {deleting ? <Modal title="Delete conversation?" close={() => { setDeleting(undefined); state.clearError('delete'); }} dismissible={!deletePending}>
        <p>Delete “{deleting.title}”? Its messages will be removed. This cannot be undone.</p>
        {(queuedFor?.(deleting.id) ?? 0) > 0 ? <p className={s.muted}>It has queued follow-ups; clear them first.</p> : null}
        {state.areaErrors.delete ? <p className={s.error} role="alert">{state.areaErrors.delete}</p> : null}
        <div className={s.actions}><button disabled={deletePending} onClick={() => { setDeleting(undefined); state.clearError('delete'); }}>Keep conversation</button><button className={s.primary} disabled={deletePending || isBusy(deleting)} onClick={() => { const c = deleting; setDeletePending(true); void state.deleteConversation(c, 'delete').then(ok => { if (ok) { forget?.(c.id); setDeleting(undefined); } }).finally(() => setDeletePending(false)); }}>{deletePending ? 'Deleting…' : 'Delete'}</button></div>
      </Modal> : null}
      {project && settingsOpen ? <ProjectSettings state={state} project={project} close={() => setSettingsOpen(false)}/> : null}
      <div className={s.panelFoot}><button className={s.historyButton} onClick={history}>Conversation history</button><small>Local workspace{document.documentElement.dataset.demo ? ' · Demo' : ''}</small></div>
    </div>
  </nav>;
}
