import { useEffect, useRef, useState } from 'react';
import { useHarbor } from './hooks/useHarbor';
import { useAppearance } from './hooks/useAppearance';
import type { Appearance } from './appearance';
import { useWorkspace } from './hooks/useWorkspace';
import type { Conversation as ConversationRecord } from '../shared/api';
import { CommandMenu } from './components/CommandMenu';
import { SessionPanel } from './components/SessionPanel';
import { ReviewPanel } from './components/ReviewPanel';
import { GitPanel } from './components/GitPanel';
import { SessionStatus } from './components/SessionStatus';
import { sessionStatus } from './session';
import { MenuIcon, PanelIcon } from './components/Icons';
import { Sidebar } from './components/Sidebar';
import { Conversation } from './components/Conversation';
import { Settings } from './components/Settings';
import { Modal } from './components/Modal';
import { QuestionDialog } from './components/Question';
import { AgentDock, LiveActivity, MissionBoard, WorkspaceSummary } from './components/WorkspaceModes';
import s from './Harbor.module.css';

export default function App() {
  const state = useHarbor();
  const appearance = useAppearance();
  const workspace = useWorkspace();
  const [panel, setPanel] = useState<'activity' | 'review'>();
  const [activityHidden, setActivityHidden] = useState(false);
  const [missionFull, setMissionFull] = useState(false);
  const [wide, setWide] = useState(() => window.innerWidth >= 1180);
  const [renaming, setRenaming] = useState<ConversationRecord>();
  const [newTitle, setNewTitle] = useState('');
  const [view, setView] = useState<'conversation' | 'settings' | 'git'>('conversation');
  const [dialog, setDialog] = useState<'switch' | 'history' | 'add' | 'remove'>();
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState('');
  const [path, setPath] = useState('');
  const [pending, setPending] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const project = state.projects.find(p => p.id === state.projectId);
  const agent = state.agents.find(a => a.id === state.conversation?.agentId);
  const status = sessionStatus(state.conversation, state.agents, state.sending);
  const layout = appearance.appearance.layout;
  const visiblePanel = panel || (layout === 'command' && wide && !activityHidden && state.conversation ? 'activity' : undefined);
  const showBoard = layout === 'mission' && !missionFull;
  function changeAppearance(patch: Partial<Appearance>) {
    if (patch.layout && patch.layout !== layout) {
      setMissionFull(false); setPanel(undefined); setActivityHidden(false);
    }
    appearance.updateAppearance(patch);
  }
  function closePanel() { setPanel(undefined); setActivityHidden(true); }
  function toggleActivity() {
    if (visiblePanel === 'activity') closePanel();
    else { setPanel('activity'); setActivityHidden(false); }
  }
  useEffect(() => {
    const media = window.matchMedia?.('(min-width: 1180px)');
    const update = () => setWide(media?.matches ?? window.innerWidth >= 1180);
    media?.addEventListener('change', update);
    return () => media?.removeEventListener('change', update);
  }, []);
  function rename(c: ConversationRecord) { setRenaming(c); setNewTitle(c.title); setMenu(false); }
  function search(history = false) { setMenu(false); setDialog(history ? 'history' : 'switch'); }
  const sideProps = { state, add: openProject, settings: () => { setMenu(false); setView('settings'); }, close: () => { setMenu(false); setView('conversation'); }, search: () => search(), history: () => search(true), rename };
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
  const question = permission ? undefined : state.questions[0];
  return <div className={s.app} data-layout={layout}>
    <div className={s.desktopSidebar}><Sidebar {...sideProps}/></div>
    <main className={s.workspace}>
      <header className={s.header}><button ref={menuTrigger} className={s.mobileMenu} aria-label="Open project menu" aria-expanded={menu} onClick={() => setMenu(true)}><MenuIcon size={18} aria-hidden="true"/></button>
        <div className={s.headerTitle}><small>{view === 'settings' ? 'Harbor / Settings' : view === 'git' ? `${project?.name || 'Harbor'} / Git` : `${project?.name || 'Harbor'} / ${agent?.title || 'Main agent'}`}</small><h1>{view === 'settings' ? 'Connections & preferences' : view === 'git' ? 'Branches and changes' : state.conversation?.title || project?.name || 'Your workspace'}</h1></div>
        <div className={s.headerActions}>{view !== 'conversation' ? <button onClick={() => setView('conversation')}>Back to conversation</button> : <><SessionStatus status={status}/>{state.conversation?.mode === 'auto' ? <span className={s.autoBadge} title="Agents act without asking for permission in this conversation.">Auto mode · no permission prompts</span> : null}{agent && agent.role !== 'main' ? <button onClick={() => void state.openAgent(agent.parentId || '')}>Back to main</button> : null}{layout === 'mission' ? <button aria-pressed={showBoard} onClick={() => { setMissionFull(!missionFull); setPanel(undefined); }}>{showBoard ? 'Conversation view' : 'Show board'}</button> : null}<button className={s.sessionInfoButton} disabled={!state.conversation} aria-label="Session information" aria-expanded={visiblePanel === 'activity'} onClick={toggleActivity}><PanelIcon size={17} aria-hidden="true"/><span>{layout === 'command' ? 'Live activity' : 'Session info'}</span></button><button disabled={!state.projectId} onClick={() => setView('git')}>Git</button></>}</div>
      </header>
      {state.error ? <div className={s.error} role="alert"><span>{state.error}</span><button onClick={() => void state.reload()}>Reload workspace</button></div> : null}
      {!state.loading && !state.clis.some(c => c.installed && c.signedIn && c.authState !== 'unknown' && state.settings?.cliOverrides[c.id]?.enabled !== false) ? <div className={s.notice}>No connection is ready. Enable or sign in to an installed CLI.<button onClick={() => setView('settings')}>View connections</button></div> : null}
      {state.loading ? <div className={s.empty} role="status">Opening your workspace…</div> : view === 'settings' ? <Settings state={state} appearanceState={{ ...appearance, updateAppearance: changeAppearance }} workspace={workspace}/> : view === 'git' ? <GitPanel key={state.projectId} state={state} openAgent={id => { setView('conversation'); setMissionFull(true); void state.openAgent(id); }}/> : <>
        <WorkspaceSummary state={state} queued={state.conversation ? (workspace.preferences.queue[state.conversation.id] || []).length : 0} review={() => setPanel('review')}/>
        <div className={`${s.workbody} ${showBoard ? s.missionWorkbody : ''}`}>
          {showBoard ? <MissionBoard state={state} select={c => { void state.selectConversation(c); if (window.innerWidth < 1400) setMissionFull(true); }} openConversation={() => setMissionFull(true)}/> : null}
          <div className={s.conversationSurface} data-board-detail={showBoard || undefined}>
            {showBoard ? <div className={s.selectedTaskHeading}><small>Selected conversation</small><strong>{state.conversation?.title || 'Choose a conversation'}</strong></div> : null}
            <Conversation state={state} openProject={openProject} workspace={workspace} review={() => setPanel('review')} dock={layout === 'focus' ? <AgentDock state={state} expand={toggleActivity}/> : undefined} showCrew={layout !== 'focus' && !(layout === 'command' && wide && visiblePanel === 'activity')}/>
          </div>
          {visiblePanel && wide ? <aside className={`${s.infoPanel} ${visiblePanel === 'review' ? s.reviewPanel : ''}`} aria-label={visiblePanel === 'activity' ? 'Session information' : 'Change review'}>{visiblePanel === 'activity' ? layout === 'command' ? <LiveActivity state={state} close={closePanel} review={() => setPanel('review')}/> : <SessionPanel state={state} close={closePanel}/> : <ReviewPanel state={state} close={closePanel}/>}</aside> : null}
        </div>
      </>}
    </main>
    {menu && !dialog && !permission && !question ? <Modal title="Projects" close={() => { setMenu(false); menuTrigger.current?.focus(); }}><Sidebar {...sideProps}/></Modal> : null}
    {visiblePanel && !wide && view === 'conversation' && !permission && !question && !dialog && !renaming && !menu ? <Modal title={visiblePanel === 'activity' ? 'Session details' : 'Current changes'} close={closePanel}>{visiblePanel === 'activity' ? <SessionPanel state={state} close={closePanel}/> : <ReviewPanel state={state} close={closePanel}/>}</Modal> : null}
    {renaming && !permission && !question ? <Modal title="Rename conversation" close={() => setRenaming(undefined)}><form onSubmit={e => { e.preventDefault(); if (!newTitle.trim()) return; setPending(true); void state.updateConversation(renaming, { title: newTitle }).then(result => { if (result) setRenaming(undefined); }).finally(() => setPending(false)); }}><label className={s.field}>Conversation name<input autoFocus value={newTitle} maxLength={160} onChange={e => setNewTitle(e.target.value)}/></label><div className={s.actions}><button type="button" onClick={() => setRenaming(undefined)}>Cancel</button><button className={s.primary} disabled={pending || !newTitle.trim()}>Save name</button></div>{state.error ? <p role="alert">{state.error}</p> : null}</form></Modal> : null}
    {dialog && !permission && !question ? <Modal title={dialog === 'switch' ? 'Quick actions' : dialog === 'history' ? 'Conversation history' : dialog === 'remove' ? 'Remove project entry?' : 'Open a project'} close={() => setDialog(undefined)}>
      {dialog === 'switch' || dialog === 'history' ? <CommandMenu state={state} history={dialog === 'history'} close={() => { setDialog(undefined); setView('conversation'); }} settings={() => setView('settings')} add={openProject} review={() => setPanel('review')} activity={() => setPanel('activity')} git={() => setView('git')}/> : dialog === 'add' ? <><p>Choose a local folder for your project.</p><label className={s.field}>Project folder<input autoFocus value={path} placeholder="C:\Projects\My project" onChange={e => setPath(e.target.value)}/></label><div className={s.actions}><button disabled={pending} onClick={() => void add(true)}>Browse folders…</button><button disabled={pending || !path.trim()} className={s.primary} onClick={() => void add(false)}>{pending ? 'Opening…' : 'Open project'}</button></div></> : <><p>Remove {project?.name} from Harbor? Local project files remain on disk.</p><div className={s.actions}><button onClick={() => setDialog(undefined)}>Keep project</button><button disabled={pending} onClick={() => { if (!project) return; setPending(true); void state.run(async () => { await state.api.removeProject(project.id); await state.reload(); setDialog(undefined); }).finally(() => setPending(false)); }}>Remove entry</button></div></>}
      {state.error ? <p role="alert">{state.error}</p> : null}
    </Modal> : null}
    {question ? <QuestionDialog key={question.requestId} q={question} who={state.agents.find(a => a.id === question.agentId)?.title || 'Harbor'} pending={pending} error={state.error ?? undefined} dismiss={() => state.dismissQuestion(question.requestId)} answer={text => { setPending(true); void state.answerQuestion(question.requestId, text).finally(() => setPending(false)); }}/> : null}
    {permission ? <Modal title={permission.kind === 'freeReset' ? 'Approve optional free reset?' : permission.kind === 'conflict' ? 'Resolve a conflict' : 'Tool permission required'} dismissible={false} close={() => {}}><p>{permission.prompt}</p><small>{state.agents.find(a => a.id === permission.agentId)?.title || 'Project agent'} · {state.permissions.length} pending</small><div className={s.actions}><button autoFocus disabled={pending} onClick={() => { setPending(true); void state.answerPermission(permission.requestId, false).finally(() => setPending(false)); }}>Deny</button><button className={s.primary} disabled={pending} onClick={() => { setPending(true); void state.answerPermission(permission.requestId, true).finally(() => setPending(false)); }}>Approve</button></div>{state.error ? <p role="alert">{state.error}</p> : null}</Modal> : null}
  </div>;
}
