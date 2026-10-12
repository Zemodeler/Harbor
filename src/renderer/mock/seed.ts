import type { Agent, CliStatus, Conversation, Message, Project, UsageWindow } from '../../shared/api';

// Sample commits (the same hashes the mock Git view shows).
const C_HEAD = 'c3a9e1f0b2d4c6e8a0f1b3d5c7e9a1b3c5d7e9f1', demoBase = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

export function seed(empty = false) {
  const now = Date.now();
  const projects: Project[] = empty ? [] : [
    { id: 'store', name: 'Storefront', path: 'C:\\Projects\\Storefront', lastOpened: now },
    { id: 'harbor', name: 'Harbor', path: 'C:\\Projects\\Harbor', lastOpened: now - 86400000 },
    { id: 'tools', name: 'Internal tools', path: 'C:\\Projects\\Tools', lastOpened: now - 172800000 }
  ];
  const clis: CliStatus[] = [
    { id: 'codex', name: 'Codex', installed: true, version: 'demo', signedIn: true, models: ['default', 'gpt-5-codex'], note: 'Sample connection' },
    { id: 'claude', name: 'Claude Code', installed: true, version: 'demo', signedIn: false, models: ['default', 'sonnet', 'opus'], note: 'Sample connection' },
    { id: 'gemini', name: 'Gemini', installed: false, signedIn: false, models: [], note: 'Not installed in this demo' }
  ];
  const conversations: Conversation[] = empty ? [] : [
    { id: 'account', projectId: 'store', title: 'Build the account page', updated: now, agentId: 'main-store' },
    { id: 'checkout', projectId: 'store', title: 'Polish the checkout', updated: now - 3600000, agentId: 'main-store' },
    { id: 'search', projectId: 'store', title: 'Explore product search', updated: now - 7200000, agentId: 'main-store' }
  ];
  const agents: Agent[] = projects.map(p => ({ id: `main-${p.id}`, projectId: p.id, role: 'main', title: 'Main agent', state: 'waiting', cli: 'codex', model: 'default', effort: 'medium' }));
  if (!empty) agents.push(
    { id: 'implement', projectId: 'store', parentId: 'main-store', conversationId: 'account', role: 'implementer', title: 'Implement account page', state: 'waiting', cli: 'codex', model: 'default', effort: 'medium', worktree: 'C:\\Harbor\\worktrees\\store\\implement-account-page-1a2b3c', testedCommit: C_HEAD, summary: 'Sample preview: profile and address form prepared. Empty address state still needs review.',
      result: { outcome: 'partial', summary: 'Profile form and address list done; empty address state still open.', checks: [{ cmd: 'npm test', ok: true }, { cmd: 'npm run lint', ok: true }], commit: C_HEAD },
      checks: [{ cmd: 'npm test', ok: true, exitCode: 0, durationMs: 18400 }, { cmd: 'npm run typecheck', ok: false, exitCode: 2, durationMs: 9200 }, { cmd: 'npm run e2e', ok: false, exitCode: null, timedOut: true, durationMs: 120000 }] },
    { id: 'plan', projectId: 'store', parentId: 'main-store', conversationId: 'account', role: 'planner', title: 'Plan account page', state: 'done', cli: 'codex', model: 'default', effort: 'high', summary: 'Sample specification: profile, address list, and accessible validation.', result: { outcome: 'done', summary: 'Specification written.', checks: [] } },
    { id: 'verify', projectId: 'store', parentId: 'main-store', conversationId: 'account', role: 'reviewer', title: 'Verify account flow', state: 'done', cli: 'codex', model: 'default', effort: 'medium', testedCommit: 'a0b1c2d3e4f5061728394a5b6c7d8e9f01234567', outdated: true, summary: 'Sample review: profile and address flows reviewed; final empty state pending.',
      result: { outcome: 'done', summary: 'Approved the profile and address flows.', verdict: 'approve', checks: [{ cmd: 'npm test', ok: true }], commit: 'a0b1c2d3e4f5061728394a5b6c7d8e9f01234567' } },
    { id: 'verify-b', projectId: 'store', parentId: 'main-store', conversationId: 'account', role: 'reviewer', title: 'Second review of the address form', state: 'done', cli: 'codex', model: 'default', effort: 'medium', summary: 'Sample review that ended without a verdict.', result: { outcome: 'blocked', summary: 'Could not run the app to review the form.', checks: [] } },
    { id: 'verify-c', projectId: 'store', parentId: 'main-store', conversationId: 'account', role: 'reviewer', title: 'Review the validation', state: 'done', cli: 'codex', model: 'default', effort: 'medium', testedCommit: C_HEAD, summary: 'Sample review asking for changes.', result: { outcome: 'done', summary: 'Error messages are not announced to screen readers.', verdict: 'changes', checks: [], commit: C_HEAD } },
    { id: 'stopped-helper', projectId: 'store', parentId: 'main-store', conversationId: 'account', role: 'implementer', title: 'Add address autocomplete', state: 'stopped', cli: 'codex', model: 'default', effort: 'medium', worktree: 'C:\\Harbor\\worktrees\\store\\address-autocomplete-4d5e6f', summary: 'Stopped by you. Conversation history retained.' },
    { id: 'integrate-1', projectId: 'store', parentId: 'main-store', conversationId: 'account', role: 'other', title: 'Integrate account work', state: 'done', cli: 'codex', model: 'default', effort: 'medium', testedCommit: 'e1f2a3b4c5d6071829304a5b6c7d8e9f0a1b2c3d', summary: 'Merged 2 branches; checks passed.',
      integration: { target: 'main', base: demoBase, branch: 'harbor/integrate-account-7a8b9c', head: 'e1f2a3b4c5d6071829304a5b6c7d8e9f0a1b2c3d', sources: [
        { agentId: 'implement', branch: 'harbor/implement-account-page-1a2b3c', commit: C_HEAD, state: 'merged', merge: 'f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d' },
        { agentId: 'stopped-helper', branch: 'harbor/address-autocomplete-4d5e6f', commit: '5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7', state: 'pending' }] },
      checks: [{ cmd: 'npm test', ok: true, exitCode: 0, durationMs: 21000 }] },
    { id: 'integrate-2', projectId: 'store', parentId: 'main-store', conversationId: 'account', role: 'other', title: 'Integrate checkout fixes', state: 'failed', cli: 'codex', model: 'default', effort: 'medium', summary: 'Merge conflict in src/checkout.tsx; nothing was applied.',
      integration: { target: 'main', base: demoBase, branch: 'harbor/integrate-checkout-1d2e3f', sources: [{ agentId: 'implement', branch: 'harbor/implement-account-page-1a2b3c', commit: C_HEAD, state: 'conflict' }], conflicts: ['src/checkout.tsx'] } },
    { id: 'rollback-1', projectId: 'store', parentId: 'main-store', conversationId: 'account', role: 'other', title: 'Roll back Implement account page', state: 'done', cli: 'codex', model: 'default', effort: 'medium', outdated: true, testedCommit: '0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e', summary: 'Reverted 2 merges; checks passed.',
      rollback: { taskId: 'implement', target: 'main', base: demoBase, branch: 'harbor/rollback-account-3c4d5e', head: '0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e', merges: [
        { commit: 'f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d', agentId: 'implement', integrationId: 'integrate-1', state: 'reverted', revert: '9e8d7c6b5a4938271605f4e3d2c1b0a998877665' },
        { commit: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d', agentId: 'implement', state: 'pending' }] },
      checks: [{ cmd: 'npm test', ok: true, exitCode: 0, durationMs: 19000 }] },
    { id: 'queued-1', projectId: 'store', parentId: 'main-store', conversationId: 'search', role: 'implementer', title: 'Index product titles', state: 'queued', cli: 'codex', model: 'default', effort: 'medium', priority: 1, summary: 'Waiting for a free slot.' },
    { id: 'queued-2', projectId: 'store', parentId: 'main-store', conversationId: 'search', role: 'planner', title: 'Plan faceted filters', state: 'queued', cli: 'codex', model: 'default', effort: 'high', paused: true, summary: 'Waiting for “Index product titles” to finish.' }
  );
  const messages: Message[] = empty ? [] : [
    { id: 'user-intro', conversationId: 'account', role: 'user', time: now - 60000, text: 'Build an account page where customers can update their profile and manage their addresses. Keep it consistent with the storefront.' },
    { id: 'tool-read', conversationId: 'account', role: 'tool', agentId: 'main-store', time: now - 59000, text: 'Read src/account.tsx\nSample file inspection; no local files read.' },
    { id: 'tool-search', conversationId: 'account', role: 'tool', agentId: 'main-store', time: now - 58000, text: 'Grep address validation\nSample search activity.' },
    { id: 'tool-command', conversationId: 'account', role: 'tool', agentId: 'main-store', time: now - 57000, text: 'Bash npm test\nSample command activity; no command was executed.' },
    { id: 'intro', conversationId: 'account', role: 'assistant', agentId: 'main-store', time: now - 55000, text: "I've assigned the account page to an implementation agent using the completed plan. The verification agent has checked the profile and address flows.\n\n### Ready for a first look\nThe implementation agent reports that the profile form and address list are ready. It’s finishing the empty address state before the final review.\n\nThis is sample activity. No project files have been changed.", details: { cli: 'codex', model: 'default', effort: 'medium', reason: 'A ready connection with useful project context.' } }
  ];
  const windows: UsageWindow[] = [
    { cli: 'codex', label: 'Sample 5-hour window', usedPct: 38, resetsAt: now + 7200000, period: 'session', source: 'estimated', projectedPct: 64 },
    { cli: 'claude', label: 'Sample weekly window', usedPct: 73, resetsAt: now + 172800000, freeResetAvailable: true, period: 'weekly', source: 'reported' },
    { cli: 'codex', label: 'Sample weekly window', usedPct: 21, resetsAt: now + 345600000, period: 'weekly', source: 'reported', model: 'default' }
  ];
  return { projects, clis, conversations, agents, messages, windows };
}
