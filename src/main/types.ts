import type { Agent, CliId, Conversation, Message, Project, Settings } from '../shared/api';
import type { Need } from './clis/capabilities';
import type { HelperResult } from './prompts';
import type { Complexity } from './router';

/** Main-process view of an agent: the public Agent plus orchestration state. 1 agent == 1 assignment. */
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
  complexity?: Complexity;
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
  /** User allowed this agent to overlap file claims held by a sibling. */
  sharedOk?: boolean;
  /** Redoes failed or rejected work (one complexity level up, high effort). */
  retry?: boolean;
  /** Number of CLI fallbacks used. */
  attempts: number;
  created: number;
  /** The helper's HARBOR_RESULT line (self-reported). */
  result?: HelperResult;
  /** Branch head after Harbor's checkpoint commit. */
  headCommit?: string;
  /** Checks Harbor itself ran on `testedCommit` (evidence, unlike result.checks). */
  checks?: CheckRun[];
  testedCommit?: string;
}
type Id = string;

export interface CheckRun { cmd: string; ok: boolean; exitCode: number | null; timedOut?: boolean; durationMs: number; /** Tail of the combined output. */ output: string }

export interface SessionLink { agentId: Id; cli: CliId; sessionId: string; updated: number }

/** One observed unit of consumption. Never fabricated: fields stay undefined when unknown. */
export interface UsageEvent {
  id: Id; time: number; cli: CliId; model: string; projectId: Id; agentId: Id; conversationId?: Id;
  inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs: number; ok: boolean;
  rateLimited?: boolean;
  /** Account limits the CLI reported during this run (Claude: `rate_limit_event`). Persisted so they survive restarts. */
  limits?: Array<{ period: 'session' | 'weekly'; usedPct: number; resetsAt: number; asOf: number; scope?: string }>;
}

export interface CoordinationEntry {
  id: Id; time: number; projectId: Id;
  kind: 'peer' | 'lock' | 'handoff' | 'conflict' | 'direct' | 'help' | 'decision';
  from?: Id; to?: Id; text: string; files?: string[];
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
}
