import type { Agent, AgentResult, AgentState, CliId, Conversation, GitFileChange, Message, Project, ProjectNote, Settings, ToolRule } from '../shared/api';
import type { Need } from './clis/capabilities';
import type { Effort } from './adapters/types';
import type { TaskSize } from './calibration';
import type { Complexity } from './router';
import type { SecretFinding } from './secretScan';
import type { SpendGrant, SpendRun } from './spend';

/** Main-process view of an agent: the public Agent plus orchestration state. 1 agent == 1 assignment. */
/** What is kept of an unanswered permission event: no prompt text (it can hold commands or paths), a hash of it instead. */
export interface PendingPermissionRecord { requestId: Id; kind: 'freeReset' | 'tool' | 'conflict' | 'screenshot'; agentId?: Id; conversationId?: Id; tool?: string; hash: string; created: number }

export interface AgentRecord extends Agent {
  /** The user request / assignment prompt this agent works on. */
  task: string;
  /** Specification handed to an implementer (produced by a planner). */
  spec?: string;
  /** Files this agent is expected to touch (informational; locks are the enforcement). */
  files?: string[];
  /** Task ids this agent waits on. */
  dependsOn: Id[];
  revision: number;
  /** User-facing label, derived from `difficulty` when Harbor computed one (<= 3 low, <= 6 medium, else high). */
  complexity?: Complexity;
  /** 0..10, computed by Harbor from the task's signals (difficulty.ts); the lead's rating was only a hint. Absent on older records. */
  difficulty?: number;
  /** Size for the cost estimates, and the signals behind `difficulty` (shown in the routing reason). */
  size?: TaskSize;
  difficultySignals?: string[];
  /** A redo of work rejected on this model and effort: routing raises the effort on it first (RouteRequest.escalateFrom). */
  escalateFrom?: { cli: CliId; model: string; effort?: Effort };
  /** A redo after an infrastructure failure: the model and effort to keep when routing stays on that CLI. */
  keepModel?: { cli: CliId; model: string; effort?: Effort };
  /** What the lead said this work needs; the router matches it against the capability catalog. */
  needs?: Need[];
  /** CLI the lead pinned this helper to (HARBOR_DELEGATE "cli"); routing falls back when it is unavailable. */
  pinnedCli?: CliId;
  /** Never edits files (research, review), whatever the role. */
  readOnly?: boolean;
  /** Conversation the agent reports to (the one the user asked in). */
  parentConversationId: Id;
  branch?: string;
  baseCommit?: string;
  /** Last report emitted by the agent. */
  report?: string;
  /** Why work stopped, for failed/stopped states. */
  error?: string;
  /** Task whose report is this agent's specification (passed verbatim). */
  specFromId?: Id;
  /** Agent that asked for this sibling via request_help. */
  helpFor?: Id;
  /** Delegation grant from the lead: read-only sub-helpers this helper may still start itself (see PlannedTask.grant). */
  grant?: { left: number; scope: string };
  /** User allowed this agent to overlap file claims held by a sibling. */
  sharedOk?: boolean;
  /** Redoes work a reviewer or Harbor check rejected: its difficulty was raised one floor step, and the effort policy never lowers it. */
  retry?: boolean;
  /** A retry after an infrastructure failure: the CLI/model that failed is a soft penalty in routing, difficulty and effort are unchanged. */
  avoid?: Array<{ cli: CliId; model?: string }>;
  /** Number of CLI fallbacks used. */
  attempts: number;
  created: number;
  /** The helper's HARBOR_RESULT line (self-reported), tied to the commit the run examined. */
  result?: AgentResult;
  /** Branch head after Harbor's checkpoint commit. */
  headCommit?: string;
  /** Checks Harbor itself ran on `testedCommit` (evidence, unlike result.checks). */
  checks?: CheckRun[];
  testedCommit?: string;
  /** Worktree whose head `testedCommit` was taken from, so Harbor can tell when that branch moves. */
  testedWorktree?: string;
  /** Integrator started by the user (integrateBranches): its outcome is shown to the user, not reported to the lead. */
  byUser?: boolean;
  /** What each run committed on the helper's branch (newest last, at most 5). Evidence for rollback; reversal always uses git objects. */
  snapshots?: TaskSnapshot[];
  /** What Harbor knows about handing this helper's latest result to the lead; absent for the current result means pending. */
  reportDelivery?: ReportDelivery;
  /**
   * Delivery generation of the current result (absent = 0). Bumped when a stopped helper is resumed in place: the resumed
   * run keeps its revision and may end in the same state, so a late mark from a turn carrying the old result must not count.
   */
  reportGen?: number;
  /** Epoch ms of the last state change (worktree retention and the handoff read it). */
  updated?: number;
  /** An integrator queued without a target: the branch that was checked out then. Running it refuses if the folder moved to another branch. */
  pinnedCheckedOut?: string;
  /** The project folder had uncommitted edits when this helper was delegated; it starts from the committed HEAD without them. */
  dirtyAtStart?: 'dirty' | 'unknown';
  /** Harbor's estimate of this helper's wall minutes at delegation (sizeGate.estimateTaskMinutes): a prior blended with calibration. */
  estimatedMinutes?: number;
  /**
   * Who stopped it: the user, Harbor's time limit, Harbor's loop guard (loopGuard.ts), or a Harbor restart (absent on older records =
   * the user). Only Harbor's own stops (cap, loop) wake the lead.
   */
  stopKind?: 'user' | 'cap' | 'restart' | 'loop' | 'spend';
  /** The task (user request) whose spend this helper counts towards (spend.ts): the user message it was delegated under. */
  spendTask?: Id;
  /** Harbor's secret scan of this agent's branch at `commit` (secretScan.ts): types and locations only, never values. */
  secretScan?: SecretScanRecord;
  /** Automatic resumes after a cap stop (softCap.MAX_CAP_RESUMES). */
  capResumes?: number;
  /** Automatic resumes after a loop stop (loopGuard.MAX_LOOP_RESUMES). */
  loopResumes?: number;
  /** Harbor resumed this stopped helper once because new work depended on it. */
  depResumed?: boolean;
  /** Routing said the model only just clears (or does not clear) the floor of hard work: Harbor schedules one reviewer after it. */
  needsReview?: boolean;
  reviewReason?: string;
  /** On an implementer: Harbor already scheduled its automatic reviewer. On that reviewer: the implementer it reviews. */
  autoReviewed?: boolean;
  autoReviewOf?: Id;
  /** Questions this helper sent to the lead in this assignment (askRouting.MAX_LEAD_ASKS). */
  leadAsks?: number;
}
type Id = string;

