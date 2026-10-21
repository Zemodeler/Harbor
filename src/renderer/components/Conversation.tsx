import { memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Agent, Attachment, Conversation as ConversationRecord, Message } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import { Brand } from './Brand';
import { Markdown } from './Markdown';
import { Tooltip } from './ui/Tooltip';
import { DocumentLinks } from '../documents/DocumentLinks';
import type { WorkspaceState } from '../hooks/useWorkspace';
import { sessionStatus } from '../session';
import { groupMessages, ToolActivity } from './ToolActivity';
import { AttachIcon, CloseIcon, ImageIcon, TemplateIcon } from './Icons';
import { RoutingDetails } from './RoutingDetails';
import { ModePicker } from './ModePicker';
import { HelperDetails } from './HelperDetails';
import { acceptFiles, acceptImages, classifyFile, IMAGE_TYPES, readFileAttachment, readImage, type PendingImage } from '../attachments';
import { applySlash, matchSlash, slashCommands, slashQuery, type SlashCommand } from '../slashCommands';
import { ImportedNotice } from './Transfer';
import s from '../Harbor.module.css';
import n from './Navigation.module.css';

/** Long conversations render only the latest groups; "Show earlier" widens the window. */
export const MESSAGE_WINDOW = 150;
/** The draft reaches shared state (and the whole app re-renders) only after typing pauses. */
export const DRAFT_PUSH_MS = 400;
/** A queued follow-up is held until Harbor shows the previous one started; this bounds the wait if no event ever comes. */
export const QUEUE_LOCK_MS = 20000;
const PEER_MESSAGE = /^(You told session|Message from session)\b/;
/** Sessions of one project can message each other (HARBOR_PEER); Harbor records those as system messages with these prefixes. */
export const isPeerMessage = (m: Pick<Message, 'role' | 'text'>) => m.role === 'system' && PEER_MESSAGE.test(m.text);
const dayLabel = (t: number) => { const d = new Date(t); return d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear() ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' }); };
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

interface SentImages { conversationId: string; at: number; names: string[]; previews: string[] }

/** One image of a message: shown at a readable size (no lazy loading: the stream follows new messages and a collapsed lazy image may never load), opens in the viewer when it has a stored file, and says so when it cannot be shown. */
function AttachmentThumb({ a, src, agentId }: { a: Attachment; src?: string; agentId?: string }) {
  const opener = useContext(DocumentLinks);
  const [failed, setFailed] = useState(false);
  const shown = src && !failed;
  const img = shown ? <img src={src} alt={a.origin === 'screenshot' ? `Screenshot: ${a.name}` : a.name} onError={() => setFailed(true)}/> : null;
  return <li className={shown ? s.hqImageItem : undefined}>
    {img && opener && a.path ? <button type="button" className={s.imageOpen} title="Open in Harbor's viewer" onClick={() => opener.open(a.path!, agentId ? { agentId } : undefined)}>{img}</button> : img}
    <span>{a.name}{src && failed ? ' (the image could not be loaded)' : ''}</span>
  </li>;
}

const MessageView = memo(function MessageView({ m, agentTitle, subAgentId, complexity, working, previewsFor, openAgent }: { m: Message; agentTitle?: string; subAgentId?: string; complexity?: 'low' | 'medium' | 'high'; working: boolean; previewsFor: (m: Message) => string[] | undefined; openAgent: (id: string) => void }) {
  const peer = isPeerMessage(m);
  const previews = m.attachments?.length ? previewsFor(m) : undefined;
  return <article className={`${s.message} ${m.role === 'user' ? s.user : s.assistant} ${peer ? s.hqPeer : ''}`} data-peer={peer || undefined}>
    <div className={s.byline}>{m.role === 'assistant' ? <Brand compact/> : null}<strong>{m.role === 'user' ? 'You' : m.role === 'assistant' ? (subAgentId ? <button className={s.agentName} title="Open this agent" onClick={() => openAgent(subAgentId)}>{agentTitle}</button> : agentTitle || 'Harbor') : peer ? 'Between sessions' : 'Activity'}</strong><time dateTime={new Date(m.time).toISOString()}>{new Date(m.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time></div>
    {m.text ? <Markdown text={m.text} agentId={m.agentId}/> : working ? <p>Working…</p> : null}
    {m.attachments?.length ? <ul className={s.messageImages} aria-label={m.attachments.some(a => a.origin === 'screenshot') ? 'Screenshot' : 'Attached images'}>{m.attachments.map((a, i) => {
      // Harbor serves its stored copies through harbor-file:// (main checks the path); a just-sent image may still use its local preview.
      const src = a.url?.startsWith('harbor-file://') ? a.url : previews?.[i];
      return <AttachmentThumb key={i} a={a} src={src} agentId={m.agentId}/>;
    })}</ul> : null}
    {m.details ? <details className={s.execution}><summary><span className={s.pill} data-tone="accent">{m.details.cli} · {m.details.model}</span><span>Execution details · why this model</span></summary><RoutingDetails details={m.details} complexity={complexity}/></details> : null}
  </article>;
});

export function Conversation({ state, openProject, workspace, review, dock, showCrew = true }: { state: HarborState; openProject: () => void; workspace: WorkspaceState; review: () => void; dock?: ReactNode; showCrew?: boolean }) {
  const stream = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const scrollAnchor = useRef<{ height: number; top: number }>(undefined);
  const sent = useRef<SentImages[]>([]);
  const [visible, setVisible] = useState(MESSAGE_WINDOW);
  const c = state.conversation;
  const agent = state.agents.find(a => a.id === c?.agentId);
  const project = state.projects.find(p => p.id === state.projectId);
  // Subagents only appear here, in the chat with the main agent, and only while they run: the user talks to the main
  // agent, which reports their results, so finished ones are dropped from the panel.
  const crew = agent?.role === 'main' ? state.agents.filter(a => a.parentId === agent.id && a.conversationId === c?.id && ['queued', 'working', 'waiting'].includes(a.state)) : [];
  // The main agent is shared by every conversation of a project and Harbor queues its turns, so its own state must not
  // lock the composer of other conversations; only this conversation's subagents (or the agent itself, if it is not main) count.
  const status = sessionStatus(c, state.agents, state.sending);
  const busy = ['working', 'queued'].includes(status);
  // Complexity is stored per session, so it is only shown on the latest routed reply.
  const latestRouted = useMemo(() => state.messages.filter(m => m.details).at(-1)?.id, [state.messages]);
  const groups = useMemo(() => groupMessages(state.messages), [state.messages]);
  const hidden = Math.max(0, groups.length - visible);
  const shown = hidden ? groups.slice(hidden) : groups;
  // Stable callbacks keep the memoised message views from re-rendering on unrelated updates.
  const openAgentRef = useRef(state.openAgent); openAgentRef.current = state.openAgent;
  const openAgent = useCallback((id: string) => void openAgentRef.current(id), []);
  const previewsFor = useCallback((m: Message) => {
    const names = m.attachments?.map(a => a.name) ?? [];
    const match = sent.current.filter(e => e.conversationId === m.conversationId && e.names.length === names.length && e.names.every((n, i) => n === names[i]) && Math.abs(e.at - m.time) < 120000)
      .sort((a, b) => Math.abs(a.at - m.time) - Math.abs(b.at - m.time))[0];
    return match?.previews;
  }, []);
  const rememberImages = useCallback((conversationId: string, images: PendingImage[]) => { sent.current = [...sent.current.slice(-19), { conversationId, at: Date.now(), names: images.map(i => i.name), previews: images.map(i => i.preview) }]; }, []);
  useEffect(() => { follow.current = true; setVisible(MESSAGE_WINDOW); }, [c?.id]);
  useEffect(() => { if (follow.current && stream.current) stream.current.scrollTop = stream.current.scrollHeight; }, [state.messages, c?.id]);
  // "Show earlier" adds content above the viewport: keep what the user was reading where it was.
  useLayoutEffect(() => {
    const el = stream.current, anchor = scrollAnchor.current;
    if (el && anchor) el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
    scrollAnchor.current = undefined;
  }, [visible]);
  function showEarlier() {
    const el = stream.current;
    if (el) { scrollAnchor.current = { height: el.scrollHeight, top: el.scrollTop }; follow.current = false; }
    setVisible(v => v + MESSAGE_WINDOW);
  }
  if (!project) return <div className={s.empty}><Brand/><h1 tabIndex={-1}>A home for your projects.</h1><p>Open a project, start a conversation, and let Harbor coordinate the work.</p><button className={s.primary} onClick={openProject}>Open a project</button></div>;
  if (!c) return <div className={s.empty}><h1 tabIndex={-1}>{project.name}</h1><p>{state.projectLoading ? 'Loading conversations…' : 'Start a conversation to begin working in this project.'}</p><button className={s.primary} disabled={state.projectLoading} onClick={() => void state.newConversation()}>New conversation</button></div>;
  let previousTime: number | undefined;
  return <>
    <div className={s.stream} ref={stream} onScroll={() => { const el = stream.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; }}>
      <div className={s.messageColumn}>
        {state.messagesLoading ? <p role="status">Loading conversation…</p> : state.messagesError ? <div className={s.hqLoadError} role="alert"><p>This conversation could not be loaded: {state.messagesError}</p><button onClick={() => void state.retryMessages()}>Retry</button></div> : !state.messages.length ? <div className={s.emptyConversation}><Brand/><h2>What shall we work on?</h2><p>Describe the next step for {project.name}, or start from one of these.</p><div className={s.starters}>{['Explain how this project is structured', 'Find and fix the failing tests', 'Review the current changes and list the risks'].map(t => <button key={t} className={s.starter} onClick={() => workspace.setDraft(c.id, d => d ? d : t)}>{t}</button>)}</div></div> : <>
          {hidden ? <button className={s.hqEarlier} onClick={showEarlier}>Show earlier messages ({hidden} more)</button> : null}
          {shown.map(group => {
            const m = group[0];
            const separator = previousTime === undefined || !sameDay(previousTime, m.time) ? <p className={s.date} key={`day-${m.id}`}><time dateTime={new Date(m.time).toISOString()}>{dayLabel(m.time)}</time></p> : null;
            previousTime = m.time;
            const owner = state.agents.find(a => a.id === m.agentId);
            return <div key={m.id} className={s.hqRow}>{separator}{m.role === 'tool' ? <ToolActivity messages={group}/> : <MessageView m={m} agentTitle={owner?.title} subAgentId={owner && owner.role !== 'main' ? owner.id : undefined} complexity={m.id === latestRouted ? c.activity?.complexity : undefined} working={busy && !m.text} previewsFor={previewsFor} openAgent={openAgent}/>}</div>;
          })}
        </>}
        {showCrew && crew.length ? <section className={s.crew} aria-label="Subagents"><h3>{crew.length === 1 ? '1 subagent' : `${crew.length} subagents`}</h3><div className={s.crewList}>{crew.map(a => <div key={a.id}><div className={s.crewCard}>
          <button className={s.crewOpen} onClick={() => void state.openAgent(a.id)}><span className={s.dot} data-state={a.state}/><span>{a.title}<small>{a.role} · {a.state} · {a.cli} / {a.model}</small></span></button>
          {['queued', 'working', 'waiting'].includes(a.state) ? <button className={s.stopLink} aria-label={`Stop ${a.title}`} onClick={() => void state.run(() => state.api.stopAgent(a.id, c.id))}>Stop</button> : null}
        </div><HelperDetails state={state} agent={a}/></div>)}</div></section> : null}
        {busy ? <div className={s.workingNotice} role="status"><span className={s.dot} data-state="working"/><span>Harbor is still working.<small>You can keep writing or queue your next message.</small></span></div> : null}
        {status === 'done' || crew.length ? <button className={`${s.reviewAction} ${status === 'done' ? s.primary : s.quiet}`} onClick={review}>Review current changes</button> : null}
      </div>
    </div>
    {c.imported ? <div className={s.composerArea}><ImportedNotice key={c.id} state={state} conversation={c}/></div> : <Composer key={c.id} state={state} workspace={workspace} c={c} agent={agent} projectName={project.name} status={status} busy={busy} dock={dock} rememberImages={rememberImages}/>}
  </>;
}

/**
 * The composer owns the draft while it is being typed: keystrokes re-render only this component. The text is pushed
 * to the shared (persisted) preferences after a pause, on every action that matters, and when the conversation
 * changes, so a draft is never lost.
 */
function Composer({ state, workspace, c, agent, projectName, status, busy, dock, rememberImages }: { state: HarborState; workspace: WorkspaceState; c: ConversationRecord; agent?: Agent; projectName: string; status: string; busy: boolean; dock?: ReactNode; rememberImages: (conversationId: string, images: PendingImage[]) => void }) {
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [attachmentError, setAttachmentError] = useState('');
  const [sendError, setSendError] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const [resumed, setResumed] = useState<string>();
  const [, setUnlock] = useState(0);
  const [slashActive, setSlashActive] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState<string>();
  const slashId = useId();
  const filePicker = useRef<HTMLInputElement>(null);
  const imagePicker = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const queueSending = useRef(false);
  const lock = useRef<{ conversation?: ConversationRecord; agents: Agent[]; activity?: number }>(undefined);
  const mounted = useRef(true);
  const ws = useRef(workspace); ws.current = workspace;
  const stored = workspace.preferences.drafts[c.id] || '';
  const [text, setText] = useState(stored);
  const latest = useRef(text), pushed = useRef(stored), dirty = useRef(false), timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const queue = workspace.preferences.queue[c.id] || [];
  const id = c.id;
  const push = (value: string) => { clearTimeout(timer.current); dirty.current = false; pushed.current = value; ws.current.setDraft(id, value); };
  const edit = (value: string, now = false) => {
    latest.current = value; setText(value);
    if (now) push(value);
    else { dirty.current = true; clearTimeout(timer.current); timer.current = setTimeout(() => push(latest.current), DRAFT_PUSH_MS); }
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(timer.current); if (dirty.current) ws.current.setDraft(id, latest.current); }; }, [id]);
  // A change made elsewhere (e.g. a failed send restoring its text) is adopted unless the user is typing.
  useEffect(() => { if (stored !== pushed.current && !dirty.current) { pushed.current = stored; latest.current = stored; setText(stored); } }, [stored]);
  useEffect(() => {
    if (textarea.current) { textarea.current.style.height = 'auto'; textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, window.innerHeight * .24)}px`; }
  }, [text]);
  // The queue is held until Harbor shows the previous follow-up started (a conversation or agent event, or new activity),
  // because the state may still read "idle" for a moment after a send resolved and the next one would burst out.
  useEffect(() => {
    if (!queue.length || busy || state.messagesLoading || state.permissions.length || ((status === 'failed' || status === 'stopped') && resumed !== c.id) || c.archived || queueSending.current || queue[0].paused) return;
    const held = lock.current;
    if (held) {
      if (state.conversation === held.conversation && state.agents === held.agents && state.lastActivity?.[c.id] === held.activity) return;
      lock.current = undefined;
    }
    const next = queue[0]; queueSending.current = true;
    const mine = { conversation: state.conversation, agents: state.agents, activity: state.lastActivity?.[c.id] };
    void state.send(next.text).then(ok => {
      if (ok) {
        lock.current = mine;
        setTimeout(() => { if (lock.current === mine) { lock.current = undefined; if (mounted.current) setUnlock(n => n + 1); } }, QUEUE_LOCK_MS);
        workspace.setQueue(c.id, items => items.filter(item => item.id !== next.id));
      } else { workspace.setQueue(c.id, items => items.map(item => ({ ...item, paused: true }))); if (mounted.current) setSendError('The follow-up was not sent. It is paused in your queue.'); }
    }).finally(() => { queueSending.current = false; });
  }, [c.id, c.archived, busy, state.messagesLoading, state.permissions.length, status, queue, resumed, state.conversation, state.agents, state.lastActivity, state.send, workspace.setQueue]);
  async function addImages(files: File[]) {
    if (!files.length) return;
    const { accepted, error } = acceptImages(images.length, files);
    setAttachmentError(error);
    // Reading is async: if the user switched conversations meanwhile, this composer is gone and the images are dropped.
    try { const read = await Promise.all(accepted.map(readImage)); if (mounted.current) setImages(prev => [...prev, ...read].slice(0, 6)); }
    catch { if (mounted.current) setAttachmentError('An image could not be read. Try another file.'); }
  }
  /** Mid-turn: skip the queue, cut the lead's turn short and act on this message now. Attached files go with it, as in a normal send. */
  function steer() {
    const draft = latest.current, sentImages = images;
    if ((!draft.trim() && !sentImages.length) || c.archived || state.messagesLoading) return;
    setSendError(''); setAttachmentError(''); edit('', true); setImages([]);
    if (sentImages.length) rememberImages(id, sentImages);
    void state.send(draft, sentImages.map(({ name, mime, dataBase64 }) => ({ name, mime, dataBase64 })), { steer: true }).then(ok => {
      if (ok) return;
      ws.current.setDraft(id, newer => newer || draft);
      if (!mounted.current) return;
      setImages(now => now.length ? now : sentImages); setSendError('Your message was kept. Retry when the connection is ready.');
    });
  }
  function send() {
    const draft = latest.current;
    if ((!draft.trim() && !images.length) || c.archived || state.messagesLoading) return;
    const body = draft, sentImages = images;
    setSendError('');
    // A pending question is waiting for exactly this text: send it now instead of queueing behind the helpers that still run.
    const answering = state.questions?.some(q => q.conversationId === c.id);
    const hold = busy && !answering;
    if (hold && sentImages.length) { setAttachmentError('Attachments can be sent when the session is idle. Remove them to queue this text.'); return; }
    if (hold) { workspace.setQueue(id, [...queue, { id: crypto.randomUUID(), text: body }]); edit('', true); return; }
    edit('', true); setImages([]); setAttachmentError('');
    if (sentImages.length) rememberImages(id, sentImages);
    void state.send(body, sentImages.map(({ name, mime, dataBase64 }) => ({ name, mime, dataBase64 }))).then(ok => {
      if (ok) return;
      ws.current.setDraft(id, newer => newer || body); // drafts are stored per conversation, so this is safe after a switch
      if (!mounted.current) return; // the composer now shows another conversation: keep its images and errors untouched
      setImages(now => now.length ? now : sentImages); setSendError('Your message was kept. Retry when the connection is ready.');
    });
  }
  /** Any non-image file becomes a real attachment: main saves it and the agent opens it with its own tools. */
  async function attachFiles(files: File[]) {
    const { accepted, error } = acceptFiles(images.length, files);
    setAttachmentError(error);
    try { const read = await Promise.all(accepted.map(readFileAttachment)); if (mounted.current) setImages(prev => [...prev, ...read].slice(0, 10)); }
    catch { if (mounted.current) setAttachmentError('A file could not be read. Try another one.'); }
  }
  /** Dropped, pasted or picked files: images get a preview, everything else is attached as is. */
  function addFiles(files: File[]) {
    const pics = files.filter(f => classifyFile(f) === 'image'), others = files.filter(f => classifyFile(f) !== 'image');
    if (pics.length) void addImages(pics);
    if (others.length) void attachFiles(others);
  }
  // Drop anywhere in the window (not only on the composer) and the files land in this conversation; the browser never opens them instead.
  const addFilesRef = useRef(addFiles); addFilesRef.current = addFiles;
  useEffect(() => {
    if (c.archived) return;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types?.includes('Files');
    const over = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); setDragging(true); };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDragging(false); };
    const drop = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); setDragging(false); const files = [...(e.dataTransfer?.files ?? [])]; if (files.length) addFilesRef.current(files); };
    window.addEventListener('dragover', over); window.addEventListener('dragleave', leave); window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); setDragging(false); };
  }, [c.archived]);
  const slashList = useMemo(() => slashCommands(workspace.preferences.templates), [workspace.preferences.templates]);
  const slashText = slashQuery(text);
  const slashMatches = useMemo(() => slashText === null || slashDismissed === text ? [] : matchSlash(slashList, slashText).slice(0, 8), [slashList, slashText, slashDismissed, text]);
  const slashIndex = Math.min(slashActive, Math.max(slashMatches.length - 1, 0));
  // Escape hides the menu for what is typed now; leaving the command (or clearing it) brings it back next time.
  useEffect(() => { setSlashActive(0); if (slashText === null) setSlashDismissed(undefined); }, [slashText]);
  function chooseSlash(cmd: SlashCommand) {
    edit(applySlash(latest.current, cmd, { project: projectName, conversation: c.title }), true);
    setSlashActive(0);
    textarea.current?.focus();
  }
  /** Returns true when the slash menu used the key. */
  function slashKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!slashMatches.length || e.nativeEvent.isComposing) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSlashActive(i => (Math.min(i, slashMatches.length - 1) + (e.key === 'ArrowDown' ? 1 : -1) + slashMatches.length) % slashMatches.length); return true; }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); chooseSlash(slashMatches[slashIndex]); return true; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setSlashDismissed(text); return true; }
    return false;
  }
  return <div className={s.composerArea}>
      {dock}
      {c.archived ? <div className={s.archivedNotice}>This conversation is archived.<button onClick={() => void state.updateConversation(c, { archived: false })}>Restore conversation</button></div> : null}
      {queue.length ? <details className={s.promptQueue} open><summary>{queue.length} queued {queue.length === 1 ? 'follow-up' : 'follow-ups'}</summary>{queue.map((item, i) => <div key={item.id}><span>{item.text.slice(0, 100)}{item.paused ? ' · Paused' : ''}</span>{item.paused || (['stopped', 'failed'].includes(status) && resumed !== c.id) ? <button onClick={() => { setResumed(c.id); workspace.setQueue(c.id, items => items.map(x => ({ ...x, paused: false }))); }}>Resume queue</button> : null}{i > 0 ? <button aria-label={`Move follow-up ${i + 1} first`} onClick={() => workspace.setQueue(c.id, [item, ...queue.filter(x => x.id !== item.id)])}>Move first</button> : null}<button onClick={() => { edit(item.text, true); workspace.setQueue(c.id, queue.filter(x => x.id !== item.id)); }}>Edit</button><button aria-label={`Remove follow-up ${i + 1}`} onClick={() => workspace.setQueue(c.id, queue.filter(x => x.id !== item.id))}>Remove</button></div>)}</details> : null}
      <div className={s.composer} data-dragging={dragging || undefined}>
      <div className={s.recipient}>To <strong>{projectName} · {agent?.title || 'Main agent'}</strong></div>
      <ModePicker conversation={c} disabled={c.archived} setMode={(mode, goal) => state.setConversationMode(c, mode, goal)}/>
      {slashMatches.length ? <ul className={n.slashMenu} id={slashId} role="listbox" aria-label="Slash commands">{slashMatches.map((cmd, i) => <li key={cmd.id} id={`${slashId}-${i}`} role="option" aria-selected={i === slashIndex} className={n.slashItem} onMouseDown={e => e.preventDefault()} onClick={() => chooseSlash(cmd)}><code>/{cmd.name}</code><span>{cmd.kind === 'saved' ? `Saved prompt · ${cmd.title}` : cmd.description}</span></li>)}</ul> : null}
      <textarea ref={textarea} disabled={c.archived} aria-label={agent?.role !== 'main' ? `Message ${agent?.title || 'agent'}` : 'Message Harbor'} aria-controls={slashMatches.length ? slashId : undefined} aria-activedescendant={slashMatches.length ? `${slashId}-${slashIndex}` : undefined} aria-keyshortcuts="Enter Shift+Enter" placeholder={agent?.role !== 'main' ? `Message ${agent?.title || 'agent'}…` : 'Message Harbor… (type / for commands)'} value={text} onChange={e => edit(e.target.value)} onPaste={e => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); addFiles(files); } }} onKeyDown={e => { if (slashKey(e)) return; if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!state.messagesLoading) send(); } }}/>
      {images.length ? <ul className={s.thumbnails} aria-label="Images to send">{images.map(img => <li key={img.id} className={img.preview ? undefined : s.fileChip}>{img.preview ? <img src={img.preview} alt={img.name}/> : <span>{img.name}</span>}<button type="button" aria-label={`Remove ${img.name}`} onClick={() => setImages(prev => prev.filter(x => x.id !== img.id))}><CloseIcon size={12} aria-hidden="true"/></button></li>)}</ul> : null}
      <div className={s.composerTools}><div className={s.composerAttachments}>
        <input ref={filePicker} hidden multiple type="file" aria-label="Choose files" onChange={e => { const files = [...(e.target.files ?? [])]; e.target.value = ''; if (files.length) addFiles(files); }}/>
        <Tooltip text="Attach any file (up to 10, 50 MB each). You can also drag files in anywhere."><button className={s.iconButton} disabled={c.archived} aria-label="Attach files" onClick={() => filePicker.current?.click()}><AttachIcon size={18} aria-hidden="true"/></button></Tooltip>
        <input ref={imagePicker} hidden multiple type="file" accept={IMAGE_TYPES.join(',')} aria-label="Choose images" onChange={e => { const files = [...(e.target.files ?? [])]; e.target.value = ''; void addImages(files); }}/>
        <Tooltip text="Attach images (PNG, JPEG, GIF, WebP; up to 6, 10 MB each)"><button className={s.iconButton} disabled={c.archived} aria-label="Attach images" onClick={() => imagePicker.current?.click()}><ImageIcon size={18} aria-hidden="true"/></button></Tooltip>
        <Tooltip text="Reusable prompts"><button className={s.iconButton} disabled={c.archived} aria-label="Reusable prompts" aria-expanded={templatesOpen} onClick={() => setTemplatesOpen(v => !v)}><TemplateIcon size={18} aria-hidden="true"/></button></Tooltip>
      </div><div className={s.composeActions}>{busy ? <button onClick={() => void state.stopConversation(c.id)}>Stop session</button> : null}{busy && agent?.role === 'main' ? <button disabled={(!text.trim() && !images.length) || state.messagesLoading || c.archived} title="Interrupt the lead's current step and act on this message (and its attachments) now" onClick={steer}>Send now</button> : null}<button className={s.primary} disabled={(!text.trim() && !images.length) || state.messagesLoading || c.archived} onClick={send}>{busy ? 'Queue follow-up' : 'Send ↑'}</button></div></div>
      {templatesOpen ? <div className={s.templatePicker}>{workspace.preferences.templates.length ? workspace.preferences.templates.map(t => <button key={t.id} onClick={() => { const before = latest.current; edit(`${before}${before ? '\n\n' : ''}${t.text}`, true); setTemplatesOpen(false); textarea.current?.focus(); }}>{t.title}</button>) : <p className={s.muted}>Save reusable prompts in Settings → Workspace.</p>}</div> : null}
      {sendError ? <div className={s.sendRecovery} role="status">{sendError}<button disabled={busy || !text.trim()} onClick={send}>Retry message</button><button onClick={() => void state.refreshClis()}>Check connections</button></div> : null}
      {attachmentError ? <p className={s.error} role="alert">{attachmentError}</p> : null}
    </div><p className={s.composeHint}>{workspace.saveError ? 'Draft saving is unavailable. Keep a copy of your message.' : state.questions?.some(q => q.conversationId === c.id) ? 'A question is waiting: type here or use its buttons, and your answer is sent now, not queued · Draft saved on this device' : busy ? 'Enter to queue · “Send now” interrupts the current step · Draft saved on this device' : 'Enter to send · Shift + Enter for a new line · Draft saved'}</p></div>;
}
