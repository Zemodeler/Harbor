import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeFetched, mergeMessages, upsertById, upsertByTime } from '../listOps';
import type { Agent, CliStatus, Conversation, ConversationMode, CloneProjectDraft, CreateProjectResult, ProjectFlagsPatch, DeleteResult, DeleteScope, HarborEvent, Message, NewProjectDraft, Project, Settings, UsageWindow } from '../../shared/api';

export type ImageUpload = { name: string; mime: string; dataBase64: string };

export type Permission = Extract<HarborEvent, { type: 'permission' }>;
export type PermissionAnswer = 'allow' | 'always' | 'deny';
/** Reconcile pending permissions only while some remain; slower after a failed check so a broken bridge is not hammered. */
export const PERMISSION_POLL_MS = 5000, PERMISSION_POLL_MAX_MS = 30000;
export type Question = Extract<HarborEvent, { type: 'question' }>;
const without = <T,>(record: Record<string, T>, key: string) => Object.fromEntries(Object.entries(record).filter(([k]) => k !== key)) as Record<string, T>;
const problem = (e: unknown, fallback: string) => e instanceof Error && e.message ? e.message : fallback;

export function useHarbor() {
  const api = window.harbor;
  const [projects, setProjects] = useState<Project[]>([]);
  const [clis, setClis] = useState<CliStatus[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  /** The latest agent request to open a document (HARBOR_OPEN_DOCUMENT); useDocuments decides whether to show it. seq makes repeats distinct. */
  const [documentRequest, setDocumentRequest] = useState<{ seq: number; event: Extract<HarborEvent, { type: 'document' }> }>();
  const [usage, setUsage] = useState<UsageWindow[]>([]);
  const [settings, setSettings] = useState<Settings>();
  const [projectId, setProjectId] = useState('');
  const [conversation, setConversation] = useState<Conversation>();
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [permissionAnswering, setPermissionAnswering] = useState<Record<string, PermissionAnswer>>({});
  const [permissionErrors, setPermissionErrors] = useState<Record<string, string>>({});
  const [permissionSyncError, setPermissionSyncError] = useState('');
  const [permissionNotice, setPermissionNotice] = useState('');
  const [questions, setQuestions] = useState<Question[]>([]);
  const [questionPending, setQuestionPending] = useState<Record<string, boolean>>({});
  const [questionErrors, setQuestionErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [projectLoading, setProjectLoading] = useState(false);
  // Errors are scoped per area so a failure does not appear in unrelated places: `error` is the page banner,
  // `areaErrors` holds the rest (e.g. 'dialog' for modals); startup, messages, questions and permissions have their own.
  const [error, setError] = useState('');
  const [areaErrors, setAreaErrors] = useState<Record<string, string>>({});
  const [startupError, setStartupError] = useState('');
  const [messagesError, setMessagesError] = useState('');
  const [sending, setSending] = useState<Set<string>>(new Set());
  const [lastActivity, setLastActivity] = useState<Record<string, number>>({});
  const current = useRef({ projectId: '', conversationId: '' });
  const projectRevision = useRef(0), messageRevision = useRef(0);
  // Only the open (or loading) conversation is cached; everything else is refetched when it is selected.
  const cachedMessages = useRef(new Map<string, Message>());
  const pendingDeltas = useRef(new Map<string, { conversationId: string; text: string }>());
  const deltaFrame = useRef<{ cancel: () => void }>(undefined);
  const agentsRef = useRef<Agent[]>([]), conversationsRef = useRef<Conversation[]>([]), projectsRef = useRef<Project[]>([]);
  agentsRef.current = agents; conversationsRef.current = conversations; projectsRef.current = projects;
  const remembered = useRef(new Map<string, string>());
  // Race guards for permissions: `seen` = event order a request was received in, `settled` = answered, expired or
  // withdrawn here (a stale snapshot must not bring it back), `sync` = only the newest listPendingPermissions applies.
  const permissionOrder = useRef(0), permissionSync = useRef(0);
  const seenPermissions = useRef(new Map<string, number>());
  const settledPermissions = useRef(new Set<string>());
  const answeringPermissions = useRef(new Set<string>());
  const answeringQuestions = useRef(new Set<string>());
  const permissionList = useRef<Permission[]>([]);
  permissionList.current = permissions;
  const forgetPermissions = useCallback((ids: string[]) => {
    if (!ids.length) return;
    ids.forEach(id => { settledPermissions.current.add(id); seenPermissions.current.delete(id); });
    const gone = new Set(ids);
    permissionList.current = permissionList.current.filter(p => !gone.has(p.requestId));
    setPermissions(ps => ps.filter(p => !gone.has(p.requestId)));
    setPermissionErrors(es => Object.fromEntries(Object.entries(es).filter(([id]) => !gone.has(id))));
  }, []);
  const receivePermission = useCallback((p: Permission) => {
    if (settledPermissions.current.has(p.requestId) || p.expiresAt !== undefined && p.expiresAt <= Date.now()) return;
    seenPermissions.current.set(p.requestId, ++permissionOrder.current);
    permissionList.current = [...permissionList.current.filter(x => x.requestId !== p.requestId), p];
    setPermissions(ps => ps.some(x => x.requestId === p.requestId) ? ps.map(x => x.requestId === p.requestId ? p : x) : [...ps, p]);
  }, []);
  /** Merge Harbor's pending list: add what is missing; drop only requests received before this check began (newer events win). */
  const refreshPermissions = useCallback(async () => {
    const sync = ++permissionSync.current, startedAt = permissionOrder.current;
    try {
      const pending = await api.listPendingPermissions();
      if (sync !== permissionSync.current) return true;
      const listed = new Set(pending.map(p => p.requestId));
      const withdrawn = permissionList.current.filter(p => !listed.has(p.requestId) && (seenPermissions.current.get(p.requestId) ?? 0) <= startedAt).map(p => p.requestId);
      if (withdrawn.length) setPermissionNotice(withdrawn.length === 1 ? 'A request no longer needs an answer: Harbor withdrew it or it was answered elsewhere.' : `${withdrawn.length} requests no longer need an answer: Harbor withdrew them or they were answered elsewhere.`);
      forgetPermissions(withdrawn);
      pending.forEach(p => { if (!seenPermissions.current.has(p.requestId)) receivePermission(p); });
      setPermissionSyncError('');
      return true;
    } catch (e) {
      if (sync === permissionSync.current) setPermissionSyncError(`Could not check which requests are still waiting${e instanceof Error && e.message ? ` (${e.message})` : ''}. Requests shown here may be out of date.`);
      return false;
    }
  }, [api, forgetPermissions, receivePermission]);
  /** Runs `work`; a failure is shown in `area` (a named place such as 'dialog') or, without one, in the page banner. */
  const run = useCallback(async <T,>(work: () => Promise<T>, area?: string): Promise<T | undefined> => {
    const put = (text: string) => area
      ? setAreaErrors(es => text ? { ...es, [area]: text } : area in es ? without(es, area) : es)
      : setError(text);
    try { put(''); return await work(); }
    catch (e) { put(problem(e, 'Something went wrong. Please try again.')); }
  }, []);
  const clearError = useCallback((area?: string) => {
    if (area) setAreaErrors(es => area in es ? without(es, area) : es); else setError('');
  }, []);
  /** Drops pending questions that are moot (the agent moved on, the user wrote, the session stopped). */
  const dropQuestions = useCallback((moot: (q: Question) => boolean) => setQuestions(qs => qs.some(moot) ? qs.filter(q => !moot(q)) : qs), []);
  /** Applies streamed text that was batched for one animation frame. */
  const flushDeltas = useCallback(() => {
    deltaFrame.current?.cancel(); deltaFrame.current = undefined;
    const batch = pendingDeltas.current;
    if (!batch.size) return;
    pendingDeltas.current = new Map();
    const open = current.current.conversationId, touched = new Set<string>(), add = new Map<string, string>();
    batch.forEach((d, id) => {
      touched.add(d.conversationId);
      const cached = cachedMessages.current.get(id);
      if (cached) cachedMessages.current.set(id, { ...cached, text: cached.text + d.text });
      if (d.conversationId === open) add.set(id, d.text);
    });
    const now = Date.now();
    setLastActivity(times => { const next = { ...times }; touched.forEach(id => { next[id] = now; }); return next; });
    if (add.size) setMessages(ms => ms.map(m => add.has(m.id) ? { ...m, text: m.text + add.get(m.id) } : m));
  }, []);
  const queueDelta = useCallback((messageId: string, conversationId: string, text: string) => {
    const pending = pendingDeltas.current.get(messageId);
    pendingDeltas.current.set(messageId, { conversationId, text: (pending?.text ?? '') + text });
    if (deltaFrame.current) return;
    if (typeof requestAnimationFrame === 'function') { const h = requestAnimationFrame(flushDeltas); deltaFrame.current = { cancel: () => cancelAnimationFrame(h) }; }
    else { const h = setTimeout(flushDeltas, 16); deltaFrame.current = { cancel: () => clearTimeout(h) }; }
  }, [flushDeltas]);
  useEffect(() => () => { deltaFrame.current?.cancel(); }, []);
  const selectConversation = useCallback(async (c: Conversation) => {
    const revision = ++messageRevision.current;
    flushDeltas(); pendingDeltas.current = new Map();
    current.current.conversationId = c.id;
    remembered.current.set(c.projectId, c.id);
    cachedMessages.current.forEach((m, id) => { if (m.conversationId !== c.id) cachedMessages.current.delete(id); });
    setConversation(c); setMessages([]); setMessagesLoading(true); setMessagesError('');
    try {
      const result = await api.listMessages(c.id);
      if (messageRevision.current === revision) setMessages(mergeMessages(result, [...cachedMessages.current.values()].filter(m => m.conversationId === c.id)));
    } catch (e) {
      if (messageRevision.current === revision) setMessagesError(problem(e, 'Could not load this conversation.'));
    }
    if (messageRevision.current === revision) setMessagesLoading(false);
  }, [api, flushDeltas]);
  /** Forget everything about the open project (the last one was removed, or none is left). */
  const clearProject = useCallback(() => {
    ++projectRevision.current; ++messageRevision.current;
    pendingDeltas.current = new Map(); cachedMessages.current.clear();
    current.current = { projectId: '', conversationId: '' };
    setProjectId(''); setConversation(undefined); setMessages([]); setConversations([]); setAgents([]); setQuestions([]);
    setProjectLoading(false); setMessagesLoading(false); setMessagesError('');
  }, []);
  const selectProject = useCallback(async (id: string) => {
    const revision = ++projectRevision.current;
    ++messageRevision.current;
    current.current = { projectId: id, conversationId: '' };
    pendingDeltas.current = new Map(); cachedMessages.current.clear();
    setProjectId(id); setConversation(undefined); setMessages([]); setConversations([]); setAgents([]); setProjectLoading(true); setMessagesLoading(false); setMessagesError('');
    await run(async () => {
      const [cs, as] = await Promise.all([api.listConversations(id), api.listAgents(id)]);
      if (projectRevision.current !== revision) return;
      // The lists were cleared above, so whatever they hold now arrived by event during the fetch: it is newer and wins.
      const liveConversations = conversationsRef.current, liveAgents = agentsRef.current;
      const mergedConversations = mergeFetched(cs, liveConversations), mergedAgents = mergeFetched(as, liveAgents);
      setConversations(prev => mergeFetched(cs, prev)); setAgents(prev => mergeFetched(as, prev));
      const c = mergedConversations.find(c => c.id === remembered.current.get(id)) || mergedConversations.find(c => !c.archived && mergedAgents.find(a => a.id === c.agentId)?.role === 'main') || mergedConversations.find(c => !c.archived);
      if (c) await selectConversation(c);
    });
    if (projectRevision.current === revision) setProjectLoading(false);
  }, [api, run, selectConversation]);
  const reload = useCallback(async () => {
    setLoading(true); setStartupError(''); setError('');
    try {
      const [ps, cs, us, ss] = await Promise.all([api.listProjects(), api.listClis(), api.getUsage(), api.getSettings()]);
      setProjects(ps); setClis(cs); setUsage(us); setSettings(ss);
      if (ps.length) await selectProject(ps.find(p => p.id === current.current.projectId)?.id || ps[0].id);
      else clearProject();
    } catch (e) {
      const text = problem(e, 'Harbor could not be reached.');
      // With nothing to show yet this is a start-up failure (with Retry), not a first run.
      if (projectsRef.current.length) setError(text); else setStartupError(text);
    }
    setLoading(false);
  }, [api, selectProject, clearProject]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const unsubscribe = api.onEvent(onEvent);
    // Only after subscribing: a reloaded renderer missed the original events, and nothing can fall between the two.
    void refreshPermissions();
    return () => { unsubscribe(); ++permissionSync.current; };
  }, [api, refreshPermissions]);
  // Uses refs and setters only: it is subscribed once and must not close over render state.
  function onEvent(e: HarborEvent) {
    if (e.type === 'conversation') {
      const previous = conversationsRef.current.find(c => c.id === e.conversation.id);
      // The session stopped waiting: a question about it is moot.
      if (previous?.activity?.state === 'waiting' && e.conversation.activity?.state !== 'waiting') dropQuestions(q => q.conversationId === e.conversation.id);
      if (e.conversation.projectId === current.current.projectId) {
        setConversations(cs => [e.conversation, ...cs.filter(c => c.id !== e.conversation.id)].sort((a, b) => b.updated - a.updated));
        if (current.current.conversationId === e.conversation.id) setConversation(e.conversation);
      }
    }
    if (e.type === 'message') {
      flushDeltas(); // deltas that came first must not be applied on top of this newer record
      const m = e.message;
      setLastActivity(times => ({ ...times, [m.conversationId]: Date.now() }));
      if (m.role === 'user') dropQuestions(q => q.conversationId === m.conversationId);
      if (m.conversationId === current.current.conversationId) {
        cachedMessages.current.set(m.id, m);
        setMessages(ms => upsertByTime(ms, m));
      }
    }
    if (e.type === 'messageDelta') queueDelta(e.messageId, e.conversationId, e.text);
    if (e.type === 'agent') {
      const previous = agentsRef.current.find(a => a.id === e.agent.id);
      if (previous?.state === 'waiting' && e.agent.state !== 'waiting') dropQuestions(q => q.agentId === e.agent.id);
      if (e.agent.projectId === current.current.projectId) setAgents(as => upsertById(as, e.agent));
    }
    if (e.type === 'usage') setUsage(e.windows);
    if (e.type === 'cli') setClis(cs => upsertById(cs, e.cli));
    if (e.type === 'question') setQuestions(qs => qs.some(q => q.requestId === e.requestId) ? qs : [...qs.filter(q => q.agentId !== e.agentId || !e.agentId), e]);
    if (e.type === 'permission') receivePermission(e);
    if (e.type === 'document') setDocumentRequest(r => ({ seq: (r?.seq ?? 0) + 1, event: e }));
  }
  // Harbor has no resolution event: poll while requests are shown so withdrawn ones disappear. Stops when none remain.
  const hasPermissions = permissions.length > 0;
  useEffect(() => {
    if (!hasPermissions) return;
    let cancelled = false, delay = PERMISSION_POLL_MS, timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const ok = await refreshPermissions();
      if (cancelled) return;
      delay = ok ? PERMISSION_POLL_MS : Math.min(delay * 2, PERMISSION_POLL_MAX_MS);
      timer = setTimeout(() => void tick(), delay);
    };
    timer = setTimeout(() => void tick(), delay);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [hasPermissions, refreshPermissions]);
  // An expired request was already denied by Harbor: remove it without answering it a second time.
  const nextExpiry = permissions.reduce((min, p) => p.expiresAt !== undefined && p.expiresAt < min ? p.expiresAt : min, Infinity);
  useEffect(() => {
    if (nextExpiry === Infinity) return;
    const timer = setTimeout(() => {
      const expired = permissionList.current.filter(p => p.expiresAt !== undefined && p.expiresAt <= Date.now());
      if (!expired.length) return;
      setPermissionNotice(expired.length === 1 ? `The request${expired[0].tool ? ` to run ${expired[0].tool}` : ''} expired without an answer. Harbor denied it and told the agent.` : `${expired.length} requests expired without an answer. Harbor denied them and told the agents.`);
      forgetPermissions(expired.map(p => p.requestId));
    }, Math.min(Math.max(nextExpiry - Date.now(), 0), 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [nextExpiry, forgetPermissions]);
  async function newConversation() {
    if (!projectId) return;
    const id = projectId;
    await run(async () => {
      const c = await api.newConversation(id);
      if (current.current.projectId !== id) return;
      setConversations(cs => [c, ...cs]); await selectConversation(c);
    });
  }
  async function deleteConversation(c: Conversation, area?: string) {
    return run(async () => {
      await api.deleteConversation(c.id);
      cachedMessages.current.forEach((m, k) => { if (m.conversationId === c.id) cachedMessages.current.delete(k); });
      dropQuestions(q => q.conversationId === c.id);
      remembered.current.delete(c.projectId);
      if (current.current.projectId !== c.projectId) return true;
      const rest = await api.listConversations(c.projectId);
      setConversations(rest);
      if (current.current.conversationId !== c.id) return true;
      if (rest[0]) await selectConversation(rest[0]);
      else { setConversation(undefined); setMessages([]); current.current.conversationId = ''; }
      return true;
    }, area);
  }
  async function openAgent(agentId: string) {
    const id = projectId;
    await run(async () => {
      const c = await api.openAgentConversation(agentId);
      if (current.current.projectId !== id) return;
      setConversations(cs => [c, ...cs.filter(x => x.id !== c.id)]); await selectConversation(c);
    });
  }
  async function addProject(path?: string, area?: string) {
    let added = false;
    await run(async () => {
      const p = await api.addProject(path);
      if (!p) return;
      setProjects(await api.listProjects()); await selectProject(p.id);
      added = true;
    }, area);
    return added;
  }
  /** Removes a project entry (never its files) and reloads; with no project left the open-project state is cleared. */
  async function removeProject(id: string, area?: string) {
    let removed = false;
    await run(async () => { await api.removeProject(id); removed = true; }, area);
    if (removed) await reload();
    return removed;
  }
  /** Starts a project (folder, template, git, optional GitHub repo) and opens it; undefined when it failed (the reason is in `area`). */
  async function createProject(draft: NewProjectDraft, area?: string) {
    let result: CreateProjectResult | undefined;
    await run(async () => {
      if (!api.createProject) throw new Error('Starting a project is available in the desktop app.');
      const r = await api.createProject(draft);
      setProjects(await api.listProjects()); await selectProject(r.project.id);
      result = r;
    }, area);
    return result;
  }
  /** Clones an existing repository into the projects folder and opens it; undefined when it failed (the reason is in `area`). */
  async function cloneProject(draft: CloneProjectDraft, area?: string) {
    let result: CreateProjectResult | undefined;
    await run(async () => {
      if (!api.cloneProject) throw new Error('Cloning a repository is available in the desktop app.');
      const r = await api.cloneProject(draft);
      setProjects(await api.listProjects()); await selectProject(r.project.id);
      result = r;
    }, area);
    return result;
  }
  /** Deletes a project at the chosen level (records, plus worktrees and branches, plus the folder) and reloads. */
  async function deleteProject(id: string, scope: DeleteScope, confirmName: string | undefined, area?: string) {
    let result: DeleteResult | undefined;
    await run(async () => {
      if (!api.deleteProject) throw new Error('Deleting a project is available in the desktop app.');
      result = await api.deleteProject(id, scope, confirmName);
    }, area);
    if (result?.removed.records) await reload();
    return result;
  }
  async function renameProject(id: string, name: string, area?: string) {
    let renamed = false;
    await run(async () => { await api.renameProject!(id, name); setProjects(await api.listProjects()); renamed = true; }, area);
    return renamed;
  }
  /** Archives or pins a project (nothing is deleted) and refreshes the project list; false when it failed (the reason is in `area`). */
  async function setProjectFlags(id: string, patch: ProjectFlagsPatch, area?: string) {
    let done = false;
    await run(async () => {
      if (!api.setProjectFlags) throw new Error('Archiving and pinning are available in the desktop app.');
      await api.setProjectFlags(id, patch); setProjects(await api.listProjects()); done = true;
    }, area);
    return done;
  }
  async function setProjectImage(id: string, image: string | null) {
    await run(async () => { await api.setProjectImage(id, image); setProjects(await api.listProjects()); });
  }
  async function setConversationMode(c: Conversation, mode: ConversationMode, goal?: string) {
    return run(async () => {
      const updated = await api.setConversationMode(c.id, mode, goal);
      if (current.current.projectId === c.projectId) {
        setConversations(cs => cs.map(x => x.id === c.id ? updated : x));
        if (current.current.conversationId === c.id) setConversation(updated);
      }
      return updated;
    });
  }
  async function send(text: string, attachments?: ImageUpload[], opts?: { steer?: boolean }) {
    const c = conversation;
    if (!c) return false;
    setSending(s => new Set(s).add(c.id));
    let success = false;
    await run(async () => { await (opts?.steer ? api.send(c.id, text, attachments?.length ? attachments : undefined, opts) : attachments?.length ? api.send(c.id, text, attachments) : api.send(c.id, text)); success = true;
      const cs = await api.listConversations(c.projectId);
      if (current.current.projectId === c.projectId) setConversations(cs);
    });
    setSending(s => { const next = new Set(s); next.delete(c.id); return next; });
    return success;
  }
  /** Stops a session; a question it was waiting on can no longer be answered, so it goes too. */
  async function stopConversation(id: string) {
    const ok = await run(async () => { await api.stopConversation(id); return true; });
    if (ok) dropQuestions(q => q.conversationId === id);
    return !!ok;
  }
  /** Per request, so one failed answer never blocks the others; the request stays visible until Harbor has the answer. */
  async function answerPermission(requestId: string, answer: PermissionAnswer, shot?: { sourceId: string; forConversation?: boolean }) {
    const p = permissionList.current.find(x => x.requestId === requestId);
    if (!p || answeringPermissions.current.has(requestId)) return false;
    // "Always" is only ever sent for a tool request that offered it; anything else is a plain answer.
    const always = answer === 'always' && p.kind === 'tool' && p.alwaysAllow === true;
    if (answer === 'always' && !always) return false;
    // A screenshot is only ever allowed with the window or screen the user picked in its card (Harbor refuses a bare yes).
    const capture = p.kind === 'screenshot' && answer === 'allow';
    if (capture && (!shot?.sourceId || !api.answerScreenshot)) return false;
    answeringPermissions.current.add(requestId);
    setPermissionAnswering(a => ({ ...a, [requestId]: answer }));
    setPermissionErrors(({ [requestId]: _, ...rest }) => rest);
    try {
      await (capture ? api.answerScreenshot!(requestId, { allow: true, sourceId: shot!.sourceId, forConversation: shot!.forConversation === true })
        : always ? api.answerPermission(requestId, true, { always: true }) : api.answerPermission(requestId, answer === 'allow'));
      forgetPermissions([requestId]);
      return true;
    } catch (e) {
      if (!settledPermissions.current.has(requestId)) setPermissionErrors(es => ({ ...es, [requestId]: `Harbor did not accept your answer${e instanceof Error && e.message ? `: ${e.message}` : '.'} Try again while the request is shown here.` }));
      void refreshPermissions();
      return false;
    } finally {
      answeringPermissions.current.delete(requestId);
      setPermissionAnswering(({ [requestId]: _, ...rest }) => rest);
    }
  }
  // Dismissing only hides the card; the question stays in the chat and can be answered there.
  const dismissQuestion = useCallback((requestId: string) => {
    setQuestions(qs => qs.filter(q => q.requestId !== requestId));
    setQuestionErrors(es => requestId in es ? without(es, requestId) : es);
  }, []);
  /** Failures stay on that question (questionErrors), never in the page banner. */
  async function answerQuestion(requestId: string, answer: string) {
    if (answeringQuestions.current.has(requestId)) return false;
    answeringQuestions.current.add(requestId);
    setQuestionPending(p => ({ ...p, [requestId]: true })); setQuestionErrors(es => requestId in es ? without(es, requestId) : es);
    try { await api.answerQuestion(requestId, answer); dismissQuestion(requestId); return true; }
    catch (e) { setQuestionErrors(es => ({ ...es, [requestId]: problem(e, 'Harbor did not accept the answer. Try again or answer in the conversation.') })); return false; }
    finally { answeringQuestions.current.delete(requestId); setQuestionPending(p => without(p, requestId)); }
  }
  async function updateSettings(s: Partial<Settings>) { await run(async () => setSettings(await api.setSettings(s))); }
  /** Like updateSettings, but a rejection reaches the caller (a field that shows its own error) instead of the page banner. */
  async function saveSettings(s: Partial<Settings>) { setSettings(await api.setSettings(s)); }
  async function updateConversation(c: Conversation, patch: { title?: string; pinned?: boolean; archived?: boolean }, area?: string) {
    return run(async () => {
      const updated = await api.updateConversation(c.id, patch);
      if (current.current.projectId === c.projectId) {
        setConversations(cs => cs.map(x => x.id === c.id ? updated : x));
        if (current.current.conversationId === c.id) setConversation(updated);
      }
      return updated;
    }, area);
  }
  async function openConversation(c: Conversation) {
    if (current.current.projectId !== c.projectId) await selectProject(c.projectId);
    await selectConversation(c);
  }
  return { api, projects, clis, conversations, agents, messages, usage, settings, projectId, conversation,
    lastActivity, updateConversation, openConversation, documentRequest,
    permissions, permissionAnswering, permissionErrors, permissionSyncError, permissionNotice, dismissPermissionNotice: () => setPermissionNotice(''), refreshPermissions,
    questions, questionPending, questionErrors, dismissQuestion, answerQuestion, stopConversation,
    loading, messagesLoading, projectLoading, error, areaErrors, startupError, messagesError, clearError, dismissError: () => setError(''),
    sending, run, reload, selectProject, selectConversation, clearProject, retryMessages: () => conversation ? selectConversation(conversation) : Promise.resolve(),
    newConversation, deleteConversation, openAgent, addProject, removeProject, createProject, cloneProject, deleteProject, renameProject, setProjectFlags, setProjectImage, send, setConversationMode, answerPermission, updateSettings, saveSettings,
    refreshClis: () => run(async () => setClis(await api.refreshClis())) };
}
export type HarborState = ReturnType<typeof useHarbor>;
