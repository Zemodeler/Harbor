import type { HarborApi, HarborEvent, Agent, GitCommit, GitFileChange, Message, Settings } from '../../shared/api';
import { seed } from './seed';

const demoBranch = 'harbor/implement-account-page-1a2b3c';
const demoCommits: GitCommit[] = [
  { hash: 'c3a9e1f0b2d4c6e8a0f1b3d5c7e9a1b3c5d7e9f1', parents: ['a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'], subject: 'Add account page form', author: 'Harbor', time: Date.now() - 1800000, refs: [demoBranch] },
  { hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', parents: ['9f8e7d6c5b4a39281706f5e4d3c2b1a098765432', '1234567890abcdef1234567890abcdef12345678'], subject: 'Merge checkout polish', author: 'Sample author', time: Date.now() - 7200000, refs: ['HEAD -> main'] },
  { hash: '1234567890abcdef1234567890abcdef12345678', parents: ['9f8e7d6c5b4a39281706f5e4d3c2b1a098765432'], subject: 'Polish checkout spacing', author: 'Sample author', time: Date.now() - 86400000, refs: [] },
  { hash: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432', parents: [], subject: 'Initial storefront', author: 'Sample author', time: Date.now() - 172800000, refs: [] }
];
const demoChanges: GitFileChange[] = [
  { path: 'src/account.tsx', status: 'modified', additions: 2, deletions: 1 },
  { path: 'src/address.tsx', status: 'added', additions: 24, deletions: 0 },
  { path: '.env.local', status: 'untracked', hidden: true }
];

export function createMockApi(options: { empty?: boolean; delay?: number } = {}): HarborApi {
  const data = seed(options.empty);
  const listeners = new Set<(e: HarborEvent) => void>();
  const runs = new Map<string, { cancelled: boolean }>();
  const permissions = new Map<string, (allow: boolean) => void>();
  const pendingPermissions = new Map<string, Extract<HarborEvent, { type: 'permission' }>>();
  const questions = new Map<string, string>();
  let settings: Settings = { routing: 'auto', cliOverrides: { codex: { enabled: true }, claude: { enabled: true }, gemini: { enabled: false } }, allowFreeReset: 'ask' };
  let requested = false;
  const copy = <T,>(v: T): T => structuredClone(v);
  const emit = (e: HarborEvent) => {
    if (e.type === 'permission') pendingPermissions.set(e.requestId, copy(e));
    listeners.forEach(cb => cb(copy(e)));
  };
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
    async getGitOverview(projectId) {
      const p = data.projects.find(x => x.id === projectId);
      if (!p) throw new Error(`Unknown project ${projectId}`);
      if (projectId !== 'store') return { projectId, branches: [], worktrees: [], notes: ['This project folder is not a Git repository.'] };
      const helper = data.agents.find(a => a.id === 'implement');
      return { projectId, base: 'main', current: 'main', notes: ['Demo only. This history is sample data.'], branches: [
        { name: 'main', head: demoCommits[1].hash, subject: demoCommits[1].subject, updated: demoCommits[1].time, current: true },
        { name: demoBranch, head: demoCommits[0].hash, subject: demoCommits[0].subject, updated: demoCommits[0].time, ahead: 1, behind: 0, worktree: 'C:\\Harbor\\worktrees\\store\\implement-account-page-1a2b3c', ...(helper ? { agentId: helper.id, agentTitle: helper.title, agentState: helper.state } : {}) }
      ], worktrees: [
        { path: p.path, head: demoCommits[1].hash, branch: 'main', changed: 1, main: true },
        { path: 'C:\\Harbor\\worktrees\\store\\implement-account-page-1a2b3c', head: demoCommits[0].hash, branch: demoBranch, changed: 0 }
      ] };
    },
    async getGitLog(projectId, opts) { if (projectId !== 'store') throw new Error('This project folder is not a Git repository.'); return copy(opts?.branch === 'main' ? demoCommits.slice(1) : demoCommits); },
    async getGitChanges(projectId, target) { if (projectId !== 'store') throw new Error('This project folder is not a Git repository.'); return copy(target?.branch || target?.commit ? demoChanges : [{ path: 'README.md', status: 'modified' as const, additions: 1, deletions: 0 }]); },
    async getGitDiff(projectId, path) {
      if (projectId !== 'store') throw new Error('This project folder is not a Git repository.');
      return path === 'src/account.tsx' ? 'diff --git a/src/account.tsx b/src/account.tsx\n@@ -1,3 +1,4 @@\n export function Account() {\n-  return null;\n+  // Sample change; no project files were edited.\n+  return <AccountForm/>;\n }' : `diff --git a/${path} b/${path}\n@@ -1 +1,2 @@\n Sample file\n+Sample change`;
    },
    async newConversation(projectId) {
      if (!data.projects.some(p => p.id === projectId)) throw new Error('Open a project first.');
      const c = { id: id(), projectId, title: 'New conversation', updated: Date.now(), agentId: `main-${projectId}` };
      data.conversations.unshift(c); return copy(c);
    },
    async listMessages(conversationId) { requireConversation(conversationId); await pause(); return copy(data.messages.filter(m => m.conversationId === conversationId)); },
    async setConversationMode(conversationId, mode, goal) {
      const c = requireConversation(conversationId);
      if (mode === 'goal' && !goal?.trim()) throw new Error('Describe the goal first.');
      c.mode = mode;
      if (mode === 'goal') c.goal = goal!.trim(); else delete c.goal;
      emit({ type: 'conversation', conversation: c }); return copy(c);
    },
    async send(conversationId, text, attachments) {
      const c = requireConversation(conversationId);
      if (c.archived) throw new Error('Restore this conversation before sending a message.');
      if (attachments && attachments.length > 6) throw new Error('You can attach up to 6 images per message.');
      if (attachments?.some(a => !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(a.mime) || a.dataBase64.length * 0.75 > 10 * 1024 * 1024)) throw new Error('Images must be PNG, JPEG, GIF or WebP and under 10 MB.');
      if (!text.trim() && !attachments?.length) throw new Error('Write a message first.');
      text = text.trim() ? text : 'See the attached image(s).';
      if (!data.clis.some(cli => cli.installed && cli.signedIn && settings.cliOverrides[cli.id]?.enabled !== false)) throw new Error('Enable and sign in to a connection in Settings.');
      let agent = data.agents.find(a => a.id === c.agentId)!;
      if (runs.has(agent.id)) throw new Error('This agent is still working. Stop it or wait before sending again.');
      const user: Message = { id: id(), conversationId, role: 'user', text, time: Date.now(), ...(attachments?.length ? { attachments: attachments.map(a => ({ name: a.name, mime: a.mime })) } : {}) };
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
      c.activity = { state: 'working', started: Date.now(), updated: Date.now(), cli: agent.cli, model: agent.model, detail: 'Sample implementation in progress.', complexity: text.length > 200 || /refactor|migrate|redesign/i.test(text) ? 'high' : text.length > 60 ? 'medium' : 'low', effort: agent.effort }; emit({ type: 'conversation', conversation: c });
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
    // Queue controls exist in the contract; this demo has no queue UI, so they only validate the agent.
    async setAgentPriority(agentId, priority) { const x = data.agents.find(a => a.id === agentId); if (!x) throw new Error('This agent is no longer available.'); x.priority = priority; updateAgent(x); },
    async pauseAgent(agentId) { const x = data.agents.find(a => a.id === agentId); if (!x) throw new Error('This agent is no longer available.'); if (x.state === 'queued') { x.paused = true; updateAgent(x); } },
    async resumeAgent(agentId) { const x = data.agents.find(a => a.id === agentId); if (!x) throw new Error('This agent is no longer available.'); x.paused = false; updateAgent(x); },
    async resumeAgentSession(agentId) { const x = data.agents.find(a => a.id === agentId); if (!x || x.state !== 'stopped') throw new Error('Only a stopped agent can be resumed.'); x.state = 'working'; updateAgent(x); },
    // The browser demo must not pretend to apply changes to a real Git checkout.
    async integrateBranches() { throw new Error('Branch integration is available in the desktop app.'); },
    async applyIntegration() { throw new Error('Applying integration is available in the desktop app.'); },
    async getChanges(agentId) {
      if (!data.agents.some(a => a.id === agentId)) throw new Error('This agent is no longer available.');
      return copy(agentId === 'implement' ? demoChanges : []);
    },
    async previewRollback() { return { supported: false, notes: ['Task rollback is available in the desktop app.'] }; },
    async rollbackTask() { throw new Error('Task rollback is available in the desktop app.'); },
    async listToolRules() { return []; },
    async removeToolRule() { return []; },
    async listPendingPermissions() { return copy([...pendingPermissions.values()]); },
    async getUsage() { await pause(); return copy(data.windows); },
    async getSettings() { await pause(); return copy(settings); },
    async setSettings(s) { settings = { ...settings, ...copy(s) }; return copy(settings); },
    async answerPermission(requestId, allow) {
      const resolve = permissions.get(requestId);
      if (!resolve) throw new Error('This permission request is no longer pending.');
      permissions.delete(requestId); pendingPermissions.delete(requestId); resolve(allow);
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
