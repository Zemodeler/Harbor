import type { HarborApi } from './api';

/** Request/response methods exposed over IPC (everything on HarborApi except onEvent). */
export type InvokeMethod = Exclude<keyof HarborApi, 'onEvent'>;

export const INVOKE_METHODS: InvokeMethod[] = [
  'listClis', 'refreshClis', 'openLogin', 'testCliPath', 'browseCliPath',
  'listCustomClis', 'listCliTemplates', 'dryRunCustomCli', 'saveCustomCli', 'removeCustomCli',
  'listProjects', 'addProject', 'removeProject', 'setProjectImage',
  'listConversations', 'newConversation', 'deleteConversation',
  'updateConversation', 'searchConversations', 'stopConversation', 'getReview', 'openProjectFolder', 'openWorkspace',
  'getGitOverview', 'getGitLog', 'getGitLogPage', 'getGitChanges', 'getGitDiff',
  'listMessages', 'send', 'setConversationMode', 'setConversationDeadline',
  'listAgents', 'openAgentConversation', 'stopAgent',
  'setAgentPriority', 'pauseAgent', 'resumeAgent', 'resumeAgentSession',
  'integrateBranches', 'applyIntegration', 'getChanges', 'previewRollback', 'rollbackTask',
  'getUsage', 'getSettings', 'setSettings', 'answerPermission', 'listPendingPermissions', 'answerQuestion',
  'listToolRules', 'removeToolRule', 'exportDiagnostics'
];

export const channel = (m: InvokeMethod): string => `harbor:${m}`;
export const EVENT_CHANNEL = 'harbor:event';
