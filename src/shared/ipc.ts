import type { HarborApi } from './api';

/** Request/response methods exposed over IPC (everything on HarborApi except onEvent and the preload-only pathForFile). */
export type InvokeMethod = Exclude<keyof HarborApi, 'onEvent' | 'pathForFile'>;

export const INVOKE_METHODS: InvokeMethod[] = [
  'listClis', 'refreshClis', 'openLogin', 'testCliPath', 'browseCliPath',
  'listCustomClis', 'listCliTemplates', 'dryRunCustomCli', 'saveCustomCli', 'removeCustomCli',
  'listSkills', 'readSkill', 'setSkillEnabled', 'previewSkillImport', 'importSkills', 'removeSkill', 'browseSkillSource',
  'listMcpServers', 'saveMcpServer', 'removeMcpServer', 'setMcpServerEnabled', 'testMcpServer', 'listCliMcpServers',
  'listProjects', 'addProject', 'removeProject', 'setProjectImage',
  'listConversations', 'newConversation', 'deleteConversation',
  'updateConversation', 'searchConversations', 'stopConversation', 'getReview', 'openProjectFolder', 'openWorkspace',
  'getGitOverview', 'getGitLog', 'getGitLogPage', 'getGitChanges', 'getGitDiff',
  'listMessages', 'send', 'setConversationMode', 'setConversationDeadline',
  'listAgents', 'openAgentConversation', 'stopAgent',
  'setAgentPriority', 'pauseAgent', 'resumeAgent', 'resumeAgentSession',
  'integrateBranches', 'applyIntegration', 'getChanges', 'previewRollback', 'rollbackTask',
  'getUsage', 'getSettings', 'setSettings', 'answerPermission', 'previewScreenshot', 'answerScreenshot', 'listPendingPermissions', 'answerQuestion',
  'openDocument', 'pickDocument', 'documentAction',
  'listToolRules', 'removeToolRule', 'exportDiagnostics',
  'previewBundleExport', 'exportBundle', 'browseImportFile', 'previewBundle', 'importBundle',
  'listImportSources', 'previewImport', 'importConversation', 'continueImported',
  'getSpendStatus', 'renameProject', 'listProjectNotes', 'removeProjectNote',
  'createRemoteToken', 'listRemoteTokens', 'revokeRemoteToken',
  'getTaskReport', 'rateResult', 'listRatings', 'getRatingSummary', 'replayRouting'
];

export const channel = (m: InvokeMethod): string => `harbor:${m}`;
export const EVENT_CHANNEL = 'harbor:event';
