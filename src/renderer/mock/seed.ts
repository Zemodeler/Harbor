import type { Agent, CliStatus, Conversation, Message, Project, UsageWindow } from '../../shared/api';

export function seed(empty = false) {
  const now = Date.now();
  const projects: Project[] = empty ? [] : [
    { id: 'store', name: 'Storefront', path: 'C:\\Projects\\Storefront', lastOpened: now },
    { id: 'harbor', name: 'Harbor', path: 'C:\\Projects\\Harbor', lastOpened: now - 86400000 },
    { id: 'tools', name: 'Internal tools', path: 'C:\\Projects\\Tools', lastOpened: now - 172800000 }
  ];
  const clis: CliStatus[] = [
    { id: 'codex', name: 'Codex', installed: true, version: 'demo', signedIn: true, models: ['default'], note: 'Sample connection' },
    { id: 'claude', name: 'Claude Code', installed: true, version: 'demo', signedIn: false, models: ['default'], note: 'Sample connection' },
    { id: 'gemini', name: 'Gemini', installed: false, signedIn: false, models: [], note: 'Not installed in this demo' }
  ];
  const conversations: Conversation[] = empty ? [] : [
    { id: 'account', projectId: 'store', title: 'Build the account page', updated: now, agentId: 'main-store' },
    { id: 'checkout', projectId: 'store', title: 'Polish the checkout', updated: now - 3600000, agentId: 'main-store' },
    { id: 'search', projectId: 'store', title: 'Explore product search', updated: now - 7200000, agentId: 'main-store' }
  ];
  const agents: Agent[] = projects.map(p => ({ id: `main-${p.id}`, projectId: p.id, role: 'main', title: 'Main agent', state: 'waiting', cli: 'codex', model: 'default', effort: 'medium' }));
  if (!empty) agents.push(
    { id: 'implement', projectId: 'store', parentId: 'main-store', role: 'implementer', title: 'Implement account page', state: 'waiting', cli: 'codex', model: 'default', effort: 'medium', summary: 'Sample preview: profile and address form prepared. Empty address state still needs review.' },
    { id: 'plan', projectId: 'store', parentId: 'main-store', role: 'planner', title: 'Plan account page', state: 'done', cli: 'codex', model: 'default', effort: 'high', summary: 'Sample specification: profile, address list, and accessible validation.' },
    { id: 'verify', projectId: 'store', parentId: 'main-store', role: 'reviewer', title: 'Verify account flow', state: 'done', cli: 'codex', model: 'default', effort: 'medium', summary: 'Sample review: profile and address flows reviewed; final empty state pending.' }
  );
  const messages: Message[] = empty ? [] : [
    { id: 'user-intro', conversationId: 'account', role: 'user', time: now - 60000, text: 'Build an account page where customers can update their profile and manage their addresses. Keep it consistent with the storefront.' },
    { id: 'intro', conversationId: 'account', role: 'assistant', agentId: 'main-store', time: now - 55000, text: "I've assigned the account page to an implementation agent using the completed plan. The verification agent has checked the profile and address flows.\n\n### Ready for a first look\nThe implementation agent reports that the profile form and address list are ready. It’s finishing the empty address state before the final review.\n\nThis is sample activity. No project files have been changed.", details: { cli: 'codex', model: 'default', effort: 'medium', reason: 'A ready connection with useful project context.' } }
  ];
  const windows: UsageWindow[] = [
    { cli: 'codex', label: 'Sample 5-hour window', usedPct: 38, resetsAt: now + 7200000 },
    { cli: 'claude', label: 'Sample weekly window', usedPct: 73, resetsAt: now + 172800000, freeResetAvailable: true }
  ];
  return { projects, clis, conversations, agents, messages, windows };
}
