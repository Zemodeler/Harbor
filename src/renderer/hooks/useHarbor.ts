import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, CliStatus, Conversation, ConversationMode, HarborEvent, Message, Project, Settings, UsageWindow } from '../../shared/api';

export type ImageUpload = { name: string; mime: string; dataBase64: string };

type Permission = Extract<HarborEvent, { type: 'permission' }>;
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
  useEffect(() => api.onEvent(e => {
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
    if (e.type === 'permission') setPermissions(ps => ps.some(p => p.requestId === e.requestId) ? ps : [...ps, e]);
  }), [api]);
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
    await run(async () => { await api.send(c.id, text, attachments?.length ? attachments : undefined); success = true;
      const cs = await api.listConversations(c.projectId);
      if (current.current.projectId === c.projectId) setConversations(cs);
    });
    setSending(s => { const next = new Set(s); next.delete(c.id); return next; });
    return success;
  }
  async function answerPermission(requestId: string, allow: boolean) {
    await run(async () => { await api.answerPermission(requestId, allow); setPermissions(ps => ps.filter(p => p.requestId !== requestId)); });
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
    permissions, questions, dismissQuestion, answerQuestion, loading, messagesLoading, projectLoading, error, sending, run, reload, selectProject, selectConversation,
    newConversation, deleteConversation, openAgent, addProject, setProjectImage, send, setConversationMode, answerPermission, updateSettings,
    refreshClis: () => run(async () => setClis(await api.refreshClis())) };
}
export type HarborState = ReturnType<typeof useHarbor>;