/**
 * One secret scan of a branch. `findings` are those the allowlist did not cover (at most secretScan.MAX_FINDINGS); `total` counts
 * them all. `overridden`: the user allowed integrating them (an explicit yes). `failed`: git could not produce the diff.
 */
export interface SecretScanRecord { commit: string; findings: SecretFinding[]; total: number; allowed: number; overridden?: boolean; truncated?: boolean; failed?: boolean }

/**
 * Delivery of one helper result (revision + delivery generation + terminal state) to the lead. A mark for another result says nothing
 * about the current result, which is then pending. Statuses:
 * - `attempted`: a lead turn carrying it handed its prompt to a CLI but was not seen to finish (stopped, failed after output,
 *   or Harbor restarted).
 *   Uncertain: the lead may or may not have read it. No CLI acknowledges receipt, so this is never upgraded by guessing.
 * - `confirmed`: a lead turn carrying it finished successfully.
 * - `skipped`: deliberately not sent (a batch of only stopped helpers, so a stop-all does not start lead turns).
 * - `unknown`: the result predates delivery tracking (upgraded state file); treated like `attempted`.
 */
export interface ReportDelivery {
  v: 1;
  revision: number;
  /** `AgentRecord.reportGen` of the result (absent = 0). */
  gen?: number;
  state: AgentState;
  status: 'attempted' | 'confirmed' | 'skipped' | 'unknown';
  time: number;
  /** When the user was told this delivery is uncertain (once, so restarts do not repeat the notice). */
  noticed?: number;
}

/** One recorded state of a helper branch after Harbor's checkpoint: `base..head` and the files it changed. */
export interface TaskSnapshot {
  revision: number;
  base: string;
  head: string;
  time: number;
  files: GitFileChange[];
  /** `git diff --binary base head` (credential files excluded) under Harbor's data folder; evidence only. */
  patchPath?: string;
}

export interface CheckRun { cmd: string; ok: boolean; exitCode: number | null; timedOut?: boolean; durationMs: number; /** Tail of the combined output. */ output: string }

export interface SessionLink {
  agentId: Id; cli: CliId; sessionId: string; updated: number;
  /** Model and effort of the last run in this session. A resumed session keeps them (changing either rewrites the prompt cache). */
  model?: string; effort?: string;
  /** The session totals the CLI reported after its last run, for the fields it reports cumulatively (runUsage.perRunUsage). */
  totals?: Partial<Record<'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'costUsd', number>>;
}

