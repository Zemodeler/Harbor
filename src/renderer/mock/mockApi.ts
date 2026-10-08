import type { HarborApi, HarborEvent, Agent, Message, Settings } from '../../shared/api';
import { seed } from './seed';

export function createMockApi(options: { empty?: boolean; delay?: number } = {}): HarborApi {
  const data = seed(options.empty);
  const listeners = new Set<(e: HarborEvent) => void>();
  const runs = new Map<string, { cancelled: boolean }>();
  const permissions = new Map<string, (allow: boolean) => void>();
  const questions = new Map<string, string>();
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
    async setProjectImage(projectId, image) {
      const p = data.projects.find(x => x.id === projectId);
      if (!p) throw new Error('Unknown project');
      if (image) p.image = image; else delete p.image;
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
    async deleteConversation(id) { await pause(); data.conversations = data.conversations.filter(c => c.id !== id); },
    async listConversations(projectId) { await pause(); return copy(data.conversations.filter(c => c.projectId === projectId)); },
    async updateConversation(conversationId, patch) {
      const c = requireConversation(conversationId);
      if (patch.title !== undefined && !patch.title.trim()) throw new Error('Enter a conversation name.');
      Object.assign(c, patch, patch.title !== undefined ? { customTitle: true } : {});
      emit({ type: 'conversation', conversation: c }); return copy(c);
    },
    async searchConversations(query, projectId) {
      const term = query.trim().toLowerCase();
      return copy(data.conversations.filter(c => (!projectId || c.projectId === projectId) && (c.title.toLowerCase().includes(term) || data.messages.some(m => m.conversationId === c.id && m.text.toLowerCase().includes(term)))).map(c => ({ conversation: c, projectName: data.projects.find(p => p.id === c.projectId)?.name || '', excerpt: data.messages.find(m => m.conversationId === c.id && m.text.toLowerCase().includes(term))?.text.slice(0, 180) })));
    },
    async stopConversation(conversationId) {
      const c = requireConversation(conversationId);
      const affected = data.agents.filter(a => a.conversationId === c.id || a.role !== 'main' && a.id === c.agentId);
      affected.forEach(a => { const run = runs.get(a.id); if (run) run.cancelled = true; a.state = 'stopped'; updateAgent(a); });
      c.activity = { ...c.activity, state: 'stopped', updated: Date.now(), detail: 'Stopped by you.' }; emit({ type: 'conversation', conversation: c });
    },
    async getReview(conversationId) { requireConversation(conversationId); return { conversationId, capturedAt: Date.now(), files: [], notes: ['Demo only. No project files have been changed.', 'Verification has not been tied to this snapshot.'] }; },
    async openProjectFolder() { throw new Error('Opening folders is available in the desktop app.'); },
    async newConversation(projectId) {
      if (!data.projects.some(p => p.id === projectId)) throw new Error('Open a project first.');
      const c = { id: id(), projectId, title: 'New conversation', updated: Date.now(), agentId: `main-${projectId}` };
      data.conversations.unshift(c); return copy(c);
    },
    async listMessages(conversationId) { requireConversation(conversationId); await pause(); return copy(data.messages.filter(m => m.conversationId === conversationId)); },
    async send(conversationId, text) {
      const c = requireConversation(conversationId);
      if (c.archived) throw new Error('Restore this conversation before sending a message.');
      if (!text.trim()) throw new Error('Write a message first.');
      if (!data.clis.some(cli => cli.installed && cli.signedIn && settings.cliOverrides[cli.id]?.enabled !== false)) throw new Error('Enable and sign in to a connection in Settings.');
      let agent = data.agents.find(a => a.id === c.agentId)!;
      if (runs.has(agent.id)) throw new Error('This agent is still working. Stop it or wait before sending again.');
      const user: Message = { id: id(), conversationId, role: 'user', text, time: Date.now() };
      data.messages.push(user); emit({ type: 'message', message: user });
      c.updated = Date.now(); if (c.title === 'New conversation') c.title = text.slice(0, 45);
      if (/ask me a question/i.test(text)) {
        const requestId = id(); questions.set(requestId, conversationId);
        c.activity = { state: 'waiting', updated: Date.now(), detail: 'Waiting for your design preference.' };
        emit({ type: 'conversation', conversation: c });
        emit({ type: 'question', requestId, conversationId, agentId: c.agentId, prompt: 'Which direction should we use for the account page?', options: ['Keep it clean and familiar', 'Use a warmer, softer palette', 'Give it a more compact layout'], allowText: true });
        return;
      }
      if (agent.role === 'main') {
        const worker: Agent = { id: id(), projectId: c.projectId, parentId: agent.id, conversationId: c.id, role: 'implementer', title: text.slice(0, 38), state: 'queued', cli: 'codex', model: 'default', effort: 'medium', summary: 'A focused sample assignment; no files will be changed.' };
        data.agents.push(worker); updateAgent(worker);
        agent = worker;
      }
      const run = { cancelled: false }; runs.set(agent.id, run);
      c.activity = { state: 'working', started: Date.now(), updated: Date.now(), cli: agent.cli, model: agent.model, detail: 'Sample implementation in progress.' }; emit({ type: 'conversation', conversation: c });
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
        c.activity = { ...c.activity, state: 'done', updated: Date.now(), detail: 'Sample session finished.' }; emit({ type: 'conversation', conversation: c });
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
    async answerQuestion(requestId, answer) {
      const c = data.conversations.find(c => c.id === questions.get(requestId)) || data.conversations[0];
      if (!c) throw new Error('This question is no longer pending.');
      questions.delete(requestId);
      const m: Message = { id: id(), conversationId: c.id, role: 'user', text: answer, time: Date.now() };
      data.messages.push(m); emit({ type: 'message', message: m });
      c.activity = { state: 'done', updated: Date.now(), detail: 'Sample answer received.' }; emit({ type: 'conversation', conversation: c });
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
