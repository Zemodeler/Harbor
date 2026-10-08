import { useEffect, useRef, useState } from 'react';
import { useHarbor } from './hooks/useHarbor';
import { Sidebar } from './components/Sidebar';
import { Conversation } from './components/Conversation';
import { Settings } from './components/Settings';
import { Modal } from './components/Modal';
import s from './Harbor.module.css';

export default function App() {
  const state = useHarbor();
  const [view, setView] = useState<'conversation' | 'settings'>('conversation');
  const [dialog, setDialog] = useState<'switch' | 'add' | 'remove'>();
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState('');
  const [path, setPath] = useState('');
  const [pending, setPending] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const project = state.projects.find(p => p.id === state.projectId);
  const agent = state.agents.find(a => a.id === state.conversation?.agentId);
  const activeAgents = state.agents.filter(a => a.id === state.conversation?.agentId || a.parentId === state.conversation?.agentId);
  const status = activeAgents.some(a => a.state === 'failed') ? 'Needs attention' : activeAgents.some(a => ['working', 'queued'].includes(a.state)) ? 'Working' : activeAgents.some(a => a.role !== 'main' && a.state === 'waiting') ? 'Needs input' : activeAgents.length && activeAgents.every(a => a.state === 'done') ? 'Ready to review' : 'Ready';
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!state.permissions.length) { setQuery(''); setDialog('switch'); } }
      if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); if (!dialog && !state.permissions.length) { setView('conversation'); void state.newConversation(); } }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [state.newConversation, dialog, state.permissions.length]);
  async function add(native: boolean) {
    setPending(true); const added = await state.addProject(native ? undefined : path); setPending(false); if (added) { setDialog(undefined); setView('conversation'); }
  }
  // Go straight to the native folder picker; failures show in the error banner.
  async function openProject() {
    setMenu(false); setDialog(undefined);
    if (await state.addProject(undefined)) setView('conversation');
  }
  const permission = state.permissions[0];
  return <div className={s.app}>
    <div className={s.desktopSidebar}><Sidebar state={state} add={openProject} settings={() => setView('settings')} close={() => setView('conversation')}/></div>
    <main className={s.workspace}>
      <header className={s.header}><button ref={menuTrigger} className={s.mobileMenu} aria-label="Open project menu" aria-expanded={menu} onClick={() => setMenu(true)}>☰</button>
        <div className={s.headerTitle}><small>{view === 'settings' ? 'Harbor / Settings' : `${project?.name || 'Harbor'} / ${agent?.title || 'Main agent'}`}</small><h1>{view === 'settings' ? 'Connections & preferences' : state.conversation?.title || project?.name || 'Your workspace'}</h1></div>
        <div className={s.headerActions}>{view === 'settings' ? <button onClick={() => setView('conversation')}>Back to conversation</button> : <><span className={s.taskStatus}>{status}</span>{agent && agent.role !== 'main' ? <button onClick={() => void state.openAgent(agent.parentId || '')}>Back to main</button> : null}<button onClick={() => setView('settings')} aria-label="Open settings">Settings</button></>}</div>
      </header>
      {state.error ? <div className={s.error} role="alert"><span>{state.error}</span><button onClick={() => void state.reload()}>Reload workspace</button></div> : null}
      {!state.loading && !state.clis.some(c => c.installed && c.signedIn && c.authState !== 'unknown' && state.settings?.cliOverrides[c.id]?.enabled !== false) ? <div className={s.notice}>No connection is ready. Enable or sign in to an installed CLI.<button onClick={() => setView('settings')}>View connections</button></div> : null}
      {state.loading ? <div className={s.empty} role="status">Opening your workspace…</div> : view === 'settings' ? <Settings state={state}/> : <Conversation state={state} openProject={openProject}/>}
    </main>
    {menu && !dialog && !permission ? <Modal title="Projects" close={() => { setMenu(false); menuTrigger.current?.focus(); }}><Sidebar state={state} add={openProject} settings={() => { setMenu(false); setView('settings'); }} close={() => { setMenu(false); setView('conversation'); menuTrigger.current?.focus(); }}/></Modal> : null}
    {dialog && !permission ? <Modal title={dialog === 'switch' ? 'Switch project' : dialog === 'remove' ? 'Remove project entry?' : 'Open a project'} close={() => setDialog(undefined)}>
      {dialog === 'switch' ? <><input autoFocus className={s.search} aria-label="Find a project" placeholder="Find a project…" value={query} onChange={e => setQuery(e.target.value)}/><div className={s.switchList}>{state.projects.filter(p => p.name.toLowerCase().includes(query.toLowerCase())).map(p => <button key={p.id} onClick={() => { void state.selectProject(p.id); setDialog(undefined); setView('conversation'); }}>{p.name}<small>{p.path}</small></button>)}</div>{!state.projects.filter(p => p.name.toLowerCase().includes(query.toLowerCase())).length ? <p>No matching projects.</p> : null}<button onClick={openProject}>Open another project</button>{project ? <button onClick={() => setDialog('remove')}>Remove {project.name} entry…</button> : null}</> : dialog === 'add' ? <><p>Choose a local folder for your project.</p><label className={s.field}>Project folder<input autoFocus value={path} placeholder="C:\Projects\My project" onChange={e => setPath(e.target.value)}/></label><div className={s.actions}><button disabled={pending} onClick={() => void add(true)}>Browse folders…</button><button disabled={pending || !path.trim()} className={s.primary} onClick={() => void add(false)}>{pending ? 'Opening…' : 'Open project'}</button></div></> : <><p>Remove {project?.name} from Harbor? Local project files remain on disk.</p><div className={s.actions}><button onClick={() => setDialog(undefined)}>Keep project</button><button disabled={pending} onClick={() => { if (!project) return; setPending(true); void state.run(async () => { await state.api.removeProject(project.id); await state.reload(); setDialog(undefined); }).finally(() => setPending(false)); }}>Remove entry</button></div></>}
      {state.error ? <p role="alert">{state.error}</p> : null}
    </Modal> : null}
    {permission ? <Modal title={permission.kind === 'freeReset' ? 'Approve optional free reset?' : permission.kind === 'conflict' ? 'Resolve a conflict' : 'Tool permission required'} dismissible={false} close={() => {}}><p>{permission.prompt}</p><small>{state.agents.find(a => a.id === permission.agentId)?.title || 'Project agent'} · {state.permissions.length} pending</small><div className={s.actions}><button autoFocus disabled={pending} onClick={() => { setPending(true); void state.answerPermission(permission.requestId, false).finally(() => setPending(false)); }}>Deny</button><button className={s.primary} disabled={pending} onClick={() => { setPending(true); void state.answerPermission(permission.requestId, true).finally(() => setPending(false)); }}>Approve</button></div>{state.error ? <p role="alert">{state.error}</p> : null}</Modal> : null}
  </div>;
}