/** One observed unit of consumption. Never fabricated: fields stay undefined when unknown. */
export interface UsageEvent {
  id: Id; time: number; cli: CliId; model: string; projectId: Id; agentId: Id; conversationId?: Id;
  /** The task (user request) the run worked on, for the spend ceilings (spend.ts). Absent on older events. */
  taskId?: Id;
  inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs: number; ok: boolean;
  /** Claude prompt-cache tokens; `inputTokens` excludes them. */
  cacheReadTokens?: number; cacheWriteTokens?: number;
  /**
   * The run ended without the CLI's final usage report (Harbor's time cap, a user stop, a crash): token fields hold only what streamed
   * before the end, a lower-bound estimate, and may be absent. Duration, CLI and model are still real.
   */
  partial?: boolean;
  rateLimited?: boolean;
  /** With `rateLimited`: the message did not name a model, so the whole CLI is held out, not just this model. */
  cliWide?: boolean;
  /** Account limits the CLI reported during this run (Claude: `rate_limit_event`). Persisted so they survive restarts. */
  limits?: Array<{ period: 'session' | 'weekly'; usedPct: number; resetsAt: number; asOf: number; scope?: string }>;
}

export interface CoordinationEntry {
  id: Id; time: number; projectId: Id;
  kind: 'peer' | 'lock' | 'handoff' | 'conflict' | 'direct' | 'help' | 'decision';
  from?: Id; to?: Id; text: string; files?: string[];
  /** Decisions: the conversation the lead noted it in, so another session's decisions are not handed to this one. */
  conversationId?: Id;
}

export interface FileLock { projectId: Id; file: string; agentId: Id; since: number }

export interface ResetApproval { id: Id; cli: CliId; time: number; approved: boolean }

export interface State {
  version: 1;
  projects: Project[];
  conversations: Conversation[];
  messages: Message[];
  agents: AgentRecord[];
  sessions: SessionLink[];
  usage: UsageEvent[];
  coordination: CoordinationEntry[];
  locks: FileLock[];
  resetApprovals: ResetApproval[];
  /** Free-reset windows the user already used, keyed by cli. */
  settings: Settings;
  /** "Always allow for this project" tool rules, keyed by project id. Optional so older files still load. */
  toolRules?: Record<Id, ToolRule[]>;
  /** Permission requests waiting for an answer when state was last written; a restart cannot continue them (the CLI is gone), so recover() reports and drops them. */
  pendingPermissions?: PendingPermissionRecord[];
  /** Hash of the `.harbor/checks.json` commands the user approved per project; changed commands need a new approval. */
  checksApproved?: Record<Id, string>;
  /** Mod switches (setModEnabled): global default and per-project choices by mod id. */
  mods?: { global?: Record<string, boolean>; projects?: Record<Id, Record<string, boolean>> };
  /** Hash of the `.harbor/permissions.json` allow list the user approved, by project. */
  permissionsApproved?: Record<Id, string>;
  /** Skill choices (global default and per project, by skill id) and what was imported into the library (by folder). */
  skills?: { global?: Record<string, boolean>; projects?: Record<Id, Record<string, boolean>>; imports?: Record<string, { source: string; hash: string; importedAt: number }> };
  /**
   * Imported history (plan section 6): decisions a bundle conversation carried (by imported conversation id; quoted data, never fed to
   * a lead as its own decisions) and continuations (by the new conversation's id: Harbor's handoff text for its first lead turn and
   * the CLI the user picked).
   */
  imports?: { decisions?: Record<Id, Array<{ text: string; time?: number }>>; continuations?: Record<Id, { text: string; cli: CliId; from: Id }> };
  /** Spend ceiling extensions the user allowed (spend.ts); pruned once they no longer matter. */
  spendGrants?: SpendGrant[];
  /** Last measured spend of runs in flight, by run key; a run Harbor never saw end (a crash) moves to `spendCarried` at load. */
  spendFlights?: Record<string, SpendRun>;
  spendCarried?: SpendRun[];
  /** Secret-scan overrides the user allowed, by project: fingerprints of exact findings on an exact commit (secretScan.findingsFingerprint). */
  secretOverrides?: Record<Id, string[]>;
  /** Project knowledge notes (knowledge.ts), keyed by project id. Optional so older files still load. */
  notes?: Record<Id, ProjectNote[]>;
}
