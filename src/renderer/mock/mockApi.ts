import type { HarborApi, HarborEvent, Agent, Message, Settings } from '../../shared/api';
import { seed } from './seed';

export function createMockApi(options: { empty?: boolean; delay?: number } = {}): HarborApi {
  const data = seed(options.empty);
  const listeners = new Set<(e: HarborEvent) => void>();
  const runs = new Map<string, { cancelled: boolean }>();
  const permissions = new Map<string, (allow: boolean) => void>();
  let settings: Settings = { routing: 'auto', cliOverrides: { codex: { enabled: true }, claude: { enabled: true }, gemini: { enabled: false } }, allowFreeReset: 'ask' };
  let requested = false;
  const copy = <T,>(v: T): T => structuredClone(v);
  const emit = (e: HarborEvent) => listeners.forEach(cb => cb(copy(e)));
  const pause = () => new Promise<void>(r => setTimeout(r, options.delay ?? 110));
  const id = () => crypto.randomUUID();
  const requireConversation = (conversationId: string) => {
    const c = data.conversations.find(c => c.id === conversationId);
    if (!c) throw new Error('This conversation is no longer available.');
    return c;
  };
  const updateAgent = (agent: Agent) => { emit({ type: 'agent', agent }); };
  const api: HarborApi = {
    async listClis() { await pause(); return copy(data.clis); },
    async refreshClis() { await pause(); data.clis.forEach(cli => emit({ type: 'cli', cli })); return copy(data.clis); },
    async openLogin(cliId) {
      const cli = data.clis.find(c => c.id === cliId);
      if (!cli?.installed) throw new Error('Install this CLI before signing in.');
      await pause(); cli.signedIn = true; emit({ type: 'cli', cli });
    },
    async listProjects() { await pause(); return copy(data.projects); },
    async addProject(path) {
      const projectPath = path?.trim() || `C:\\Projects\\New project ${data.projects.length + 1}`;
      const existing = data.projects.find(p => p.path.toLowerCase() === projectPath.toLowerCase());
      if (existing) return copy(existing);
      const p = { id: id(), name: projectPath.split(/[\\/]/).filter(Boolean).at(-1) || 'Project', path: projectPath, lastOpened: Date.now() };
      data.projects.push(p);
      data.agents.push({ id: `main-${p.id}`, projectId: p.id, role: 'main', title: 'Main agent', state: 'waiting', cli: 'codex', model: 'default', effort: 'medium' });
      return copy(p);
    },
    async removeProject(projectId) {
      data.agents.filter(a => a.projectId === projectId).forEach(a => { const run = runs.get(a.id); if (run) run.cancelled = true; });
      const convIds = new Set(data.conversations.filter(c => c.projectId === projectId).map(c => c.id));
      data.projects = data.projects.filter(p => p.id !== projectId);
      data.conversations = data.conversations.filter(c => c.projectId !== projectId);
      data.agents = data.agents.filter(a => a.projectId !== projectId);
      data.messages = data.messages.filter(m => !convIds.has(m.conversationId));
    },
    async listConversations(projectId) { await pause(); return copy(data.conversations.filter(c => c.projectId === projectId)); },
    async newConversation(projectId) {
      if (!data.projects.some(p => p.id === projectId)) throw new Error('Open a project first.');
      const c = { id: id(), projectId, title: 'New conversation', updated: Date.now(), agentId: `main-${projectId}` };
      data.conversations.unshift(c); return copy(c);
    },
    async listMessages(conversationId) { requireConversation(conversationId); await pause(); return copy(data.messages.filter(m => m.conversationId === conversationId)); },
    async send(conversationId, text) {
      const c = requireConversation(conversationId);
      if (!text.trim()) throw new Error('Write a message first.');
      if (!data.clis.some(cli => cli.installed && cli.signedIn && settings.cliOverrides[cli.id]?.enabled !== false)) throw new Error('Enable and sign in to a connection in Settings.');
      let agent = data.agents.find(a => a.id === c.agentId)!;
      if (runs.has(agent.id)) throw new Error('This agent is still working. Stop it or wait before sending again.');
      const user: Message = { id: id(), conversationId, role: 'user', text, time: Date.now() };
      data.messages.push(user); emit({ type: 'message', message: user });
      c.updated = Date.now(); if (c.title === 'New conversation') c.title = text.slice(0, 45);
      if (agent.role === 'main') {
        const worker: Agent = { id: id(), projectId: c.projectId, parentId: agent.id, role: 'implementer', title: text.slice(0, 38), state: 'queued', cli: 'codex', model: 'default', effort: 'medium', summary: 'A focused sample assignment; no files will be changed.' };
        data.agents.push(worker); updateAgent(worker);
        agent = worker;
      }
      const run = { cancelled: false }; runs.set(agent.id, run);
      agent.state = 'queued'; updateAgent(agent);
      try {
        await pause(); if (run.cancelled) return;
        agent.state = 'working'; updateAgent(agent);
        if (run.cancelled) return;
        const message: Message = { id: id(), conversationId, role: 'assistant', agentId: c.agentId, text: '', time: Date.now(), details: { cli: agent.cli, model: agent.model, effort: agent.effort, reason: 'Demo routing: reuse a ready connection with project context.' } };
        data.messages.push(message); emit({ type: 'message', message });
        const response = c.agentId.startsWith('main-')
          ? "I've assigned your request to a focused implementation agent.\n\n### Sample result\nThe agent reports that the requested change is ready for review. This demonstration does not edit your files.\n\n```ts\nconst status = 'ready for review';\n```"
          : 'I’ve received your clarification for this assignment.\n\nThis is a sample response. I’ll preserve the scope of my assignment and report progress to the main agent.';
        for (const chunk of response.match(/.{1,18}|\n/g) || []) {
          await pause(); if (run.cancelled) return;
          message.text += chunk; emit({ type: 'messageDelta', messageId: message.id, conversationId, text: chunk });
        }
        agent.state = 'done'; agent.summary = 'Sample assignment completed; no local files modified.'; updateAgent(agent);
        data.windows[0].usedPct = Math.min(100, data.windows[0].usedPct + 3);
        emit({ type: 'usage', windows: data.windows });
        if (!requested && settings.allowFreeReset === 'ask') {
          requested = true;
          const requestId = id();
          permissions.set(requestId, allow => {
            if (allow) { data.windows[1].usedPct = 0; data.windows[1].freeResetAvailable = false; emit({ type: 'usage', windows: data.windows }); }
            const result: Message = { id: id(), conversationId, role: 'system', text: allow ? 'Sample reset approved. No real account was changed.' : 'Sample reset declined. Current allowance is unchanged.', time: Date.now() };
            data.messages.push(result); emit({ type: 'message', message: result });
          });
          emit({ type: 'permission', requestId, kind: 'freeReset', agentId: agent.id, prompt: 'Demo only: use one optional free reset for the sample Claude weekly window? It has 27% remaining and one sample entitlement. A reset restores this window to 100%. The scheduled refresh is in two days. This demonstrates approval handling; no real entitlement is consumed.' });
        }
      } finally { runs.delete(agent.id); }
    },
    async listAgents(projectId) { await pause(); return copy(data.agents.filter(a => a.projectId === projectId)); },
    async openAgentConversation(agentId) {
      const agent = data.agents.find(a => a.id === agentId);
      if (!agent) throw new Error('This agent is no longer available.');
      let c = data.conversations.find(c => c.agentId === agentId);
      if (!c) { c = { id: id(), projectId: agent.projectId, agentId, title: agent.title, updated: Date.now() }; data.conversations.unshift(c); }
      return copy(c);
    },
    async stopAgent(agentId) {
      const a = data.agents.find(a => a.id === agentId);
      if (!a) throw new Error('This agent is no longer available.');
      const affected = data.agents.filter(x => x.id === agentId || (a.role === 'main' && x.parentId === agentId));
      affected.forEach(x => { const run = runs.get(x.id); if (run) run.cancelled = true; x.state = 'stopped'; x.summary = 'Stopped by you. Conversation history retained.'; updateAgent(x); });
    },
    async getUsage() { await pause(); return copy(data.windows); },
    async getSettings() { await pause(); return copy(settings); },
    async setSettings(s) { settings = { ...settings, ...copy(s) }; return copy(settings); },
    async answerPermission(requestId, allow) {
      const resolve = permissions.get(requestId);
      if (!resolve) throw new Error('This permission request is no longer pending.');
      permissions.delete(requestId); resolve(allow);
    },
    onEvent(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; }
  };
  return api;
}

export function installMockApi() {
  if (window.harbor === undefined) {
    window.harbor = createMockApi({ empty: new URLSearchParams(window.location.search).has('firstRun') });
    document.documentElement.dataset.demo = 'true';
  }
}
