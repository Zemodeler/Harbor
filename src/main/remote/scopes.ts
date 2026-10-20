import type { PendingPermission, RemoteScope } from '../../shared/api';
import type { InvokeMethod } from '../../shared/ipc';
import { SECRET_TOOL } from '../secretScan';
import { SPEND_TOOL } from '../spend';

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
  refreshClis: 'full', setProjectImage: 'full', removeProject: 'full', renameProject: 'full',

  // Added while integrating roadmap wave 1 (main's skills/MCP/custom CLIs/documents/bundles/importers, and contract 0.1.38-0.1.40).
  listCustomClis: 'read-only', listCliTemplates: 'read-only', listSkills: 'read-only', readSkill: 'read-only', listCliMcpServers: 'read-only',
  getSpendStatus: 'read-only', listProjectNotes: 'read-only', getTaskReport: 'read-only', listRatings: 'read-only',
  getRatingSummary: 'read-only', replayRouting: 'read-only',
  setSkillEnabled: 'full', removeProjectNote: 'full', rateResult: 'full',
  // Desktop only: they run or approve executables (CLI paths, custom CLIs, MCP commands), configure what agents may run,
  // capture or show the desktop, read files outside a project (documents, bundles, other tools' transcripts), may hold
  // secret values (MCP env and headers), or start a lead turn that spends quota (continueImported).
  testCliPath: 'never', browseCliPath: 'never', dryRunCustomCli: 'never', saveCustomCli: 'never', removeCustomCli: 'never',
  previewSkillImport: 'never', importSkills: 'never', removeSkill: 'never', browseSkillSource: 'never',
  listMcpServers: 'never', saveMcpServer: 'never', removeMcpServer: 'never', setMcpServerEnabled: 'never', testMcpServer: 'never',
  previewScreenshot: 'never', answerScreenshot: 'never', openDocument: 'never', pickDocument: 'never', documentAction: 'never',
  previewBundleExport: 'never', exportBundle: 'never', browseImportFile: 'never', previewBundle: 'never', importBundle: 'never',
  listImportSources: 'never', previewImport: 'never', importConversation: 'never', continueImported: 'never',

  // Project lifecycle and publish (0.1.47): disk deletion and publishing stay at the desktop, like addProject.
  createProject: 'never', previewDeleteProject: 'never', deleteProject: 'never', previewPush: 'never', pushBranch: 'never',
  createPullRequest: 'never', setRemote: 'never', getGithubStatus: 'never', browseFolder: 'never',

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
      // A yes here spends past a ceiling or integrates possible secrets: only at the desktop. A no is fine from anywhere.
      if (args[1] === true && (p.tool === SPEND_TOOL || p.tool === SECRET_TOOL)) return 'Going past a spend ceiling or a secret-scan finding can only be allowed in the Harbor app.';
      return undefined;
    });
  }
  if (method === 'setSettings') {
    const patch = args[0];
    if (patch && typeof patch === 'object' && 'remote' in patch) return 'Remote access settings can only be changed in the Harbor app.';
  }
  return undefined;
}
