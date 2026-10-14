export type Id = string;
export type CliId = 'claude' | 'codex' | 'gemini' | string;
export interface CliStatus { id: CliId; name: string; installed: boolean; version?: string; signedIn: boolean; models: string[]; note?: string; authState?: 'signedIn'|'signedOut'|'unknown'; features?: CliFeatures; custom?: boolean }   // features = what Harbor can use on this CLI (CHANGELOG 0.1.31); custom = added by the user as a CustomCliDescriptor
export interface CliFeatures { images: boolean; resume: boolean; structuredOutput: boolean; permissionModes: boolean; readOnly: boolean; mcp: boolean; nativeSkills: boolean; usageReadings: boolean }   // a missing feature never blocks routing; it changes what Harbor does (no resume = handoff text every turn, no images = vision work goes elsewhere, no readOnly = no read-only work unless the user accepted it)
export type CliArg = string | string[];   // a string[] is a group: dropped whole when any placeholder in it expands to nothing (e.g. ["--model","{model}"] with the CLI's default model)
export interface CustomCliDescriptor {   // a user-described CLI (Settings > Connections > Add CLI), stored in the data folder's custom-clis.json; never read from a project folder (CHANGELOG 0.1.31)
 id: CliId; name: string; exe: string;   // id: lowercase letters, digits and dashes, not a built-in id; exe: absolute path of the approved executable
 version?: { args: string[] };   // default ["--version"]
 status?: { args: string[]; signedInExit?: number; signedOutPattern?: string };   // signedOutPattern = plain text (case-insensitive) that means "signed out"; absent status = sign-in unknown
 login?: { args: string[] };
 run: {
  args: CliArg[];   // placeholders: {model} {effort} {cwd} {promptFile}; whole-argument slots {resumeArgs} {effortArgs} {permissionArgs} {imageArgs} (appended at the end when absent)
  prompt?: 'stdin' | 'file';   // default stdin; file = written to a temp file passed as {promptFile}
  env?: Record<string, string>;   // extra variables you typed; the CLI otherwise gets only a fixed allowlist of Windows variables
  output?: { format: 'text' | 'jsonl'; map?: { text?: string; session?: string; done?: string; error?: string; usage?: { input?: string; output?: string } } };   // map paths: $.a.b[0].c; done may be "$.type==result"
  resume?: { args: CliArg[] };   // {sessionId} allowed here only; absent = no resume (Harbor sends its handoff text instead)
  effort?: Partial<Record<'low' | 'medium' | 'high', string[]>>;
  permissions?: Partial<Record<'read-only' | 'edit' | 'full', string[]>>;   // no read-only entry = no read-only work unless acceptReadOnlyRisk
  image?: { args: string[] };   // per image, {path} = the image file; absent = not vision-capable
 };
 models?: Array<{ id: string; tier?: 'cheap' | 'standard' | 'strong'; strengths?: string[] }>;   // catalog entries (capabilities.json entries for the same cli/model win); default one 'default' model with no strengths
 acceptReadOnlyRisk?: boolean;   // the user accepted that this CLI may write during read-only roles (planners, reviewers, plan mode)
 approvedHash?: string; approvedAt?: number;   // set by Harbor on save: sha256 of the executable the user approved, and when; a changed file blocks the CLI until approved again
}
export interface CliTemplate { id: string; name: string; description: string; verified?: string; descriptor: Omit<CustomCliDescriptor, 'exe'> & { exe?: string } }   // verified = which CLI version the flags were checked against with --help
export interface CliDryRunStep { name: 'version' | 'status' | 'prompt'; command: string; exitCode: number | null; stdout: string; stderr: string; error?: string; durationMs: number }   // stdout/stderr clipped for display
export interface CliDryRun { ok: boolean; problems?: string[]; version?: string; authState?: 'signedIn' | 'signedOut' | 'unknown'; steps: CliDryRunStep[]; parsed?: { text?: string; sessionId?: string; inputTokens?: number; outputTokens?: number; chunks: number; ok?: boolean; error?: string } }   // problems = descriptor errors (nothing was run when present); parsed = what Harbor understood from the prompt run
export interface Project { id: Id; name: string; path: string; lastOpened: number; image?: string }   // image = small data: URL chosen by the user
export interface Conversation { id: Id; projectId: Id; title: string; updated: number; agentId: Id; pinned?: boolean; archived?: boolean; customTitle?: boolean; activity?: SessionActivity; reviewBase?: string; mode?: ConversationMode; goal?: string; deadline?: number }   // agentId = main agent, or a subagent for direct chats; deadline = epoch ms the owner needs this conversation's work by (setConversationDeadline; CHANGELOG 0.1.27)
export type EditorId = 'code' | 'code-insiders' | 'cursor' | 'windsurf';   // editors Harbor can open a folder or file in (CHANGELOG 0.1.25)
export type ConversationMode = 'default'|'auto'|'plan'|'goal';   // auto = no permission prompts; plan = read-only plan first; goal = keep going until done (needs `goal`)
export interface SessionActivity { state: 'queued'|'working'|'waiting'|'done'|'failed'|'stopped'; started?: number; updated: number; detail?: string; cli?: CliId; model?: string; complexity?: 'low'|'medium'|'high'; effort?: string }
export interface SearchHit { conversation: Conversation; projectName: string; excerpt?: string }
export interface ReviewSnapshot { conversationId: Id; capturedAt: number; files: Array<{ path: string; patch: string; source: string; untracked?: boolean }>; notes: string[] }
export interface GitBranch { name: string; head: string; subject: string; updated: number; current?: boolean; upstream?: string; ahead?: number; behind?: number; worktree?: string; agentId?: Id; agentTitle?: string; agentState?: AgentState }   // ahead/behind = against GitOverview.base; agent* = the Harbor helper that owns a harbor/* branch
export interface GitWorktree { path: string; head: string; branch?: string; changed: number; main?: boolean }   // changed = uncommitted files; main = the project folder itself
export interface GitOverview { projectId: Id; base?: string; current?: string; branches: GitBranch[]; worktrees: GitWorktree[]; notes: string[] }
export interface GitCommit { hash: string; parents: string[]; subject: string; author: string; time: number; refs: string[] }
export interface GitFileChange { path: string; status: 'added'|'modified'|'deleted'|'renamed'|'untracked'|'other'; oldPath?: string; additions?: number; deletions?: number; hidden?: boolean }   // hidden = credential file, diff never shown
export interface GitTarget { branch?: string; commit?: string }   // neither = uncommitted changes in the project folder
export type AgentRole ='main' | 'planner' | 'implementer' | 'reviewer' | 'other';
export type AgentState = 'queued' | 'working' | 'waiting' | 'done' | 'failed' | 'stopped';
export interface Agent { id: Id; projectId: Id; parentId?: Id; role: AgentRole; title: string; state: AgentState; cli: CliId; model: string; effort: 'low'|'medium'|'high'; worktree?: string; summary?: string; conversationId?: Id; priority?: number; paused?: boolean; testedCommit?: string; outdated?: boolean; result?: AgentResult; checks?: CheckOutcome[]; integration?: Integration; rollback?: Rollback; estimatedMinutes?: number }   // estimatedMinutes = Harbor's estimate of the helper's wall minutes when it was delegated (a prior blended with calibration, never a promise); conversationId = the main-agent conversation that created this subagent; priority = higher starts first (absent = 0); paused = will not start while queued; testedCommit = exact commit a reviewer examined, or that Harbor's checks ran on; outdated = that branch moved since (computed); result = the helper's last HARBOR_RESULT; checks = commands Harbor itself ran on testedCommit; integration = set on an integrator (role 'other', run by Harbor itself, no CLI); rollback = set on a rollback agent (role 'other', run by Harbor itself, no CLI)
export interface Integration { target?: string; base?: string; branch?: string; head?: string; sources: IntegrationSource[]; conflicts?: string[]; applied?: boolean }   // target = user branch to fast-forward (absent until resolved: the project's checked-out branch); base = target's head when the run started; branch/head = the harbor/integrate-* branch and its head; conflicts = unmerged paths of the source that stopped the run; applied = applyIntegration moved target to head
export interface IntegrationSource { agentId: Id; branch?: string; commit?: string; state: 'pending'|'merged'|'conflict'; merge?: string }   // commit = the source head pinned (and merged by SHA) at run start; merge = the merge commit Harbor created for it on the integration branch (absent when it was already included)
export interface RollbackPreview { agentId?: Id; target?: string; targetHead?: string; supported?: boolean; merges?: RollbackMerge[]; files?: GitFileChange[]; laterCommits?: RollbackLaterCommit[]; dependents?: RollbackDependent[]; clean?: boolean|null; conflicts?: string[]; blockers?: string[]; notes?: string[] }   // read-only: nothing is changed. supported = the task reached target through merge commits Harbor can reverse; clean = reverting them on targetHead merges cleanly (null = could not be simulated); conflicts = paths of the first revert that would conflict; blockers = why a rollback may not run now
export interface RollbackMerge { commit: string; agentId?: Id; integrationId?: Id }   // a merge commit on the target that brought the task's work in (agentId = the helper merged; integrationId = the integrator that made it)
export interface RollbackLaterCommit { hash: string; subject?: string; files?: string[]; agentId?: Id; agentTitle?: string }   // a commit on the target after the task's merge that touches the same files (agent* = owning Harbor helper when known)
export interface RollbackDependent { agentId: Id; title?: string; state?: AgentState; reason: 'dependsOn'|'spec'|'help'|'overlap' }   // dependsOn = waited for the task; spec = used its report as spec; help = the task was created to help it; overlap = later work on the same files
export interface Rollback { taskId: Id; target?: string; base?: string; branch?: string; head?: string; merges: RollbackRevert[]; conflicts?: string[]; applied?: boolean }   // taskId = the agent whose merges are reverted; target = user branch to fast-forward (absent until resolved); base = target's head pinned at the first run; branch/head = the harbor/rollback-* branch and its head; merges = the task's merges on target, newest first (pinned with base); conflicts = unmerged paths of the revert that stopped the run; applied = applyIntegration moved target to head
export interface RollbackRevert { commit: string; agentId?: Id; integrationId?: Id; state: 'pending'|'reverted'|'conflict'; revert?: string }   // a RollbackMerge plus its progress; revert = the commit `git revert -m 1` made for it on the rollback branch
export interface AgentResult { outcome: 'done'|'partial'|'blocked'; summary: string; verdict?: 'approve'|'changes'; checks: Array<{ cmd: string; ok: boolean }>; commit?: string }   // self-reported (checks here are claims); verdict = reviewers; commit = what the run examined (reviewer: its testedCommit; edit helper: its branch head)
export interface CheckOutcome { cmd: string; ok: boolean; exitCode: number|null; timedOut?: boolean; durationMs: number }   // a .harbor/checks.json command Harbor ran itself (evidence)
export interface Attachment { name: string; mime: string; path?: string }   // path = absolute file under Harbor's data folder, set by main
export interface Message { id: Id; conversationId: Id; role: 'user'|'assistant'|'system'|'tool'; text: string; time: number; agentId?: Id; details?: { cli: CliId; model: string; effort: string; reason: string; summary?: string; scored?: Array<{ cli: CliId; model: string; score: number; terms: Record<string, number>; effort?: string; price?: number; headroom?: { remainingPct: number; windows: Array<{ period: 'session'|'weekly'; scope?: string; remainingPct: number; resetsAt?: number; projectedPct?: number; source: 'reported'|'estimated' }> } }>; margin?: number; tied?: boolean; degraded?: { wantedTier: string; gotTier: string }; difficulty?: number; needsReview?: boolean; reviewReason?: string; skipped?: Array<{ cli: CliId; model?: string; why: string; until?: number; transient?: boolean }> }; attachments?: Attachment[] }
export interface ToolRule { id: Id; tool: string; prefix?: string; created: number }   // a tool call allowed without asking in one project: prefix = Bash command prefix (whole words); absent = any call of that exact tool
export interface UsageWindow { cli: CliId; label: string; usedPct: number; resetsAt?: number; freeResetAvailable?: boolean; period?: 'session'|'weekly'; source?: 'reported'|'estimated'; model?: string; projectedPct?: number; calibrated?: boolean }   // calibrated (estimated windows): false = the budget is Harbor's fallback guess, not learned from the provider's own readings; show it as unknown/approximate
export interface Settings { routing: 'auto'|'manual'; cliOverrides: Record<CliId,{enabled:boolean}>; allowFreeReset: 'ask'|'never'; desktopNotifications?: boolean; keepRunningInBackground?: boolean; editor?: EditorId; concurrencyLimit?: number; allowedModels?: Record<CliId,string[]>; rolePreferences?: Partial<Record<Exclude<AgentRole,'main'>,RolePreference>>; effortPolicy?: EffortPolicy; lowAllowancePolicy?: LowAllowancePolicy; subscriptionReserve?: number; maxHelpersPerTurn?: number; maxPlannersPerTurn?: number; projectOverrides?: Record<Id,ProjectSettings>; cliPaths?: Record<CliId,string> }   // routing fields: absent = built-in default (CHANGELOG 0.1.12); maxHelpersPerTurn/maxPlannersPerTurn: fan-out brake per lead turn (defaults 4 and 1; CHANGELOG 0.1.23); keepRunningInBackground: absent/false = close quits; cliPaths = absolute executable path per CLI chosen in Settings, wins over HARBOR_<CLI>_PATH and PATH (merged per CLI; '' removes one; CHANGELOG 0.1.30)
export type EffortPolicy = 'adaptive'|'conserve'|'quality';   // adaptive = by role and complexity; conserve = one effort step lower (never for retries); quality = one step higher
export type LowAllowancePolicy = 'reduceEffort'|'switch';   // absent (the default) = headroom routing: the CLI with more room in its tighter window (5h or weekly, pace-aware) takes the work once the gap is large; 'reduceEffort' = stay on the session's CLI and lower effort; 'switch' = prefer a model/CLI that is not low
export interface RolePreference { cli?: CliId; model?: string }   // a strong preference, not a hard rule: exhausted, disabled or disallowed options are still skipped
export type ProjectSettings = Pick<Settings,'concurrencyLimit'|'allowedModels'|'rolePreferences'|'effortPolicy'|'lowAllowancePolicy'|'subscriptionReserve'>;   // wins over the global value per field (per CLI for allowedModels, per role for rolePreferences)
export type HarborEvent =
 | { type:'message'; message: Message }
 | { type:'messageDelta'; messageId: Id; conversationId: Id; text: string }
 | { type:'agent'; agent: Agent }
 | { type:'conversation'; conversation: Conversation }
 | { type:'usage'; windows: UsageWindow[] }
 | { type:'cli'; cli: CliStatus }
 | { type:'permission'; requestId: Id; kind:'freeReset'|'tool'|'conflict'; prompt: string; agentId?: Id; conversationId?: Id; tool?: string; alwaysAllow?: boolean; expiresAt?: number }   // kind 'tool': conversationId = where the asking agent runs; tool = tool name; alwaysAllow = "always allow for this project" may be offered; expiresAt = denied automatically after this time
 | { type:'question'; requestId: Id; conversationId: Id; prompt: string; options?: string[]; allowText?: boolean; agentId?: Id };   // an agent needs a decision; answer with answerQuestion
