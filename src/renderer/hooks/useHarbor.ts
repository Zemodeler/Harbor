import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, CliStatus, Conversation, ConversationMode, HarborEvent, Message, Project, Settings, UsageWindow } from '../../shared/api';

export type ImageUpload = { name: string; mime: string; dataBase64: string };

export type Permission = Extract<HarborEvent, { type: 'permission' }>;
export type PermissionAnswer = 'allow' | 'always' | 'deny';
/** Reconcile pending permissions only while some remain; slower after a failed check so a broken bridge is not hammered. */
export const PERMISSION_POLL_MS = 5000, PERMISSION_POLL_MAX_MS = 30000;
export type Question = Extract<HarborEvent, { type: 'question' }>;
export function useHarbor() {
  const api = window.harbor;
  const [projects, setProjects] = useState<Project[]>([]);
  const [clis, setClis] = useState<CliStatus[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
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
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [projectLoading, setProjectLoading] = useState(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState<Set<string>>(new Set());
  const [lastActivity, setLastActivity] = useState<Record<string, number>>({});
  const current = useRef({ projectId: '', conversationId: '' });
  const projectRevision = useRef(0), messageRevision = useRef(0);
  const cachedMessages = useRef(new Map<string, Message>());
  const remembered = useRef(new Map<string, string>());
  // Race guards for permissions: `seen` = event order a request was received in, `settled` = answered, expired or
  // withdrawn here (a stale snapshot must not bring it back), `sync` = only the newest listPendingPermissions applies.
  const permissionOrder = useRef(0), permissionSync = useRef(0);
  const seenPermissions = useRef(new Map<string, number>());
  const settledPermissions = useRef(new Set<string>());
  const answeringPermissions = useRef(new Set<string>());
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
  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    try { setError(''); return await work(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.'); }
  }, []);
  const selectConversation = useCallback(async (c: Conversation) => {
    const revision = ++messageRevision.current;
    current.current.conversationId = c.id;
    remembered.current.set(c.projectId, c.id);
    setConversation(c); setMessages([]); setMessagesLoading(true);
    await run(async () => {
      const result = await api.listMessages(c.id);
      if (messageRevision.current === revision) {
        const combined = new Map(result.map(m => [m.id, m]));
        cachedMessages.current.forEach(m => { if (m.conversationId === c.id) combined.set(m.id, m); });
        setMessages([...combined.values()].sort((a, b) => a.time - b.time));
      }
    });
    if (messageRevision.current === revision) setMessagesLoading(false);
  }, [api, run]);
  const selectProject = useCallback(async (id: string) => {
    const revision = ++projectRevision.current;
    ++messageRevision.current;
    current.current = { projectId: id, conversationId: '' };
    setProjectId(id); setConversation(undefined); setMessages([]); setConversations([]); setAgents([]); setProjectLoading(true); setMessagesLoading(false);
    await run(async () => {
      const [cs, as] = await Promise.all([api.listConversations(id), api.listAgents(id)]);
      if (projectRevision.current !== revision) return;
      setConversations(cs); setAgents(as);
      const c = cs.find(c => c.id === remembered.current.get(id)) || cs.find(c => !c.archived && as.find(a => a.id === c.agentId)?.role === 'main') || cs.find(c => !c.archived);
      if (c) await selectConversation(c);
    });
    if (projectRevision.current === revision) setProjectLoading(false);
  }, [api, run, selectConversation]);
  const reload = useCallback(async () => {
    setLoading(true);
    await run(async () => {
      const [ps, cs, us, ss] = await Promise.all([api.listProjects(), api.listClis(), api.getUsage(), api.getSettings()]);
      setProjects(ps); setClis(cs); setUsage(us); setSettings(ss);
      if (ps.length) await selectProject(ps.find(p => p.id === current.current.projectId)?.id || ps[0].id);
    });
    setLoading(false);
  }, [api, run, selectProject]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const unsubscribe = api.onEvent(onEvent);
    // Only after subscribing: a reloaded renderer missed the original events, and nothing can fall between the two.
    void refreshPermissions();
    return () => { unsubscribe(); ++permissionSync.current; };
  }, [api, refreshPermissions]);
  function onEvent(e: HarborEvent) {
    if (e.type === 'conversation' && e.conversation.projectId === current.current.projectId) {
      setConversations(cs => [e.conversation, ...cs.filter(c => c.id !== e.conversation.id)].sort((a, b) => b.updated - a.updated));
      if (current.current.conversationId === e.conversation.id) setConversation(e.conversation);
    }
    if (e.type === 'message') {
      setLastActivity(times => ({ ...times, [e.message.conversationId]: Date.now() }));
      cachedMessages.current.set(e.message.id, e.message);
      if (e.message.conversationId === current.current.conversationId) setMessages(ms => [...ms.filter(m => m.id !== e.message.id), e.message]);
    }
    if (e.type === 'messageDelta') {
      setLastActivity(times => ({ ...times, [e.conversationId]: Date.now() }));
      const cached = cachedMessages.current.get(e.messageId);
      if (cached) cachedMessages.current.set(e.messageId, { ...cached, text: cached.text + e.text });
      if (e.conversationId === current.current.conversationId) setMessages(ms => ms.map(m => m.id === e.messageId ? { ...m, text: m.text + e.text } : m));
    }
    if (e.type === 'agent' && e.agent.projectId === current.current.projectId) setAgents(as => [...as.filter(a => a.id !== e.agent.id), e.agent]);
    if (e.type === 'usage') setUsage(e.windows);
    if (e.type === 'cli') setClis(cs => [...cs.filter(c => c.id !== e.cli.id), e.cli]);
    if (e.type === 'question') setQuestions(qs => qs.some(q => q.requestId === e.requestId) ? qs : [...qs.filter(q => q.agentId !== e.agentId || !e.agentId), e]);
    if (e.type === 'permission') receivePermission(e);
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
  async function deleteConversation(c: Conversation) {
    await run(async () => {
      await api.deleteConversation(c.id);
      cachedMessages.current.forEach((m, k) => { if (m.conversationId === c.id) cachedMessages.current.delete(k); });
      remembered.current.delete(c.projectId);
      if (current.current.projectId !== c.projectId) return;
      const rest = await api.listConversations(c.projectId);
      setConversations(rest);
      if (current.current.conversationId !== c.id) return;
      if (rest[0]) await selectConversation(rest[0]);
      else { setConversation(undefined); setMessages([]); current.current.conversationId = ''; }
    });
  }
  async function openAgent(agentId: string) {
    const id = projectId;
    await run(async () => {
      const c = await api.openAgentConversation(agentId);
      if (current.current.projectId !== id) return;
      setConversations(cs => [c, ...cs.filter(x => x.id !== c.id)]); await selectConversation(c);
    });
  }
  async function addProject(path?: string) {
    let added = false;
    await run(async () => {
      const p = await api.addProject(path);
      if (!p) return;
      setProjects(await api.listProjects()); await selectProject(p.id);
      added = true;
    });
    return added;
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
  async function send(text: string, attachments?: ImageUpload[]) {
    const c = conversation;
    if (!c) return false;
    setSending(s => new Set(s).add(c.id));
    let success = false;
    await run(async () => { await (attachments?.length ? api.send(c.id, text, attachments) : api.send(c.id, text)); success = true;
      const cs = await api.listConversations(c.projectId);
      if (current.current.projectId === c.projectId) setConversations(cs);
    });
    setSending(s => { const next = new Set(s); next.delete(c.id); return next; });
    return success;
  }
  /** Per request, so one failed answer never blocks the others; the request stays visible until Harbor has the answer. */
  async function answerPermission(requestId: string, answer: PermissionAnswer) {
    const p = permissionList.current.find(x => x.requestId === requestId);
    if (!p || answeringPermissions.current.has(requestId)) return false;
    // "Always" is only ever sent for a tool request that offered it; anything else is a plain answer.
    const always = answer === 'always' && p.kind === 'tool' && p.alwaysAllow === true;
    if (answer === 'always' && !always) return false;
    answeringPermissions.current.add(requestId);
    setPermissionAnswering(a => ({ ...a, [requestId]: answer }));
    setPermissionErrors(({ [requestId]: _, ...rest }) => rest);
    try {
      await (always ? api.answerPermission(requestId, true, { always: true }) : api.answerPermission(requestId, answer === 'allow'));
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
  // Dismissing only hides the pop-up; the question stays in the chat and can be answered there.
  const dismissQuestion = (requestId: string) => setQuestions(qs => qs.filter(q => q.requestId !== requestId));
  async function answerQuestion(requestId: string, answer: string) {
    await run(async () => { await api.answerQuestion(requestId, answer); dismissQuestion(requestId); });
  }
  async function updateSettings(s: Partial<Settings>) { await run(async () => setSettings(await api.setSettings(s))); }
  async function updateConversation(c: Conversation, patch: { title?: string; pinned?: boolean; archived?: boolean }) {
    return run(async () => {
      const updated = await api.updateConversation(c.id, patch);
      if (current.current.projectId === c.projectId) {
        setConversations(cs => cs.map(x => x.id === c.id ? updated : x));
        if (current.current.conversationId === c.id) setConversation(updated);
      }
      return updated;
    });
  }
  async function openConversation(c: Conversation) {
    if (current.current.projectId !== c.projectId) await selectProject(c.projectId);
    await selectConversation(c);
  }
  return { api, projects, clis, conversations, agents, messages, usage, settings, projectId, conversation,
    lastActivity, updateConversation, openConversation,
    permissions, permissionAnswering, permissionErrors, permissionSyncError, permissionNotice, dismissPermissionNotice: () => setPermissionNotice(''), refreshPermissions,
    questions, dismissQuestion, answerQuestion, loading, messagesLoading, projectLoading, error, sending, run, reload, selectProject, selectConversation,
    newConversation, deleteConversation, openAgent, addProject, setProjectImage, send, setConversationMode, answerPermission, updateSettings,
    refreshClis: () => run(async () => setClis(await api.refreshClis())) };
}
export type HarborState = ReturnType<typeof useHarbor>;
