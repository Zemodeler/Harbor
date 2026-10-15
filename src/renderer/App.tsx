import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHarbor, type HarborState } from './hooks/useHarbor';
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
import { QuestionCard } from './components/Question';
import { PermissionRequests } from './components/PermissionRequests';
import { AgentDock, LiveActivity, MissionBoard, WorkspaceSummary } from './components/WorkspaceModes';
import { useDocuments } from './hooks/useDocuments';
import { DocumentLinks, type DocumentOpener } from './documents/DocumentLinks';
import { DocumentViewer } from './documents/DocumentViewer';
import s from './Harbor.module.css';
import dc from './documents/Documents.module.css';
import { Onboarding } from './components/Onboarding';
import { TagEditor } from './components/TagEditor';
import { Toasts } from './components/Toasts';
import { useConversationMeta } from './hooks/useConversationMeta';
import { useToasts } from './hooks/useToasts';
import { markOnboardingDone, onboardingDone, shouldOfferOnboarding } from './onboarding';
import { tagCounts } from './conversationMeta';
import { fillTemplate } from './slashCommands';
import n from './components/Navigation.module.css';

/** Subscribes to a media query so layout follows window resizes (a one-off innerWidth read goes stale). */
function useMedia(minWidth: number) {
  const query = `(min-width: ${minWidth}px)`;
  const read = () => window.matchMedia?.(query).matches ?? window.innerWidth >= minWidth;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    const update = () => setMatches(read());
    update();
    const media = window.matchMedia?.(query);
    if (media) { media.addEventListener('change', update); return () => media.removeEventListener('change', update); }
    window.addEventListener('resize', update); // no matchMedia: follow the window size instead
    return () => window.removeEventListener('resize', update);
  }, [query]);
  return matches;
}

/** Agent questions are cards, not dialogs: other dialogs and the composer stay usable and typed answers are kept. */
function QuestionCards({ state }: { state: HarborState }) {
  if (!state.questions.length) return null;
  return <div className={s.hqQuestions}>{state.questions.map(q => <QuestionCard key={q.requestId} q={q} who={state.agents.find(a => a.id === q.agentId)?.title || 'Harbor'} pending={!!state.questionPending[q.requestId]} error={state.questionErrors[q.requestId]} dismiss={() => state.dismissQuestion(q.requestId)} answer={text => void state.answerQuestion(q.requestId, text)}/>)}</div>;
}

