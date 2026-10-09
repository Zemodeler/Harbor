import type { HarborApi } from './api';

/** Request/response methods exposed over IPC (everything on HarborApi except onEvent). */
export type InvokeMethod = Exclude<keyof HarborApi, 'onEvent'>;

export const INVOKE_METHODS: InvokeMethod[] = [
  'listClis', 'refreshClis', 'openLogin',
  'listProjects', 'addProject', 'removeProject', 'setProjectImage',
  'listConversations', 'newConversation', 'deleteConversation',
  'updateConversation', 'searchConversations', 'stopConversation', 'getReview', 'openProjectFolder',
  'getGitOverview', 'getGitLog', 'getGitChanges', 'getGitDiff',
  'listMessages', 'send',
  'listAgents', 'openAgentConversation', 'stopAgent', 'resumeAgent',
  'getUsage', 'getSettings', 'setSettings', 'answerPermission', 'answerQuestion'
];

export const channel = (m: InvokeMethod): string => `harbor:${m}`;
export const EVENT_CHANNEL = 'harbor:event';
