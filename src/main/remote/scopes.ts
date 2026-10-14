import type { PendingPermission, RemoteScope } from '../../shared/api';
import type { InvokeMethod } from '../../shared/ipc';

/** The least scope a method needs remotely; 'never' = desktop only. */
export type MethodClass = RemoteScope | 'never';

/**
 * Every contract method is classified here on purpose (a test checks that INVOKE_METHODS and this table match), and anything
 * missing is denied at runtime. 'never': it acts on the desktop itself (opens windows, terminals, a sign-in, a folder picker),
 * adds a folder agents will then work in, or manages remote access, so a remote client can never widen its own reach.
 */
export const METHOD_SCOPE: Record<InvokeMethod, MethodClass> = {
  listClis: 'read-only', listProjects: 'read-only', listConversations: 'read-only', searchConversations: 'read-only',
  getReview: 'read-only', getGitOverview: 'read-only', getGitLog: 'read-only', getGitLogPage: 'read-only',
  getGitChanges: 'read-only', getGitDiff: 'read-only', listMessages: 'read-only', listAgents: 'read-only',
  getChanges: 'read-only', previewRollback: 'read-only', getUsage: 'read-only', getSettings: 'read-only',
  listToolRules: 'read-only', listPendingPermissions: 'read-only',

  answerPermission: 'answer-permissions', answerQuestion: 'answer-permissions',

  send: 'full', newConversation: 'full', deleteConversation: 'full', updateConversation: 'full', stopConversation: 'full',
  setConversationMode: 'full', setConversationDeadline: 'full', stopAgent: 'full', openAgentConversation: 'full',
  setAgentPriority: 'full', pauseAgent: 'full', resumeAgent: 'full', resumeAgentSession: 'full',
  integrateBranches: 'full', applyIntegration: 'full', rollbackTask: 'full', setSettings: 'full', removeToolRule: 'full',
  refreshClis: 'full', setProjectImage: 'full', removeProject: 'full',

  openLogin: 'never', addProject: 'never', openProjectFolder: 'never', openWorkspace: 'never', exportDiagnostics: 'never',
  createRemoteToken: 'never', listRemoteTokens: 'never', revokeRemoteToken: 'never'
};

const RANK: Record<RemoteScope, number> = { 'read-only': 0, 'answer-permissions': 1, full: 2 };

/** Default deny: unknown names, inherited keys and 'never' methods are refused for every scope. */
export function scopeAllows(scope: RemoteScope, method: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(METHOD_SCOPE, method)) return false;
  const need = METHOD_SCOPE[method as InvokeMethod];
  if (need === 'never' || !(scope in RANK)) return false;
  return RANK[scope] >= RANK[need];
}

/**
 * Rules finer than a method: the answer to a free reset spends the owner's reset and is only ever given at the desktop;
 * "always allow" stores a standing rule, which needs full scope; settings can never change remote access remotely.
 * Returns a refusal message, or undefined when the call may go ahead.
 */
export function remoteCallRefusal(method: string, args: unknown[], scope: RemoteScope, pending: () => Promise<PendingPermission[]>): Promise<string | undefined> | string | undefined {
  if (method === 'answerPermission') {
    const [requestId, , opts] = args;
    if (opts !== undefined && opts !== null && (opts as { always?: unknown }).always === true && scope !== 'full') return 'Remembering an answer ("always allow") needs a full-scope token.';
    return pending().then((list) => {
      const p = list.find((x) => x.requestId === requestId);
      if (!p) return 'No such permission request is waiting.';
      if (p.kind === 'freeReset') return 'A free reset can only be answered in the Harbor app.';
      return undefined;
    });
  }
  if (method === 'setSettings') {
    const patch = args[0];
    if (patch && typeof patch === 'object' && 'remote' in patch) return 'Remote access settings can only be changed in the Harbor app.';
  }
  return undefined;
}