export type PendingPermission = Extract<HarborEvent, { type: 'permission' }>;
export interface HarborApi {
 listClis(): Promise<CliStatus[]>; refreshClis(): Promise<CliStatus[]>; openLogin(cli: CliId): Promise<void>;
 testCliPath?(cli: CliId, path: string): Promise<CliStatus>;   // runs the CLI's version and sign-in checks against this executable without saving it; rejects a path that is not an existing file (CHANGELOG 0.1.30)
 browseCliPath?(): Promise<string | null>;   // file picker for an executable; null when cancelled (CHANGELOG 0.1.30)
 listCustomClis?(): Promise<CustomCliDescriptor[]>; listCliTemplates?(): Promise<CliTemplate[]>;   // CHANGELOG 0.1.31
 dryRunCustomCli?(descriptor: CustomCliDescriptor, opts: { confirmExe: string }): Promise<CliDryRun>;   // validates, then runs version, status and one "reply OK" prompt in a temp folder; confirmExe must repeat descriptor.exe (the user's explicit OK to run that file). Saves nothing
 saveCustomCli?(descriptor: CustomCliDescriptor, opts: { confirmExe: string; replace?: boolean }): Promise<CustomCliDescriptor[]>;   // replace = update the custom CLI with the same id (otherwise a used id is refused); validates, records the executable's hash (approval), stores and re-runs discovery; also re-approves a changed file. Rejects invalid descriptors with every problem listed
 removeCustomCli?(id: CliId): Promise<CustomCliDescriptor[]>;   // returns the remaining custom CLIs
 listProjects(): Promise<Project[]>; addProject(path?: string): Promise<Project|null>; removeProject(id: Id): Promise<void>; setProjectImage(id: Id, image: string | null): Promise<Project>;
 listConversations(projectId: Id): Promise<Conversation[]>; newConversation(projectId: Id): Promise<Conversation>; deleteConversation(id: Id): Promise<void>;
 updateConversation(id: Id, patch: { title?: string; pinned?: boolean; archived?: boolean }): Promise<Conversation>;
 searchConversations(query: string, projectId?: Id): Promise<SearchHit[]>;
 stopConversation(id: Id): Promise<void>;
 getReview(id: Id): Promise<ReviewSnapshot>;
 openProjectFolder(id: Id): Promise<void>;
 openWorkspace?(projectId: Id, action: 'terminal' | 'editor' | 'folder', opts?: { agentId?: Id; file?: string }): Promise<void>;   // user-started: opens the project folder, or an edit helper's worktree when agentId is given, in a terminal, the chosen editor (Settings.editor, default code) or Explorer; file = path relative to that folder (editor and folder only). CHANGELOG 0.1.25
 getGitOverview(projectId: Id): Promise<GitOverview>;
 getGitLog(projectId: Id, opts?: { branch?: string; limit?: number; skip?: number }): Promise<GitCommit[]>;   // no branch = all local branches, newest first, topological; skip = commits to skip (paging)
 getGitLogPage?(projectId: Id, opts?: { branch?: string; limit?: number; skip?: number }): Promise<{ commits: GitCommit[]; hasMore: boolean; note?: string }>;   // same as getGitLog plus hasMore, and a note when git timed out instead of an empty list that looks like no commits
 getGitChanges(projectId: Id, target?: GitTarget): Promise<GitFileChange[]>;   // branch = since its merge-base with base, plus its worktree's uncommitted work
 getGitDiff(projectId: Id, path: string, target?: GitTarget): Promise<string>;
 listMessages(conversationId: Id, opts?: { before?: Id | number; limit?: number }): Promise<Message[]>;   // no opts = the whole conversation; limit = only the newest N (ascending); before = a message id or epoch ms, page backwards from there
 send(conversationId: Id, text: string, attachments?: { name: string; mime: string; dataBase64: string }[], opts?: { steer?: boolean }): Promise<void>;   // images only: png/jpeg/gif/webp, max 10 MB each, max 6. opts.steer: when the lead is mid-turn, cut that turn short and act on this message now instead of after it. CHANGELOG 0.1.26
 setConversationMode(conversationId: Id, mode: ConversationMode, goal?: string): Promise<Conversation>;   // goal mode requires a goal
 setConversationDeadline?(conversationId: Id, deadline: number | null): Promise<Conversation>;   // epoch ms the owner needs the work by; null clears it. Routing turns it into urgency (CHANGELOG 0.1.27)
 listAgents(projectId: Id): Promise<Agent[]>; openAgentConversation(agentId: Id): Promise<Conversation>; stopAgent(agentId: Id): Promise<void>;   // also cancels a queued assignment
 setAgentPriority(agentId: Id, priority: number): Promise<void>; pauseAgent(agentId: Id): Promise<void>; resumeAgent(agentId: Id): Promise<void>;   // pause only holds queued work back; a running agent keeps running
 resumeAgentSession(agentId: Id): Promise<void>;   // continue a stopped helper in its saved CLI session (rejects when it is not stopped or has no session)
 integrateBranches(projectId: Id, agentIds: Id[], target?: string): Promise<Agent>;   // queue an integrator that merges these helpers' approved harbor/* branches into a new harbor/integrate-* branch; target = branch to apply to later (default: the project's checked-out branch)
 applyIntegration(agentId: Id): Promise<Agent>;   // fast-forward the integration's (or rollback's) target to its head; rejects unless done, the project folder is clean and the target is still at base. Never pushes or forces
 getChanges(agentId: Id): Promise<GitFileChange[]>;   // committed files changed on a helper's branch (since its base) or an integration (base..head); [] when the agent has no branch
 previewRollback(agentId: Id, target?: string): Promise<RollbackPreview>;   // what undoing this task's merges on target (default: the checked-out branch) would revert, conflict with and affect. Read-only: changes no ref, index or file
 rollbackTask(agentId: Id, target?: string): Promise<Agent>;   // queue a rollback agent that reverts the task's merges on a new harbor/rollback-* branch and runs the checks; apply it with applyIntegration. Never touches target itself
 getUsage(): Promise<UsageWindow[]>;
 getSettings(): Promise<Settings>; setSettings(s: Partial<Settings>): Promise<Settings>;
 answerPermission(requestId: Id, allow: boolean, opts?: { always?: boolean }): Promise<void>;   // always = (tool requests with alwaysAllow) also store a project rule; ignored elsewhere
 listToolRules(projectId: Id): Promise<ToolRule[]>; removeToolRule(projectId: Id, ruleId: Id): Promise<ToolRule[]>;   // "always allow for this project" rules; remove returns the remaining rules
 listPendingPermissions(): Promise<PendingPermission[]>;   // permission requests still waiting for an answer (a reloaded renderer misses the events); same fields as the `permission` event
 answerQuestion(requestId: Id, answer: string): Promise<void>;   // delivered into the asking agent's conversation as the user's message
 exportDiagnostics?(): Promise<string>;   // redacted plain-text support bundle (versions, CLI states, counts, journal and log tails); contains no message text, prompts or credentials
 onEvent(cb: (e: HarborEvent) => void): () => void;   // returns unsubscribe
}
declare global { interface Window { harbor: HarborApi } }
