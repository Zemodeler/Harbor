export type Id = string;
export type CliId = 'claude' | 'codex' | 'gemini' | string;
export interface CliStatus { id: CliId; name: string; installed: boolean; version?: string; signedIn: boolean; models: string[]; note?: string; authState?: 'signedIn'|'signedOut'|'unknown' }
export interface Project { id: Id; name: string; path: string; lastOpened: number; image?: string }   // image = small data: URL chosen by the user
export interface Conversation { id: Id; projectId: Id; title: string; updated: number; agentId: Id; pinned?: boolean; archived?: boolean; customTitle?: boolean; activity?: SessionActivity; reviewBase?: string }   // agentId = main agent, or a subagent for direct chats
export interface SessionActivity { state: 'queued'|'working'|'waiting'|'done'|'failed'|'stopped'; started?: number; updated: number; detail?: string; cli?: CliId; model?: string }
export interface SearchHit { conversation: Conversation; projectName: string; excerpt?: string }
export interface ReviewSnapshot { conversationId: Id; capturedAt: number; files: Array<{ path: string; patch: string; source: string; untracked?: boolean }>; notes: string[] }
export type AgentRole = 'main' | 'planner' | 'implementer' | 'reviewer' | 'other';
export type AgentState = 'queued' | 'working' | 'waiting' | 'done' | 'failed' | 'stopped';
export interface Agent { id: Id; projectId: Id; parentId?: Id; role: AgentRole; title: string; state: AgentState; cli: CliId; model: string; effort: 'low'|'medium'|'high'; worktree?: string; summary?: string; conversationId?: Id }   // conversationId = the main-agent conversation that created this subagent
export interface Message { id: Id; conversationId: Id; role: 'user'|'assistant'|'system'|'tool'; text: string; time: number; agentId?: Id; details?: { cli: CliId; model: string; effort: string; reason: string } }
export interface UsageWindow { cli: CliId; label: string; usedPct: number; resetsAt?: number; freeResetAvailable?: boolean; period?: 'session'|'weekly'; source?: 'reported'|'estimated'; model?: string; projectedPct?: number }
export interface Settings { routing: 'auto'|'manual'; cliOverrides: Record<CliId,{enabled:boolean}>; allowFreeReset: 'ask'|'never'; desktopNotifications?: boolean }
export type HarborEvent =
 | { type:'message'; message: Message }
 | { type:'messageDelta'; messageId: Id; conversationId: Id; text: string }
 | { type:'agent'; agent: Agent }
 | { type:'conversation'; conversation: Conversation }
 | { type:'usage'; windows: UsageWindow[] }
 | { type:'cli'; cli: CliStatus }
 | { type:'permission'; requestId: Id; kind:'freeReset'|'tool'|'conflict'; prompt: string; agentId?: Id }
 | { type:'question'; requestId: Id; conversationId: Id; prompt: string; options?: string[]; allowText?: boolean; agentId?: Id };   // an agent needs a decision; answer with answerQuestion
export interface HarborApi {
 listClis(): Promise<CliStatus[]>; refreshClis(): Promise<CliStatus[]>; openLogin(cli: CliId): Promise<void>;
 listProjects(): Promise<Project[]>; addProject(path?: string): Promise<Project|null>; removeProject(id: Id): Promise<void>; setProjectImage(id: Id, image: string | null): Promise<Project>;
 listConversations(projectId: Id): Promise<Conversation[]>; newConversation(projectId: Id): Promise<Conversation>; deleteConversation(id: Id): Promise<void>;
 updateConversation(id: Id, patch: { title?: string; pinned?: boolean; archived?: boolean }): Promise<Conversation>;
 searchConversations(query: string, projectId?: Id): Promise<SearchHit[]>;
 stopConversation(id: Id): Promise<void>;
 getReview(id: Id): Promise<ReviewSnapshot>;
 openProjectFolder(id: Id): Promise<void>;
 listMessages(conversationId: Id): Promise<Message[]>; send(conversationId: Id, text: string): Promise<void>;
 listAgents(projectId: Id): Promise<Agent[]>; openAgentConversation(agentId: Id): Promise<Conversation>; stopAgent(agentId: Id): Promise<void>;
 getUsage(): Promise<UsageWindow[]>;
 getSettings(): Promise<Settings>; setSettings(s: Partial<Settings>): Promise<Settings>;
 answerPermission(requestId: Id, allow: boolean): Promise<void>;
 answerQuestion(requestId: Id, answer: string): Promise<void>;   // delivered into the asking agent's conversation as the user's message
 onEvent(cb: (e: HarborEvent) => void): () => void;   // returns unsubscribe
}
declare global { interface Window { harbor: HarborApi } }