export default function App() {
  const state = useHarbor();
  const appearance = useAppearance();
  const workspace = useWorkspace();
  const docs = useDocuments(state.api, state.projectId, state.conversation, state.agents, state.documentRequest);
  const opener = useMemo<DocumentOpener>(() => ({ open: (path, o) => docs.open(path, o) }), [docs.open]);
  const [dropping, setDropping] = useState(false);
  const meta = useConversationMeta();
  const toasts = useToasts(state);
  const [welcome, setWelcome] = useState(false);
  const [tagging, setTagging] = useState<ConversationRecord>();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [panel, setPanel] = useState<'activity' | 'review'>();
  const [activityHidden, setActivityHidden] = useState(false);
  const [missionFull, setMissionFull] = useState(false);
  const wide = useMedia(1180);
  const veryWide = useMedia(1400);
  const [renaming, setRenaming] = useState<ConversationRecord>();
  const [newTitle, setNewTitle] = useState('');
  const [view, setView] = useState<'conversation' | 'settings' | 'git'>('conversation');
  const [dialog, setDialog] = useState<'switch' | 'history' | 'add' | 'remove'>();
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState('');
  const [path, setPath] = useState('');
  const [pending, setPending] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const focusWorkspace = useCallback(() => (workspaceRef.current?.querySelector<HTMLElement>('textarea:not(:disabled)') || workspaceRef.current?.querySelector<HTMLElement>('h1'))?.focus(), []);
  const project = state.projects.find(p => p.id === state.projectId);
  const agent = state.agents.find(a => a.id === state.conversation?.agentId);
  const status = sessionStatus(state.conversation, state.agents, state.sending);
  const layout = appearance.appearance.layout;
  const visiblePanel = panel || (layout === 'command' && wide && !activityHidden && state.conversation ? 'activity' : undefined);
  const showBoard = layout === 'mission' && !missionFull;
  const showViewer = docs.tabs.length > 0 && !docs.hidden;
  // In the Mission Board layout the board fills the grid, so a docked viewer would land in a stray row: use the modal there.
  const viewerModal = showViewer && (!wide || view !== 'conversation' || showBoard) && !dialog && !renaming && !menu;
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
  // After a view change, move focus to the new view's heading so keyboard and screen reader users land in it.
  const shownView = useRef(view);
  useEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    workspaceRef.current?.querySelector<HTMLElement>('h1')?.focus();
  }, [view]);
  useEffect(() => { if (!dialog) state.clearError('dialog'); }, [dialog, state.clearError]);
  function rename(c: ConversationRecord) { setRenaming(c); setNewTitle(c.title); setMenu(false); }
  function search(history = false) { setMenu(false); setDialog(history ? 'history' : 'switch'); }
  const editTags = (c: ConversationRecord) => { setMenu(false); setTagging(c); };
  const forget = (id: string) => { workspace.forgetConversation(id); meta.forget(id); };
  const sideProps = { state, add: openProject, settings: () => { setMenu(false); setView('settings'); }, close: () => { setMenu(false); setView('conversation'); }, search: () => search(), history: () => search(true), rename, queuedFor: (id: string) => (workspace.preferences.queue[id] || []).length, forget, tags: meta.tags, editTags, archivedOpen, setArchivedOpen };
  // First run: offer the guide once Harbor has loaded with no projects (a start-up failure is not a first run).
  const offerWelcome = shouldOfferOnboarding({ loading: state.loading, startupError: state.startupError, projects: state.projects.length, done: onboardingDone() });
  useEffect(() => { if (offerWelcome) setWelcome(true); }, [offerWelcome]);
  function finishWelcome() { markOnboardingDone(); setWelcome(false); }
  /** Puts text into the open conversation's draft (the composer adopts it) and moves focus there. */
  function toDraft(change: (draft: string) => string) {
    const c = state.conversation;
    if (!c) return;
    setView('conversation');
    workspace.setDraft(c.id, change);
    setTimeout(focusWorkspace, 0);
  }
  const paletteActions = {
    settings: () => setView('settings'), add: openProject, review: () => setPanel('review'), activity: () => setPanel('activity'), git: () => setView('git'),
    rename, editTags, welcome: () => setWelcome(true), showArchived: () => { setView('conversation'); setArchivedOpen(true); },
    deep: () => toDraft(d => d.startsWith('/deep') ? d : `/deep ${d}`),
    insertPrompt: (text: string) => { const t = fillTemplate(text, { project: project?.name, conversation: state.conversation?.title }); toDraft(d => d ? `${d}\n\n${t}` : t); },
    setTheme: (mode: Appearance['mode']) => changeAppearance({ mode }),
    setLayout: (layout: Appearance['layout']) => changeAppearance({ layout }),
    openFile: docs.supported && state.projectId ? () => void docs.pick() : undefined,
    openPath: docs.supported && state.projectId ? (p: string) => docs.open(p) : undefined
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); setQuery(''); setDialog('switch'); }
      // Ctrl+Shift+F: search every message of this project's conversations.
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setDialog('history'); }
      if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); if (!dialog) { setView('conversation'); void state.newConversation(); } }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [state.newConversation, dialog]);
  // Drop a file anywhere to view it (images dropped on the message box still attach there: that handler marks the event handled).
  useEffect(() => {
    const files = (e: DragEvent) => !!e.dataTransfer?.types?.includes('Files');
    const over = (e: DragEvent) => { if (!files(e) || !state.projectId || !docs.supported) return; e.preventDefault(); setDropping(true); };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDropping(false); };
    const drop = (e: DragEvent) => {
      setDropping(false);
      if (e.defaultPrevented || !files(e) || !state.projectId || !docs.supported) return;
      e.preventDefault();
      for (const f of [...(e.dataTransfer?.files ?? [])].slice(0, 6)) {
        const path = state.api.pathForFile?.(f) || '';
        if (path) docs.open(path); else docs.report(f.name, 'This file has no local path (it was dropped from another app or a browser). Save it to disk first, or use Open file… in Ctrl+K.');
      }
    };
    window.addEventListener('dragover', over); window.addEventListener('dragleave', leave); window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); };
  }, [state.api, state.projectId, docs.supported, docs.open, docs.report]);
  async function add(native: boolean) {
    setPending(true); const added = await state.addProject(native ? undefined : path, 'dialog'); setPending(false); if (added) { setDialog(undefined); setView('conversation'); }
  }
  // Go straight to the native folder picker; failures show in the error banner.
  async function openProject() {
    setMenu(false); setDialog(undefined);
    if (await state.addProject(undefined)) setView('conversation');
  }
  return <DocumentLinks.Provider value={opener}><div className={s.app} data-layout={layout}>
    <a className={n.skipLink} href="#harbor-workspace" onClick={e => { e.preventDefault(); focusWorkspace(); }}>Skip to conversation</a>
    <div className={s.desktopSidebar}><Sidebar {...sideProps}/></div>
    <main className={s.workspace} ref={workspaceRef} id="harbor-workspace" aria-label="Workspace">
      <header className={s.header}><button ref={menuTrigger} className={s.mobileMenu} aria-label="Open project menu" aria-expanded={menu} onClick={() => setMenu(true)}><MenuIcon size={18} aria-hidden="true"/></button>
        <div className={s.headerTitle}><small>{view === 'settings' ? 'Harbor / Settings' : view === 'git' ? `${project?.name || 'Harbor'} / Git` : `${project?.name || 'Harbor'} / ${agent?.title || 'Main agent'}`}</small><h1 tabIndex={-1}>{view === 'settings' ? 'Connections & preferences' : view === 'git' ? 'Branches and changes' : state.conversation?.title || project?.name || 'Your workspace'}</h1></div>
        <div className={s.headerActions}>{view !== 'conversation' ? <button onClick={() => setView('conversation')}>Back to conversation</button> : <><SessionStatus status={status}/>{state.conversation?.mode === 'auto' ? <span className={s.autoBadge} title="Agents act without asking for permission in this conversation.">Auto mode · no permission prompts</span> : null}{agent && agent.role !== 'main' ? <button onClick={() => void state.openAgent(agent.parentId || '')}>Back to main</button> : null}{layout === 'mission' ? <button aria-pressed={showBoard} onClick={() => { setMissionFull(!missionFull); setPanel(undefined); }}>{showBoard ? 'Conversation view' : 'Show board'}</button> : null}<button className={s.sessionInfoButton} disabled={!state.conversation} aria-label="Session information" aria-expanded={visiblePanel === 'activity'} onClick={toggleActivity}><PanelIcon size={17} aria-hidden="true"/><span>{layout === 'command' ? 'Live activity' : 'Session info'}</span></button><button disabled={!state.projectId} onClick={() => setView('git')}>Git</button></>}</div>
      </header>
      {state.error ? <div className={s.error} role="alert"><span>{state.error}</span><span className={s.hqBannerActions}><button onClick={() => void state.reload()}>Reload workspace</button><button onClick={state.dismissError}>Dismiss</button></span></div> : null}
      {!state.loading && !state.clis.some(c => c.installed && c.signedIn && c.authState !== 'unknown' && state.settings?.cliOverrides[c.id]?.enabled !== false) ? <div className={s.notice}>No connection is ready. Enable or sign in to an installed CLI.<button onClick={() => setView('settings')}>View connections</button></div> : null}
      <QuestionCards state={state}/>
      <PermissionRequests state={state} fallbackFocus={focusWorkspace} openConversation={c => { setView('conversation'); setMissionFull(true); void state.selectConversation(c); }}/>
      {state.loading ? <div className={s.empty} role="status">Opening your workspace…</div> : state.startupError && !state.projects.length ? <div className={s.empty} role="alert"><h1 tabIndex={-1}>Harbor could not start</h1><p>{state.startupError}</p><button className={s.primary} onClick={() => void state.reload()}>Retry</button></div> : view === 'settings' ? <Settings state={state} appearanceState={{ ...appearance, updateAppearance: changeAppearance }} workspace={workspace} showConversation={() => setView('conversation')}/> : view === 'git' ? <GitPanel key={state.projectId} state={state} openAgent={id => { setView('conversation'); setMissionFull(true); void state.openAgent(id); }}/> : <>
        <WorkspaceSummary state={state} queued={state.conversation ? (workspace.preferences.queue[state.conversation.id] || []).length : 0} review={() => setPanel('review')}/>
        <div className={`${s.workbody} ${showBoard ? s.missionWorkbody : ''}`}>
          {showBoard ? <MissionBoard state={state} select={c => { void state.selectConversation(c); if (!veryWide) setMissionFull(true); }} openConversation={() => setMissionFull(true)}/> : null}
          <div className={s.conversationSurface} data-board-detail={showBoard || undefined}>
            {showBoard ? <div className={s.selectedTaskHeading}><small>Selected conversation</small><strong>{state.conversation?.title || 'Choose a conversation'}</strong></div> : null}
            <Conversation state={state} openProject={openProject} workspace={workspace} review={() => setPanel('review')} dock={layout === 'focus' ? <AgentDock state={state} expand={toggleActivity}/> : undefined} showCrew={layout !== 'focus' && !(layout === 'command' && wide && visiblePanel === 'activity')}/>
          </div>
          {showViewer && wide && view === 'conversation' && !showBoard ? <aside className={dc.viewerPane} aria-label="Documents"><DocumentViewer docs={docs} api={state.api} projectId={state.projectId} agentTitle={id => state.agents.find(a => a.id === id)?.title} close={docs.hide}/></aside> : null}
          {visiblePanel && wide ? <aside className={`${s.infoPanel} ${visiblePanel === 'review' ? s.reviewPanel : ''}`} aria-label={visiblePanel === 'activity' ? 'Session information' : 'Change review'}>{visiblePanel === 'activity' ? layout === 'command' ? <LiveActivity state={state} close={closePanel} review={() => setPanel('review')}/> : <SessionPanel state={state} close={closePanel}/> : <ReviewPanel state={state} close={closePanel}/>}</aside> : null}
        </div>
      </>}
    </main>
    {menu && !dialog ? <Modal title="Projects" close={() => { setMenu(false); menuTrigger.current?.focus(); }}><Sidebar {...sideProps}/></Modal> : null}
    {viewerModal ? <Modal title="Document viewer" close={docs.hide}><div className={dc.viewerModal}><DocumentViewer docs={docs} api={state.api} projectId={state.projectId} agentTitle={id => state.agents.find(a => a.id === id)?.title} close={docs.hide}/></div></Modal> : null}
    {dropping ? <div className={dc.dropHint} aria-hidden="true">Drop to open in Harbor's viewer</div> : null}
    {visiblePanel && !wide && view === 'conversation' && !dialog && !renaming && !menu && !viewerModal ? <Modal title={visiblePanel === 'activity' ? 'Session details' : 'Current changes'} close={closePanel}>{visiblePanel === 'activity' ? <SessionPanel state={state} close={closePanel}/> : <ReviewPanel state={state} close={closePanel}/>}</Modal> : null}
    {renaming ? <Modal title="Rename conversation" close={() => setRenaming(undefined)}><form onSubmit={e => { e.preventDefault(); if (!newTitle.trim()) return; setPending(true); void state.updateConversation(renaming, { title: newTitle }, 'dialog').then(result => { if (result) setRenaming(undefined); }).finally(() => setPending(false)); }}><label className={s.field}>Conversation name<input autoFocus value={newTitle} maxLength={160} onChange={e => setNewTitle(e.target.value)}/></label><div className={s.actions}><button type="button" onClick={() => setRenaming(undefined)}>Cancel</button><button className={s.primary} disabled={pending || !newTitle.trim()}>Save name</button></div>{state.areaErrors.dialog ? <p className={s.error} role="alert">{state.areaErrors.dialog}</p> : null}</form></Modal> : null}
    {dialog ? <Modal title={dialog === 'switch' ? 'Quick actions' : dialog === 'history' ? 'Conversation history' : dialog === 'remove' ? 'Remove project entry?' : 'Open a project'} close={() => setDialog(undefined)}>
      {dialog === 'switch' || dialog === 'history' ? <CommandMenu state={state} history={dialog === 'history'} close={() => { setDialog(undefined); setView('conversation'); }} actions={paletteActions} meta={meta} templates={workspace.preferences.templates}/> : dialog === 'add' ? <><p>Choose a local folder for your project.</p><label className={s.field}>Project folder<input autoFocus value={path} placeholder="C:\Projects\My project" onChange={e => setPath(e.target.value)}/></label><div className={s.actions}><button disabled={pending} onClick={() => void add(true)}>Browse folders…</button><button disabled={pending || !path.trim()} className={s.primary} onClick={() => void add(false)}>{pending ? 'Opening…' : 'Open project'}</button></div></> : <><p>Remove {project?.name} from Harbor? Local project files remain on disk.</p><div className={s.actions}><button onClick={() => setDialog(undefined)}>Keep project</button><button disabled={pending} onClick={() => { if (!project) return; setPending(true); void state.removeProject(project.id, 'dialog').then(ok => { if (ok) setDialog(undefined); }).finally(() => setPending(false)); }}>Remove entry</button></div></>}
      {state.areaErrors.dialog ? <p className={s.error} role="alert">{state.areaErrors.dialog}</p> : null}
    </Modal> : null}
    {tagging && !dialog ? <TagEditor conversation={tagging} tags={meta.tags[tagging.id] || []} known={tagCounts(meta.tags).map(t => t.tag)} save={tags => meta.setTags(tagging.id, tags)} close={() => setTagging(undefined)}/> : null}
    {welcome && !dialog && !tagging && !renaming ? <Onboarding state={state} finish={finishWelcome}/> : null}
    <Toasts toasts={toasts}/>
  </div></DocumentLinks.Provider>;
}
