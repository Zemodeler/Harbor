import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Agent, AgentRole, AgentState, Attachment, CliId, Conversation, ConversationMode, HarborEvent, Id, IntegrationSource, Message, PendingPermission, Project, SessionActivity, SpendStatus } from '../shared/api';
import type { Chunk, CliAdapter, Effort, ToolPermissionDecision, ToolPermissionRequest } from './adapters/types';
import { DEFAULT_CATALOG, autoRoutable, entryFor, type CatalogEntry, type Need, type Tier } from './clis/capabilities';
import type { TaskSize } from './calibration';
import { nativeEffort } from './clis/effort';
import { RunUsage, perRunUsage } from './runUsage';
import { loadChecks as loadProjectChecks, runShellCheck, type CheckRunner } from './checks';
import type { ResolvedCli } from './clis/discovery';
import { harborBranchFor, staleWorktrees, type Git, type WorktreeEntry } from './git';
import { breakCycles } from './graph';
import { Journal, type JournalEntry } from './journal';
import { LockTable, WHOLE_PROJECT, needsLock } from './locks';
import {
  CONCIERGE_SYSTEM, LEAD_SYSTEM, MAX_PEERS_PER_TURN, REPORT_CHARS, RESUME_PROMPT, clip, titleFrom, conciergePrompt, historyText, imageBriefText, isApproval, isReadOnlyQuestion, leadPrompt, proseAsk, needsWorkspace, newProtocolNonce, attachedFilesNote, noVisionNote, nonceInstruction, parseConcierge, parseProtocol, requestedCli, screenshotAnswerText, stripProtocol, subagentPrompt, systemFor,
  type AskRequest, type Escalation, type HelpRequest, type HeldReports, type LeadTrigger, type PeerMessage, type PeerRequest, type PlannedTask, type Protocol, type ReplyRequest, type SessionPeer
} from './prompts';
import { buildHandoff, type HandoffEvidence } from './handoff';
import { matchesTracked, reapTrackedProcesses, setSpawnObserver, systemKiller, type ProcessKiller } from './proc';
import { EXTERNAL_EFFECTS_NOTE, previewRollback, relatedAgents } from './rollback';
import { combineComplexity, estimateComplexity } from './complexity';
import { calibrate, type Calibration } from './calibration';
import { conversationUrgency } from './deadline';
import { COMPLEXITY_DIFFICULTY, complexityOf, difficultyOf, raiseDifficulty, strongestLevel } from './difficulty';
import { EFFORT_BONUS, capabilityOf } from './budgetCost';
import { bindingNeed, committedFor, inFlightKTokSoFar, newestReadingAt, type InFlightRun } from './routePrice';
import { CAP_RESUME_PROMPT, DEPENDENCY_RESUME_PROMPT, capLimits, capReason, capResumeAllowed, softCheck, type CapKind } from './softCap';
import { describeLoop, loopResumeAllowed, loopResumePrompt, type LoopEvidence } from './loopGuard';
import { LoopWatch, type LoopGuardSettings } from './loopWatch';
import { gitProgressProbe } from './progressProbe';
import { USER_QUESTION_TIMEOUT_MS, routeAsk, safeDefault, type UserAskKind } from './askRouting';
import { SPLIT_ADVICE, describeDrivers, estimateTaskMinutes, fmtMinutes, gateSize, gateTask, planEta } from './sizeGate';
import { STATUS_ARGS, dirtyOverlap, parseStatusV2, underPrefix } from './dirtyBase';
import { helperLimitFromLedger, type HelperLimit } from './helperLimit';
import { MAX_HELPERS_CAP } from './budget';
import { NOTES_BUDGET, notesText, selectNotes } from './knowledge';
import { RepoMapCache } from './repoMap';
import { calibrationSample, finishedRuns, overlapKTok, readingsDuring } from './runCalibration';
import { effortFor, evaluate, explainNoRoute, route, type Complexity, type RouteDecision, type RouteRequest, type RouterInput } from './router';
import { DEFAULT_CONCURRENCY, DEFAULT_HELPERS_PER_TURN, DEFAULT_PLANNERS_PER_TURN, currentResult, describeToolRule, effectiveSettings, matchesToolRule, newId, normPath, toolRuleFor, type ReportMark, type Store, type ToolRuleDraft } from './store';
import type { AgentRecord, CheckRun, ReportDelivery, TaskSnapshot, UsageEvent } from './types';
import type { ReportedLimit } from './codexLimits';
import { buildHistory, type FreeResetCoordinator, type UsageLedger } from './usage';
import { isModelSpecific } from './adapters/types';
import type { EventBus } from './events';
import { CLI_DEFINITIONS } from './clis/registry';
import { resolveShownImage } from './images';
import { resolveDocumentPath, type DocumentRoot } from './documents';
import type { ScreenshotBroker, ScreenshotLine, ShotOutcome } from './screenshots';
import type { McpRun } from './mcp/materialize';
import {
  SPEND_CHECK_MS, SPEND_SCOPES, SPEND_TOOL, ceilingsConfigured, checksFor, continuePrompt, counts, describeHit, describeLimit, firstHit, liveRunOf, spendRunOf, statusOf,
  type SpendHit, type SpendRun
} from './spend';
import { SECRET_TOOL, applyAllowlist, describeFindings, findingsFingerprint, scanDiff } from './secretScan';
import type { SecretScanRecord } from './types';

export interface OrchestratorDeps {
  store: Store;
  bus: EventBus;
  ledger: UsageLedger;
  git: Git;
  getClis: () => ResolvedCli[];
  adapterFor: (cli: CliId) => CliAdapter | undefined;
  enabled: (cli: CliId) => boolean;
  verified?: (cli: CliId) => boolean;
  /** Whether a read-only run on this CLI stays read-only (a custom CLI without a read-only mode does not, unless the user accepted that). */
  readOnlySafe?: (cli: CliId) => boolean;
  /**
   * The enabled skills for one lead or helper run on `cli` in `cwd` (plan section 3.3): text appended to its system prompt and
   * folders the run must be able to read. Undefined = no skills. Asked after routing, because it depends on the chosen CLI.
   */
  skillsFor?: (projectId: Id, cli: CliId, cwd: string) => { system: string; readableDirs: string[] } | undefined;
  /**
   * The project's MCP servers for one lead or helper run on `cli` (plan section 5, mcp/materialize.ts planMcpRun) and notes for the
   * run details (server names only). `asks` = the run has Harbor's tool permission handler. Asked after routing, per attempt.
   */
  mcpFor?: (projectId: Id, cli: CliId, run: { permission: RoutedOptions['permission']; asks: boolean }) => { mcp?: McpRun; notes: string[] } | undefined;
  /** Capability catalog (editable data); defaults to the built-in one. */
  catalog?: CatalogEntry[];
  worktreesRoot: string;
  /** Raise a permission event and resolve with the user's answer. */
  /** `signal` withdraws the request (it resolves false and is no longer listed as pending). */
  ask: (kind: 'freeReset' | 'tool' | 'conflict', prompt: string, agentId?: Id, signal?: AbortSignal) => Promise<boolean>;
  freeReset?: FreeResetCoordinator;
  maxActivePerProject?: number;
  /** Cap on automatic lead turns after one user message (guards against runaway loops). */
  maxAutoTurns?: number;
  /** Where Harbor records what went wrong in its own runs; in memory when omitted. */
  journal?: Journal;
  /** Checks Harbor runs after an edit helper (default: `.harbor/checks.json` of the project, run in a shell). */
  loadChecks?: (projectPath: string) => string[];
  runCheck?: CheckRunner;
  /** Finds and kills leftover CLI processes at startup; injected so tests never touch real processes. */
  killer?: ProcessKiller;
  /** Where per-run patches of helper branches are kept as rollback evidence; without it snapshots record files only. */
  patchesRoot?: string;
  /** How long a tool permission request waits for the user before it is denied (default TOOL_PERMISSION_TIMEOUT_MS). */
  toolPermissionTimeoutMs?: number;
  /** Starts a timer and returns its cancel function; injected so tests control time. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Stall watchdog and per-run caps (defaults below). Its timer and clock are separate from `setTimer`, so retry waits never trip it. */
  /**
   * `helperCapMs` is the HARD limit of a helper run and `helperSoftCapMs` its soft limit (an active run continues past it, an idle one
   * stops); `activeWindowMs` is how recent output must be to count as active (see softCap.ts).
   */
  stall?: { stallMs?: number; leadCapMs?: number; helperCapMs?: number; helperSoftCapMs?: number; activeWindowMs?: number; setTimer?: (fn: () => void, ms: number) => () => void; now?: () => number;
    /** Loop guard for helpers (loopGuard.ts): on by default; the lead only gets a notice. */
    loopGuard?: LoopGuardSettings };
  /** How long a helper's question to the user waits before the safe default applies (default askRouting.USER_QUESTION_TIMEOUT_MS). */
  questionTimeoutMs?: number;
  /** Test hook: approve every project checks file without asking (the real flow asks the user once per file content). */
  autoApproveChecks?: boolean;
  /** Working folder of runs that need no repository (the concierge); default: `harbor-neutral` under the OS temp folder. */
  neutralDir?: string;
  /** Clock for routing (history decay, use-it-or-lose-it); default Date.now. */
  now?: () => number;
  /** Report wake-ups of the lead are gathered for `ms` (default 400) so a cascade of finishing helpers wakes it once; 0 = immediately. */
  reportDebounce?: { ms?: number; setTimer?: (fn: () => void, ms: number) => () => void };
  /** HARBOR_SCREENSHOT requests (screenshots.ts): asks the user, captures what they pick. Absent = requests are refused with a note. */
  screenshots?: ScreenshotBroker;
  /** Copies a checked project image (HARBOR_SHOW_IMAGE) into the conversation's attachments folder. Absent = such lines are refused. */
  attachImage?: (conversationId: Id, image: { path: string; mime: string }) => Attachment;
  /** How often runs in flight are measured against the spend ceilings (default spend.SPEND_CHECK_MS) and its timer (tests). */
  spendCheckMs?: number;
  spendTimer?: (fn: () => void, ms: number) => () => void;
  /** Repo maps for helper prompts (repoMap.ts); default: one cache over `git`. */
  repoMaps?: RepoMapCache;
}

/** A run with no output for this long is flagged as possibly stuck (it is never killed for that alone). */
export const STALL_MS = 10 * 60_000;
/** Hard limit of one lead turn: past it Harbor stops the process tree and marks the turn stopped. Helpers have soft and hard limits (softCap.ts). */
export const LEAD_CAP_MS = 60 * 60_000;

/** Helper results that finish within this window wake the lead together (see scheduleReport). */
export const REPORT_DEBOUNCE_MS = 400;

/** An unanswered tool permission request is denied after this long, so it can never hold a run (and its queue slot) forever. */
export const TOOL_PERMISSION_TIMEOUT_MS = 5 * 60_000;
const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

/**
 * Failures the CLI itself calls temporary (Claude's OAuth refresh race when another Claude process refreshes the
 * shared token). Retrying the same CLI after a short wait keeps the run on the routed model instead of falling back.
 */
const TRANSIENT_CLI_ERRORS: RegExp[] = [
  /failed to refresh oauth token/i,
  /another claude code process is refreshing/i
];
/** Connection trouble: nothing about the CLI, the model or the quota is wrong, so the same CLI is simply tried again. */
const NETWORK_ERRORS: RegExp[] = [
  /\b(?:ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH)\b/,
  /connection (?:error|reset|refused|closed|lost)|socket hang up|fetch failed/i,
  /\breconnecting\b/i,
  /\bnetwork (?:error|failure|is unreachable|unreachable|connection|request failed|timeout)|(?:error|failure|problem)s? (?:with|in|on) (?:the )?network\b/i
];
export type TransientKind = 'oauth' | 'network';
export const transientKind = (error: string | undefined): TransientKind | undefined =>
  !error ? undefined : TRANSIENT_CLI_ERRORS.some((r) => r.test(error)) ? 'oauth' : NETWORK_ERRORS.some((r) => r.test(error)) ? 'network' : undefined;
export const isTransientCliError = (error: string | undefined): boolean => transientKind(error) !== undefined;
/** Waits before each same-CLI retry of a transient failure; the CLI suggests about a minute. */
export const TRANSIENT_RETRY_DELAYS_MS = [20_000, 45_000];
/** Backoff for connection errors (shorter first: most are a dropped packet, not an outage). */
export const NETWORK_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];
/**
 * "Overloaded" (529) says the provider is busy, not that the account is out of quota: retried once on the same CLI, then the next
 * CLI is tried, and nothing is held against the model afterwards (a rate limit holds it out for 30 minutes).
 */
const OVERLOAD_RE = /overloaded|\b529\b/i;
const HARD_LIMIT_RE = /rate.?limit|usage limit|quota|too many requests|\b429\b|limit reached|limit will reset/i;
export const OVERLOAD_RETRY_DELAY_MS = 15_000;
/** A CLI that could not be started at all (missing, unsupported flag) consumed no quota: it is not counted in the ledger. */
const SPAWN_FAILURE_RE = /\bENOENT\b|\bEACCES\b|\bEPERM\b|spawn .*(?:failed|error)|unknown (?:option|argument|flag)|unexpected argument|unrecognized (?:option|argument|arguments)|unsupported (?:flag|option)|invalid (?:flag|option)/i;

/**
 * A tool call waiting for the user's answer. In memory only: a restart ends the run that asked. The deadline is a wall-clock
 * time, not a timer's promise: after the machine slept the timer may have stalled, so `rearm` starts it again for what is left.
 */
interface ToolAsk { agentId: Id; projectId: Id; conversationId: Id; run: number; tool: string; rule?: ToolRuleDraft; noRules?: boolean; event: PendingPermission; deadline: number; settle(d: ToolPermissionDecision): void; rearm(): void }

const MAX_SNAPSHOTS = 5;

export interface OrphanSweep { killed: number[]; skipped: number[] }

/** The error of an agent `recover()` stopped; persisted, so it also marks restart-stopped agents after a later restart. */
const RESTART_ERROR = 'Harbor restarted while this agent was running. Its worktree and any commits are preserved; send a message to continue.';

const EDIT_ROLES: AgentRole[] = ['implementer', 'other'];
/** Difficulty of a /deep lead turn: above what a weaker model reaches by effort alone (see budgetCost.REQUIRED_LEVEL_KNOTS). */
const DEEP_DIFFICULTY = 9;
const TERMINAL: AgentState[] = ['done', 'failed', 'stopped'];
const DEFAULT_TITLE = 'New conversation';
const GOAL_MAX_CONTINUATIONS = 8;
const MAX_PEER_WAKES = 2;
const MAX_PEER_INBOX = 10;

const COUNT_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const COUNT = '(\\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
/** How many helpers or planners the user's message asked for by number ("use 6 helpers", "five parallel agents", "3 planners"); absent = not asked. */
export function askedCounts(text: string): { helpers?: number; planners?: number } {
  const num = (s: string): number => (/^\d+$/.test(s) ? Number(s) : COUNT_WORDS[s.toLowerCase()] ?? 0);
  const best = (re: RegExp): number | undefined => { const all = [...text.matchAll(re)].map((m) => num(m[1]!)).filter((n) => n > 0); return all.length ? Math.max(...all) : undefined; };
  return {
    helpers: best(new RegExp(`\\b${COUNT}\\s+(?:parallel\\s+|separate\\s+|independent\\s+)?(?:helpers?|agents?|workers?|subagents?|implementers?|reviewers?)\\b`, 'gi')),
    planners: best(new RegExp(`\\b${COUNT}\\s+(?:parallel\\s+|separate\\s+)?planners?\\b`, 'gi'))
  };
}

/** What a message records about how it was routed: the choice and reason, plus the evidence behind it (scores, margin, ties, tier loss, skips). */
export function detailsOf(d: RouteDecision): NonNullable<Message['details']> {
  return {
    cli: d.cli, model: d.model, effort: d.effort, reason: d.reason, ...(d.summary ? { summary: d.summary } : {}),
    ...(d.scored ? { scored: d.scored } : {}), ...(d.margin !== undefined ? { margin: d.margin } : {}), ...(d.tied ? { tied: true } : {}),
    ...(d.degraded ? { degraded: d.degraded } : {}), difficulty: d.difficulty,
    ...(d.needsReview ? { needsReview: true, ...(d.reviewReason ? { reviewReason: d.reviewReason } : {}) } : {}),
    ...(d.skipped?.length ? { skipped: d.skipped } : {}), ...(d.request ? { request: d.request } : {})
  };
}

/** Runs that ended this recently may have burned quota no reading shows yet (committedNow). */
const RECENT_RUNS_MS = 30 * 60_000;
/** A helper held for quota with no known reset time is tried again after this long. */
const QUOTA_RECHECK_MS = 10 * 60_000;

interface RoutedRun {
  ok: boolean;
  /**
   * No model could take this helper only for reasons that clear by themselves (quota held in reserve, too little left for the run,
   * a cooldown): it goes back to the queue until `until` (when known) instead of failing.
   */
  held?: { until?: number };
  text: string;
  /** Every text chunk of the run, not only the final answer: protocol lines can be anywhere. */
  allText?: string;
  error?: string;
  stopped?: boolean;
  decision?: RouteDecision;
  /**
   * A CLI may have taken the prompt: some attempt produced output, or was stopped after the prompt was handed over (a stop
   * says nothing about how far the CLI got). Only a failure without any output counts as not started: adapters report a CLI
   * that could not be spawned that way, but cannot tell it apart from one that read its stdin and died silently.
   */
  started?: boolean;
  /** The per-turn protocol tag the run was asked to use; pass it to parseProtocol/stripProtocol for this output. */
  nonce?: string;
  /** Tool calls the run made (a goal continuation without any made no progress). */
  toolCalls?: number;
  /** Harbor stopped the run at its time limit (not the user): resumable. */
  capped?: boolean;
  /** Which limit: idle past the soft limit, or the hard limit (softCap.ts). */
  capKind?: CapKind;
  /** Harbor's loop guard stopped the run (loopGuard.ts): what looped. Resumable, like a cap stop. */
  loop?: LoopEvidence;
  /** The CLI ended without a completion event after producing output (exit code 0); counted as finished, with a warning. */
  noCompletion?: boolean;
  /** A spend ceiling stopped the run, or kept it from starting (spend.ts); `error` says which. Never retried elsewhere. */
  spent?: boolean;
}

/** A run in flight as the spend ceilings see it (spendTick). */
interface SpendFlight {
  key: string; projectId: Id; taskId?: Id;
  /** Where the user is told it was stopped: the lead's conversation, or the one that delegated the helper. */
  conversationId: Id;
  stopped?: boolean;
  measure(now: number): SpendRun;
  stop(hit: SpendHit): void;
}

/** Harbor stopped it (time limit, loop guard, spend ceiling), not the user: the lead is woken and decides. */
const harborStopped = (a: Pick<AgentRecord, 'stopKind'>): boolean => a.stopKind === 'cap' || a.stopKind === 'loop' || a.stopKind === 'spend';

/**
 * Helper results carried by one lead turn: a reports trigger's items (snapshots taken when queued), plus held reports added
 * when the turn starts. A newer revision or incarnation of a helper is never settled by this batch. `prev` is each
 * result's mark when it joined.
 */
interface ReportBatch {
  marks: ReportMark[];
  prev: Map<Id, ReportDelivery | undefined>;
  /** `attempted` was written: a lead turn is about to hand these to a CLI. */
  started: boolean;
  settled: boolean;
}

interface RoutedOptions {
  prompt: string;
  system: string;
  /** Prepended when the native session cannot be resumed (first turn, or the CLI changed). */
  contextIfNoResume?: string | (() => Promise<string> | string);
  role: AgentRole;
  complexity: Complexity;
  /** Harbor's difficulty (difficulty.ts) and its signals; absent = derived from `complexity`. */
  difficulty?: number;
  difficultySignals?: string[];
  size?: TaskSize;
  /** The owner is waiting on this run (lead, concierge): it may use the quota reserve. */
  interactive?: boolean;
  /** A redo of rejected work: more effort on that model first (RouteRequest.escalateFrom). */
  escalateFrom?: { cli: CliId; model: string; effort?: Effort };
  /** A redo after an infrastructure failure: keep this model and effort when routing stays on its CLI. */
  keepModel?: { cli: CliId; model: string; effort?: Effort };
  tier?: Tier;
  needs?: Need[];
  /** Question-and-answer run (the concierge): the adapter drops tools and the CLI's own environment (see RunOptions.lean). */
  lean?: boolean;
  /** Needs a model must have (image turns: vision); a model lacking one is skipped. */
  required?: Need[];
  /** How the request's complexity was decided (concierge and/or the request's own signals); appended to the routing reason. */
  complexityNote?: string;
  /** Soft penalty for the CLI/model a retried helper failed on. */
  avoid?: Array<{ cli: CliId; model?: string }>;
  /** Fan-out helper: kept off a CLI at low allowance while another is healthy (see RouteRequest.fanOut). */
  fanOut?: boolean;
  effort?: Effort;
  /** Keep `effort` as given: the effort policy does not apply. */
  fixedEffort?: boolean;
  retry?: boolean;
  /** CLI the user asked for by name. */
  preferCli?: CliId;
  permission: 'read-only' | 'edit' | 'full';
  /** Absolute paths of images for this turn only. */
  images?: string[];
  /** Absolute paths of other files the user attached this turn (any type); named in the prompt and their folder made readable. */
  files?: string[];
  /**
   * Screenshots Harbor captured for this agent (this turn only). Unlike `images` they do not require a vision model: a CLI whose
   * `features.images` is false gets their file paths in the prompt with a note that it cannot see them.
   */
  shots?: string[];
  /** Pin to one CLI; routing falls back (with a note) when it is unavailable. */
  requireCli?: CliId;
  cwd: string;
  signal: AbortSignal;
  resume: boolean;
  conversationId: Id;
  stream: boolean;
  /** Lead turns: forbid git merge/rebase/cherry-pick/reset/push in CLIs that can enforce it. */
  denyGitWrites?: boolean;
  /** Key of the native session to resume and record; defaults to the agent id. */
  sessionKey?: Id;
  /** Called right before each attempt hands the prompt to a CLI. */
  onAttempt?: () => void;
  /** Protocol tag for this run (see `nonceInstruction`): appended to the prompt, honoured when the output is parsed. */
  nonce?: string;
  /** Extra writable directories (a worktree's git metadata) and command prefixes an edit run may use unasked. */
  writableDirs?: string[];
  allowedCommands?: string[];
  /** Lead and helper runs: add the project's enabled skills for the chosen CLI (never the concierge, which stays lean). */
  skills?: boolean;
}

export class Orchestrator {
  private locks: LockTable;
  private controllers = new Map<Id, AbortController>();
  private running = new Set<Id>();
  private mainChain = new Map<Id, Promise<void>>();
  private followups = new Map<Id, string[]>();
  /**
   * Results (`reportKey`) queued for or delivered to a lead in this run, so they are not batched twice. A turn that never
   * reaches a CLI, or ends without finishing, gives its keys back; how far each result got is persisted in `reportDelivery`.
   */
  private reported = new Set<Id>();
  // Keyed by conversation: the main agent is shared by a project's conversations, but its context must not be.
  private notes = new Map<Id, string[]>();
  private autoTurns = new Map<Id, number>();
  /** Automatic goal-mode continuations since the user's last message. */
  private goalTurns = new Map<Id, number>();
  /** Conversations whose plan the user just approved: that message continues the plan, so it skips the concierge. */
  private goAhead = new Set<Id>();
  /** Running lead turns by conversation, so Stop can reach them and conversations never block each other. */
  private leads = new Map<Id, { ctl: AbortController; projectId: Id }>();
  private leadActive = new Map<Id, number>();
  /** What the concierge last decided per conversation: the lead keeps its tier for report and help turns. */
  private plans = new Map<Id, Escalation>();
  /** Per native session: the CLI it runs on and, after a move, the one it left and when (the router counts a straight move back against it). */
  private sessionCli = new Map<Id, { cli: CliId; left?: { cli: CliId; at: number } }>();
  /** Conversations where the lead asked a question: the next user message answers it and skips the concierge. */
  private leadAsked = new Set<Id>();
  private conflictAsked = new Set<Id>();
  /** Withdraws an agent's open conflict question once it is moot (the agent got its files, or ended). */
  private conflictAsks = new Map<Id, AbortController>();
  /** Edit helpers already told they are held back by plan mode (one note each). */
  private planHeldNoted = new Set<Id>();
  /** Open questions to the user. In memory only: after a restart the question text is still in the chat to answer by typing. */
  private questions = new Map<Id, { agentId: Id; conversationId: Id }>();
  /** Per helper: the token of its pending question's safe-default timer (a newer question or any answer invalidates it). */
  private askTokens = new Map<Id, number>();
  /** Conversations told that helpers wait for a quota reset; the reset time the pump timer is armed for. */
  private quotaHeld = new Map<Id, number>();
  private quotaArmedFor?: number;
  /** Conversation + uncommitted-files fingerprint already mentioned (the dirty-folder note is said once per state). */
  private dirtyNoted = new Set<string>();
  /** Peer messages waiting for a lead's next turn, by target conversation. In memory: a restart ends the sessions they were meant for. */
  private peerInbox = new Map<Id, PeerMessage[]>();
  /** Urgent wake-ups of an idle lead since the user last wrote to it; bounded so two leads cannot wake each other forever. */
  private peerWakes = new Map<Id, number>();
  private sessionGeneration = new Map<Id, number>();
  private stoppedSessions = new Set<Id>();
  /** Conversations whose running lead turn was aborted to make room for a newer user message (not a user stop). */
  private steered = new Set<Id>();
  /** Pending tool permission requests by request id. */
  private toolAsks = new Map<Id, ToolAsk>();
  private runSeq = 0;
  /** Whether a project folder is a git repository with commits (probed at each lead turn and helper start); decides if edit helpers get a worktree. */
  private repoKind = new Map<Id, 'git' | 'none'>();
  /** Folder prefix of a project inside its repository root ('' unless the project is a subfolder). */
  private prefixes = new Map<string, string>();
  /** Front-desk answers since the lead's last turn, so a resumed lead knows what the user was told meanwhile. In memory. */
  private frontDesk = new Map<Id, Array<{ user: string; answer: string }>>();
  /** Conversations whose lead's last message ended in a question: the next user message is its answer, not a new request. In memory. */
  private leadQuestion = new Set<Id>();
  /** Conversations whose lead was already resumed once for ignored protocol lines since the user's last message. */
  private malformedResumed = new Set<Id>();
  /** One running lead turn per project may edit its folder; the rest wait here, in order. */
  private editSlots = new Map<Id, { holder?: Id; waiting: Array<{ conv: Id; go: () => void }> }>();
  private twoLeadsWarned = new Set<Id>();
  /** Checks files already asked about in this run (project + content hash), so several helpers finishing together ask once. */
  private checksAsks = new Map<string, Promise<boolean>>();
  /** Runs in flight, measured against the spend ceilings. */
  private spendFlights = new Map<symbol, SpendFlight>();
  /** One open "continue past this ceiling?" question per ceiling key; every run waiting on it shares the answer. */
  private spendAsks = new Map<string, Promise<boolean>>();
  /** Ceilings the user declined to extend (key -> project, absent = all projects): not asked again until the user's next message. */
  private spendDenied = new Map<string, Id | undefined>();
  private shuttingDown = false;
  /** Settles when the startup git work of recover() (prune, checkpoints, cleanup) is done. */
  private startup: Promise<void> = Promise.resolve();

  private startedAt = Date.now();
  /** Runs handed to an adapter and not yet ended, for the quota they will still burn (committedNow). */
  private inFlight = new Map<symbol, InFlightRun>();
  /** Helpers routing held for quota (RoutedRun.held), not started again before this time. */
  private heldUntil = new Map<Id, number>();
  /** The follow-up text of a helper whose follow-up run was held for quota; delivered when the pump releases it. */
  private heldFollowUps = new Map<Id, string>();
  /** Settles when the orphan sweep started by recover() is done. */
  private sweep: Promise<OrphanSweep> = Promise.resolve({ killed: [], skipped: [] });
  readonly journal: Journal;
  /** Project notes each conversation's lead session has already been shown (or wrote), so a resumed session is not sent them again. */
  private notesShown = new Map<Id, Set<Id>>();
  private repoMaps: RepoMapCache;

  constructor(private d: OrchestratorDeps) {
    this.locks = new LockTable(() => d.store.locks, (l) => d.store.setLocks(l));
    this.repoMaps = d.repoMaps ?? new RepoMapCache({ git: (cwd, args) => d.git.exec(cwd, args) });
    this.journal = d.journal ?? new Journal();
    // Every CLI process this run starts is persisted, so a crash cannot leave one that the next run cannot identify.
    setSpawnObserver({ spawned: (p) => d.store.trackProcess(p), exited: (pid, started) => d.store.untrackProcess(pid, started) });
  }

  /** Resolves with what the startup orphan sweep did (tests and diagnostics). */
  whenSwept(): Promise<OrphanSweep> { return this.sweep; }

  get lockTable(): LockTable { return this.locks; }

  // ------------------------------------------------------------ plumbing

  private emit(e: HarborEvent): void { this.d.bus.emit(e); }

  private log(e: Omit<JournalEntry, 'time'>): void { this.journal.add(e); }

  private sessionState(id: Id, state: SessionActivity['state'], detail?: string): void {
    const c = this.d.store.getConversation(id);
    if (!c) return;
    const started = state === 'working' && c.activity?.state !== 'working' ? Date.now() : c.activity?.started;
    this.d.store.patchConversation(id, { activity: { ...c.activity, state, started, updated: Date.now(), detail } });
    this.emit({ type: 'conversation', conversation: { ...c } });
  }

  stopConversation(id: Id): void {
    const c = this.d.store.getConversation(id);
    if (!c) throw new Error('This conversation is no longer available.');
    this.stoppedSessions.add(id);
    this.sessionGeneration.set(id, (this.sessionGeneration.get(id) ?? 0) + 1);
    this.denyToolAsks((p) => p.conversationId === id, 'the conversation was stopped');
    // Open screenshot requests of this session are withdrawn, and a window allowed for it is allowed no longer.
    this.d.screenshots?.cancel((r) => r.sessionId === id || r.conversationId === id, 'the conversation was stopped');
    this.d.screenshots?.revokeGrant(id);
    this.leads.get(id)?.ctl.abort();
    for (const a of this.d.store.listAgentRecords(c.projectId)) {
      if (a.role !== 'main' && (a.parentConversationId === id || a.id === c.agentId)) this.stop(a.id);
    }
    this.sessionState(id, 'stopped', 'Stopped by you. Conversation history and files are preserved.');
  }

  private post(conversationId: Id, role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
    const m = this.d.store.addMessage({ id: newId(), conversationId, role, text, time: Date.now(), ...extra });
    this.emit({ type: 'message', message: m });
    return m;
  }

  private publish(a: AgentRecord): void { this.emit({ type: 'agent', agent: toAgent(a) }); }

  private setState(a: AgentRecord, state: AgentState, patch: Partial<AgentRecord> = {}): void {
    Object.assign(a, patch, { state, updated: Date.now() });
    if (state !== 'queued') { this.heldUntil.delete(a.id); this.heldFollowUps.delete(a.id); } // a stopped/cancelled/finished helper is no longer held
    this.d.store.upsertAgent(a);
    this.publish(a);
  }

  private project(id: Id): Project {
    const p = this.d.store.getProject(id);
    if (!p) throw new Error(`Unknown project ${id}`);
    return p;
  }

  private addNote(conversationId: Id, note: string): void {
    const n = this.notes.get(conversationId) ?? [];
    n.push(clip(note, 300));
    this.notes.set(conversationId, n.slice(-10));
  }

  /** Resolves when no agent work or lead turn is in flight (used by tests and the smoke script). */
  async whenIdle(timeoutMs = 60000): Promise<void> {
    const start = Date.now();
    await this.startup;
    for (;;) {
      // A screenshot request waiting for the user is not work in flight; one being checked or captured is.
      const busy = this.running.size > 0 || this.mainBusy > 0 || this.reportWakes.size > 0 || (this.d.screenshots?.active() ?? 0) > 0;
      const pending = this.d.store.allAgentRecords().some((a) => a.role !== 'main' && (a.state === 'queued' || a.state === 'working'));
      if (!busy && !pending) return;
      if (Date.now() - start > timeoutMs) throw new Error('whenIdle timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  private mainBusy = 0;
  /** Lead wake-ups waiting out the debounce, by conversation (see scheduleReport). */
  private reportWakes = new Map<Id, { wake: boolean; last: AgentRecord; cancel: () => void }>();

  // ------------------------------------------------------------ lifecycle

  /** Agent runs and lead turns in flight (what quitting would interrupt). */
  activeRunCount(): number { return this.running.size + this.leads.size; }

  /**
   * Quitting: stop every run (the CLIs' process trees are killed by the aborted streams), then end any CLI process Harbor
   * recorded for this instance through the injected killer, and persist. The synchronous part (abort and flush) happens before
   * the first await, so a caller that cannot wait still gets state on disk. Runs stay `working` in the file; the next start's
   * recover() stops them and keeps their worktrees.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const w of this.reportWakes.values()) w.cancel();
    this.reportWakes.clear();
    for (const ctl of this.controllers.values()) ctl.abort();
    for (const l of this.leads.values()) l.ctl.abort();
    for (const ctl of this.conflictAsks.values()) ctl.abort();
    this.denyToolAsks(() => true, 'Harbor is quitting');
    this.d.screenshots?.cancel(() => true, 'Harbor is quitting');
    this.d.store.flush();
    const killer = this.d.killer ?? systemKiller;
    // Only this instance's processes: a second Harbor's CLIs are not ours to kill.
    const mine = this.d.store.listTrackedProcesses().filter((t) => !t.owner || t.owner.pid === process.pid);
    await Promise.all(mine.map(async (t) => {
      try {
        if (matchesTracked(t, await killer.inspect(t.pid))) await killer.kill(t.pid);
        this.d.store.untrackProcess(t.pid, t.started);
      } catch { /* the next start's orphan sweep still has the record */ }
    }));
    this.d.store.flush();
  }

  /**
   * The machine woke from sleep: timers may have stalled while the wall clock moved on, so each open permission request is
   * re-armed for what is left of its deadline (or denied when that has passed).
   */
  rearmTimers(): void {
    for (const p of [...this.toolAsks.values()]) p.rearm();
    this.d.screenshots?.rearm();
  }

  /** Whether the folder is a git repo with commits; remembered, because lock decisions in the (synchronous) scheduler read it. */
  private async probeRepo(project: Project): Promise<boolean> {
    const repo = await this.d.git.isRepoWithCommits(project.path);
    this.repoKind.set(project.id, repo ? 'git' : 'none');
    return repo;
  }

  /** The project's folder inside its repository ('' unless the project is a subfolder): helpers and checks run in the same subfolder of their worktree. */
  private async prefixOf(project: Project): Promise<string> {
    const known = this.prefixes.get(project.path);
    if (known !== undefined) return known;
    const prefix = await this.d.git.showPrefix(project.path).catch(() => '');
    this.prefixes.set(project.path, prefix);
    return prefix;
  }

  private async cwdIn(project: Project, worktree: string): Promise<string> {
    const prefix = await this.prefixOf(project);
    return prefix ? join(worktree, prefix) : worktree;
  }

  /**
   * Removes the worktree folders of work that is done with: landed (applied integration or rollback, or a source merged into
   * an applied integration) or idle for `maxAgeDays`. Branches are never deleted, so the work stays reachable and a follow-up
   * re-attaches the worktree. Never a running or queued agent, an upstream someone still waits for, or a source of an
   * integration that is not applied yet. Uncommitted files are committed first; a folder that still is not clean stays.
   */
  async collectWorktrees(maxAgeDays = 14): Promise<number> {
    const { store, git } = this.d;
    const now = Date.now();
    const horizon = maxAgeDays * 86_400_000;
    let removed = 0;
    for (const project of store.listProjects()) {
      const agents = store.listAgentRecords(project.id);
      const entries: WorktreeEntry[] = [];
      for (const a of agents) {
        if (!a.worktree || !a.branch) continue;
        const live = this.running.has(a.id) || ['queued', 'working', 'waiting'].includes(a.state);
        const needed = agents.some((o) => o.id !== a.id && (
          (o.dependsOn.includes(a.id) && !TERMINAL.includes(o.state)) ||
          (!!o.integration && !o.integration.applied && now - (o.updated ?? o.created) < horizon && o.integration.sources.some((s) => s.agentId === a.id))));
        const applied = !!(a.integration?.applied || a.rollback?.applied);
        const merged = !a.integration && !a.rollback && agents.some((i) => !!i.integration?.applied && i.integration.sources.some((s) => s.agentId === a.id && s.state === 'merged'));
        entries.push({ path: a.worktree, branch: a.branch, lastActivity: a.updated ?? a.created, applied, merged, active: live || needed });
      }
      for (const e of staleWorktrees(entries, this.d.worktreesRoot, now, maxAgeDays)) {
        const a = agents.find((x) => x.worktree === e.path);
        if (!a) continue;
        try {
          if (existsSync(e.path)) {
            if (this.canEdit(a) && !a.integration && !a.rollback) await git.checkpoint(e.path, `harbor: ${a.title} (before cleanup)`);
            const st = await git.exec(e.path, ['status', '--porcelain', '--untracked-files=all']);
            if (!st.ok || st.stdout.trim()) continue; // not clean (or unknown): leave it for the user
            await git.removeWorktree(project.path, this.d.worktreesRoot, e.path); // no branch argument: the branch stays
          }
          a.worktree = undefined;
          store.upsertAgent(a);
          this.publish(a);
          removed++;
        } catch { /* a worktree that cannot be removed now is tried again at the next start */ }
      }
    }
    return removed;
  }

  // ------------------------------------------------------------ projects

  ensureProject(project: Project): { main: AgentRecord; conversation: Conversation } {
    const { store } = this.d;
    let main = store.mainAgent(project.id);
    if (!main) {
      main = store.upsertAgent({
        id: newId(), projectId: project.id, role: 'main', title: 'Lead agent', state: 'waiting',
        cli: 'auto', model: 'auto', effort: 'low', task: 'Work on the user\'s requests', dependsOn: [], revision: 1,
        parentConversationId: '', attempts: 0, created: Date.now()
      });
    }
    let conv = store.listConversations(project.id).find((c) => c.agentId === main!.id);
    if (!conv) conv = this.newConversation(project.id);
    return { main, conversation: conv };
  }

  newConversation(projectId: Id): Conversation {
    const main = this.d.store.mainAgent(projectId) ?? this.ensureProject(this.project(projectId)).main;
    return this.d.store.addConversation({ id: newId(), projectId, title: DEFAULT_TITLE, updated: Date.now(), agentId: main.id });
  }

  /** Reconcile persisted state after a restart: nothing is running, so working agents are stopped (never replayed). */
  recover(): void {
    this.sweep = this.reapOrphans();
    for (const p of this.d.store.listProjects()) for (const c of this.d.store.listConversations(p.id)) {
      if (c.activity && ['working', 'queued'].includes(c.activity.state)) this.sessionState(c.id, 'stopped', 'Harbor restarted. Send a message to continue.');
    }
    // The pump below must not fail dependents of these agents (or start a lead turn): they wait until the user resumes or stops.
    const interrupted: AgentRecord[] = [];
    for (const a of this.d.store.allAgentRecords()) {
      if (a.state === 'working') { this.setState(a, 'stopped', { error: RESTART_ERROR, stopKind: 'restart' }); if (a.role !== 'main') interrupted.push(a); }
      if (a.role === 'main') this.setState(a, 'waiting');
    }
    this.d.store.setLocks(this.d.store.locks.filter((l) => this.running.has(l.agentId)));
    this.noticeUncertainReports();
    this.noticeInterrupted(interrupted);
    for (const p of this.d.store.listProjects()) this.pump(p.id);
    this.startup = this.startupGit(interrupted).catch(() => {});
  }

  /** One summary per conversation of the helpers the restart stopped; it also goes to the lead's next turn as a note (no turn is started). */
  private noticeInterrupted(items: AgentRecord[]): void {
    const byConv = new Map<Id, AgentRecord[]>();
    for (const a of items) {
      if (!this.d.store.getConversation(a.parentConversationId)) continue;
      byConv.set(a.parentConversationId, [...(byConv.get(a.parentConversationId) ?? []), a]);
    }
    for (const [conv, list] of byConv) {
      const refs = list.slice(0, MAX_HELD_REFS).map((a) => `"${clip(a.title, 50)}"${a.branch ? ` (${a.branch})` : ''}`).join(', ') + (list.length > MAX_HELD_REFS ? `, and ${list.length - MAX_HELD_REFS} more` : '');
      const text = `Harbor restarted while ${list.length} helper(s) were running: ${refs}. They are stopped, and uncommitted work in their worktrees is committed to their branches. Resume one to continue it from its saved session, or leave it.`;
      this.post(conv, 'system', text);
      this.addNote(conv, `Restart: ${list.length} helper(s) were stopped mid-run (${refs}); their work so far is on their branches.`);
    }
  }

  /**
   * After a restart, once the orphan sweep has ended old CLI processes: forget worktree records whose folder is gone, commit
   * what the interrupted helpers left uncommitted (so nothing is lost with the worktree), and clean up worktrees that are done with.
   */
  private async startupGit(interrupted: AgentRecord[]): Promise<void> {
    await this.sweep.catch(() => {});
    // Only folders with a .git entry: a project that is not a repository has nothing to prune, and no git process should run there.
    const repos = this.d.store.listProjects().filter((p) => existsSync(join(p.path, '.git')));
    for (const p of repos) if (this.d.store.listAgentRecords(p.id).some((a) => a.worktree)) await this.d.git.pruneWorktrees(p.path).catch(() => false);
    for (const a of interrupted) {
      if (this.running.has(a.id)) continue; // resumed already
      if (a.worktree && a.baseCommit && this.canEdit(a) && existsSync(a.worktree)) await this.checkpointWork(a).catch(() => undefined);
    }
    if (this.shuttingDown) return;
    await this.collectWorktrees().catch(() => 0);
  }

  /** Commits uncommitted work of an edit helper to its branch (a stopped, failed or interrupted run). Returns a sentence for the report. */
  private async checkpointWork(a: AgentRecord): Promise<string> {
    const cp = await this.d.git.checkpoint(a.worktree!, `harbor: ${a.title} (partial)`);
    if (cp.head) { a.headCommit = cp.head; this.d.store.upsertAgent(a); this.markOutdated(a.projectId, a.worktree!, cp.head); }
    return checkpointNote(cp, a.branch);
  }

  /**
   * Tells each conversation once which helper reports may not have reached its lead (an interrupted turn, or an upgraded
   * file). Nothing starts here: the reports wait for the lead's next turn, whatever starts it.
   */
  private noticeUncertainReports(): void {
    const byConv = new Map<Id, AgentRecord[]>();
    for (const a of this.d.store.allAgentRecords()) {
      const d = deliveryOf(a);
      if (a.role === 'main' || a.byUser || !d || !UNCERTAIN.includes(d.status) || d.noticed || !this.d.store.getConversation(a.parentConversationId)) continue;
      byConv.set(a.parentConversationId, [...(byConv.get(a.parentConversationId) ?? []), a]);
    }
    for (const [conv, items] of byConv) {
      this.post(conv, 'system', `Harbor cannot tell whether the lead received ${items.length} helper report(s): ${reportRefs(items)}. Each report is kept and goes to the lead with its next turn (your next message to it, or its next helper report), marked as possibly seen already. Nothing is re-run.`);
      this.d.store.noticeReports(items);
    }
  }

  /** Stopped by a restart (not by the user), and not resumed since: its dependents keep waiting instead of failing. */
  private restartStopped(a: AgentRecord): boolean {
    return a.state === 'stopped' && a.error === RESTART_ERROR;
  }

  /**
   * Kill CLI processes a previous Harbor run left behind. Only PIDs Harbor recorded are considered, and only
   * when the live process still has the recorded name and start time (a reused PID is someone else's process).
   */
  private async reapOrphans(): Promise<OrphanSweep> {
    const { store } = this.d;
    const killer = this.d.killer ?? systemKiller;
    // Snapshot before anything else: processes this run spawns (discovery, agents) are recorded too and must be left alone.
    const old = store.listTrackedProcesses().filter((t) => t.started < this.startedAt);
    // Records owned by a Harbor that is still running are kept and skipped (a second window must not kill the first's CLIs).
    return await reapTrackedProcesses(old, store, killer);
  }

  /**
   * Continue a stopped helper in its own native session. Nothing is replayed: the prompt tells the agent to
   * inspect its worktree and keep what already happened, and the session link must exist.
   */
  resumeAgent(agentId: Id): void {
    const a = this.d.store.getAgent(agentId);
    if (!a) throw new Error('This agent is no longer available.');
    if (a.role === 'main') throw new Error('Send a message in the conversation to continue the lead agent.');
    if (a.state !== 'stopped') throw new Error('Only a stopped agent can be resumed.');
    if (this.running.has(a.id)) throw new Error('This agent is already running.');
    if (!a.integration && !a.rollback && !this.d.store.getSession(a.id)) throw new Error('This agent has no saved session to resume. Send it a message instead.');
    this.stoppedSessions.delete(a.parentConversationId);
    this.reported.delete(reportKey(a));
    this.d.store.clearReportDelivery(a.id);
    this.post(this.convFor(a), 'system', 'Resuming from the saved session.', { agentId: a.id });
    this.followUp(a, RESUME_PROMPT);
  }

  // ------------------------------------------------------------ user input

  /** `attachments` are already validated and written to disk by the service (each has a `path`). */
  async userMessage(conversationId: Id, text: string, attachments: Attachment[] = [], opts: { steer?: boolean } = {}): Promise<void> {
    const conv = this.d.store.getConversation(conversationId);
    if (!conv) throw new Error('Unknown conversation');
    const agent = this.d.store.getAgent(conv.agentId);
    if (!agent) throw new Error('Conversation has no agent');
    if (conv.archived) throw new Error('Restore this conversation before sending a message.');
    // Imported history (plan 6.2) is read-only: no agent ever runs in it; continueImported starts a new conversation instead.
    if (conv.imported) throw new Error('This is imported history and is read-only. Use "Continue with…" to keep working on it.');
    this.post(conversationId, 'user', text, { agentId: agent.id, ...(attachments.length ? { attachments } : {}) });
    // A go-ahead after a plan ends plan mode: the lead now executes what it proposed.
    if (conv.mode === 'plan' && isApproval(text)) {
      this.d.store.patchConversation(conversationId, { mode: 'default' });
      this.goAhead.add(conversationId);
      this.planHeldNoted.clear();
      this.pump(agent.projectId); // helpers held back by plan mode may start now
      this.post(conversationId, 'system', 'Plan approved: switching this conversation back to the default mode. The lead will carry out the plan.');
      this.emit({ type: 'conversation', conversation: { ...this.d.store.getConversation(conversationId)! } });
    }
    this.goalTurns.set(conversationId, 0);
    this.malformedResumed.delete(conversationId);
    // A new message is a new decision: a ceiling the user declined to extend is asked about again the next time it stops a run.
    for (const [key, p] of this.spendDenied) if (p === undefined || p === conv.projectId) this.spendDenied.delete(key);
    this.d.store.setGoalPaused(conversationId, false); // a new message clears a goal pause
    for (const [id, q] of this.questions) if (q.conversationId === conversationId) this.questions.delete(id);
    if (conv.title === DEFAULT_TITLE && !conv.customTitle) this.d.store.touchConversation(conv.id, { title: titleFrom(text) });
    if (agent.role === 'main') {
      this.autoTurns.set(conversationId, 0);
      this.peerWakes.delete(conversationId);
      if (opts.steer) this.interruptLead(conversationId);
      const isImage = (a: Attachment) => a.mime.startsWith('image/');
      const images = attachments.filter(isImage).map((a) => a.path).filter((p): p is string => !!p);
      const files = attachments.filter((a) => !isImage(a) && a.path).map((a) => a.path!);
      this.enqueueMain(agent.projectId, { kind: 'user', text: files.length ? `${text}

${attachedFilesNote(attachments.filter((a) => !isImage(a) && a.path))}` : text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) }, conversationId);
    } else {
      const others = attachments.filter((a) => !a.mime.startsWith('image/') && a.path);
      this.direct(agent, others.length ? `${text}

${attachedFilesNote(others)}` : text, conversationId);
    }
  }

  /**
   * Steering: the user sent a message while the lead is mid-turn and wants it acted on now, not after the turn. The running turn
   * is aborted (its native session, helpers and files stay) and the message starts the next one, which resumes that session.
   * Turns already chained behind it are dropped like on a stop; their reports stay held and ride along with the new turn.
   */
  private interruptLead(conversationId: Id): void {
    const lead = this.leads.get(conversationId);
    if (!lead || lead.ctl.signal.aborted) return;
    this.steered.add(conversationId);
    this.sessionGeneration.set(conversationId, (this.sessionGeneration.get(conversationId) ?? 0) + 1);
    this.denyToolAsks((p) => p.conversationId === conversationId, 'the user sent a new message');
    this.addNote(conversationId, 'The user sent a new message while you were working, so your previous turn was cut off mid-way. Check the current state of the folder (git status, git log) before continuing and do not repeat steps that already finished. Follow the new message; drop earlier plans it contradicts.');
    lead.ctl.abort();
  }

  /**
   * The user switched a conversation's mode. Running helpers are never killed or re-permissioned: a mode only governs
   * runs that start afterwards (plan also holds queued edit helpers back until the mode changes again).
   */
  modeChanged(conversationId: Id, from: ConversationMode, to: ConversationMode): void {
    const conv = this.d.store.getConversation(conversationId);
    if (!conv || from === to) return;
    const helpers = this.d.store.listAgentRecords(conv.projectId).filter((x) => x.role !== 'main' && x.parentConversationId === conversationId);
    const running = helpers.filter((x) => this.running.has(x.id)).length;
    if (to === 'plan') {
      this.post(conversationId, 'system', running
        ? `Plan mode: ${running} running helper(s) continue with the permissions they started with. Helpers that start from now on are read-only, and queued edit helpers wait until you leave plan mode.`
        : 'Plan mode: helpers that start from now on are read-only, and queued edit helpers wait until you leave plan mode.');
    } else if (to === 'auto') {
      // Auto mode takes effect in the running conversation too: requests already waiting are allowed, and later ones from running agents are.
      let allowed = 0;
      for (const [id, p] of [...this.toolAsks]) {
        const ag = this.d.store.getAgent(p.agentId);
        if (p.conversationId === conversationId && !p.noRules && ag && (ag.role === 'main' || this.canEdit(ag)) && this.finishToolAsk(id, { allow: true }, 'allowed: auto mode was turned on', `Allowed ${p.tool}: auto mode is on.`)) allowed++;
      }
      const restart = !!this.leads.get(conversationId) && !this.leads.get(conversationId)!.ctl.signal.aborted && from !== 'plan';
      this.post(conversationId, 'system', `Auto mode is on for this conversation now${allowed ? `; ${allowed} waiting request(s) were allowed` : ''}. Running agents no longer ask before tools that need your permission.${restart ? ' The lead is restarting its turn so the sandbox lifts too.' : ' A running helper keeps its sandbox until its next run starts.'}`);
      // A running lead turn keeps the permissions it started with, so it is restarted once (its native session resumes) to run in full.
      if (restart) {
        this.leadAsked.add(conversationId); // the restart message continues the lead's own work: no front-desk triage
        this.interruptLead(conversationId);
        this.enqueueMain(conv.projectId, { kind: 'user', text: 'Auto mode was just turned on, so you now run without permission prompts. Continue exactly where you stopped; do not redo finished steps.' }, conversationId);
      }
    }
    if (from === 'plan') this.planHeldNoted.clear();
    if (to === 'goal') this.d.store.setGoalPaused(conversationId, false);
    this.pump(conv.projectId);
  }

  stop(agentId: Id): void {
    const a = this.d.store.getAgent(agentId);
    if (!a) return;
    if (a.role === 'main') {
      // Stop the conversations whose lead is running; with none running, stop every helper of the project.
      const active = [...this.leads].filter(([, l]) => l.projectId === a.projectId);
      const convs = new Set(active.map(([c]) => c));
      for (const s of this.d.store.listAgentRecords(a.projectId)) {
        if (s.role !== 'main' && (!convs.size || convs.has(s.parentConversationId))) this.stop(s.id);
      }
      this.denyToolAsks((p) => p.agentId === a.id && convs.has(p.conversationId), 'the lead was stopped');
      this.d.screenshots?.cancel((r) => r.agentId === a.id && (!convs.size || convs.has(r.sessionId)), 'the lead was stopped');
      for (const [, l] of active) l.ctl.abort();
      return;
    }
    this.denyToolAsks((p) => p.agentId === a.id, 'the agent was stopped');
    this.d.screenshots?.cancel((r) => r.agentId === a.id, 'the agent was stopped');
    this.controllers.get(a.id)?.abort();
    if (!this.running.has(a.id) && !TERMINAL.includes(a.state)) {
      this.setState(a, 'stopped', { error: 'Stopped by the user before it started.', stopKind: 'user' });
      this.locks.release(a.id);
      this.finished(a);
    }
  }

  private helperRecord(agentId: Id): AgentRecord {
    const a = this.d.store.getAgent(agentId);
    if (!a) throw new Error('Unknown agent');
    if (a.role === 'main') throw new Error('The lead agent has no queue position. Use stop to stop it.');
    return a;
  }

  /** Higher runs first among queued work of the same project; default 0. Does not affect running agents. */
  setPriority(agentId: Id, priority: number): void {
    if (!Number.isFinite(priority)) throw new Error('Priority must be a number.');
    const a = this.helperRecord(agentId);
    a.priority = priority;
    this.d.store.upsertAgent(a);
    this.publish(a);
    this.pump(a.projectId);
  }

  /** Keeps a queued agent from starting. A running agent is not interrupted; the flag only applies if it is queued again. */
  pause(agentId: Id): void {
    const a = this.helperRecord(agentId);
    if (TERMINAL.includes(a.state) || a.paused) return;
    a.paused = true;
    this.d.store.upsertAgent(a);
    this.publish(a);
  }

  resume(agentId: Id): void {
    const a = this.helperRecord(agentId);
    if (!a.paused) return;
    a.paused = false;
    this.d.store.upsertAgent(a);
    this.publish(a);
    this.pump(a.projectId);
  }

  // ------------------------------------------------------------ concierge and lead

  /** `batch`: the helper results a reports trigger carries; settled however the turn ends, including when it is dropped. */
  private enqueueMain(projectId: Id, trigger: LeadTrigger, conversationId: Id, batch?: ReportBatch): void {
    if (trigger.kind !== 'user' && this.stoppedSessions.has(conversationId)) { if (batch) this.settleReports(batch, 'notStarted', conversationId); return; }
    if (trigger.kind === 'user') this.stoppedSessions.delete(conversationId);
    // One chain per conversation: a long turn in one conversation must not block another.
    const prev = this.mainChain.get(conversationId) ?? Promise.resolve();
    const generation = this.sessionGeneration.get(conversationId) ?? 0;
    if (!this.leads.has(conversationId)) this.sessionState(conversationId, 'queued', 'Waiting to start.');
    this.mainBusy++;
    const next = prev.then(() => generation === (this.sessionGeneration.get(conversationId) ?? 0) ? this.mainTurn(projectId, trigger, conversationId, batch) : undefined).catch((e) => {
      this.post(conversationId, 'system', `Lead agent error: ${String(e?.message ?? e)}`);
      this.sessionState(conversationId, 'failed', String(e?.message ?? e));
    }).finally(() => {
      // A turn dropped (newer session generation) or broken before it settled its reports.
      if (batch && !batch.settled) this.settleReports(batch, batch.started ? 'interrupted' : 'notStarted', conversationId);
      this.mainBusy--;
      if (this.mainChain.get(conversationId) === next) this.mainChain.delete(conversationId);
    });
    this.mainChain.set(conversationId, next);
  }

  /** Every user prompt: a cheap concierge first, then (only when it escalates) a lead chosen for the work. */
  private async mainTurn(projectId: Id, trigger: LeadTrigger, conversationId: Id, batch?: ReportBatch): Promise<void> {
    const project = this.project(projectId);
    const main = this.ensureProject(project).main;
    const ctl = new AbortController();
    this.leads.set(conversationId, { ctl, projectId });
    this.leadActive.set(projectId, (this.leadActive.get(projectId) ?? 0) + 1);
    this.setState(main, 'working');
    this.sessionState(conversationId, 'working', 'Harbor is working on this conversation.');
    try {
      if (!this.d.store.getConversation(conversationId)?.reviewBase) {
        const base = await this.d.git.head(project.path);
        if (base) this.d.store.patchConversation(conversationId, { reviewBase: base });
      }
      let plan: Escalation = this.plans.get(conversationId) ?? { complexity: 'medium', needs: [], ack: '' };
      if (trigger.kind === 'user') {
        const deep = /^\/deep\b\s*/i.exec(trigger.text);
        // Continuing an imported chat: the front desk cannot see that chat, so the first turn goes to the lead, which gets the handoff.
        const continuation = this.d.store.continuation(conversationId);
        const freshContinuation = !!continuation && !this.d.store.getSession(`lead:${conversationId}`);
        if (freshContinuation && !deep && !trigger.images?.length) {
          plan = this.estimated(conversationId, trigger.text);
        } else if (deep) {
          // "/deep" skips the front desk and gives the lead the strongest reasoning: difficulty 9 is beyond what any model reaches
          // only by thinking harder, so the price cannot trade it down to a weaker model at high effort.
          plan = { complexity: 'high', needs: ['planning', 'code'], ack: '', effort: 'high', difficulty: DEEP_DIFFICULTY };
          trigger = { ...trigger, text: trigger.text.slice(deep[0].length) || trigger.text };
        } else if (trigger.images?.length || trigger.files?.length) {
          // The front desk can neither see images nor open files, so it never triages them: straight to a lead that can.
          plan = this.estimated(conversationId, trigger.text, (trigger.images?.length ?? 0) + (trigger.files?.length ?? 0));
        } else if ((this.plans.has(conversationId) || this.goAhead.has(conversationId)) && isApproval(trigger.text)) {
          // A go-ahead continues the last request at its size: no front-desk call, no fresh guess. A one-off "/deep" is not inherited.
          plan = { ...plan, effort: undefined, difficulty: undefined };
        } else if (!this.leadAsked.has(conversationId) && this.heldReports(project.id, conversationId).items.length) {
          // Held reports need the lead: the front desk sees only their summaries and would answer "continue" itself, leaving
          // them stranded. Decided here, when the turn runs, so reports settled or queued meanwhile count as they are now.
          plan = { ...plan, effort: undefined, difficulty: undefined };
        } else if (!this.leadAsked.has(conversationId)) {
          // Obvious work (a file, a command, a named CLI) and replies to the lead's question never need the front desk's guess:
          // deciding that before the call saves the call.
          const direct = this.bypassConcierge(conversationId, trigger.text);
          if (direct) plan = direct;
          else {
            const c = await this.concierge(project, main, conversationId, trigger.text, ctl.signal);
            if (c === 'handled') { this.leadQuestion.delete(conversationId); return; }
            plan = c;
          }
        } // else: this message answers the lead's own question, so there is nothing to triage
        // An explicit "use codex" applies to this request (and its go-aheads); other messages keep the earlier choice.
        const asked = requestedCli(trigger.text);
        if (asked) plan = { ...plan, preferCli: asked };
        // The CLI the user picked in "Continue with…" is preferred until a message names another one.
        else if (continuation && !plan.preferCli) plan = { ...plan, preferCli: continuation.cli };
        this.plans.set(conversationId, plan);
        // Vision is a need of this turn only; later go-ahead turns must not inherit it.
        if (trigger.images?.length && !plan.needs.includes('vision')) plan = { ...plan, needs: [...plan.needs, 'vision'] };
      }
      this.goAhead.delete(conversationId);
      this.leadAsked.delete(conversationId);
      this.leadQuestion.delete(conversationId);
      // Whatever the front desk guessed, the lead edits and reads code: it is never left with only "chat".
      plan = { ...plan, needs: withCodeNeed(plan.needs) };
      this.warnTwoLeads(project, conversationId);
      // One lead turn per project edits the folder at a time; plan-mode leads are read-only and never wait.
      // A plain question ("what is happening in the latest run?") is read-only too: it must not sit behind a long editing session.
      const lookOnly = trigger.kind === 'user' && this.editSlots.get(projectId)?.holder !== undefined && isReadOnlyQuestion(trigger.text);
      if (lookOnly) this.addNote(conversationId, 'Another session of this project is editing the folder right now. This turn is only a question: read and report, and do not edit, commit or run anything that changes files. If the user wants changes, say so and ask them to send that as a separate request.');
      const edits = (this.d.store.getConversation(conversationId)?.mode ?? 'default') !== 'plan' && !lookOnly;
      const release = edits ? await this.acquireEditSlot(projectId, conversationId, ctl.signal) : undefined;
      try {
        if (ctl.signal.aborted) return;
        this.sessionState(conversationId, 'working', 'Harbor is working on this conversation.');
        await this.leadTurn(project, main, trigger, conversationId, plan, ctl.signal, batch);
      } finally { release?.(); }
    } finally {
      this.leads.delete(conversationId);
      const steered = this.steered.delete(conversationId);
      if (steered) { /* the next turn is already queued and sets the state itself */ }
      else if (ctl.signal.aborted) this.sessionState(conversationId, 'stopped', 'Stopped by you.');
      else if (this.d.store.getConversation(conversationId)?.activity?.state === 'working') this.sessionState(conversationId, 'done', 'The lead has finished its turn.');
      const n = (this.leadActive.get(projectId) ?? 1) - 1;
      if (n <= 0) { this.leadActive.delete(projectId); this.setState(main, 'waiting'); } else this.leadActive.set(projectId, n);
    }
  }

  /** Escalate without asking the front desk: the message is plainly work, or answers the lead's own last question. */
  private bypassConcierge(conversationId: Id, text: string): Escalation | undefined {
    if (needsWorkspace(text) || requestedCli(text) || this.leadQuestion.has(conversationId)) return this.estimated(conversationId, text);
    return undefined;
  }

  /**
   * Complexity from the request's own wording (see complexity.ts). With no concierge verdict it stands alone; with one, it can only
   * raise it to high. Needs stay 'code': the lead always reads and edits.
   */
  private estimated(conversationId: Id, text: string, attachments?: number, concierge?: Escalation): Escalation {
    const est = estimateComplexity({ text, attachments, mode: this.d.store.getConversation(conversationId)?.mode });
    const c = combineComplexity(est, concierge?.complexity);
    return { ...(concierge ?? { needs: ['code'] as Need[], ack: '' }), complexity: c.complexity, note: c.note };
  }

  /** Counts one automatic lead turn against the cap since the user's last message; false (and a notice) once it is spent. */
  private autoTurn(conversationId: Id): boolean {
    const turns = (this.autoTurns.get(conversationId) ?? 0) + 1;
    this.autoTurns.set(conversationId, turns);
    if (turns > (this.d.maxAutoTurns ?? 12)) {
      this.post(conversationId, 'system', 'Paused automatic coordination after many consecutive steps. Send a message to continue.');
      return false;
    }
    return true;
  }

  /**
   * The slot that lets one lead turn per project edit its folder. Waiting turns show as queued and go in order; a stop while
   * waiting gives the place up. Resolves to the release function (undefined only when the wait was aborted).
   */
  private acquireEditSlot(projectId: Id, conversationId: Id, signal: AbortSignal): Promise<(() => void) | undefined> {
    const slot = this.editSlots.get(projectId) ?? { waiting: [] };
    this.editSlots.set(projectId, slot);
    const release = (): void => {
      slot.holder = undefined;
      const next = slot.waiting.shift();
      if (next) next.go();
      else if (this.editSlots.get(projectId) === slot) this.editSlots.delete(projectId);
    };
    const take = (): (() => void) => { slot.holder = conversationId; return release; };
    if (!slot.holder) return Promise.resolve(take());
    const other = this.d.store.getConversation(slot.holder);
    this.sessionState(conversationId, 'queued', `Waiting for the session "${clip(other?.title ?? 'another session', 50)}", which is editing this project. Only one session edits the project folder at a time.`);
    return new Promise((resolve) => {
      const entry = { conv: conversationId, go: () => { signal.removeEventListener('abort', onAbort); resolve(take()); } };
      const onAbort = (): void => {
        const i = slot.waiting.indexOf(entry);
        if (i >= 0) slot.waiting.splice(i, 1);
        resolve(undefined);
      };
      slot.waiting.push(entry);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Once per project: two sessions with a running lead share one folder. */
  private warnTwoLeads(project: Project, conversationId: Id): void {
    if (this.twoLeadsWarned.has(project.id)) return;
    const other = [...this.leads].find(([c, l]) => c !== conversationId && l.projectId === project.id);
    if (!other) return;
    this.twoLeadsWarned.add(project.id);
    this.post(conversationId, 'system', 'Another session of this project has a running lead. Both work in the same folder, so Harbor lets only one of them edit at a time (the other waits, read-only plan mode excepted). Keep their tasks apart anyway: they cannot see each other\'s uncommitted edits.');
  }

  // ------------------------------------------------------------ other sessions of the same project

  /** Conversations led by the project's lead agent (helper chats are not sessions), archived ones excluded. */
  private leadConversations(projectId: Id, except: Id): Conversation[] {
    const main = this.d.store.mainAgent(projectId);
    return this.d.store.listConversations(projectId).filter((c) => c.id !== except && !c.archived && !!main && c.agentId === main.id);
  }

  /** What one lead is told about its siblings: only sessions that are running, described from Harbor's own records. */
  sessionPeers(projectId: Id, conversationId: Id): SessionPeer[] {
    return this.leadConversations(projectId, conversationId)
      .filter((c) => c.activity?.state === 'working' || c.activity?.state === 'queued')
      .map((c) => ({
        id: c.id, title: c.title, state: c.activity!.state,
        goal: this.d.store.listMessages(c.id).filter((m) => m.role === 'user').at(-1)?.text ?? c.title,
        branches: this.registerFor(projectId, c.id).filter((a) => a.branch && !TERMINAL.includes(a.state)).map((a) => a.branch!)
      }));
  }

  /** Id, id prefix, exact title, then unique title substring. Ambiguity resolves to nothing: a message must never reach the wrong session. */
  private resolveSession(candidates: Conversation[], to: string): Conversation | undefined {
    const q = to.trim().toLowerCase();
    if (!q) return undefined;
    const pick = (pred: (c: Conversation) => boolean) => { const m = candidates.filter(pred); return m.length === 1 ? m[0] : undefined; };
    return pick((c) => c.id.toLowerCase() === q) ?? (q.length >= 6 ? pick((c) => c.id.toLowerCase().startsWith(q)) : undefined)
      ?? pick((c) => c.title.toLowerCase() === q) ?? pick((c) => c.title.toLowerCase().includes(q));
  }

  /** A lead's HARBOR_PEER line: recorded, shown in both transcripts, and handed to the target's lead at a turn boundary. */
  private deliverPeer(projectId: Id, fromConv: Id, req: PeerRequest): void {
    const sender = this.d.store.getConversation(fromConv);
    const target = this.resolveSession(this.leadConversations(projectId, fromConv), req.to);
    if (!sender) return;
    if (!target) {
      this.post(fromConv, 'system', `Could not deliver a message to "${clip(req.to, 60)}": no single other session of this project matches.`);
      return;
    }
    const msg: PeerMessage = { fromId: sender.id, fromTitle: sender.title, text: req.text, urgent: req.urgent, time: Date.now() };
    this.d.store.addCoordination({ projectId, kind: 'peer', from: sender.id, to: target.id, text: req.text });
    this.post(fromConv, 'system', `You told session "${clip(target.title, 60)}": ${clip(req.text, 200)}`);
    this.post(target.id, 'system', `Message from session "${clip(sender.title, 60)}": ${clip(req.text, 200)}`);
    const idle = !this.leads.has(target.id) && !this.stoppedSessions.has(target.id);
    const wakes = this.peerWakes.get(target.id) ?? 0;
    // Waking an idle lead spends quota, so only an urgent message does, and only a few times between user messages.
    if (req.urgent && idle && wakes < MAX_PEER_WAKES) {
      this.peerWakes.set(target.id, wakes + 1);
      this.enqueueMain(projectId, { kind: 'peer', messages: [msg] }, target.id);
      return;
    }
    const q = this.peerInbox.get(target.id) ?? [];
    this.peerInbox.set(target.id, [...q, msg].slice(-MAX_PEER_INBOX));
  }

  private registerFor(projectId: Id, conversationId: Id): AgentRecord[] {
    return this.d.store.listAgentRecords(projectId).filter((x) => x.role !== 'main' && x.parentConversationId === conversationId);
  }

  private chatHistory(conversationId: Id, excludeLatest: boolean): Message[] {
    const msgs = this.d.store.listMessages(conversationId).filter((m) => m.role === 'user' || m.role === 'assistant');
    return (excludeLatest ? msgs.slice(0, -1) : msgs).slice(-10);
  }

  /** An empty folder for runs that read no files (Harbor's data folder when known, else an OS temp subfolder); the project's own folder if it cannot be made. */
  private neutralCwd(fallback: string): string {
    const dir = this.d.neutralDir ?? join(tmpdir(), 'harbor-neutral');
    try { mkdirSync(dir, { recursive: true }); return dir; } catch { return fallback; }
  }

  /** Cheap model: answers simple messages itself, otherwise says what the work needs. Never uses tools. */
  private async concierge(project: Project, main: AgentRecord, conversationId: Id, text: string, signal: AbortSignal): Promise<'handled' | Escalation> {
    const out = await this.runRouted(main, {
      prompt: conciergePrompt(project.name, this.registerFor(project.id, conversationId), this.chatHistory(conversationId, true).slice(-8), text), system: CONCIERGE_SYSTEM,
      role: 'main', complexity: 'low', tier: 'cheap', effort: 'low', fixedEffort: true, needs: ['chat'], permission: 'read-only', interactive: true,
      // It answers from its prompt (project name, helper list, recent chat), so it needs neither the repository nor any of the CLI's
      // tools or environment: a neutral folder and a lean run keep the cheap model cheap.
      cwd: this.neutralCwd(project.path), lean: true,
      signal, resume: false, conversationId, stream: false, sessionKey: `concierge:${conversationId}`
    });
    if (!out.ok) {
      this.sessionState(conversationId, out.stopped ? 'stopped' : 'failed', out.spent ? 'Stopped: spend ceiling reached (estimate).' : out.error);
      this.post(conversationId, 'system', out.spent ? `Not answered: ${out.error}` : out.stopped ? 'Stopped.' : `Harbor could not run: ${out.error}`, { agentId: main.id });
      return 'handled';
    }
    const details = out.decision && detailsOf(out.decision);
    const d = parseConcierge(out.text);
    // The front desk cannot read files: an answer to a message that clearly needs the workspace is a guess, so the lead takes it.
    // Medium (not high): the guard knows work is needed, not how hard it is, and must not buy Opus for a trivial edit.
    if (d.kind === 'answer' && needsWorkspace(text)) return this.estimated(conversationId, text);
    if (d.kind === 'answer') {
      this.post(conversationId, 'assistant', d.text, { agentId: main.id, details });
      // The lead never sees this exchange; its next turn is told (see leadTurn).
      this.frontDesk.set(conversationId, [...(this.frontDesk.get(conversationId) ?? []), { user: text, answer: d.text }].slice(-3));
      return 'handled';
    }
    if (d.escalation.ack) this.post(conversationId, 'assistant', d.escalation.ack, { agentId: main.id, details });
    return this.estimated(conversationId, text, undefined, d.escalation);
  }

  /**
   * Harbor's own record of this conversation for a session that cannot resume (see handoff.ts): decisions, unfinished work and
   * what verification still covers. Evidence is compared with each branch's head now, so a later commit shows as stale.
   */
  private async handoffFor(project: Project, conversationId: Id): Promise<string> {
    const { store, git } = this.d;
    const conv = store.getConversation(conversationId);
    const agents = this.registerFor(project.id, conversationId);
    const evidence: HandoffEvidence[] = [];
    for (const a of agents) {
      if (a.integration || a.rollback || !a.branch || a.role === 'reviewer') continue;
      const head = await git.branchHead(project.path, a.branch).catch(() => undefined);
      const reviews = this.reviewersOf(project.id, a).filter((r) => r.state === 'done' && r.testedCommit && r.result?.verdict);
      const review = reviews.sort((x, y) => y.created - x.created)[0];
      if (review) evidence.push({ title: a.title, branch: a.branch, verdict: review.result!.verdict, tested: review.testedCommit, head });
      if (a.checks?.length) evidence.push({ title: `${a.title} (Harbor checks)`, branch: a.branch, checks: a.checks.map((c) => ({ cmd: c.cmd, ok: c.ok })), tested: a.testedCommit, head });
      if (!review && !a.checks?.length) evidence.push({ title: a.title, branch: a.branch, head });
    }
    return buildHandoff({
      mode: conv?.mode, goal: conv?.goal, conversationId,
      decisions: store.listCoordination(project.id).filter((c) => c.kind === 'decision').map((c) => ({ text: c.text, conversationId: c.conversationId, time: c.time })),
      work: agents.filter((a) => !a.integration && !a.rollback).map((a) => ({ title: a.title, role: a.role, state: a.state, branch: a.branch, updated: a.updated ?? a.created, note: a.state === 'done' ? undefined : a.error ?? a.summary })),
      evidence,
      applied: agents.filter((a) => (a.integration?.applied || a.rollback?.applied)).map((a) => `${a.title} → ${a.integration?.target ?? a.rollback?.target ?? 'target'}`)
    });
  }

  /** The working agent: reads, edits, runs commands, and delegates through HARBOR_DELEGATE lines when that pays off. */
  private async leadTurn(project: Project, main: AgentRecord, trigger: LeadTrigger, conversationId: Id, plan: Escalation, signal: AbortSignal, batch?: ReportBatch): Promise<void> {
    const notes = [...(this.notes.get(conversationId) ?? [])];
    this.notes.delete(conversationId);
    // What the user was told by the front desk since this lead last ran: it cannot know, and would contradict or repeat it.
    const front = (this.frontDesk.get(conversationId) ?? []).slice(-2);
    this.frontDesk.delete(conversationId);
    if (front.length) notes.push(`The front desk answered these without you since your last turn:\n${front.map((e) => `User: ${clip(e.user, 300)}\nFront desk: ${clip(e.answer, 400)}`).join('\n')}`);
    const history = this.chatHistory(conversationId, trigger.kind === 'user');
    const inbox = this.peerInbox.get(conversationId) ?? [];
    this.peerInbox.delete(conversationId);
    const conv = this.d.store.getConversation(conversationId);
    const mode = conv?.mode ?? 'default';
    const goal = mode === 'goal' ? conv?.goal : undefined;
    const goalMode = !!goal;
    const headBefore = await this.d.git.head(project.path).catch(() => undefined);
    await this.probeRepo(project).catch(() => false);
    const checkCmds = this.checkCommands(project);
    // Project notes this session has not seen yet (all relevant ones on its first turn); a resumed session already holds the rest.
    const allNotes = this.d.store.listProjectNotes(project.id);
    const seenNotes = this.notesShown.get(conversationId) ?? new Set<Id>();
    const query = trigger.kind === 'user' ? trigger.text : goal ?? '';
    const fresh = selectNotes(allNotes.filter((n) => !seenNotes.has(n.id)), query, NOTES_BUDGET.lead);
    const knowledge = notesText(fresh.picked, fresh.omitted);
    // Only built when the lead's native session cannot be resumed (new conversation, lost session, or another CLI took over).
    const context = async (): Promise<string> => {
      const handoff = await this.handoffFor(project, conversationId).catch(() => '');
      // A conversation that continues an imported chat: Harbor's summary of it, framed as quoted history (handoff.ts).
      const imported = this.d.store.continuation(conversationId)?.text ?? '';
      // A session that lost its native history also lost the notes it was shown before: they come back here.
      const inPrompt = new Set(fresh.picked.map((n) => n.id));
      const again = selectNotes(allNotes.filter((n) => seenNotes.has(n.id) && !inPrompt.has(n.id)), query, NOTES_BUDGET.lead);
      return [imported, handoff, notesText(again.picked, again.omitted), history.length ? `Conversation so far (your earlier session is not available):\n${historyText(history)}` : ''].filter(Boolean).join('\n\n');
    };
    // Whatever started this turn (a user message, a goal step, a report, a help request, a peer), it also carries the
    // reports Harbor still holds for this conversation, settled with the turn like a reports trigger's own.
    const pick = this.heldReports(project.id, conversationId);
    const turn: ReportBatch = batch ?? { marks: [], prev: new Map(), started: false, settled: false };
    pick.items.forEach((x) => this.reported.add(reportKey(x)));
    joinBatch(turn, pick.items);
    const held: HeldReports = { items: pick.items.map(reportSnapshot), omitted: { count: pick.omitted.length, refs: pick.omitted.slice(0, MAX_HELD_REFS).map(resultRef) } };
    const nonce = newProtocolNonce();
    let out: RoutedRun;
    try {
      out = await this.runRouted(main, {
        prompt: leadPrompt(project.name, this.registerFor(project.id, conversationId), trigger, { notes, mode, goal, peers: this.sessionPeers(project.id, conversationId), inbox, held, knowledge, checksConfigured: checkCmds.length > 0 }), system: LEAD_SYSTEM, skills: true,
        contextIfNoResume: context,
        // The lead's difficulty comes from the concierge's rating, already raised by the request's own signals (combineComplexity).
        role: 'main', complexity: plan.complexity, difficulty: plan.difficulty ?? COMPLEXITY_DIFFICULTY[plan.complexity], interactive: true,
        ...(plan.effort ? { effort: plan.effort, fixedEffort: true } : {}), needs: plan.needs, preferCli: plan.preferCli, complexityNote: plan.note,
        // A turn with images goes only to a model the catalog says can see them; one that cannot is skipped with that reason.
        ...(trigger.kind === 'user' && trigger.images?.length ? { required: ['vision' as const] } : {}),
        permission: mode === 'plan' ? 'read-only' : mode === 'auto' ? 'full' : 'edit', cwd: project.path,
        images: trigger.kind === 'user' ? trigger.images : undefined,
        ...(trigger.kind === 'user' && trigger.files?.length ? { files: trigger.files } : {}),
        ...(trigger.kind === 'screenshot' && trigger.shots?.length ? { shots: trigger.shots } : {}),
        signal, resume: true, conversationId, stream: true, sessionKey: `lead:${conversationId}`, denyGitWrites: true,
        nonce, allowedCommands: commandPrefixes(checkCmds),
        onAttempt: turn.marks.length ? () => this.reportsAttempted(turn) : undefined
      });
      // Only a turn that finished is evidence the lead read its reports; one that took the prompt and then ended is not.
      this.settleReports(turn, out.ok ? 'confirmed' : out.started ? 'interrupted' : 'notStarted', conversationId, !out.ok && !out.stopped);
    } finally {
      if (!turn.settled) this.settleReports(turn, turn.started ? 'interrupted' : 'notStarted', conversationId);
    }
    // Notes count as shown only once a CLI actually took the prompt.
    if ((out.ok || out.started) && fresh.picked.length) this.notesShown.set(conversationId, new Set([...seenNotes, ...fresh.picked.map((n) => n.id)]));
    await this.detectLeadMerge(project, main, conversationId, headBefore);
    if (!out.ok && out.stopped && this.steered.has(conversationId)) {
      this.post(conversationId, 'system', 'Interrupted to follow your new message.', { agentId: main.id });
      return;
    }
    if (!out.ok && out.spent) {
      // The reason reaches the lead on its next turn (the user's next message, or a wake once the user allowed more).
      if (out.started) this.addNote(conversationId, `Harbor stopped your previous turn at a spend ceiling: ${out.error ?? 'spend ceiling reached'} Check what is already done before continuing, and keep the rest of the work small.`);
      this.sessionState(conversationId, 'stopped', 'Stopped: spend ceiling reached (estimate).');
      this.post(conversationId, 'system', `The lead ${out.started ? 'was stopped' : 'did not start'}: ${out.error} Send a message to continue; Harbor asks you before it spends more.`, { agentId: main.id });
      if (goalMode) { this.d.store.setGoalPaused(conversationId, true); this.post(conversationId, 'system', 'Goal mode paused: a spend ceiling was reached.'); }
      return;
    }
    if (!out.ok) {
      const capMinutes = Math.round((this.d.stall?.leadCapMs ?? LEAD_CAP_MS) / 60_000);
      this.sessionState(conversationId, out.stopped ? 'stopped' : 'failed', out.capped ? 'Stopped: the turn hit its time limit.' : out.error);
      this.post(conversationId, 'system', out.capped ? `Harbor stopped the lead: this turn ran longer than ${capMinutes} minutes. Send a message to continue.` : out.stopped ? 'Stopped.' : `The lead agent could not run: ${out.error}`, { agentId: main.id });
      if (goalMode) this.d.store.setGoalPaused(conversationId, true);
      if (goalMode) this.post(conversationId, 'system', out.stopped ? 'Goal mode paused: you stopped the session. Send a message to continue toward the goal.' : 'Goal mode paused: the lead\'s turn failed.');
      return;
    }
    const proto = parseProtocol(out.allText ?? out.text, { nonce: out.nonce });
    let delegations = proto.delegate;
    if (mode === 'plan') {
      const edits = delegations.filter((t) => t.access === 'edit');
      if (edits.length) {
        delegations = delegations.filter((t) => t.access !== 'edit');
        this.post(conversationId, 'system', `Plan mode: ignored ${edits.length} edit helper(s) (${edits.map((t) => t.title).join(', ')}). Approve the plan to let the lead carry it out.`);
      }
    }
    delegations = this.dedupeDelegations(delegations, conversationId);
    delegations = this.fanOutBrake(delegations, conversationId, trigger.kind === 'user' ? trigger.text : undefined);
    for (const text of proto.decision) this.d.store.addCoordination({ projectId: project.id, kind: 'decision', from: main.id, text, conversationId });
    for (const n of proto.note) {
      const note = this.d.store.addProjectNote(project.id, { text: n.text, topic: n.topic, conversationId });
      // The writer already knows it; other sessions get it on their next turn.
      if (note) this.notesShown.set(conversationId, new Set([...(this.notesShown.get(conversationId) ?? []), note.id]));
    }
    const screened = await this.screenDelegations(project, delegations, conversationId);
    delegations = screened.kept;
    const pin = delegations.some((t) => t.integrate) ? await this.pinTarget(project) : undefined;
    const created = this.createTasks(project, delegations, conversationId, trigger.kind === 'help' ? trigger.from.id : undefined, { pin, dirty: screened.dirty });
    for (const b of proto.image) this.post(conversationId, 'assistant', imageBriefText(b), { agentId: main.id });
    this.showImages(main, conversationId, proto.showImage, project.path, [project.path]);
    this.openDocuments(main, conversationId, proto.openDocument, project.path, [{ kind: 'project', path: project.path }]);
    for (const p of proto.peer.slice(0, MAX_PEERS_PER_TURN)) this.deliverPeer(project.id, conversationId, p);
    const replied = new Set(proto.reply.map((r) => this.deliverReply(project.id, conversationId, r)).filter((x): x is Id => !!x));
    const started = created.filter((c) => c.state !== 'failed');
    if (started.length) {
      this.post(conversationId, 'system', 'Delegated: ' + started.map((c, i) => `${i + 1}. ${c.title}${c.dependsOn.length ? ' (after earlier steps)' : ''}`).join('  '), { agentId: main.id });
      this.postPlanEstimate(conversationId, started, main.id);
    }
    const asking = proto.ask[0];
    const shown = stripProtocol(out.text, { nonce: out.nonce });
    // A helper's question the lead decided is the user's: asked on the helper's behalf, so the answer goes straight back to it.
    const asker = trigger.kind === 'help' && trigger.question ? this.d.store.getAgent(trigger.from.id) : undefined;
    const forHelper = !!asking && !!asker && asker.state === 'waiting' && !replied.has(asker.id) && !created.some((c) => c.helpFor === asker.id);
    if (asking && forHelper) {
      this.post(conversationId, 'assistant', `${asker!.title} needs your decision: ${asking.question}`, { agentId: main.id });
      this.askUserForHelper(asker!, asking, 'lead');
    } else if (asking) {
      this.leadAsked.add(conversationId);
      if (!shown.includes(asking.question)) this.post(conversationId, 'assistant', asking.question, { agentId: main.id });
      this.askUser(main.id, conversationId, asking);
    } else if (/\?\s*$/.test(shown)) {
      // A question in prose: the user's next message answers it, so it goes to the lead, not the front desk.
      this.leadQuestion.add(conversationId);
      // With options listed in the text it also gets buttons (the text is already in the chat, so it is not posted again).
      const prose = !signal.aborted ? proseAsk(shown) : undefined;
      if (prose) this.askUser(main.id, conversationId, prose);
    }
    // A screenshot request ends the turn like a question: the user decides in a card, and the answer (image or refusal) resumes the lead.
    const shot = proto.screenshot[0];
    const shotAsked = !!shot && !asking && !signal.aborted;
    if (shotAsked) this.requestScreenshot(main, conversationId, conversationId, shot);
    else if (shot && asking) this.post(conversationId, 'system', 'Harbor ignored the lead\'s screenshot request because it also asked you a question; it can ask again after your answer.', { agentId: main.id });
    if (trigger.kind === 'help' && !forHelper && !replied.has(trigger.from.id) && !created.some((c) => c.helpFor === trigger.from.id)) {
      if (trigger.question) {
        // The lead answered the helper's question in prose: forwarded as its next message (only while it still waits for it).
        if (asker?.state === 'waiting') this.followUp(asker, `The lead answers your question: ${shown || 'decide within your assignment (do not widen its scope or edit files outside the ones you own), and say in your report what you assumed.'}`);
      } else {
        // No helper assigned: tell the blocked agent so it can continue on its own judgment.
        this.followUp(trigger.from, `The lead did not assign another helper for your request. Response: ${shown || 'proceed with your best judgment within scope, or report that you are blocked.'}`);
      }
    }
    if (screened.refused.length) this.refusedNotice(project.id, conversationId, screened.refused, !!asking || signal.aborted);
    this.pump(project.id);
    // Lines Harbor did not act on (bad JSON, unknown fields, or no protocol tag) are reported once and the lead gets one chance to fix them.
    const ignored = ignoredProtocolLines(out.allText ?? out.text, proto, out.nonce);
    let resumed = false;
    if (ignored.length) {
      this.post(conversationId, 'system', `Harbor ignored ${ignored.length} protocol line(s): ${clip(ignored[0]!, 120)}`, { agentId: main.id });
      this.log({ kind: 'protocol', projectId: project.id, conversationId, agentId: main.id, text: `lead: ignored ${ignored.length} protocol line(s): ${clip(ignored[0]!, 200)}` });
      if (!this.malformedResumed.has(conversationId) && !asking && !shotAsked && !signal.aborted && this.autoTurn(conversationId)) {
        this.malformedResumed.add(conversationId);
        resumed = true;
        this.enqueueMain(project.id, { kind: 'notice', text: `Harbor ignored ${ignored.length} protocol line(s) in your last answer, so nothing was done for them: ${ignored.slice(0, 3).map((l) => clip(l, 160)).join(' | ')}\nEvery protocol line must be ONE physical line of valid JSON at column 0 written as HARBOR_<KIND>[${out.nonce ?? 'tag'}]: {...} (use the tag from your instructions). Re-send only the corrected line(s); do not redo finished work.` }, conversationId);
      }
    }
    if (goalMode && !resumed) {
      const stalled = trigger.kind === 'goal' && (out.toolCalls ?? 0) === 0 && !created.length && !asking && !shotAsked && proto.goalDone === undefined;
      this.goalStep(project.id, conversationId, proto.goalDone?.summary, !!asking || shotAsked, { stalled, delegated: created.length > 0 });
    }
  }

  /**
   * Fan-out brake: one lead turn starts at most `maxHelpersPerTurn` helpers (default 4) and `maxPlannersPerTurn` planners (default 1)
   * unless the user's message asked for more by number. Integrators are Harbor's own git work and do not count. The rest are not
   * started and not dropped silently: the user sees which, and the lead is told to confirm them on its next turn. A task that waits
   * on a held-back one is held back with it (it would otherwise fail as an unresolved reference).
   */
  private fanOutBrake(tasks: PlannedTask[], conversationId: Id, userText?: string): PlannedTask[] {
    const s = this.d.store.getSettings();
    const asked = userText ? askedCounts(userText) : {};
    const maxHelpers = Math.max(s.maxHelpersPerTurn ?? DEFAULT_HELPERS_PER_TURN, asked.helpers ?? 0);
    const maxPlanners = Math.max(s.maxPlannersPerTurn ?? DEFAULT_PLANNERS_PER_TURN, asked.planners ?? 0);
    let helpers = 0, planners = 0;
    const held = new Set<string>();
    for (const t of tasks) {
      if (t.integrate) continue;
      if (t.role === 'planner' && planners >= maxPlanners) { held.add(t.ref); continue; }
      if (helpers >= maxHelpers) { held.add(t.ref); continue; }
      helpers++;
      if (t.role === 'planner') planners++;
    }
    if (!held.size) return tasks;
    // Whatever waits on a held-back task waits with it.
    for (let grew = true; grew;) {
      grew = false;
      for (const t of tasks) {
        if (held.has(t.ref)) continue;
        if ([...t.dependsOn, ...(t.specFrom ? [t.specFrom] : []), ...(t.integrate?.sources ?? [])].some((r) => held.has(r))) { held.add(t.ref); grew = true; }
      }
    }
    const heldTasks = tasks.filter((t) => held.has(t.ref));
    const list = heldTasks.map((t) => `${t.role}: ${t.title}`).join('; ');
    this.post(conversationId, 'system', `Harbor started ${tasks.length - heldTasks.length} of ${tasks.length} delegated helper(s) and held back ${heldTasks.length} (limit per turn: ${maxHelpers} helpers, ${maxPlanners} planner${maxPlanners === 1 ? '' : 's'}): ${clip(list, 300)}. The lead is asked to confirm them; say so if you want more at once.`);
    this.addNote(conversationId, `Harbor did NOT start ${heldTasks.length} of your delegations (per-turn limit: ${maxHelpers} helpers, ${maxPlanners} planner(s)): ${clip(list, 180)}. Re-delegate them after the first results if they are still needed, or ask the user to confirm.`);
    return tasks.filter((t) => !held.has(t.ref));
  }

  /** Identical (role, instructions) in one turn start once: a repeated line is a model stutter, not two jobs. Refs of dropped copies point at the kept one. */
  private dedupeDelegations(tasks: PlannedTask[], conversationId: Id): PlannedTask[] {
    // Same job = same role and instructions AND the same inputs (what it waits for, owns and builds on): two reviewers with identical
    // words but different subjects are two jobs.
    const list = (v: string[]) => [...v].sort().join(',');
    const norm = (t: PlannedTask) => [t.role, t.access, t.integrate ? `integrate:${list(t.integrate.sources)}` : '', list(t.dependsOn), t.specFrom ?? '', list(t.files), t.instructions.replace(/\s+/g, ' ').trim().toLowerCase()].join('\0');
    const kept = new Map<string, PlannedTask>();
    const alias = new Map<string, string>();
    for (const t of tasks) {
      const first = kept.get(norm(t));
      if (first) alias.set(t.ref, first.ref); else kept.set(norm(t), t);
    }
    if (!alias.size) return tasks;
    this.post(conversationId, 'system', `Harbor started ${alias.size} identical delegation(s) once: ${tasks.filter((t) => alias.has(t.ref)).map((t) => `"${clip(t.title, 50)}"`).join(', ')}.`);
    const fix = (r: string) => alias.get(r) ?? r;
    return tasks.filter((t) => !alias.has(t.ref)).map((t) => ({
      ...t, dependsOn: [...new Set(t.dependsOn.map(fix))], specFrom: t.specFrom ? fix(t.specFrom) : undefined,
      ...(t.integrate ? { integrate: { ...t.integrate, sources: [...new Set(t.integrate.sources.map(fix))] } } : {})
    }));
  }

  /**
   * A helper starts from the committed HEAD. The project folder's uncommitted files (git status, Harbor's own .harbor/ left out): `tracked`
   * changes and `paths` (tracked plus untracked). Tracked changes are mentioned once per state; git failing is said every time.
   */
  private async dirtyBase(project: Project, tasks: PlannedTask[], conversationId: Id): Promise<{ state?: 'dirty' | 'unknown'; paths: string[]; tracked: string[] }> {
    if (!tasks.some((t) => t.access === 'edit' && !t.integrate) || this.repoKind.get(project.id) !== 'git') return { paths: [], tracked: [] };
    const r = await this.d.git.exec(project.path, STATUS_ARGS);
    if (!r.ok) {
      this.post(conversationId, 'system', 'git timed out (or failed) while checking the project folder, so Harbor cannot say whether it has uncommitted edits. Edit helpers start from the committed HEAD and would not contain them.');
      return { state: 'unknown', paths: [], tracked: [] };
    }
    const prefix = await this.prefixOf(project);
    const own = (p: string) => !/^\.harbor\//i.test(p);
    const st = parseStatusV2(r.stdout);
    const tracked = underPrefix(st.tracked, prefix).filter(own);
    const paths = [...tracked, ...underPrefix(st.untracked, prefix).filter(own)];
    if (tracked.length) {
      const key = `${conversationId}:${createHash('sha256').update([...tracked].sort().join('\n')).digest('hex').slice(0, 16)}`;
      if (!this.dirtyNoted.has(key)) {
        this.dirtyNoted.add(key);
        this.post(conversationId, 'system', 'The project folder has uncommitted changes. Edit helpers start from the committed HEAD in their own worktree, so they will NOT contain those edits (and their results may conflict with them). Harbor holds a helper whose files overlap them; commit first if helpers should build on them.');
      }
    }
    return { ...(tracked.length ? { state: 'dirty' as const } : {}), paths, tracked };
  }

  /**
   * Before anything is created: the size gate (sizeGate.ts) and the dirty-base check (dirtyBase.ts). A refused task is not created;
   * whatever waits on it in this turn is withheld with it. The lead is told why and what to do instead (refusedNotice).
   */
  private async screenDelegations(project: Project, tasks: PlannedTask[], conversationId: Id): Promise<{ kept: PlannedTask[]; refused: Array<{ task: PlannedTask; why: string }>; dirty?: 'dirty' | 'unknown' }> {
    const why = new Map<string, string>();
    for (const t of tasks) {
      if (t.access !== 'edit' || t.integrate) continue;
      const e = this.estimateFor(project, t);
      const r = gateTask({ title: t.title, instructions: t.instructions, access: t.access, files: t.files, minutes: e.minutes, detail: e.detail });
      if (r) why.set(t.ref, `${r}. ${SPLIT_ADVICE}`);
    }
    const base = await this.dirtyBase(project, tasks.filter((t) => !why.has(t.ref)), conversationId);
    if (base.paths.length) {
      for (const t of tasks) {
        if (t.access !== 'edit' || t.integrate || why.has(t.ref)) continue;
        // A whole-project claim is held only for tracked changes: an untracked scratch file would otherwise hold every such helper.
        const overlap = dirtyOverlap(t.files, t.files.length ? base.paths : base.tracked);
        if (!overlap.length) continue;
        const list = `${overlap.slice(0, 5).join(', ')}${overlap.length > 5 ? `, and ${overlap.length - 5} more` : ''}`;
        why.set(t.ref, `its files overlap uncommitted edits in the project folder (${clip(list, 240)}), and it would start from the last commit without them. Commit those files first and delegate it again, narrow its "files" to exclude them, or delegate it with "access":"read"`);
      }
    }
    if (!why.size) return { kept: tasks, refused: [], ...(base.state ? { dirty: base.state } : {}) };
    // Whatever waits on a refused task is withheld with it (it would otherwise fail as an unresolved reference).
    const held = new Set(why.keys());
    for (let grew = true; grew;) {
      grew = false;
      for (const t of tasks) {
        if (held.has(t.ref) || ![...t.dependsOn, ...(t.specFrom ? [t.specFrom] : []), ...(t.integrate?.sources ?? [])].some((r) => held.has(r))) continue;
        held.add(t.ref);
        why.set(t.ref, 'it depends on a task Harbor did not start');
        grew = true;
      }
    }
    return { kept: tasks.filter((t) => !held.has(t.ref)), refused: tasks.filter((t) => held.has(t.ref)).map((task) => ({ task, why: why.get(task.ref)! })), ...(base.state ? { dirty: base.state } : {}) };
  }

  /** Refused delegations: the user sees which, and the lead is woken with the reasons (or told at its next turn when it waits on the user). */
  private refusedNotice(projectId: Id, conversationId: Id, refused: Array<{ task: PlannedTask; why: string }>, later: boolean): void {
    const lines = refused.map((r) => `- "${clip(r.task.title, 80)}": ${r.why}`);
    this.post(conversationId, 'system', `Harbor did not start ${refused.length} delegation(s):\n${lines.map((l) => clip(l, 400)).join('\n')}`);
    this.log({ kind: 'protocol', projectId, conversationId, text: `refused ${refused.length} delegation(s): ${clip(refused.map((r) => `${r.task.title}: ${r.why}`).join(' | '), 400)}` });
    const text = `Harbor did NOT start these delegations, so nothing was run for them:\n${lines.join('\n')}\nRe-delegate them accordingly; do not redo work that already finished.`;
    if (later || !this.autoTurn(conversationId)) { this.addNote(conversationId, clip(text, 300)); return; }
    this.enqueueMain(projectId, { kind: 'notice', text }, conversationId);
  }

  /** Harbor's size and minutes estimate of a delegation (difficulty.ts + sizeGate.ts), before any retry adjustment. */
  private estimateFor(project: Project, t: PlannedTask, hasSpec = false, difficulty?: number): { minutes: number; difficulty: number; detail: string } {
    const est = difficultyOf({ role: t.role, text: t.instructions, files: t.files, readOnly: t.access === 'read', hint: t.complexity, verify: t.access === 'edit' && this.checkCommands(project).length > 0, hasSpec });
    const d = difficulty ?? est.difficulty;
    const calibration = this.d.store.getCalibration();
    const size = gateSize(est.size, est.drivers);
    return { difficulty: d, detail: describeDrivers(est.drivers, size), minutes: estimateTaskMinutes({ role: t.role, size, difficulty: d, needs: t.needs, catalog: this.usableCatalog(), ...(calibration ? { calibration } : {}) }) };
  }

  /** Catalog entries of the CLIs Harbor can run now (all of the catalog when none is known yet). */
  private usableCatalog(): CatalogEntry[] {
    const catalog = this.d.catalog ?? DEFAULT_CATALOG;
    const clis = new Set(this.d.getClis().filter((c) => c.installed && this.d.enabled(c.id)).map((c) => c.id));
    const mine = catalog.filter((e) => clis.has(e.cli));
    return mine.length ? mine : catalog;
  }

  /** One system message per delegation turn: the plan's estimated wall time (helpers at once from the budget) and each task's estimate. */
  private postPlanEstimate(conversationId: Id, started: AgentRecord[], mainId: Id): void {
    const userMax = effectiveSettings(this.d.store.getSettings(), started[0]!.projectId).concurrencyLimit ?? this.d.maxActivePerProject ?? DEFAULT_CONCURRENCY;
    const limit = Math.max(1, Math.min(userMax, this.budgetLimit().limit || 1));
    const eta = planEta(started.map((c) => ({ id: c.id, minutes: c.estimatedMinutes ?? 0, dependsOn: c.dependsOn })), limit);
    const per = started.map((c, i) => `${i + 1}. ${clip(c.title, 60)} ${c.integration ? '(Harbor merges)' : fmtMinutes(c.estimatedMinutes ?? 0)}`).join('; ');
    this.post(conversationId, 'system', `Plan estimate: about ${fmtMinutes(eta.minutes)} of wall time with up to ${limit} helper(s) at once (longest chain ${fmtMinutes(eta.criticalPathMinutes)}). Per task: ${per}. Estimates are Harbor's priors and measured runs, not a promise.`, { agentId: mainId });
  }

  /**
   * A lead's HARBOR_REPLY: forwarded to a helper of this conversation that waits (its answer) or was stopped (it continues in its own
   * session, on its branch). Returns the helper's id when delivered.
   */
  private deliverReply(projectId: Id, conversationId: Id, r: ReplyRequest): Id | undefined {
    const q = r.to.trim().toLowerCase();
    const mine = this.registerFor(projectId, conversationId).filter((x) => !x.integration && !x.rollback);
    const hits = mine.filter((x) => x.id.toLowerCase() === q);
    const target = hits[0] ?? (q.length >= 6 ? (mine.filter((x) => x.id.toLowerCase().startsWith(q)).length === 1 ? mine.find((x) => x.id.toLowerCase().startsWith(q)) : undefined) : undefined);
    if (!target) { this.post(conversationId, 'system', `Harbor could not deliver the lead's reply to "${clip(r.to, 60)}": no single helper of this conversation has that id.`); return undefined; }
    if (!['waiting', 'stopped', 'working', 'queued'].includes(target.state)) {
      this.post(conversationId, 'system', `Harbor did not deliver the lead's reply to "${target.title}": it is ${target.state}. Delegate new work (with "retryOf" to redo it) instead.`, { agentId: target.id });
      return undefined;
    }
    this.d.store.addCoordination({ projectId, kind: 'direct', from: this.d.store.mainAgent(projectId)?.id, to: target.id, text: r.text });
    this.post(conversationId, 'system', `The lead replied to "${target.title}": ${clip(r.text, 200)}`, { agentId: target.id });
    if (target.state === 'queued') { const f = this.followups.get(target.id) ?? []; f.push(r.text); this.followups.set(target.id, f); return target.id; }
    if (target.state === 'stopped') { this.reported.delete(reportKey(target)); this.d.store.clearReportDelivery(target.id); }
    this.followUp(target, `Message from the lead: ${r.text}`);
    return target.id;
  }

  /** The checked-out branch now: an integrator queued without a target is pinned to it, and refuses to run once the folder is on another branch. */
  private async pinTarget(project: Project): Promise<{ checkedOut?: string }> {
    return { checkedOut: await this.d.git.currentBranch(project.path).catch(() => undefined) };
  }

  /**
   * Backstop for the rule that only the integrator lands harbor/* branches: if a harbor/* head became reachable from the
   * project's HEAD during the lead's turn, the lead merged (or fast-forwarded to) one itself. Works for every CLI.
   */
  private async detectLeadMerge(project: Project, main: AgentRecord, conversationId: Id, before: string | undefined): Promise<void> {
    if (!before) return;
    try {
      const { git } = this.d;
      const after = await git.head(project.path);
      if (!after || after === before) return;
      const merged: string[] = [];
      const seen = new Set<string>();
      for (const r of this.d.store.listAgentRecords(project.id)) {
        if (!r.branch?.startsWith('harbor/') || seen.has(r.branch)) continue;
        seen.add(r.branch);
        const head = await git.branchHead(project.path, r.branch);
        if (head && head !== before && !(await git.isAncestor(project.path, head, before)) && await git.isAncestor(project.path, head, after)) merged.push(r.branch);
      }
      if (!merged.length) return;
      const list = merged.join(', ');
      this.post(conversationId, 'system', `Warning: the lead merged ${list} into the project itself. Branches should land through an integrator helper so they are gated and applied by you. Check the project's history before building on it.`, { agentId: main.id });
      this.log({ kind: 'protocol', projectId: project.id, conversationId, agentId: main.id, text: `Lead merged helper branch(es) itself: ${list}` });
    } catch { /* detection must never break a lead turn */ }
  }

  /**
   * True while any helper of the conversation (not only this turn's) is queued, running or waiting. Integrations and
   * rollbacks the user started are not the lead's work and never report to it, so they do not count.
   */
  private helpersActive(projectId: Id, conversationId: Id): boolean {
    return this.registerFor(projectId, conversationId).some((x) => !x.byUser && (x.state === 'queued' || x.state === 'working' || x.state === 'waiting'));
  }

  /** Goal mode: resume the lead until it reports the goal done, asks, fails, waits for helpers (reports resume it), or the cap is hit. */
  private goalStep(projectId: Id, conversationId: Id, doneSummary: string | undefined, asked: boolean, progress: { stalled: boolean; delegated: boolean } = { stalled: false, delegated: false }): void {
    const { store } = this.d;
    if (doneSummary !== undefined) {
      // Only HARBOR_GOAL_DONE ends goal mode (prose never does), and never while helpers this turn or earlier ones are still going:
      // their reports resume the lead, which can then say so again.
      if (progress.delegated || this.helpersActive(projectId, conversationId)) {
        this.post(conversationId, 'system', 'Harbor ignored the goal-done line: helpers are still active. Their reports resume the lead, which can confirm once they are in.');
        return;
      }
      this.post(conversationId, 'system', `Goal reached: ${doneSummary || 'the lead reports the goal is done.'}`);
      return;
    }
    if (asked) { store.setGoalPaused(conversationId, true); this.post(conversationId, 'system', 'Goal mode paused: the lead is waiting for your answer.'); return; }
    if (progress.stalled) {
      store.setGoalPaused(conversationId, true);
      this.post(conversationId, 'system', 'Goal mode paused: the last automatic continuation made no tool calls and delegated nothing, so Harbor stopped instead of looping on prose. Send a message to continue toward the goal.');
      return;
    }
    if (store.isGoalPaused(conversationId)) return; // a report or failure resumed the lead once; only the user restarts the loop
    if (this.helpersActive(projectId, conversationId)) return; // the last helper's report resumes the lead, and that turn comes back here
    const n = this.goalTurns.get(conversationId) ?? 0;
    if (n >= GOAL_MAX_CONTINUATIONS) { this.post(conversationId, 'system', `Goal mode paused after ${GOAL_MAX_CONTINUATIONS} automatic continuations. Send a message to continue toward the goal.`); return; }
    this.goalTurns.set(conversationId, n + 1);
    this.enqueueMain(projectId, { kind: 'goal', continuation: n + 1, max: GOAL_MAX_CONTINUATIONS }, conversationId);
  }

  /**
   * A reviewer delegated without "dependsOn" has nothing to review. With exactly one candidate (the one edit helper of this turn, or else
   * the one finished edit helper of this conversation nobody reviewed) Harbor binds it and says so; otherwise the reviewer is refused
   * with the candidate ids, so the lead can fix it in one step. Only in a git repository (elsewhere a reviewer reads the folder).
   */
  private bindReviewers(project: Project, tasks: PlannedTask[], conversationId: Id): { tasks: PlannedTask[]; refused: Map<string, string> } {
    const refused = new Map<string, string>();
    if (this.repoKind.get(project.id) !== 'git') return { tasks, refused };
    const loose = tasks.filter((t) => t.role === 'reviewer' && !t.integrate && !t.dependsOn.length && !t.specFrom);
    if (!loose.length) return { tasks, refused };
    const thisTurn = tasks.filter((t) => t.access === 'edit' && !t.integrate);
    const earlier = this.registerFor(project.id, conversationId).filter((a) => this.canEdit(a) && a.state === 'done' && !!a.branch && !a.integration && !a.rollback && !this.reviewersOf(project.id, a).length);
    const out = tasks.map((t) => {
      if (!loose.includes(t)) return t;
      const bind = thisTurn.length === 1 ? { ref: thisTurn[0]!.ref, title: thisTurn[0]!.title } : !thisTurn.length && earlier.length === 1 ? { ref: earlier[0]!.id, title: earlier[0]!.title } : undefined;
      if (bind) {
        this.post(conversationId, 'system', `Harbor bound the reviewer "${clip(t.title, 60)}" to "${clip(bind.title, 60)}", the only change it can review.`);
        return { ...t, dependsOn: [bind.ref] };
      }
      const cands = thisTurn.length ? thisTurn.map((c) => `ref ${c.ref} ("${clip(c.title, 40)}")`) : earlier.map((c) => `id=${c.id} ("${clip(c.title, 40)}")`);
      refused.set(t.ref, `Refused: this reviewer depends on no helper, so there is no change to review. ${cands.length ? `Candidates: ${cands.slice(0, 6).join(', ')}.` : 'There is no finished, unreviewed edit helper to bind it to.'} Delegate it with "dependsOn" naming the implementer to review. Nothing was run.`);
      return t;
    });
    return { tasks: out, refused };
  }

  private createTasks(project: Project, input: PlannedTask[], conversationId: Id, requester?: Id, ctx: { pin?: { checkedOut?: string }; dirty?: 'dirty' | 'unknown' } = {}): AgentRecord[] {
    const { store } = this.d;
    const { tasks, refused: unbound } = this.bindReviewers(project, input, conversationId);
    const refToId = new Map<string, Id>(tasks.map((t) => [t.ref, newId()]));
    const resolve = (r: string): Id | undefined => refToId.get(r) ?? store.listAgentRecords(project.id).find((a) => a.id === r)?.id;
    const out: AgentRecord[] = [];
    // A reference that names nothing (a typo, an id from another project, a ref from an earlier turn) fails its task: guessing
    // "no dependency" would start a reviewer with nothing to review, or an implementer before its spec exists.
    const unresolved = new Map<string, string[]>();
    for (const t of tasks) {
      const bad = [...t.dependsOn, ...(t.specFrom ? [t.specFrom] : []), ...(t.integrate?.sources ?? [])].filter((r) => !resolve(r));
      if (bad.length) unresolved.set(t.ref, [...new Set(bad)]);
    }
    // Resolve the whole dependency graph first so cycles can be detected and broken (never left waiting forever).
    const graph = new Map<Id, Set<Id>>();
    const sourcesOf = new Map<Id, Id[]>();
    for (const t of tasks) {
      const id = refToId.get(t.ref)!;
      if (unresolved.has(t.ref)) { graph.set(id, new Set()); continue; }
      const deps = new Set(t.dependsOn.map(resolve).filter((x): x is Id => !!x && x !== id));
      const spec = t.specFrom ? resolve(t.specFrom) : undefined;
      if (spec && spec !== id) deps.add(spec);
      if (t.integrate) {
        // An integrator waits for each source and for every reviewer of it, so the gate sees final verdicts.
        const sources = [...new Set(t.integrate.sources.map(resolve).filter((x): x is Id => !!x && x !== id))];
        sourcesOf.set(id, sources);
        for (const s of sources) {
          deps.add(s);
          for (const u of tasks) if (u.role === 'reviewer' && u.dependsOn.map(resolve).includes(s)) deps.add(refToId.get(u.ref)!);
          for (const r of store.listAgentRecords(project.id)) if (r.role === 'reviewer' && r.dependsOn.includes(s) && !TERMINAL.includes(r.state)) deps.add(r.id);
        }
        deps.delete(id);
      }
      graph.set(id, deps);
    }
    for (const [from, to] of breakCycles(graph)) {
      const title = (i: Id) => tasks.find((t) => refToId.get(t.ref) === i)?.title ?? i;
      this.post(conversationId, 'system', `Ignored a circular dependency: "${title(from)}" cannot wait for "${title(to)}".`);
    }
    const failed: AgentRecord[] = [];
    for (const t of tasks) {
      const id = refToId.get(t.ref)!;
      const deps = graph.get(id)!;
      const wantedSpec = t.specFrom ? resolve(t.specFrom) : undefined;
      const specFromId = wantedSpec && deps.has(wantedSpec) ? wantedSpec : undefined;
      // Harbor rates the work itself from concrete signals; the lead's complexity is only a hint (difficulty.ts).
      const est = difficultyOf({
        role: t.role, text: t.instructions, files: t.files, readOnly: t.access === 'read', hint: t.complexity,
        verify: t.access === 'edit' && this.checkCommands(project).length > 0, hasSpec: !!specFromId
      });
      // A retry spends more only when the work itself was judged wanting (a reviewer asked for changes, or a check Harbor ran failed):
      // the capability floor goes up one step, which the router meets with more effort on the same model first, and with a stronger
      // model only when that is the cheaper way (never one kept out of automatic routing, never past the strongest one). A failure of
      // the infrastructure (rate limit, spawn, sign-in, stopped, dependency failed, network) says nothing about the work or the model:
      // the retry keeps difficulty, model and effort and merely avoids the CLI that failed.
      const prior = t.retryOf ? store.listAgentRecords(project.id).find((a) => a.id === t.retryOf) : undefined;
      const rejected = !!prior && this.workRejected(project.id, prior);
      const ran = !!prior && prior.cli !== 'auto' && prior.cli !== 'harbor';
      const priorD = prior ? Math.max(prior.difficulty ?? COMPLEXITY_DIFFICULTY[prior.complexity ?? 'medium'], est.difficulty) : est.difficulty;
      const difficulty = rejected ? raiseDifficulty(priorD, this.strongestLevel(t.needs)) : prior ? priorD : est.difficulty;
      const complexity: Complexity = complexityOf(difficulty);
      const escalateFrom = rejected && ran ? { cli: prior!.cli, model: prior!.model, effort: prior!.effort } : undefined;
      const keepModel = prior && !rejected && ran ? { cli: prior.cli, model: prior.model, effort: prior.effort } : undefined;
      const avoid = prior && !rejected && (prior.state === 'failed' || prior.state === 'stopped') && ran ? [{ cli: prior.cli }] : undefined;
      // Avoided per CLI, not per model: a soft penalty on one model (sonnet) would push the retry to the pricier sibling (opus) of the same CLI,
      // which is exactly the escalation this branch exists to prevent.
      if (rejected) this.post(conversationId, 'system', `Retrying "${t.title}" with the capability floor one step higher (difficulty ${priorD} → ${difficulty}) because "${prior!.title}" was rejected (reviewer changes or a failed check): more effort on ${escalateFrom ? escalateFrom.model : 'the same model'} first, a stronger model only if that is cheaper.`);
      else if (prior) this.post(conversationId, 'system', `Retrying "${t.title}" at the same difficulty, model and effort: "${prior.title}" ${prior.state === 'failed' ? 'failed' : 'did not finish'}, which is not a reason to spend more${avoid ? `; ${avoid[0]!.cli} is avoided when another CLI fits equally well` : ''}.`);
      const rec: AgentRecord = {
        id, projectId: project.id, parentId: this.d.store.mainAgent(project.id)?.id, role: t.role, title: t.title, state: 'queued', cli: 'auto', model: 'auto',
        effort: keepModel?.effort ?? effortFor(t.role, complexity), retry: rejected ? true : undefined, ...(avoid ? { avoid } : {}), task: t.instructions, files: t.files, dependsOn: [...deps], specFromId,
        needs: t.needs, readOnly: t.access === 'read', pinnedCli: t.cli,
        helpFor: t.helpFor ?? requester, revision: 1, complexity, difficulty, size: est.size, difficultySignals: prior ? [...est.signals, rejected ? `retry of rejected work: floor raised from ${priorD}` : `retry: kept ${priorD}`] : est.signals,
        ...(escalateFrom ? { escalateFrom } : {}), ...(keepModel ? { keepModel } : {}),
        parentConversationId: conversationId, attempts: 0, created: Date.now(), updated: Date.now(),
        // A clear edit goes straight to one implementer; its instructions are the spec.
        spec: t.role === 'implementer' && !specFromId ? t.instructions : undefined,
        ...(ctx.dirty && t.access === 'edit' && !t.integrate ? { dirtyAtStart: ctx.dirty } : {}),
        ...(!t.integrate ? { estimatedMinutes: Math.round(this.estimateFor(project, t, !!specFromId, difficulty).minutes * 10) / 10 } : {})
      };
      const bad = unresolved.get(t.ref);
      const loose = unbound.get(t.ref);
      if (bad) {
        Object.assign(rec, { state: 'failed' as const, error: `Unresolvable reference(s): ${bad.map((r) => `"${clip(r, 60)}"`).join(', ')}. Use a ref from this same turn or an id= shown in the helper list. Nothing was run.`, dependsOn: [], specFromId: undefined });
        failed.push(rec);
      } else if (loose) {
        Object.assign(rec, { state: 'failed' as const, error: loose });
        failed.push(rec);
      } else if (t.integrate) {
        Object.assign(rec, { cli: 'harbor', model: 'git', effort: 'low', needs: undefined, pinnedCli: undefined, retry: undefined });
        rec.integration = { target: t.integrate.target ?? ctx.pin?.checkedOut, sources: (sourcesOf.get(id) ?? []).map((agentId) => ({ agentId, state: 'pending' as const })) };
        // No target named: pinned to the branch checked out now, and refused later if the folder has moved to another branch.
        if (!t.integrate.target && ctx.pin?.checkedOut) rec.pinnedCheckedOut = ctx.pin.checkedOut;
      }
      store.upsertAgent(rec);
      store.addConversation({ id: newId(), projectId: project.id, title: `${t.role}: ${t.title}`, updated: Date.now(), agentId: id });
      this.publish(rec);
      out.push(rec);
    }
    // Failed tasks are announced after the others exist: finishing one reports to the lead and unblocks the pump.
    for (const rec of failed) {
      this.log({ kind: 'protocol', projectId: project.id, conversationId, agentId: rec.id, text: `${rec.role} "${rec.title}": ${rec.error}` });
      this.finished(rec);
    }
    return out;
  }

  // ------------------------------------------------------------ scheduling

  /** Mark an agent running and create its abort controller up front so stop() works during setup. */
  private begin(id: Id): void {
    this.running.add(id);
    this.controllers.set(id, new AbortController());
  }

  private activeCount(projectId: Id): number {
    return this.d.store.listAgentRecords(projectId).filter((a) => a.role !== 'main' && this.running.has(a.id)).length;
  }

  private canEdit(a: AgentRecord): boolean { return EDIT_ROLES.includes(a.role) && !a.readOnly; }

  /** Helper runs in flight in every project that draw on quota (Harbor's own integrations and rollbacks do not). */
  private runningHelpers(): number {
    return this.d.store.allAgentRecords().filter((a) => a.role !== 'main' && this.running.has(a.id) && !a.integration && !a.rollback).length;
  }

  /**
   * How many helpers may run at once from the quota budget (helperLimit.ts): the pools of the auto-routable models of the CLIs Harbor
   * can use now. Without a known reset time an all-exhausted budget does not hold work: routing then says why it cannot run.
   */
  private budgetLimit(): HelperLimit {
    const { store, ledger } = this.d;
    const catalog = this.d.catalog ?? DEFAULT_CATALOG;
    try {
      const clis = this.d.getClis().filter((c) => c.installed && c.authState !== 'signedOut' && this.d.enabled(c.id) && !!this.d.adapterFor(c.id)).map((c) => c.id);
      const now = (this.d.now ?? Date.now)();
      const calibration = store.getCalibration();
      const running = store.allAgentRecords().filter((a) => a.role !== 'main' && this.running.has(a.id)).map((a) => entryFor(catalog, a.cli, a.model)).filter((e): e is CatalogEntry => !!e);
      return helperLimitFromLedger({ catalog, clis, ledger, now, running, committed: this.committedNow(now, calibration), ...(calibration ? { calibration } : {}) });
    } catch (e) {
      this.log({ kind: 'triage', projectId: '__harbor__', text: `helper budget could not be computed: ${String((e as Error).message ?? e)}` });
      return { limit: MAX_HELPERS_CAP, why: 'budget unavailable' };
    }
  }

  /**
   * Quota the runs in flight (leads and helpers, every project) are still expected to burn: routing and the helper limit count it as
   * used, because a provider reading cannot show it yet (routePrice.committedFor).
   */
  private committedNow(now: number, calibration: Calibration | undefined, except?: symbol) {
    const runs = [...this.inFlight].filter(([k]) => k !== except).map(([, r]) => r);
    const catalog = this.d.catalog ?? DEFAULT_CATALOG;
    const recent = finishedRuns(this.d.store.listUsage().filter((u) => u.time > now - RECENT_RUNS_MS), (c, m) => entryFor(catalog, c, m));
    return committedFor(runs, now, calibration, newestReadingAt(this.d.ledger), recent);
  }

  /** Every pool is out until `until`: the helper stays queued, the conversation is told once, and the pump runs again at the reset. */
  private holdForQuota(a: AgentRecord, until: number, reason = 'every quota pool Harbor can use is exhausted'): void {
    const at = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const why = `Waiting: ${reason} until about ${at}; it starts then`;
    if (a.error !== why) this.setState(a, 'queued', { error: why });
    if (!this.quotaHeld.has(a.parentConversationId)) {
      this.quotaHeld.set(a.parentConversationId, until);
      this.post(a.parentConversationId, 'system', `${reason[0]!.toUpperCase()}${reason.slice(1)} until about ${at}. Queued helpers wait and start by themselves then; nothing is lost.`, { agentId: a.id });
      this.log({ kind: 'triage', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: `helpers held: every pool exhausted until ${new Date(until).toISOString()}` });
    }
    if (this.quotaArmedFor === until) return;
    this.quotaArmedFor = until;
    const now = (this.d.now ?? Date.now)();
    (this.d.setTimer ?? defaultTimer)(() => {
      this.quotaArmedFor = undefined; // fired: a later hold for the same instant must arm again
      for (const p of this.d.store.listProjects()) this.pump(p.id);
    }, Math.max(1_000, until - now + 1_000));
  }

  /** A helper held for quota starts: the lead hears it at its next turn (no extra turn is spent on it). */
  private quotaResumed(a: AgentRecord): void {
    if (!this.quotaHeld.delete(a.parentConversationId)) return;
    this.post(a.parentConversationId, 'system', 'Quota is available again: helpers held for it are starting.', { agentId: a.id });
    this.addNote(a.parentConversationId, 'Helpers that waited for a quota reset are running again.');
  }

  /**
   * New work depends on a helper Harbor stopped at its time limit: its work is on its branch, so it is resumed (once per helper, and not
   * when the user stopped the conversation) and the dependent keeps waiting. False when that does not apply.
   */
  private resumeForDependent(dep: AgentRecord, waiting: AgentRecord): boolean {
    if (dep.state !== 'stopped' || dep.stopKind !== 'cap' || dep.depResumed || !dep.branch || this.running.has(dep.id) || this.stoppedSessions.has(dep.parentConversationId)) return false;
    dep.depResumed = true;
    this.reported.delete(reportKey(dep));
    this.d.store.clearReportDelivery(dep.id);
    this.post(dep.parentConversationId, 'system', `"${waiting.title}" builds on "${dep.title}", which Harbor stopped at its time limit: Harbor resumes "${dep.title}" from ${dep.branch} so its work can finish first.`, { agentId: dep.id });
    this.setState(waiting, 'queued', { error: `Waiting for "${dep.title}", which Harbor resumed to finish its work` });
    this.followUp(dep, DEPENDENCY_RESUME_PROMPT);
    return true;
  }

  pump(projectId: Id): void {
    const { store } = this.d;
    const max = effectiveSettings(store.getSettings(), projectId).concurrencyLimit ?? this.d.maxActivePerProject ?? DEFAULT_CONCURRENCY;
    // The quota budget's limit is shared by every project (one account); computed once per pump, and only when something can start.
    let budget: HelperLimit | undefined;
    // Higher priority first, then work whose conversation's deadline is closer to its estimate (urgency), then oldest first. Phase 5
    // simulator: without the urgency order a deadline's backlog waited in line behind other conversations' work.
    const urg = new Map<Id, number>();
    const now = (this.d.now ?? Date.now)();
    const urgencyOf = (c: Id) => { let u = urg.get(c); if (u === undefined) { u = this.urgencyFor(c, now, store.getCalibration()); urg.set(c, u); } return u; };
    const all = store.listAgentRecords(projectId).filter((a) => a.role !== 'main')
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || urgencyOf(b.parentConversationId) - urgencyOf(a.parentConversationId) || a.created - b.created);
    const byId = new Map(all.map((a) => [a.id, a]));
    for (const a of all) {
      if (a.state !== 'queued') continue;
      if (this.running.has(a.id)) continue;
      if (a.paused) continue;
      const deps = a.dependsOn.map((id) => byId.get(id)).filter((x): x is AgentRecord => !!x);
      // An integrator waits for reviewers only so its gate sees final verdicts: a failed or stopped review is settled, and the
      // gate (latest verdict on the current head) decides. Work stopped by a restart is not settled: it waits to be resumed.
      const settled = (x: AgentRecord) => !!a.integration && x.role === 'reviewer' && TERMINAL.includes(x.state) && !this.restartStopped(x);
      // A dependency already running again (resumed, not yet marked working) is pending, not bad.
      const bad = deps.find((x) => (x.state === 'failed' || x.state === 'stopped') && !settled(x) && !this.restartStopped(x) && !this.running.has(x.id));
      if (bad) {
        // A dependency Harbor stopped at its time limit has its work on a branch: resume it once instead of failing what builds on it.
        if (this.resumeForDependent(bad, a)) continue;
        const how = bad.branch ? `continue it with HARBOR_REPLY to id=${bad.id} (it resumes on ${bad.branch}) and delegate this again, or ` : '';
        this.setState(a, 'failed', { error: `Blocked: dependency "${bad.title}" ${bad.state}. Nothing was run. Options: ${how}re-plan without it.` });
        this.finished(a);
        continue;
      }
      const pending = deps.find((x) => x.state !== 'done' && !settled(x));
      if (pending) {
        const why = this.restartStopped(pending)
          ? `Waiting for "${pending.title}", which stopped when Harbor restarted: resume it, or stop this agent`
          : `Waiting for "${pending.title}"`;
        if (a.state !== 'queued' || a.error !== why) this.setState(a, 'queued', { error: why });
        continue;
      }
      if (this.canEdit(a) && this.d.store.getConversation(a.parentConversationId)?.mode === 'plan') {
        // Plan mode is read-only: an edit helper queued before (or despite) it waits for the mode to change.
        const why = 'Waiting: plan mode is on (edit helpers start after you approve the plan)';
        if (a.error !== why) this.setState(a, 'queued', { error: why });
        if (!this.planHeldNoted.has(a.id)) { this.planHeldNoted.add(a.id); this.post(a.parentConversationId, 'system', `Plan mode: "${a.title}" stays queued until you leave plan mode.`, { agentId: a.id }); }
        continue;
      }
      if (this.activeCount(projectId) >= max) continue;
      const heldTill = this.heldUntil.get(a.id);
      if (heldTill !== undefined) { if (heldTill > (this.d.now ?? Date.now)()) continue; this.heldUntil.delete(a.id); }
      if (!a.integration && !a.rollback) {
        budget ??= this.budgetLimit();
        if (budget.limit === 0 && budget.until !== undefined) { this.holdForQuota(a, budget.until); continue; }
        if (this.runningHelpers() >= Math.max(1, budget.limit)) continue;
      }
      // A follow-up that routing held for quota continues the helper's own session; it is not its assignment run again.
      const heldFollow = this.heldFollowUps.get(a.id);
      if (heldFollow !== undefined) { this.heldFollowUps.delete(a.id); this.quotaResumed(a); this.followUp(a, heldFollow); continue; }
      if (!this.claim(a)) continue;
      this.quotaResumed(a);
      this.begin(a.id);
      void this.runAgent(a).catch((e) => this.failAgent(a, `Internal error: ${String(e?.message ?? e)}`));
    }
  }

  /** Acquire file ownership for edit helpers. On conflict, ask the user whether to proceed in parallel. */
  private claim(a: AgentRecord): boolean {
    // An integrator or rollback only writes its own new branch, never files another helper is editing.
    if (!this.canEdit(a) || a.sharedOk || a.integration || a.rollback) return true;
    // A helper that edits in its own git worktree cannot collide with anyone before integration: no lock, not even a whole-project one.
    // The worktree comes from the repository probe (a repo with commits gets one when the helper starts); only a folder without git
    // edits in place and needs ownership of the files, or of the whole project when it did not say which.
    const project = this.d.store.getProject(a.projectId);
    const kind = this.repoKind.get(a.projectId) ?? (project && existsSync(join(project.path, '.git')) ? 'git' : 'none'); // before the first probe (e.g. after a restart): a .git entry means a worktree will be made
    if (!needsLock({ worktree: a.worktree ?? (kind === 'git' ? 'pending' : undefined), canEdit: true })) return true;
    const files = a.files?.length ? a.files : [WHOLE_PROJECT];
    const r = this.locks.acquire(a.projectId, a.id, files);
    if (r.ok) { this.withdrawConflictAsk(a.id); return true; }
    const holder = this.d.store.getAgent(r.conflicts[0]!.holder);
    const summary = `Waiting for "${holder?.title ?? 'another agent'}" to release ${r.conflicts.map((c) => c.file).join(', ')}`;
    if (a.error !== summary) this.setState(a, 'queued', { error: summary });
    if (!this.conflictAsked.has(a.id)) {
      this.conflictAsked.add(a.id);
      this.d.store.addCoordination({ projectId: a.projectId, kind: 'conflict', from: a.id, to: holder?.id, text: summary, files: r.conflicts.map((c) => c.file) });
      this.post(a.parentConversationId, 'system', `File conflict: "${a.title}" needs ${r.conflicts.map((c) => c.file).join(', ')} which "${holder?.title}" is editing.`);
      const ctl = new AbortController();
      this.conflictAsks.set(a.id, ctl);
      void this.d.ask('conflict', `"${a.title}" wants to edit ${r.conflicts.map((c) => c.file).join(', ')}, currently owned by "${holder?.title}". Allow it to proceed in parallel? (Each works in its own worktree; the results will need integration.) Choose No to make it wait.`, a.id, ctl.signal).then((allow) => {
        if (ctl.signal.aborted) return; // moot: the agent already got its files or ended
        this.conflictAsks.delete(a.id);
        this.d.store.addCoordination({ projectId: a.projectId, kind: 'decision', text: `User ${allow ? 'allowed parallel editing' : 'chose to serialize'} for "${a.title}"`, from: a.id });
        if (allow) { a.sharedOk = true; this.d.store.upsertAgent(a); }
        this.pump(a.projectId);
      });
    }
    return false;
  }

  private withdrawConflictAsk(agentId: Id): void {
    this.conflictAsks.get(agentId)?.abort();
    this.conflictAsks.delete(agentId);
  }

  // ------------------------------------------------------------ running helpers

  private failAgent(a: AgentRecord, error: string): void {
    this.running.delete(a.id);
    this.controllers.delete(a.id);
    this.locks.release(a.id);
    this.setState(a, 'failed', { error });
    this.post(this.convFor(a), 'system', `Failed: ${error}`, { agentId: a.id });
    this.log({ kind: 'helper-failed', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: `${a.role} "${a.title}": ${error}` });
    this.finished(a);
  }

  private convFor(a: AgentRecord): Id {
    return this.d.store.findConversationByAgent(a.id)?.id ?? a.parentConversationId;
  }

  /** Commands of the project's checks file (the injected loader, or `.harbor/checks.json` of the main checkout). */
  private checkCommands(project: Project): string[] {
    try { return (this.d.loadChecks ?? loadProjectChecks)(project.path); } catch { return []; }
  }

  /**
   * The helper's worktree: an existing harbor/* branch of this helper (a retry, an interrupted creation, a folder cleaned up
   * earlier) comes back as it was; otherwise a new branch from the current HEAD.
   */
  private async worktreeFor(a: AgentRecord, project: Project) {
    const { git, worktreesRoot } = this.d;
    const key = project.id.slice(0, 8);
    const again = await git.reuseWorktree(project.path, worktreesRoot, key, a.branch ?? harborBranchFor(a.title, a.id));
    if (again) return a.baseCommit ? { ...again, baseCommit: a.baseCommit } : again;
    return git.createWorktree(project.path, worktreesRoot, key, a.title, a.id);
  }

  private async runAgent(a: AgentRecord): Promise<void> {
    if (a.integration) return this.runIntegration(a);
    if (a.rollback) return this.runRollback(a);
    const project = this.project(a.projectId);
    const { store, git } = this.d;
    const conv = this.convFor(a);
    this.setState(a, 'working', { error: undefined, stopKind: undefined });
    this.post(conv, 'system', `Assignment (${a.role}, rev ${a.revision}): ${a.title}\n\n${a.task}`, { agentId: a.id });

    // Workspace: edit helpers get an isolated worktree; read-only helpers read the project (or the change under review).
    let cwd = project.path;
    let worktreeNote: string | undefined;
    let depsLinked = false;
    let reviewedBase: string | undefined;
    const upstream = a.dependsOn.map((id) => store.getAgent(id)).filter((x): x is AgentRecord => !!x);
    // Only writers and reviewers care whether the folder is a repository; a read-only helper starts without spawning git.
    const repo = this.canEdit(a) || a.role === 'reviewer' ? await this.probeRepo(project) : false;
    if (this.canEdit(a)) {
      if (repo && (!a.worktree || !existsSync(a.worktree))) {
        try {
          const wt = await this.worktreeFor(a, project);
          this.setState(a, 'working', { worktree: wt.path, branch: wt.branch, baseCommit: wt.baseCommit });
          // A crash right now must not lose the link between this helper and its branch: the next start would create a second one.
          store.flush();
          depsLinked = await git.linkDependencies(project.path, await this.cwdIn(project, wt.path));
        } catch (e) { return this.failAgent(a, `Could not create a git worktree: ${String((e as Error).message)}`); }
      }
      if (a.worktree) {
        cwd = await this.cwdIn(project, a.worktree);
        const prefix = await this.prefixOf(project);
        worktreeNote = `You work in an isolated git worktree on branch ${a.branch}. Commit your work to this branch. Do not touch other directories.${prefix ? ` The project is the ${prefix}/ folder of this repository; you start in it.` : ''}${depsLinked ? ' node_modules is linked from the main checkout: do not run npm install and never delete node_modules.' : ''}`;
        if (a.dirtyAtStart) worktreeNote += ` NOTE: the user's project folder had uncommitted changes when this was delegated${a.dirtyAtStart === 'unknown' ? ' (or Harbor could not tell)' : ''}. Your worktree starts from the committed HEAD${a.baseCommit ? ` (${a.baseCommit.slice(0, 7)})` : ''} and does not contain them.`;
      }
      else worktreeNote = 'This project is not a git repository with commits, so you edit the project directory directly while holding exclusive ownership. Keep changes minimal and scoped.';
    } else {
      const reviewed = upstream.find((u) => u.worktree);
      if (a.role === 'reviewer') {
        if (reviewed?.worktree && existsSync(reviewed.worktree)) {
          cwd = await this.cwdIn(project, reviewed.worktree);
          reviewedBase = reviewed.baseCommit;
          // Pin the exact version under review now; the branch may move while the reviewer works.
          const tested = await git.head(reviewed.worktree);
          if (tested) this.setState(a, 'working', { testedCommit: tested, testedWorktree: reviewed.worktree, outdated: false });
        } else if (repo) {
          // Reviewing the shared checkout would judge whatever happens to be there, not the change: refuse instead of guessing.
          return this.failAgent(a, upstream.length
            ? 'Refused: none of the helpers this review waited for has a worktree to review (its worktree was removed, or it edits nothing). Ask for the change to be re-delegated, then review it.'
            : 'Refused: this reviewer depends on no helper, so there is no change to review. Delegate it with "dependsOn" naming the implementer to review.');
        }
      }
      worktreeNote = 'Read-only: do not modify files.';
    }

    // The planner's report is the implementer's specification, verbatim.
    if (a.specFromId) {
      const src = store.getAgent(a.specFromId);
      if (src?.report) { a.spec = src.report; store.upsertAgent(a); }
    }

    const cmds = this.checkCommands(project);
    const picked = selectNotes(store.listProjectNotes(project.id), `${a.title} ${a.task} ${(a.files ?? []).join(' ')}`, NOTES_BUDGET.helper);
    // A reviewer judges one diff against its spec; the map would only add tokens. Everyone else starts with it instead of exploring.
    const repoMap = a.role === 'reviewer' ? '' : await this.repoMaps.get(project.path).catch(() => '');
    const prompt = subagentPrompt(a, { projectName: project.name, upstream, worktreeNote, baseCommit: reviewedBase, verifyHint: cmds.length ? cmds.join('; ') : undefined, knowledge: notesText(picked.picked, picked.omitted), repoMap });
    const res = await this.execute(a, prompt, { cwd, resume: false });
    // Held for quota (Phase 5): nothing ran, so it is not a failure. It waits in the queue and starts again at the reset.
    if (this.holdRun(a, res)) return;
    await this.afterRun(a, res);
  }

  /**
   * Routing held this run for quota (nothing ran): re-queue the helper instead of failing it. `followText` is a follow-up's message,
   * kept so the pump delivers it to the helper's own session when released (an assignment run needs none).
   */
  private holdRun(a: AgentRecord, res: RoutedRun, followText?: string): boolean {
    if (!res.held || res.started || this.controllers.get(a.id)?.signal.aborted) return false;
    this.locks.release(a.id);
    this.running.delete(a.id);
    this.controllers.delete(a.id);
    const until = res.held.until ?? (this.d.now ?? Date.now)() + QUOTA_RECHECK_MS;
    // The pump skips it until then, so it is not restarted (and announced again) on every pump in between.
    this.holdForQuota(a, until, 'too little quota is left above the reserve for this helper'); // sets 'queued' (clears nothing below)
    if (a.state !== 'queued') this.setState(a, 'queued');
    this.heldUntil.set(a.id, until);
    if (followText !== undefined) {
      const pending = this.followups.get(a.id)?.splice(0) ?? [];
      this.heldFollowUps.set(a.id, [followText, ...pending].join('\n\n'));
    }
    return true;
  }

  /** What the best auto-routable model can reach at high effort for these needs: an escalated retry never asks for more. */
  private strongestLevel(needs?: Need[]): number {
    return strongestLevel(this.d.catalog ?? DEFAULT_CATALOG, needs);
  }

  /** One CLI run for a helper (initial or follow-up), streaming into its conversation. */
  private async execute(a: AgentRecord, prompt: string, o: { cwd: string; resume: boolean; shots?: string[] }): Promise<RoutedRun> {
    const ctl = this.controllers.get(a.id) ?? new AbortController();
    // Auto mode lifts prompts and the sandbox for edit helpers only; reviewers and read-only helpers stay read-only.
    // Plan mode wins over everything: every helper that starts (or resumes) in it is read-only.
    const mode = this.d.store.getConversation(a.parentConversationId)?.mode;
    const permission = mode === 'plan' || !this.canEdit(a) ? 'read-only' : mode === 'auto' ? 'full' : 'edit';
    // A sandboxed edit run in a worktree must be able to write the worktree's git metadata (under the main repo's .git), or
    // `git add` / `git commit` fail inside it.
    const writableDirs = permission === 'edit' && a.worktree ? await this.d.git.worktreeWritableDirs(a.worktree).catch(() => []) : [];
    const allowed = permission === 'edit' ? commandPrefixes(this.checkCommands(this.project(a.projectId))) : [];
    return this.runRouted(a, {
      prompt, system: systemFor(a.role as Exclude<AgentRole, 'main'>), skills: true, role: a.role, complexity: a.complexity ?? 'medium', needs: a.needs, retry: a.retry,
      ...(a.difficulty !== undefined ? { difficulty: a.difficulty } : {}), ...(a.size ? { size: a.size } : {}), ...(a.difficultySignals ? { difficultySignals: a.difficultySignals } : {}),
      ...(a.escalateFrom ? { escalateFrom: a.escalateFrom } : {}), ...(a.keepModel ? { keepModel: a.keepModel } : {}),
      avoid: a.avoid, fanOut: a.role === 'planner' || a.role === 'implementer' || a.role === 'reviewer',
      requireCli: a.pinnedCli,
      permission, cwd: o.cwd, signal: ctl.signal,
      resume: o.resume, conversationId: this.convFor(a), stream: true,
      contextIfNoResume: o.resume ? () => this.helperContext(a) : undefined,
      nonce: newProtocolNonce(), ...(writableDirs.length ? { writableDirs } : {}), ...(allowed.length ? { allowedCommands: allowed } : {}),
      ...(o.shots?.length ? { shots: o.shots } : {})
    });
  }

  /** A follow-up whose native session is gone (or on another CLI) still knows its assignment and what it reported. */
  private helperContext(a: AgentRecord): string {
    const parts = [`Your earlier session is not available. Your assignment was: ${clip(a.task, 1500)}`];
    if (a.report) parts.push(`Your last report:\n${clip(a.report, 1500)}`);
    parts.push('Inspect the current state (git status and git log in your worktree) before acting, and do not repeat steps that already completed. Earlier checks or reviews cover only the commits they ran on.');
    return parts.join('\n\n');
  }

  /** Flag verification of a branch as outdated once its head differs from the commit that was tested. */
  private markOutdated(projectId: Id, worktree: string, head: string): void {
    for (const x of this.d.store.listAgentRecords(projectId)) {
      if (!x.testedWorktree || normPath(x.testedWorktree) !== normPath(worktree) || !x.testedCommit) continue;
      const outdated = x.testedCommit !== head;
      if (x.outdated === outdated) continue;
      x.outdated = outdated;
      this.d.store.upsertAgent(x);
      this.publish(x);
    }
  }

  private async afterRun(a: AgentRecord, res: RoutedRun): Promise<void> {
    const { store, git } = this.d;
    // Still "running" while Harbor checkpoints and checks, so stop() aborts the checks instead of finishing the agent twice.
    const ctl = this.controllers.get(a.id);
    const nonce = res.nonce;
    let report = stripProtocol(res.text, { nonce });
    const proto = parseProtocol(res.allText ?? res.text, { nonce });
    for (const l of ignoredProtocolLines(res.allText ?? res.text, proto, nonce)) this.log({ kind: 'protocol', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: `${a.role} "${a.title}": ${l}` });
    if (!res.ok && !res.stopped) this.log({ kind: 'helper-failed', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: `${a.role} "${a.title}" on ${a.cli}/${a.model}: ${res.error ?? 'failed'}` });
    // The CLI has ended, so nothing writes the shared checkout any more: its file locks go now, before the slow part (checkpoint, checks).
    this.locks.release(a.id);
    const stopped = !!res.stopped || !!ctl?.signal.aborted;
    if (res.noCompletion) report += '\n\nNote: the CLI ended without a completion event (it exited normally after its output), so Harbor counted the run as finished. Check that the work is complete.';

    if (a.worktree && a.baseCommit && this.canEdit(a)) {
      // Every ending commits what the helper left, so a failed or stopped run loses nothing with its worktree.
      const cp = await git.checkpoint(a.worktree, res.ok ? `harbor: ${a.title}` : `harbor: ${a.title} (partial)`);
      if (cp.head) { a.headCommit = cp.head; this.markOutdated(a.projectId, a.worktree, cp.head); }
      const warn = checkpointNote(cp, a.branch, false);
      if (res.ok) {
        const stat = await git.diffStat(a.worktree, a.baseCommit);
        const files = await git.changedFiles(a.worktree, a.baseCommit);
        if (stat) report += `\n\nChanges on ${a.branch}${cp.committed ? ' (uncommitted work was checkpointed by Harbor)' : ''}:\n${stat}`;
        else if (!cp.timedOut && !cp.error) report += `\n\nNo changes were committed on ${a.branch}.`;
        if (warn) report += `\n\n${warn}`;
        if (cp.head && cp.head !== a.baseCommit && !a.integration) await this.recordSnapshot(a, a.worktree, a.baseCommit, cp.head);
        const claimed = (a.files ?? []).map((f) => f.replace(/\\/g, '/').toLowerCase());
        const outside = claimed.length ? files.filter((f) => !claimed.some((c) => f.toLowerCase() === c || f.toLowerCase().startsWith(c.replace(/\/?$/, '/')))) : [];
        if (outside.length) {
          const msg = `"${a.title}" changed files outside its claim: ${outside.join(', ')}. Needs coordination before integration.`;
          store.addCoordination({ projectId: a.projectId, kind: 'conflict', from: a.id, text: msg, files: outside });
          this.post(a.parentConversationId, 'system', msg, { agentId: a.id });
          this.log({ kind: 'outside-claim', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: msg });
          report += `\n\nWARNING: edits outside claimed files: ${outside.join(', ')}`;
        }
        report += this.harborDirWarning(a, files);
        if (cp.head && cp.head !== a.baseCommit) report += await this.secretEvidence(a, a.worktree, a.baseCommit, cp.head);
        if (cp.head && !stopped) report += await this.runChecks(a, cp.head, ctl?.signal);
      } else {
        if (cp.committed) report += `\n\nThe run did not finish cleanly; Harbor committed its uncommitted work to ${a.branch} so nothing is lost.`;
        if (warn) report += `\n\n${warn}`;
      }
    }

    // Each run replaces the previous result: a verdict from an earlier revision must not outlive it.
    // The commit ties the result to what was examined: the reviewed head pinned at start, or the helper's own head.
    const examined = a.role === 'reviewer' ? a.testedCommit : this.canEdit(a) ? a.headCommit : undefined;
    const own = proto.result;
    let result: AgentRecord['result'] = own ? { ...own, ...(examined ? { commit: examined } : {}) } : undefined;
    // A helper that ends without its result line has not told Harbor how it ended: that is not a clean "done" either.
    if (res.ok && !stopped && !own) result = { outcome: 'partial', summary: 'helper ended without a result line', checks: [], ...(examined ? { commit: examined } : {}) };
    a.result = result;
    // A verdict counts only when the parser accepted it (the final line of the output). Without one, nothing can approve or reject.
    if (a.role === 'reviewer' && res.ok && !stopped && !result?.verdict) {
      report = `NO VERDICT: this reviewer's output did not end with a valid HARBOR_RESULT line carrying a verdict (approve or changes), so it counts as neither an approval nor a rejection.\n\n${report}`;
    }

    // Routing said the model only just clears hard work: one automatic review once it is done (see autoReview).
    if (res.decision?.needsReview && this.canEdit(a) && a.role === 'implementer') Object.assign(a, { needsReview: true, reviewReason: res.decision.reviewReason });
    this.running.delete(a.id);
    this.controllers.delete(a.id);
    // Harbor's time limit, not the user: resumed once from the saved session (its work is committed above) before the lead hears of it.
    const capStopped = !!res.capped && !ctl?.signal.aborted;
    const loopStopped = !!res.loop && !ctl?.signal.aborted;
    const spendStopped = !!res.spent && !ctl?.signal.aborted;
    if (loopStopped && this.loopStop(a, res.loop!, report)) return;
    if (capStopped && capResumeAllowed(a) && !this.stoppedSessions.has(a.parentConversationId) && !this.shuttingDown) {
      a.capResumes = (a.capResumes ?? 0) + 1;
      a.report = report;
      store.upsertAgent(a);
      const note = `${res.error ?? 'Harbor stopped this run at its time limit'}. Its work so far is committed${a.branch ? ` on ${a.branch}` : ''}; Harbor resumes it once from its saved session to finish and report.`;
      this.post(this.convFor(a), 'system', note, { agentId: a.id });
      if (this.convFor(a) !== a.parentConversationId) this.post(a.parentConversationId, 'system', `"${a.title}": ${note}`, { agentId: a.id });
      this.log({ kind: 'triage', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: `${a.role} "${a.title}": ${res.error ?? 'capped'}; resumed automatically` });
      const pending = this.followups.get(a.id)?.splice(0) ?? [];
      this.followUp(a, [CAP_RESUME_PROMPT, ...pending].join('\n\n'));
      return;
    }
    const blocked = res.ok && proto.help.some((h) => h.blocked);
    const asking = res.ok && !stopped && proto.ask[0];
    const askRoute = asking ? routeAsk(asking, { leadAsks: a.leadAsks ?? 0, leadAvailable: !this.stoppedSessions.has(a.parentConversationId) }) : undefined;
    // A screenshot request makes the helper wait like a question: the user's answer (the image or a refusal) is its next message.
    const shot = res.ok && !stopped && !asking && !blocked ? proto.screenshot[0] : undefined;
    if (proto.screenshot.length && !shot && res.ok && !stopped) this.post(this.convFor(a), 'system', 'Harbor ignored this helper\'s screenshot request because it also asked a question or requested help; it can ask again afterwards.', { agentId: a.id });
    if (res.ok && proto.showImage.length) {
      const project = this.project(a.projectId);
      const cwd = a.worktree && existsSync(a.worktree) ? await this.cwdIn(project, a.worktree) : project.path;
      this.showImages(a, this.convFor(a), proto.showImage, cwd, [project.path, ...(a.worktree ? [a.worktree] : [])]);
    }
    if (res.ok && proto.openDocument.length) {
      const project = this.project(a.projectId);
      const cwd = a.worktree && existsSync(a.worktree) ? await this.cwdIn(project, a.worktree) : project.path;
      this.openDocuments(a, this.convFor(a), proto.openDocument, cwd, [{ kind: 'project', path: project.path }, ...(a.worktree ? [{ kind: 'worktree' as const, path: a.worktree, agentId: a.id }] : [])]);
    }
    const summary = own?.summary || firstLine(report);
    if (stopped) {
      const where = `Its work so far is committed${a.branch ? ` on ${a.branch}` : ''}${a.headCommit ? ` at ${a.headCommit.slice(0, 10)}` : ''}.`;
      const capError = `${res.error ?? 'Harbor stopped this run at its time limit'}${a.capResumes ? ' (after one automatic resume)' : ''}. ${where} The lead decides: continue it (HARBOR_REPLY), split what is left, or do it itself.`;
      const loopError = res.loop ? `Harbor stopped this run again because it was going in circles: ${describeLoop(res.loop)} (after one automatic resume with a different instruction). ${where} The lead decides: re-scope it, split it, or take it over.` : '';
      const spendError = `${res.error ?? 'Harbor stopped this run at a spend ceiling'} ${where} Nothing more runs in this scope until the user allows it; the lead decides what is still worth doing.`;
      this.setState(a, 'stopped', { report, error: loopStopped ? loopError : capStopped ? capError : spendStopped ? spendError : 'Stopped by the user.', stopKind: loopStopped ? 'loop' : capStopped ? 'cap' : spendStopped ? 'spend' : 'user', summary: undefined });
    }
    else if (!res.ok) this.setState(a, 'failed', { report, error: res.error ?? 'failed', summary: undefined });
    else if (asking) this.setState(a, 'waiting', { report, summary, error: askRoute?.to === 'lead' ? "Waiting for the lead's answer." : 'Waiting for your answer.' });
    else if (shot) this.setState(a, 'waiting', { report, summary, error: 'Waiting for your answer to its screenshot request.' });
    else if (blocked) this.setState(a, 'waiting', { report, summary, error: 'Blocked: waiting for another helper requested through the lead.' });
    else this.setState(a, 'done', { report, summary, error: undefined });

    if (asking && askRoute) {
      const conv = this.convFor(a);
      this.post(conv, 'assistant', asking.question, { agentId: a.id });
      // File claims, scope and which branch to build on are the lead's to decide; only the user's own questions go to the user.
      if (askRoute.to === 'lead' && this.autoTurn(a.parentConversationId)) {
        a.leadAsks = (a.leadAsks ?? 0) + 1;
        store.upsertAgent(a);
        this.d.store.addCoordination({ projectId: a.projectId, kind: 'help', from: a.id, text: `question: ${asking.question}` });
        this.post(a.parentConversationId, 'system', `"${a.title}" asked the lead: ${clip(asking.question, 160)}`, { agentId: a.id });
        this.enqueueMain(a.projectId, { kind: 'help', from: a, reason: 'question', proposedRole: 'none', instructions: asking.question, blocked: true, question: { options: asking.options } }, a.parentConversationId);
        this.armAskDefault(a, 'repeat');
      } else {
        if (a.error !== 'Waiting for your answer.') this.setState(a, 'waiting', { error: 'Waiting for your answer.' });
        this.askUserForHelper(a, asking, askRoute.to === 'user' ? askRoute.kind : 'repeat');
      }
    }
    for (const h of proto.help) this.helpRequested(a, h);
    if (shot) this.requestScreenshot(a, this.convFor(a), a.parentConversationId, shot);

    // Direct prompts that arrived while running are delivered now, resuming this agent's session. While a screenshot request is
    // open they stay queued: the answer resumes the helper, and that run's end delivers them.
    const queued = shot ? [] : this.followups.get(a.id)?.splice(0) ?? [];
    if (queued.length && !stopped) { this.followUp(a, queued.join('\n\n')); return; }
    if (a.state !== 'waiting') this.finished(a);
    else this.pump(a.projectId);
  }

  /**
   * A loop stop (loopGuard.ts): journal it, tell the conversation, and resume the helper ONCE with what looped and the instruction to
   * change approach. True when it was resumed; false leaves the caller to mark it stopped (stopKind 'loop'), which wakes the lead.
   */
  private loopStop(a: AgentRecord, e: LoopEvidence, report: string): boolean {
    const what = describeLoop(e);
    const resume = loopResumeAllowed(a) && !this.stoppedSessions.has(a.parentConversationId) && !this.shuttingDown;
    this.log({ kind: 'loop', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: `${a.role} "${a.title}": ${what} (${e.kind}); ${resume ? 'resumed once' : 'left stopped, lead woken'}` });
    if (!resume) return false;
    a.loopResumes = (a.loopResumes ?? 0) + 1;
    a.report = report;
    this.d.store.upsertAgent(a);
    const note = `Stopped "${a.title}": ${what}; resuming it once with a different instruction.`;
    this.post(this.convFor(a), 'system', note, { agentId: a.id });
    if (this.convFor(a) !== a.parentConversationId) this.post(a.parentConversationId, 'system', note, { agentId: a.id });
    const where = a.branch || a.headCommit ? `Your work so far is committed${a.branch ? ` on branch ${a.branch}` : ''}${a.headCommit ? ` at ${a.headCommit.slice(0, 10)}` : ''}.` : '';
    const pending = this.followups.get(a.id)?.splice(0) ?? [];
    this.followUp(a, [loopResumePrompt(e, where), ...pending].join('\n\n'));
    return true;
  }

  /** Changes under `.harbor/` alter what Harbor runs and trusts (the checks); they are never merged without being pointed out. */
  private harborDirWarning(a: AgentRecord, files: string[]): string {
    const touched = files.filter((f) => /(^|\/)\.harbor\//i.test(f.replace(/\\/g, '/')));
    if (!touched.length) return '';
    const msg = `"${a.title}" changes Harbor's own configuration: ${touched.join(', ')}. Harbor does not treat these like ordinary code: review them before integrating (a changed checks file asks for a fresh approval before it runs).`;
    this.post(a.parentConversationId, 'system', msg, { agentId: a.id });
    this.log({ kind: 'outside-claim', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: msg });
    return `\n\nWARNING: changes under .harbor/: ${touched.join(', ')}. Review them before this branch is integrated.`;
  }

  // ------------------------------------------------------------ secret scanning (secretScan.ts)

  /** Harbor's secret scan of `base..head` in `cwd`, minus the project's allowlist. Types and locations only, never values. */
  private async secretScan(a: AgentRecord, cwd: string, base: string, head: string): Promise<SecretScanRecord> {
    const { diff, truncated, failed } = await this.d.git.diffForScan(cwd, base, head);
    if (failed) return { commit: head, findings: [], total: 0, allowed: 0, failed: true };
    const scan = scanDiff(diff);
    const { kept, allowed } = applyAllowlist(scan.findings, effectiveSettings(this.d.store.getSettings(), a.projectId).secretAllowlist);
    // Findings past MAX_FINDINGS were not run through the allowlist: they count as kept (the safe side).
    const total = kept.length + Math.max(0, scan.total - scan.findings.length);
    return { commit: head, findings: kept, total, allowed: allowed.length, ...(truncated ? { truncated: true } : {}) };
  }

  /** After an edit helper's run: the scan of its branch, recorded as evidence (the lead's report, reviewers, the integration gate). */
  private async secretEvidence(a: AgentRecord, cwd: string, base: string, head: string): Promise<string> {
    const rec = await this.secretScan(a, cwd, base, head).catch(() => undefined);
    a.secretScan = rec;
    if (!rec) return '';
    if (rec.failed) return `\n\nHarbor could not run its secret scan on ${head.slice(0, 10)} (git failed); the integration scans again.`;
    if (!rec.total) return '';
    const text = `Secret scan (Harbor) on ${head.slice(0, 10)}: ${rec.total} possible secret${rec.total === 1 ? '' : 's'}: ${describeFindings(rec.findings, rec.total)}. Values are not shown. Integration is blocked until they are removed, allowlisted, or the user allows them.`;
    this.post(a.parentConversationId, 'system', `"${a.title}": ${text}`, { agentId: a.id });
    this.log({ kind: 'secret-scan', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: `"${a.title}" ${head.slice(0, 10)}: ${describeFindings(rec.findings, rec.total, 5)}` });
    return `\n\nWARNING: ${text}`;
  }

  /**
   * Before applying an integration: its head must have passed the secret scan, or the user must have allowed exactly its findings.
   * An integration from before secret scanning is scanned now; findings then need a re-run of the integration, which asks.
   */
  private async secretsCleared(a: AgentRecord, cwd: string, base: string, head: string): Promise<void> {
    const prior = a.secretScan;
    const clean = (r: SecretScanRecord | undefined) => !!r && r.commit === head && !r.failed && (r.overridden || (!r.total && !r.truncated));
    if (clean(prior)) return;
    const rec = prior?.commit === head && !prior.failed ? prior : await this.secretScan(a, cwd, base, head);
    a.secretScan = rec;
    this.d.store.upsertAgent(a);
    if (clean(rec)) return;
    const fp = `${findingsFingerprint(head, rec.findings)}${rec.truncated ? ':partial' : ''}`;
    if (!rec.failed && this.d.store.hasSecretOverride(a.projectId, fp)) { rec.overridden = true; this.d.store.upsertAgent(a); return; }
    throw new Error(rec.failed
      ? `Harbor could not run its secret scan on ${head.slice(0, 10)}, so nothing was changed. Try again.`
      : `Harbor's secret scan found ${rec.total ? `${rec.total} possible secret${rec.total === 1 ? '' : 's'} (${describeFindings(rec.findings, rec.total, 5)})` : 'a change too large to scan completely'} on ${head.slice(0, 10)}, so nothing was changed. Run the integration again: Harbor asks you before integrating them.`);
  }

  /**
   * Integration gate: the scan of everything the integration brings onto the target (`base..head`). A hit (or a change too large to
   * scan completely, or a scan that failed) blocks it unless the user says yes to exactly these findings on this commit (a `permission`
   * event; no answer is a no). A yes is remembered per project, so re-running or applying the same head does not ask again.
   */
  private async secretGate(a: AgentRecord, cwd: string, base: string, head: string, signal?: AbortSignal): Promise<{ blocked?: string; note: string }> {
    const h = head.slice(0, 10);
    const rec = await this.secretScan(a, cwd, base, head);
    a.secretScan = rec;
    if (rec.failed) return { blocked: `Harbor could not run its secret scan on ${h} (git failed), so the integration is not cleared. Run it again.`, note: '' };
    if (!rec.total && !rec.truncated) return { note: `\n\nSecret scan (Harbor) on ${h}: nothing found${rec.allowed ? ` (${rec.allowed} allowlisted)` : ''}.` };
    const summary = [rec.total ? `${rec.total} possible secret${rec.total === 1 ? '' : 's'}: ${describeFindings(rec.findings, rec.total)}` : '', rec.truncated ? 'the change is too large to scan completely' : ''].filter(Boolean).join('; ');
    const fp = `${findingsFingerprint(head, rec.findings)}${rec.truncated ? ':partial' : ''}`;
    const journal = (text: string) => this.log({ kind: 'secret-scan', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: `integration ${h}: ${text}` });
    const allowedNote = `\n\nSecret scan (Harbor) on ${h}: ${summary}. You allowed integrating these (values not shown).`;
    if (this.d.store.hasSecretOverride(a.projectId, fp)) { rec.overridden = true; journal('allowed earlier by the user'); return { note: allowedNote }; }
    journal(`${describeFindings(rec.findings, rec.total, 5)}${rec.truncated ? ' (partial scan)' : ''}; asked the user`);
    const prompt = `Harbor's secret scan found ${summary} in what "${a.title}" would integrate (head ${h}). Values are not shown. Integrate anyway? Yes allows exactly these findings on this commit; anything new asks again. No blocks the integration: remove them (or add the paths to the project's secret allowlist) and run it again.`;
    const d = await this.askTool(a, this.convFor(a), ++this.runSeq, { tool: SECRET_TOOL, input: {} }, signal ?? new AbortController().signal, { noRules: true, prompt });
    if (d.allow) {
      this.d.store.addSecretOverride(a.projectId, fp);
      rec.overridden = true;
      journal('allowed by the user');
      return { note: allowedNote };
    }
    journal('blocked');
    return { blocked: `Secret scan found ${summary} on ${h}. Integration blocked (values not shown): remove them, allowlist the paths in the project's settings, or run the integration again and allow it.`, note: '' };
  }

  /**
   * Whether the project's checks may run. The commands come from a file in the repository, so the first time a given content
   * would run (and whenever it changes) the user is asked, listing the commands; nothing runs until they allow it. The approval
   * is remembered per project by content hash.
   */
  private async checksTrusted(a: AgentRecord, project: Project, cmds: string[], signal?: AbortSignal): Promise<boolean> {
    const { store } = this.d;
    const hash = createHash('sha256').update(JSON.stringify(cmds)).digest('hex');
    if (store.getChecksApproval(project.id) === hash) return true;
    if (this.d.autoApproveChecks) { store.setChecksApproval(project.id, hash); return true; }
    const key = `${project.id}:${hash}`;
    let pending = this.checksAsks.get(key);
    if (!pending) {
      const prompt = `The project's checks (.harbor/checks.json) have not been approved yet. Harbor would run these commands in a helper's worktree, with your user permissions:\n${cmds.map((c) => `  ${c}`).join('\n')}\nAllow them? This approves exactly these commands for this project; if the file changes, Harbor asks again.`;
      pending = this.askTool(a, this.convFor(a), ++this.runSeq, { tool: 'Harbor checks', input: { command: cmds.join(' ; ') } }, signal ?? new AbortController().signal, { noRules: true, prompt })
        .then((d) => { if (d.allow) store.setChecksApproval(project.id, hash); return d.allow; });
      this.checksAsks.set(key, pending);
      void pending.finally(() => { if (this.checksAsks.get(key) === pending) this.checksAsks.delete(key); });
    }
    return pending;
  }

  /**
   * Run the project's checks on the helper's committed branch head. These are evidence; the helper's own HARBOR_RESULT
   * checks are claims. With no checks configured nothing changes. Returns the text appended to the report.
   */
  private async runChecks(a: AgentRecord, head: string, signal?: AbortSignal): Promise<string> {
    const project = this.project(a.projectId);
    const cmds = this.checkCommands(project);
    if (!cmds.length || !a.worktree) return '';
    if (!(await this.checksTrusted(a, project, cmds, signal))) {
      this.post(this.convFor(a), 'system', 'Harbor did not run the project checks: .harbor/checks.json is not approved (answer the permission request to allow it).', { agentId: a.id });
      return `\n\nHarbor did NOT run the project checks (${cmds.join(', ')}): the checks file has not been approved by the user, so nothing here is verified by Harbor.`;
    }
    if (signal?.aborted) return '';
    const run = this.d.runCheck ?? runShellCheck;
    const cwd = await this.cwdIn(project, a.worktree);
    this.post(this.convFor(a), 'system', `Harbor is running checks on ${a.branch}: ${cmds.join(', ')}`, { agentId: a.id });
    const runs: CheckRun[] = [];
    for (const cmd of cmds) {
      if (signal?.aborted) break;
      runs.push({ cmd, ...(await run(cmd, cwd, signal)) });
    }
    // testedWorktree lets markOutdated flag these checks once the branch moves past `head`.
    Object.assign(a, { checks: runs, testedCommit: head, testedWorktree: a.worktree, outdated: false });
    const failed = runs.filter((r) => !r.ok);
    if (failed.length && !signal?.aborted) {
      this.log({ kind: 'checks-failed', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: `"${a.title}" on ${head.slice(0, 10)}: ${failed.map((f) => `${f.cmd} (${f.timedOut ? 'timed out' : `exit ${f.exitCode}`})`).join(', ')}` });
    }
    const lines = runs.map((r) => `- ${r.cmd}: ${r.ok ? 'PASS' : `FAIL (${r.timedOut ? 'timed out' : `exit ${r.exitCode}`})`}${r.ok ? '' : `\n${clip(r.output.split(/\r?\n/).slice(-15).join('\n'), 1500)}`}`);
    return `\n\nChecks Harbor ran on ${head.slice(0, 10)}:\n${lines.join('\n')}`;
  }

  /**
   * Record what the helper's branch holds after this run (newest 5 kept). The patch is evidence only, written without
   * credential files; a rollback always reverses git objects. Failures never affect the run.
   */
  private async recordSnapshot(a: AgentRecord, worktree: string, base: string, head: string): Promise<void> {
    if (a.snapshots?.at(-1)?.head === head) return;
    try {
      const files = await this.d.git.changes(worktree, base, head);
      const snap: TaskSnapshot = { revision: a.revision, base, head, time: Date.now(), files };
      if (this.d.patchesRoot) {
        const hidden = files.filter((f) => f.hidden).flatMap((f) => [f.path, ...(f.oldPath ? [f.oldPath] : [])]);
        // Bounded: a huge diff keeps its file list (above) but no replayable patch.
        const { patch } = await this.d.git.diffBinaryCapped(worktree, base, head, hidden);
        if (patch !== undefined) {
          const dir = join(this.d.patchesRoot, a.projectId.slice(0, 8), a.id);
          mkdirSync(dir, { recursive: true });
          snap.patchPath = join(dir, `${a.revision}-${head.slice(0, 7)}.patch`);
          writeFileSync(snap.patchPath, patch);
        }
      }
      const all = [...(a.snapshots ?? []), snap];
      for (const old of all.slice(0, -MAX_SNAPSHOTS)) if (old.patchPath && old.patchPath !== snap.patchPath) rmSync(old.patchPath, { force: true });
      a.snapshots = all.slice(-MAX_SNAPSHOTS);
      this.d.store.upsertAgent(a);
    } catch { /* no snapshot this run: rollback falls back to the branch and merge history */ }
  }

  private finished(a: AgentRecord): void {
    const { store } = this.d;
    this.conflictAsked.delete(a.id);
    this.withdrawConflictAsk(a.id);
    const parent = a.parentConversationId;
    const verb = a.state === 'done' ? 'finished' : a.state === 'stopped' ? 'was stopped' : 'failed';
    this.post(parent, 'system', `${a.state === 'done' ? '✓' : '✗'} ${a.title} ${verb}${a.summary ? `: ${clip(a.summary, 200)}` : a.error ? `: ${clip(a.error, 200)}` : ''}`, { agentId: a.id });

    // A helper requested for a blocked agent: hand its report back.
    if (a.helpFor && a.state === 'done') {
      const req = store.getAgent(a.helpFor);
      if (req && req.state === 'waiting') this.followUp(req, `Your requested helper "${a.title}" finished. Its report:\n${clip(a.report ?? '', 5000)}\n\nContinue your assignment.`);
    }
    if (a.state === 'failed' && this.d.store.getConversation(parent)?.mode === 'goal') this.d.store.setGoalPaused(parent, true);
    // Before the report wake is scheduled: a queued review keeps the lead asleep until it has the verdict too.
    this.autoReview(a);

    this.pump(a.projectId);
    if (!a.byUser) this.scheduleReport(a);
  }

  /**
   * Routing said this implementer's model only just clears (or does not clear) the floor of hard work (RouteDecision.needsReview):
   * Harbor schedules ONE read-only reviewer after it, unless the lead already has one on it. At most once per implementer.
   */
  private autoReview(a: AgentRecord): void {
    if (a.state !== 'done' || a.role !== 'implementer' || !a.needsReview || a.autoReviewed || !a.branch || !a.headCommit || a.headCommit === a.baseCommit) return;
    if (this.reviewersOf(a.projectId, a).length) return;
    const { store } = this.d;
    a.autoReviewed = true;
    store.upsertAgent(a);
    const why = a.reviewReason ?? 'its model only just clears the difficulty of this work';
    const task = `Review the change of "${a.title}" on ${a.branch} against the specification it was built against and its acceptance criteria. Harbor scheduled this review because ${why}.`;
    const est = difficultyOf({ role: 'reviewer', text: task, files: a.files, readOnly: true });
    const complexity = complexityOf(est.difficulty);
    const rec: AgentRecord = {
      id: newId(), projectId: a.projectId, parentId: store.mainAgent(a.projectId)?.id, role: 'reviewer', title: `Review "${clip(a.title, 50)}"`, state: 'queued',
      cli: 'auto', model: 'auto', effort: effortFor('reviewer', complexity), task, files: a.files, dependsOn: [a.id], readOnly: true, needs: ['review', 'code'],
      revision: 1, complexity, difficulty: est.difficulty, size: est.size, difficultySignals: [...est.signals, 'automatic review: routing flagged the implementer'],
      parentConversationId: a.parentConversationId, attempts: 0, created: Date.now(), updated: Date.now(), autoReviewOf: a.id
    };
    store.upsertAgent(rec);
    store.addConversation({ id: newId(), projectId: a.projectId, title: `reviewer: ${rec.title}`, updated: Date.now(), agentId: rec.id });
    this.publish(rec);
    this.post(a.parentConversationId, 'system', `Harbor scheduled one review of "${a.title}": ${why}.`, { agentId: rec.id });
  }

  /** A planner's own wake is skipped while queued dependents already carry its report as their spec: it rides along with the final wake. */
  private plannerFeedsDependents(a: AgentRecord): boolean {
    return a.role === 'planner' && a.state === 'done' && this.d.store.listAgentRecords(a.projectId).some((x) => x.specFromId === a.id && (x.state === 'queued' || x.state === 'working' || x.state === 'waiting'));
  }

  /**
   * Gathers wake-ups of one conversation's lead: helpers finishing within the debounce window (a failure cascade, several
   * helpers ending together) wake it once with one batch instead of once each, each wake being a full lead turn. The first
   * finisher arms the timer; the rest only add to it, so the wait is bounded.
   */
  private scheduleReport(a: AgentRecord): void {
    const conv = a.parentConversationId;
    // Judgement needed now: a failure, Harbor's own stop (the user's stops never wake it), a helper that says it is blocked, or a planner nothing waits on.
    const own = a.state === 'failed' || (a.state === 'stopped' && harborStopped(a)) || a.result?.outcome === 'blocked' || (a.role === 'planner' && !this.plannerFeedsDependents(a));
    const pending = this.reportWakes.get(conv);
    if (pending) { pending.wake ||= own; pending.last = a; return; }
    const ms = this.d.reportDebounce?.ms ?? REPORT_DEBOUNCE_MS;
    if (ms <= 0) { this.maybeReportToMain(a, own); return; }
    const entry = { wake: own, last: a, cancel: (): void => {} };
    this.reportWakes.set(conv, entry);
    entry.cancel = (this.d.reportDebounce?.setTimer ?? defaultTimer)(() => {
      if (this.reportWakes.get(conv) !== entry) return;
      this.reportWakes.delete(conv);
      if (!this.shuttingDown) this.maybeReportToMain(entry.last, entry.wake);
    }, ms);
  }

  /** Resume the lead only when its judgement is needed: a planner that nothing waits on, any failure, or all work finished. */
  private maybeReportToMain(a: AgentRecord, wake = false): void {
    const { store } = this.d;
    // User-started integrations and rollbacks are left out: they never report, so they must not hold back the lead's report either.
    const agents = store.listAgentRecords(a.projectId).filter((x) => x.role !== 'main' && !x.byUser && x.parentConversationId === a.parentConversationId);
    const active = agents.some((x) => x.state === 'queued' || x.state === 'working' || x.state === 'waiting');
    const needsMain = wake || a.state === 'failed' || !active;
    if (!needsMain) return;
    const open = agents.filter((x) => TERMINAL.includes(x.state) && !this.reported.has(reportKey(x)));
    // Never sent anywhere. Uncertain results (a lead may have read them) only ride along: they never start a turn themselves.
    const fresh = open.filter((x) => !deliveryOf(x));
    if (!fresh.length) return;
    // A stop-all should not trigger a flurry of lead turns: a batch of only USER-stopped helpers is skipped on purpose. A helper Harbor
    // stopped at its time limit is not a stop-all: skipping it left a real run's lead idle for 28 minutes until the user typed again.
    if (fresh.every((x) => x.state === 'stopped' && !harborStopped(x))) { fresh.forEach((x) => this.reported.add(reportKey(x))); store.markReports(fresh, 'skipped'); return; }
    if (!this.autoTurn(a.parentConversationId)) return;
    // Uncertain results join when the turn starts (`heldReports`), within the same bound as any other turn.
    fresh.forEach((x) => this.reported.add(reportKey(x)));
    const batch: ReportBatch = { marks: [], prev: new Map(), started: false, settled: false };
    joinBatch(batch, fresh);
    this.enqueueMain(a.projectId, { kind: 'reports', items: fresh.map(reportSnapshot) }, a.parentConversationId, batch);
  }

  /**
   * Reports of this conversation that a lead turn should still carry: never delivered (a turn that could not start, a
   * dropped turn, paused coordination, a helper that finished while others ran) or uncertain (an interrupted turn, an
   * upgraded file). Stopped results never sent are left out, as a stop-all batch is: the register lists them. Ones already
   * travelling with a queued or running turn are left out too. Bounded; the rest stay held for a later turn.
   */
  private heldReports(projectId: Id, conversationId: Id): { items: AgentRecord[]; omitted: AgentRecord[] } {
    return pickHeld(this.registerFor(projectId, conversationId).filter((x) => {
      if (x.byUser || !TERMINAL.includes(x.state) || this.reported.has(reportKey(x))) return false;
      const d = deliveryOf(x);
      return d ? UNCERTAIN.includes(d.status) : x.state !== 'stopped' || harborStopped(x);
    }));
  }

  /** Before each attempt of the turn: from here a crash leaves these results uncertain, never silently delivered or lost. */
  private reportsAttempted(batch: ReportBatch): void {
    if (batch.started || batch.settled) return;
    batch.started = true;
    this.d.store.markReports(batch.marks, 'attempted');
  }

  /**
   * How a turn carrying reports ended. `confirmed`: it finished. `notStarted`: no CLI took the prompt (no eligible CLI,
   * spawn failure, dropped turn), so the results are pending again exactly as before; `tell` says so to the user.
   * `interrupted`: a CLI may have taken it (output, or a stop after hand-over) but the turn did not finish; the results stay
   * `attempted` and the user is told. Either way they are held for the lead's next turn, whatever starts it.
   */
  private settleReports(batch: ReportBatch, outcome: 'confirmed' | 'notStarted' | 'interrupted', conversationId: Id, tell = false): void {
    if (batch.settled) return;
    batch.settled = true;
    if (!batch.marks.length) return;
    const { store } = this.d;
    if (outcome === 'confirmed') { store.markReports(batch.marks, 'confirmed'); return; }
    for (const m of batch.marks) this.reported.delete(reportKey(m));
    const refs = markRefs(batch.marks, (id) => store.getAgent(id)?.title);
    const next = "the lead's next turn (your next message to it, or its next helper report)";
    if (outcome === 'notStarted') {
      if (batch.started) store.restoreReports(batch.marks.map((mark) => ({ mark, prev: batch.prev.get(mark.id) })));
      // A dropped turn (the user stopped the session) needs no notice; a turn that could not run does.
      if (tell) this.post(conversationId, 'system', `${batch.marks.length} helper report(s) did not reach the lead: ${refs}. Harbor keeps them and sends them with ${next}.`);
      return;
    }
    this.post(conversationId, 'system', `The lead's turn ended before it finished with ${batch.marks.length} helper report(s): ${refs}. Harbor cannot tell whether the lead read them, so it sends them again with ${next}, marked as possibly seen. Nothing is re-run.`);
    store.noticeReports(batch.marks);
  }

  // ------------------------------------------------------------ integration (Harbor's own git code, no CLI)

  /**
   * Whether the work itself was judged wanting: its latest reviewer verdict is "changes", or a check Harbor ran on it failed. These
   * are the only reasons a retry may spend more (a stronger tier, then higher effort). A failed or stopped run is not one.
   */
  private workRejected(projectId: Id, prior: AgentRecord): boolean {
    if (prior.result?.verdict === 'changes' || prior.checks?.some((c) => !c.ok)) return true;
    const latest = this.reviewersOf(projectId, prior).filter((r) => r.state === 'done' && r.result?.verdict).sort((x, y) => y.created - x.created)[0];
    return latest?.result?.verdict === 'changes';
  }

  /** Reviewers of a helper: those that waited for it, or examined its worktree. */
  private reviewersOf(projectId: Id, src: AgentRecord): AgentRecord[] {
    return this.d.store.listAgentRecords(projectId).filter((r) => r.role === 'reviewer' &&
      (r.dependsOn.includes(src.id) || (!!src.worktree && !!r.testedWorktree && normPath(r.testedWorktree) === normPath(src.worktree))));
  }

  /** The user asks Harbor to integrate finished helpers' branches. Queued like a helper, after the sources and their reviewers. */
  async integrateBranches(projectId: Id, agentIds: Id[], target?: string): Promise<AgentRecord> {
    const { store } = this.d;
    const project = this.project(projectId);
    if (!Array.isArray(agentIds) || !agentIds.length) throw new Error('Choose at least one helper branch to integrate.');
    if (target !== undefined && (typeof target !== 'string' || !target.trim())) throw new Error('Name the target branch, or leave it out to use the checked-out branch.');
    const sources = [...new Set(agentIds)].map((id) => {
      const s = store.getAgent(id);
      if (!s || s.projectId !== projectId) throw new Error('Unknown agent');
      if (s.integration || s.rollback || !s.branch) throw new Error(`"${s.title}" has no helper branch to integrate.`);
      return s;
    });
    const deps = new Set<Id>();
    // Only reviews still in progress are waited for; finished ones (and old failed ones) are judged by the gate at run time.
    for (const s of sources) { deps.add(s.id); for (const r of this.reviewersOf(projectId, s)) if (!TERMINAL.includes(r.state)) deps.add(r.id); }
    const title = `Integrate ${sources.length === 1 ? `"${clip(sources[0]!.title, 40)}"` : `${sources.length} branches`}`;
    // No target named: pinned now to the branch checked out now. Running it later refuses if the folder moved to another branch.
    const checkedOut = target ? undefined : await this.d.git.currentBranch(project.path).catch(() => undefined);
    const rec: AgentRecord = {
      id: newId(), projectId, parentId: store.mainAgent(projectId)?.id, role: 'other', title, state: 'queued', cli: 'harbor', model: 'git', effort: 'low',
      task: `Merge the approved branches of ${sources.map((s) => `"${s.title}" (${s.branch})`).join(', ')} into a new integration branch${target ? ` for ${target.trim()}` : checkedOut ? ` for ${checkedOut}` : ''}.`,
      dependsOn: [...deps], revision: 1, attempts: 0, created: Date.now(), updated: Date.now(), byUser: true,
      parentConversationId: sources.find((s) => s.parentConversationId)?.parentConversationId ?? this.ensureProject(project).conversation.id,
      integration: { target: target?.trim() ?? checkedOut, sources: sources.map((s) => ({ agentId: s.id, state: 'pending' })) },
      ...(checkedOut ? { pinnedCheckedOut: checkedOut } : {})
    };
    store.upsertAgent(rec);
    store.addConversation({ id: newId(), projectId, title: `integrator: ${title}`, updated: Date.now(), agentId: rec.id });
    this.publish(rec);
    this.post(rec.parentConversationId, 'system', `You started "${title}". Harbor merges the approved branches itself once they and their reviews are finished.`, { agentId: rec.id });
    this.pump(projectId);
    return rec;
  }

  /** Why a source may not be merged, or its head to pin. Reads only. */
  private async gateSource(repo: string, src: AgentRecord | undefined): Promise<{ head: string } | string> {
    if (!src) return 'a source helper is no longer available';
    const name = `"${src.title}"`;
    if (src.integration) return `${name} is an integration, not a helper branch`;
    if (!src.branch?.startsWith('harbor/')) return `${name} has no harbor/* branch`;
    const head = await this.d.git.branchHead(repo, src.branch);
    if (!head) return `${name}: branch ${src.branch} does not exist`;
    const reviewers = this.reviewersOf(src.projectId, src);
    // A verdict counts only for the exact head it examined; anything older is outdated.
    const current = reviewers.filter((r) => r.state === 'done' && r.testedCommit === head && r.outdated !== true);
    if (current.some((r) => r.result?.verdict === 'changes')) return `${name}: a reviewer asked for changes on ${head.slice(0, 7)}`;
    if (current.some((r) => r.result?.verdict === 'approve')) return { head };
    if (reviewers.some((r) => r.result?.verdict === 'approve')) return `${name}: its approval is outdated (${src.branch} moved to ${head.slice(0, 7)} since the review)`;
    return `${name} has no approving review of ${head.slice(0, 7)}`;
  }

  /** Sources in dependency order (a source another one builds on goes first), otherwise creation order. */
  private integrationOrder<T extends { agent: AgentRecord }>(items: T[]): T[] {
    const { store } = this.d;
    const reaches = (from: AgentRecord, to: Id, seen = new Set<Id>()): boolean => from.dependsOn.some((d) => {
      if (d === to) return true;
      if (seen.has(d)) return false;
      seen.add(d);
      const n = store.getAgent(d);
      return !!n && reaches(n, to, seen);
    });
    const left = [...items].sort((x, y) => x.agent.created - y.agent.created);
    const out: T[] = [];
    while (left.length) {
      const i = Math.max(0, left.findIndex((x) => !left.some((y) => y !== x && reaches(x.agent, y.agent.id))));
      out.push(left.splice(i, 1)[0]!);
    }
    return out;
  }

  /**
   * Merge approved helper branches into a harbor/integrate-* worktree, deterministically. Every source is gated before any
   * git write; sources are merged by pinned SHA; a conflict is recorded, aborted and ends the run. Re-running is idempotent:
   * sources already contained in the integration head are skipped. The user's branch is never touched here (see applyIntegration).
   */
  private async runIntegration(a: AgentRecord): Promise<void> {
    const { store, git } = this.d;
    const project = this.project(a.projectId);
    const integ = a.integration!;
    const signal = this.controllers.get(a.id)?.signal;
    const conv = this.convFor(a);
    this.setState(a, 'working', { error: undefined });
    this.post(conv, 'system', `Assignment (integrator, rev ${a.revision}): ${a.title}\n\n${a.task}`, { agentId: a.id });

    const end = (state: AgentState, report: string, error?: string, summary?: string): void => {
      this.running.delete(a.id);
      this.controllers.delete(a.id);
      this.followups.delete(a.id);
      this.locks.release(a.id);
      if (state === 'failed') this.log({ kind: 'helper-failed', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: `integrator "${a.title}": ${error}` });
      this.post(conv, 'assistant', report, { agentId: a.id });
      this.setState(a, state, { report, summary, error, stopKind: state === 'stopped' ? 'user' : undefined });
      this.finished(a);
    };
    const refuse = (why: string) => end('failed', `Integration refused. Nothing was merged.\n${why}`, `Refused: ${why}`);

    if (!(await git.isRepoWithCommits(project.path))) return refuse('the project folder is not a git repository with commits.');
    // 1. Target (as the ref is really spelled: on Windows "Main" reaches "main") and base. A re-run keeps the base its
    // integration branch was built on while the target is still there; once the target moved it starts fresh from the new head.
    if (a.pinnedCheckedOut && !git.sameBranch(await git.currentBranch(project.path), a.pinnedCheckedOut)) {
      return refuse(`this integration was queued for ${a.pinnedCheckedOut}, the branch checked out when it was requested, but the project folder is now on ${(await git.currentBranch(project.path)) ?? 'a detached HEAD'}. Switch back to ${a.pinnedCheckedOut}, or queue it again with an explicit target.`);
    }
    const named = integ.target ?? await git.currentBranch(project.path);
    if (!named) return refuse('the project folder has a detached HEAD; name a target branch.');
    const target = await git.resolveBranch(project.path, named);
    if (!target) return refuse(`"${named}" is not an existing local branch.`);
    const targetHead = await git.branchHead(project.path, target);
    if (!targetHead) return refuse(`"${target}" is not an existing local branch.`);
    const rebase = !!a.worktree && !!integ.base && integ.base !== targetHead;
    const base = a.worktree && integ.base && !rebase ? integ.base : targetHead;
    // 2. Gate every source before any git write.
    const items = integ.sources.map((s) => ({ s, agent: store.getAgent(s.agentId) }));
    const gates = await Promise.all(items.map((x) => this.gateSource(project.path, x.agent)));
    const refusals = gates.filter((g): g is string => typeof g === 'string');
    if (!items.length) refusals.push('there are no source branches.');
    if (refusals.length) return refuse(refusals.join('; '));
    if (signal?.aborted) return end('stopped', 'Stopped before merging.', 'Stopped by the user.');
    integ.target = target;
    integ.base = base;
    integ.conflicts = undefined;
    integ.applied = undefined;
    // A merge recorded by an earlier run stays valid while the pinned commit is the same and the merge is still on this branch.
    const earlier = new Map(items.map((x) => [x.s, { commit: x.s.commit, merge: x.s.merge }]));
    items.forEach((x, i) => Object.assign(x.s, { branch: x.agent!.branch, commit: (gates[i] as { head: string }).head, state: 'pending', merge: undefined }));
    this.setState(a, 'working');

    // 3. The integration worktree, on harbor/integrate-<target>-<id6>, from base.
    if (!a.worktree) {
      try {
        const wt = await git.createWorktree(project.path, this.d.worktreesRoot, project.id.slice(0, 8), `integrate ${target}`, a.id, base);
        Object.assign(a, { worktree: wt.path, branch: wt.branch, baseCommit: base });
        integ.branch = wt.branch;
        this.setState(a, 'working');
      } catch (e) { return end('failed', `Could not create the integration worktree: ${String((e as Error).message)}`, `Could not create a git worktree: ${String((e as Error).message)}`); }
    }
    const wt = a.worktree!;
    await git.abortMerge(wt); // a merge left half-done by a crash
    const lines: string[] = [];
    if (rebase) {
      // Only Harbor's own integration branch, in its own worktree, is reset; sources already on the new base are skipped below.
      try { await git.resetHarborWorktree(this.d.worktreesRoot, wt, a.branch!, base); }
      catch (e) { return end('failed', `Could not restart the integration on the new base: ${String((e as Error).message)}`, `Could not restart on the new base: ${String((e as Error).message)}`); }
      a.baseCommit = base;
      lines.push(`- ${target} moved since the last run: rebuilt ${a.branch} from ${base.slice(0, 10)}`);
    }

    // 4. Merge, one pinned commit at a time.
    let conflict: { title: string; paths: string[]; output: string } | undefined;
    for (const x of this.integrationOrder(items as Array<{ s: IntegrationSource; agent: AgentRecord }>)) {
      if (signal?.aborted) break;
      const label = `${x.s.branch} ("${x.agent.title}") @ ${x.s.commit!.slice(0, 10)}`;
      if (await git.isAncestor(wt, x.s.commit!, 'HEAD')) {
        const prev = earlier.get(x.s);
        if (prev?.merge && prev.commit === x.s.commit && await git.isAncestor(wt, prev.merge, 'HEAD')) x.s.merge = prev.merge;
        x.s.state = 'merged'; lines.push(`- ${label}: already included`); continue;
      }
      const r = await git.merge(wt, x.s.commit!);
      // The merge commit attributes this source's changes for a later rollback.
      if (r.ok) { x.s.state = 'merged'; x.s.merge = await git.head(wt); lines.push(`- ${label}: merged`); continue; }
      const paths = await git.unmergedPaths(wt);
      await git.abortMerge(wt);
      x.s.state = 'conflict';
      integ.conflicts = paths;
      conflict = { title: x.agent.title, paths, output: r.output };
      lines.push(`- ${label}: CONFLICT${paths.length ? ` in ${paths.join(', ')}` : ''} (merge aborted)`);
      break;
    }
    for (const x of items) if (x.s.state === 'pending') lines.push(`- ${x.s.branch} ("${x.agent!.title}"): not merged`);
    const head = await git.head(wt);
    integ.head = head;
    this.setState(a, 'working', { headCommit: head });
    if (head) this.markOutdated(a.projectId, wt, head);

    let report = `Integration of ${items.length} branch${items.length === 1 ? '' : 'es'} for ${target} (base ${base.slice(0, 10)}) on ${a.branch}:\n${lines.join('\n')}\n\nIntegration head: ${head?.slice(0, 10) ?? 'unknown'}`;
    if (head) report += this.harborDirWarning(a, await git.changedFiles(wt, base));
    if (signal?.aborted) return end('stopped', `${report}\n\nStopped by the user.`, 'Stopped by the user.');
    if (conflict) {
      const why = conflict.paths.length ? `"${conflict.title}" conflicts in ${conflict.paths.join(', ')}` : `"${conflict.title}" could not be merged: ${clip(conflict.output, 300)}`;
      report += `\n\nThe merge was aborted; branches merged before it stay on ${a.branch}. Resolve the conflict on the source branch (or in a new helper), have it reviewed again, then run the integration again.`;
      return end('failed', report, `Merge conflict: ${why}`);
    }

    // 5. Secret scan of everything this brings onto the target: a hit blocks it unless the user says yes to exactly these findings.
    a.secretScan = undefined;
    if (head && head !== base) {
      const secrets = await this.secretGate(a, wt, base, head, signal);
      if (signal?.aborted) return end('stopped', `${report}\n\nStopped by the user.`, 'Stopped by the user.');
      if (secrets.blocked) return end('failed', `${report}\n\n${secrets.blocked}`, `Secret scan: ${secrets.blocked}`);
      report += secrets.note;
    }

    // 6. Checks on the combined result: the sources' own checks do not cover it.
    Object.assign(a, { checks: undefined, testedCommit: undefined, testedWorktree: undefined, outdated: undefined });
    if (head) report += await this.runChecks(a, head, signal);
    if (signal?.aborted) return end('stopped', `${report}\n\nStopped by the user.`, 'Stopped by the user.');
    const failed = (a.checks ?? []).filter((c) => !c.ok);
    if (failed.length) {
      report += `\n\nNot ready to apply: checks failed on the integration head.`;
      return end('failed', report, `Checks failed on integration: ${failed.map((f) => f.cmd).join(', ')}`);
    }
    report += `\n\nReady to apply: Harbor can fast-forward ${target} to ${head?.slice(0, 10)} (only while ${target} is still at ${base.slice(0, 10)} and the project folder is clean). Nothing was pushed.`;
    return end('done', report, undefined, `Integrated ${items.length} branch${items.length === 1 ? '' : 'es'} on ${a.branch}; ready to apply to ${target}.`);
  }

  /**
   * Fast-forward the user's target branch to a finished integration's or rollback's head. Refuses when the project folder has
   * uncommitted changes, when the target moved since the base, or when the run is not done. Never pushes or forces.
   * Applying again once the target is at head changes nothing.
   */
  async applyIntegration(agentId: Id): Promise<AgentRecord> {
    const { store, git } = this.d;
    const a = store.getAgent(agentId);
    if (!a) throw new Error('Unknown agent');
    const job = a.integration ?? a.rollback;
    if (!job) throw new Error('This agent is not an integration.');
    const kind = a.integration ? 'integration' : 'rollback';
    if (this.running.has(a.id)) throw new Error(`This ${kind} is still running.`);
    const { base, head } = job;
    const complete = a.integration ? a.integration.sources.every((s) => s.state === 'merged') : !!a.rollback?.merges.length && a.rollback.merges.every((m) => m.state === 'reverted');
    if (a.state !== 'done' || !job.target || !base || !head || !a.branch || !complete) {
      throw new Error(a.integration
        ? 'Only a finished integration with every branch merged and its checks passing can be applied.'
        : 'Only a finished rollback with every merge reverted and its checks passing can be applied.');
    }
    const project = this.project(a.projectId);
    // The ref's real spelling: on Windows a target stored as "Main" would otherwise move the checked-out "main" behind its index.
    const target = await git.resolveBranch(project.path, job.target);
    const current = target && await git.branchHead(project.path, target);
    if (!target || !current) throw new Error(`The target branch ${job.target} no longer exists.`);
    if (job.applied && current === head) return a;
    if (current !== head) {
      if ((await git.branchHead(project.path, a.branch)) !== head) throw new Error(`${a.branch} moved since its checks ran. Run the ${kind} again.`);
      if (current !== base) {
        throw new Error(`${target} moved since the ${kind} started (was ${base.slice(0, 10)}, now ${current.slice(0, 10)}). ${a.integration
          ? 'Run the integration again: it rebuilds on the new head of the target.'
          : 'Start a new rollback of the task: this one was built on the old head.'}`);
      }
      const dirty = await git.isDirtyDetailed(project.path);
      if (dirty.timedOut) throw new Error('git timed out while checking the project folder for uncommitted changes, so nothing was changed. Try again.');
      if (dirty.failed) throw new Error('git could not read the status of the project folder, so nothing was changed.');
      if (dirty.dirty) throw new Error('The project folder has uncommitted changes. Commit or stash them first; Harbor does not overwrite your work.');
      if (a.integration) await this.secretsCleared(a, project.path, base, head);
      if (!git.sameBranch(await git.currentBranch(project.path), target)) {
        const elsewhere = await git.worktreeOf(project.path, target);
        if (elsewhere) throw new Error(`${target} is checked out in ${elsewhere}. Apply from there or switch the project folder to ${target}.`);
      }
      // The awaits above leave room for a re-run to start: check again right before the write. The compare-and-swap
      // (update-ref with the expected old value, or the HEAD check before an ff-only merge) is the final authority.
      await git.fastForward(project.path, target, base, head, () => {
        if (this.running.has(a.id) || a.state !== 'done' || job.head !== head || job.base !== base) throw new Error(`This ${kind} started running again; nothing was changed.`);
      });
    }
    job.applied = true;
    store.upsertAgent(a);
    this.publish(a);
    const task = a.rollback && store.getAgent(a.rollback.taskId);
    const msg = `${target} fast-forwarded to ${head.slice(0, 10)} ("${a.title}")${task ? `: the merges of "${task.title}" are reverted` : ''}. Nothing was pushed.`;
    this.post(this.convFor(a), 'system', msg, { agentId: a.id });
    if (a.parentConversationId && a.parentConversationId !== this.convFor(a)) this.post(a.parentConversationId, 'system', msg, { agentId: a.id });
    if (a.rollback) this.rollbackApplied(a, task);
    await this.collectWorktrees().catch(() => 0); // landed work no longer needs its worktree folders (the branches stay)
    return a;
  }

  // ------------------------------------------------------------ rollback (Harbor's own git code, no CLI)

  /** The user asks Harbor to reverse a task's merges on `target`. Queued like a helper; nothing touches git until it runs. */
  rollbackTask(agentId: Id, target?: string): AgentRecord {
    const { store } = this.d;
    const task = store.getAgent(agentId);
    if (!task) throw new Error('Unknown agent');
    const project = this.project(task.projectId);
    if (task.role === 'main') throw new Error('The lead agent has no task to roll back.');
    if (task.rollback) throw new Error('This agent is a rollback. Rolling back a rollback is not supported.');
    if (target !== undefined && (typeof target !== 'string' || !target.trim())) throw new Error('Name the target branch, or leave it out to use the checked-out branch.');
    // One rollback at a time per project: two would gate on each other's unapplied state.
    const open = store.listAgentRecords(project.id).find((x) => x.rollback && !TERMINAL.includes(x.state));
    if (open) throw new Error(`Rollback "${open.title}" is still ${open.state}. Wait for it to finish or stop it first.`);
    const title = `Roll back "${clip(task.title, 40)}"`;
    const rec: AgentRecord = {
      id: newId(), projectId: project.id, parentId: store.mainAgent(project.id)?.id, role: 'other', title, state: 'queued', cli: 'harbor', model: 'git', effort: 'low',
      task: `Revert the merges that brought "${task.title}" onto ${target?.trim() || 'the checked-out branch'}, on a new rollback branch, and run the project's checks on the result.`,
      dependsOn: [], revision: 1, attempts: 0, created: Date.now(), byUser: true,
      parentConversationId: task.parentConversationId || this.ensureProject(project).conversation.id,
      rollback: { taskId: task.id, target: target?.trim(), merges: [] }
    };
    store.upsertAgent(rec);
    store.addConversation({ id: newId(), projectId: project.id, title: `rollback: ${title}`, updated: Date.now(), agentId: rec.id });
    this.publish(rec);
    this.post(rec.parentConversationId, 'system', `You started "${title}". Harbor reverts the task's merges on a new branch; your branch changes only when you apply it.`, { agentId: rec.id });
    this.pump(project.id);
    return rec;
  }

  /**
   * Revert a task's merge commits, newest first, on a harbor/rollback-* worktree from the target's head. The preview is the
   * gate: any blocker refuses before a git write. A conflict is recorded and the revert aborted (earlier reverts stay on the
   * rollback branch). A re-run continues on the same branch and base, skipping merges already reverted. The target is never
   * touched here (see applyIntegration).
   */
  private async runRollback(a: AgentRecord): Promise<void> {
    const { store, git } = this.d;
    const project = this.project(a.projectId);
    const rb = a.rollback!;
    const signal = this.controllers.get(a.id)?.signal;
    const conv = this.convFor(a);
    this.setState(a, 'working', { error: undefined });
    this.post(conv, 'system', `Assignment (rollback, rev ${a.revision}): ${a.title}\n\n${a.task}`, { agentId: a.id });

    const end = (state: AgentState, report: string, error?: string, summary?: string): void => {
      this.running.delete(a.id);
      this.controllers.delete(a.id);
      this.followups.delete(a.id);
      this.locks.release(a.id);
      if (state === 'failed') this.log({ kind: 'helper-failed', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: `rollback "${a.title}": ${error}` });
      this.post(conv, 'assistant', report, { agentId: a.id });
      this.setState(a, state, { report, summary, error, stopKind: state === 'stopped' ? 'user' : undefined });
      this.finished(a);
    };
    const refuse = (why: string) => end('failed', `Rollback refused. Nothing was reverted.\n${why}`, `Refused: ${why}`);

    // 1. The preview gates every git write. This agent is left out so it does not count as a running rollback.
    const task = store.getAgent(rb.taskId);
    if (!task) return refuse('the task is no longer available.');
    const agents = store.listAgentRecords(a.projectId).filter((x) => x.id !== a.id);
    // The ref's real spelling: on Windows "Main" reaches "main".
    const named = rb.target && await git.resolveBranch(project.path, rb.target);
    if (rb.target && !named) return refuse(`"${rb.target}" is not an existing local branch.`);
    const preview = await previewRollback({ git, repo: project.path, agents }, task, named);
    if (preview.blockers?.length) return refuse(preview.blockers.join(' '));
    if (!preview.target || !preview.targetHead) return refuse('the target branch could not be resolved.');
    if (signal?.aborted) return end('stopped', 'Stopped before reverting.', 'Stopped by the user.');

    // 2. Pin base and merges on the first run; a re-run keeps what its rollback branch was built on.
    if (!a.worktree || !rb.base) {
      rb.target = preview.target;
      rb.base = preview.targetHead;
      rb.merges = (preview.merges ?? []).map((m) => ({ ...m, state: 'pending' as const }));
    }
    const target = rb.target!, base = rb.base;
    rb.conflicts = undefined;
    rb.applied = undefined;
    for (const m of rb.merges) if (m.state === 'conflict') m.state = 'pending';
    this.setState(a, 'working');

    // 3. The rollback worktree, on harbor/rollback-<task>-<id6>, from base.
    if (!a.worktree) {
      try {
        const wt = await git.createWorktree(project.path, this.d.worktreesRoot, project.id.slice(0, 8), `rollback ${task.title}`, a.id, base);
        Object.assign(a, { worktree: wt.path, branch: wt.branch, baseCommit: base });
        rb.branch = wt.branch;
        this.setState(a, 'working');
      } catch (e) { return end('failed', `Could not create the rollback worktree: ${String((e as Error).message)}`, `Could not create a git worktree: ${String((e as Error).message)}`); }
    }
    const wt = a.worktree!;
    await git.abortRevert(wt); // a revert left half-done by a crash

    // 4. Revert, newest merge first, each by SHA against its target-side parent.
    const lines: string[] = [];
    let conflict: { commit: string; paths: string[]; output: string } | undefined;
    for (const m of rb.merges) {
      if (signal?.aborted) break;
      const label = `merge ${m.commit.slice(0, 10)}`;
      if (m.state === 'reverted' && m.revert && await git.isAncestor(wt, m.revert, 'HEAD')) { lines.push(`- ${label}: already reverted as ${m.revert.slice(0, 10)}`); continue; }
      const r = await git.revertMerge(wt, m.commit);
      if (r.ok) { m.state = 'reverted'; m.revert = await git.head(wt); lines.push(`- ${label}: reverted as ${m.revert?.slice(0, 10) ?? 'unknown'}`); continue; }
      const paths = await git.unmergedPaths(wt);
      await git.abortRevert(wt);
      Object.assign(m, { state: 'conflict', revert: undefined });
      rb.conflicts = paths;
      conflict = { commit: m.commit, paths, output: r.output };
      lines.push(`- ${label}: CONFLICT${paths.length ? ` in ${paths.join(', ')}` : ''} (revert aborted)`);
      break;
    }
    for (const m of rb.merges) if (m.state === 'pending') lines.push(`- merge ${m.commit.slice(0, 10)}: not reverted`);
    const head = await git.head(wt);
    rb.head = head;
    this.setState(a, 'working', { headCommit: head });
    if (head) this.markOutdated(a.projectId, wt, head);

    let report = `Rollback of "${task.title}" on ${target} (base ${base.slice(0, 10)}) on ${a.branch}:\n${lines.join('\n')}\n\nRollback head: ${head?.slice(0, 10) ?? 'unknown'}`;
    if (signal?.aborted) return end('stopped', `${report}\n\nStopped by the user.`, 'Stopped by the user.');
    if (conflict) {
      const why = conflict.paths.length ? `reverting ${conflict.commit.slice(0, 10)} conflicts in ${conflict.paths.join(', ')}` : `reverting ${conflict.commit.slice(0, 10)} failed: ${clip(conflict.output, 300)}`;
      report += `\n\nThe revert was aborted; reverts made before it stay on ${a.branch}. ${target} was not touched. Later work on these files has to be undone or adjusted by hand (or by a new helper).`;
      return end('failed', report, `Rollback conflict: ${why}`);
    }

    // 5. Checks on the result: the code without the task must still pass.
    Object.assign(a, { checks: undefined, testedCommit: undefined, testedWorktree: undefined, outdated: undefined });
    if (head) report += await this.runChecks(a, head, signal);
    if (signal?.aborted) return end('stopped', `${report}\n\nStopped by the user.`, 'Stopped by the user.');
    const failed = (a.checks ?? []).filter((c) => !c.ok);
    if (failed.length) {
      report += `\n\nNot ready to apply: checks failed on the rollback head.`;
      return end('failed', report, `Checks failed on rollback: ${failed.map((f) => f.cmd).join(', ')}`);
    }
    report += `\n\nReady to apply: Harbor can fast-forward ${target} to ${head?.slice(0, 10)} (only while ${target} is still at ${base.slice(0, 10)} and the project folder is clean). Nothing was pushed. ${EXTERNAL_EFFECTS_NOTE}`;
    const n = rb.merges.length;
    return end('done', report, undefined, `Reverted ${n} merge${n === 1 ? '' : 's'} of "${task.title}" on ${a.branch}; ready to apply to ${target}.`);
  }

  /**
   * After a rollback reached the target: verification of the reverted task, the helpers it merged, its dependents and their
   * reviewers no longer describes the code, so it is marked outdated (an approval then no longer lets it be integrated).
   */
  private rollbackApplied(a: AgentRecord, task: AgentRecord | undefined): void {
    const { store } = this.d;
    const rb = a.rollback!;
    const all = store.listAgentRecords(a.projectId);
    const ids = new Set<Id>([rb.taskId]);
    for (const m of rb.merges) { if (m.agentId) ids.add(m.agentId); if (m.integrationId) ids.add(m.integrationId); }
    if (task) for (const d of relatedAgents(task, all)) ids.add(d.agentId);
    for (const id of [...ids]) { const x = store.getAgent(id); if (x) for (const r of this.reviewersOf(a.projectId, x)) ids.add(r.id); }
    let marked = 0;
    for (const id of ids) {
      const x = store.getAgent(id);
      if (!x || x.id === a.id || x.role === 'main' || !x.testedCommit || x.outdated === true) continue;
      x.outdated = true;
      store.upsertAgent(x);
      this.publish(x);
      marked++;
    }
    this.log({ kind: 'rollback', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id,
      text: `Rolled back "${task?.title ?? rb.taskId}" on ${rb.target}: reverted ${rb.merges.map((m) => m.commit.slice(0, 10)).join(', ')}; ${rb.target} fast-forwarded to ${rb.head?.slice(0, 10)}. Verification of ${marked} agent${marked === 1 ? '' : 's'} marked outdated.` });
  }

  // ------------------------------------------------------------ direct prompts and follow-ups

  private direct(a: AgentRecord, text: string, conversationId: Id): void {
    this.d.store.addCoordination({ projectId: a.projectId, kind: 'direct', to: a.id, text });
    this.addNote(a.parentConversationId, `User sent "${a.title}" directly: ${text}`);
    this.post(a.parentConversationId, 'system', `You messaged "${a.title}" directly: ${clip(text, 160)}`, { agentId: a.id });
    a.revision += 1;
    this.d.store.upsertAgent(a);
    if (this.running.has(a.id)) {
      const q = this.followups.get(a.id) ?? [];
      q.push(text);
      this.followups.set(a.id, q);
      this.post(conversationId, 'system', 'Delivered after the current step finishes.', { agentId: a.id });
    } else this.followUp(a, text);
  }

  /** Continue a helper's own session with a new message. */
  private followUp(a: AgentRecord, text: string, shots?: string[]): void {
    if (this.running.has(a.id)) { const q = this.followups.get(a.id) ?? []; q.push(shots?.length ? `${text}\n(Screenshot file: ${shots.join(', ')})` : text); this.followups.set(a.id, q); return; }
    this.askTokens.delete(a.id); // whatever it waited for is answered now: no safe default later
    this.begin(a.id);
    // An integrator has no CLI session: any message (or resume) runs the integration again, which is idempotent.
    if (a.integration) { void this.runIntegration(a).catch((e) => this.failAgent(a, `Internal error: ${String(e?.message ?? e)}`)); return; }
    if (a.rollback) { void this.runRollback(a).catch((e) => this.failAgent(a, `Internal error: ${String(e?.message ?? e)}`)); return; }
    void (async () => {
      const project = this.project(a.projectId);
      let cwd = a.worktree && existsSync(a.worktree) ? await this.cwdIn(project, a.worktree) : project.path;
      if (this.canEdit(a) && a.branch && (!a.worktree || !existsSync(a.worktree)) && await this.probeRepo(project)) {
        // The worktree folder was cleaned up (or lost): attach the branch again. Never fall back to the user's own folder.
        const wt = await this.worktreeFor(a, project).catch(() => undefined);
        if (!wt) { this.running.delete(a.id); this.controllers.delete(a.id); this.post(this.convFor(a), 'system', `Could not restore the worktree of ${a.branch}; nothing was run.`, { agentId: a.id }); return; }
        this.setState(a, 'working', { worktree: wt.path, branch: wt.branch });
        this.d.store.flush();
        cwd = await this.cwdIn(project, wt.path);
      }
      if (a.role === 'reviewer' && a.testedWorktree && existsSync(a.testedWorktree)) {
        // A reviewer's follow-up looks at the reviewed branch again, so its next verdict covers the head it sees now.
        const tested = await this.d.git.head(a.testedWorktree).catch(() => undefined);
        if (tested) { cwd = await this.cwdIn(project, a.testedWorktree); Object.assign(a, { testedCommit: tested, outdated: false }); }
      }
      // Same rule as claim(): only a writer in the shared checkout (no worktree) owns files.
      if (needsLock({ worktree: a.worktree, canEdit: this.canEdit(a) })) {
        const r = this.locks.acquire(a.projectId, a.id, a.files?.length ? a.files : [WHOLE_PROJECT]);
        if (!r.ok) { this.running.delete(a.id); this.controllers.delete(a.id); this.post(this.convFor(a), 'system', 'Another agent owns the files this agent needs; try again when it finishes.', { agentId: a.id }); return; }
      }
      this.setState(a, 'working', { error: undefined, stopKind: undefined });
      const res = await this.execute(a, text, { cwd, resume: true, ...(shots?.length ? { shots } : {}) });
      // Held for quota: the follow-up is delivered later as text, so a screenshot is named by its file path there.
      if (this.holdRun(a, res, shots?.length ? `${text}\n(Screenshot file: ${shots.join(', ')})` : text)) return;
      await this.afterRun(a, res);
    })().catch((e) => this.failAgent(a, `Internal error: ${String(e?.message ?? e)}`));
  }

  // ------------------------------------------------------------ questions to the user

  /** Pop a question up on the user's screen. The asker has already ended its turn; the answer is its next message. */
  private askUser(agentId: Id, conversationId: Id, ask: AskRequest): void {
    for (const [id, q] of this.questions) if (q.agentId === agentId && q.conversationId === conversationId) this.questions.delete(id); // a newer question replaces the old one
    const requestId = newId();
    this.questions.set(requestId, { agentId, conversationId });
    this.sessionState(conversationId, 'waiting', ask.question);
    this.emit({ type: 'question', requestId, conversationId, agentId, prompt: ask.question, options: ask.options.length ? ask.options : undefined, allowText: ask.allowText,
      ...(ask.multi ? { multiSelect: true } : {}),
      ...(ask.more?.length ? { questions: ask.more.map((m) => ({ prompt: m.question, options: m.options.length ? m.options : undefined, allowText: m.allowText, ...(m.multi ? { multiSelect: true } : {}) })) } : {}) });
  }

  /**
   * A helper's question that only the user can answer (askRouting.ts): shown to them, with a safe default ("no") applied after
   * `questionTimeoutMs` so the helper never waits forever. The question event also raises Harbor's desktop notification.
   */
  private askUserForHelper(a: AgentRecord, ask: AskRequest, kind: UserAskKind): void {
    const conv = this.convFor(a);
    const ms = this.d.questionTimeoutMs ?? USER_QUESTION_TIMEOUT_MS;
    const minutes = Math.max(1, Math.round(ms / 60_000));
    this.post(a.parentConversationId, 'system', `"${a.title}" is waiting for your answer: ${clip(ask.question, 160)} (without an answer within ${minutes} minutes Harbor answers with the safe default: no).`, { agentId: a.id });
    this.log({ kind: 'question', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: `"${a.title}" asked the user (${kind}): ${clip(ask.question, 200)}` });
    this.askUser(a.id, conv, ask);
    this.armAskDefault(a, kind);
  }

  /**
   * The safe-default timer of a waiting helper's question. Also armed when the question went to the lead: if the lead's help turn is
   * dropped (the user steered, the session stopped) or fails without answering, the helper still never waits forever.
   * A lead answer reaches followUp, which clears the token.
   */
  private armAskDefault(a: AgentRecord, kind: UserAskKind): void {
    const ms = this.d.questionTimeoutMs ?? USER_QUESTION_TIMEOUT_MS;
    const minutes = Math.max(1, Math.round(ms / 60_000));
    const token = (this.askTokens.get(a.id) ?? 0) + 1;
    this.askTokens.set(a.id, token);
    (this.d.setTimer ?? defaultTimer)(() => {
      if (this.askTokens.get(a.id) !== token || this.shuttingDown) return;
      this.askTokens.delete(a.id);
      const cur = this.d.store.getAgent(a.id);
      if (!cur || cur.state !== 'waiting' || this.running.has(cur.id)) return;
      for (const [id, q] of this.questions) if (q.agentId === cur.id) this.questions.delete(id);
      this.log({ kind: 'question', projectId: cur.projectId, conversationId: cur.parentConversationId, agentId: cur.id, text: `"${cur.title}": no answer within ${minutes} minutes; safe default applied (${kind})` });
      this.post(cur.parentConversationId, 'system', `No answer within ${minutes} minutes to "${cur.title}": Harbor answered with the safe default (no; stay within the assignment).`, { agentId: cur.id });
      this.followUp(cur, safeDefault(kind, minutes));
    }, ms);
  }

  async answerQuestion(requestId: Id, answer: string): Promise<void> {
    const q = this.questions.get(requestId);
    if (!q) throw new Error('This question is no longer pending. Answer in the chat instead.');
    if (!answer.trim()) throw new Error('Choose an option or type an answer.');
    this.questions.delete(requestId);
    await this.userMessage(q.conversationId, answer.trim());
  }

  // ------------------------------------------------------------ screenshots and images (plan section 4)

  /** Whether a CLI can be handed image files (`features.images`); a CLI Harbor knows nothing about cannot. */
  private seesImages(cli: CliId): boolean {
    const r = this.d.getClis().find((c) => c.id === cli);
    return (r?.features ?? CLI_DEFINITIONS.find((x) => x.id === cli)?.features)?.images === true;
  }

  /** HARBOR_SHOW_IMAGE: images the agent wants the user to see, checked (inside `roots`, a real image) and copied into the conversation. */
  private showImages(a: AgentRecord, conversationId: Id, paths: string[], cwd: string, roots: string[]): void {
    const who = a.role === 'main' ? 'the lead' : `"${a.title}"`;
    for (const raw of paths) {
      const r = resolveShownImage(raw, cwd, roots, (p) => readFileSync(p));
      if ('error' in r || !this.d.attachImage) {
        const why = 'error' in r ? r.error : 'images cannot be shown here';
        this.post(conversationId, 'system', `Harbor did not show an image from ${who}: ${why} (${clip(raw, 120)}).`, { agentId: a.id });
        // The journal gets the reason only: the path is the agent's text and may name anything on the machine.
        this.log({ kind: 'protocol', projectId: a.projectId, conversationId: a.role === 'main' ? conversationId : a.parentConversationId, agentId: a.id, text: `${a.role === 'main' ? 'lead' : `${a.role} "${a.title}"`}: image not shown: ${why}` });
        continue;
      }
      try {
        const att = this.d.attachImage(conversationId, r);
        this.post(conversationId, 'assistant', `Image from ${who}: ${att.name}`, { agentId: a.id, attachments: [att] });
      } catch (e) {
        this.post(conversationId, 'system', `Harbor could not copy an image from ${who}: ${String((e as Error).message ?? e)}`, { agentId: a.id });
      }
    }
  }

  /**
   * HARBOR_OPEN_DOCUMENT: files the agent wants the user to read in Harbor's viewer. Only the path checks run here (inside the
   * project or the agent's worktree, no link leaving them, no credential file); the renderer then calls openDocument, which checks
   * again and reads the file. Nothing is copied. The chat gets the path either way, so the user can reopen it with a click.
   */
  private openDocuments(a: AgentRecord, conversationId: Id, docs: Array<{ path: string; title?: string }>, cwd: string, roots: DocumentRoot[]): void {
    const who = a.role === 'main' ? 'the lead' : `"${a.title}"`;
    for (const d of docs) {
      const r = resolveDocumentPath(d.path, cwd, roots);
      if (!r.ok) {
        this.post(conversationId, 'system', `Harbor did not open a document from ${who}: ${r.message} (${clip(d.path, 120)})`, { agentId: a.id });
        // The journal gets the reason only: the path is the agent's text and may name anything on the machine.
        this.log({ kind: 'protocol', projectId: a.projectId, conversationId: a.role === 'main' ? conversationId : a.parentConversationId, agentId: a.id, text: `${a.role === 'main' ? 'lead' : `${a.role} "${a.title}"`}: document not opened: ${r.reason}` });
        continue;
      }
      const shown = '`' + r.relPath.replace(/`/g, '') + '`';
      this.post(conversationId, 'system', `Opened ${d.title ? `${d.title} (${shown})` : shown} from ${who} in the document viewer.`, { agentId: a.id });
      this.emit({ type: 'document', projectId: a.projectId, conversationId, path: r.path, ...(d.title ? { title: d.title } : {}), ...(r.root.agentId ? { agentId: r.root.agentId } : {}) });
    }
  }

  /**
   * An agent's HARBOR_SCREENSHOT line: the user is asked in a card with a live preview (screenshots.ts), and the answer (the image,
   * or why there is none) resumes the agent. `conversationId` is where it shows; `sessionId` is the lead conversation it belongs to.
   */
  private requestScreenshot(a: AgentRecord, conversationId: Id, sessionId: Id, line: ScreenshotLine): void {
    const who = a.role === 'main' ? 'The lead agent' : `"${a.title}"`;
    const target = line.target === 'screen' ? 'a screen' : line.title ? `the window "${clip(line.title, 80)}"` : 'a window';
    this.post(conversationId, 'system', `${who} asks for a screenshot of ${target}: ${line.why}`, { agentId: a.id });
    if (a.role !== 'main' && conversationId !== sessionId) this.post(sessionId, 'system', `"${a.title}" asks for a screenshot of ${target}.`, { agentId: a.id });
    const broker = this.d.screenshots;
    if (!broker?.available) { this.shotAnswered(a.id, conversationId, { kind: 'denied', why: 'unavailable', detail: 'screen capture is not available in this Harbor (it needs the desktop app)' }); return; }
    // Like a question: the session shows that it waits for the user (the lead's turn ends now; the answer starts the next one).
    if (a.role === 'main') this.sessionState(conversationId, 'waiting', 'Waiting for your answer to a screenshot request.');
    const project = this.d.store.getProject(a.projectId);
    void broker.request({ agentId: a.id, agentRole: a.role, agentTitle: a.title, projectId: a.projectId, projectName: project?.name ?? '', conversationId, sessionId, line })
      .then((o) => this.shotAnswered(a.id, conversationId, o))
      .catch((e) => this.shotAnswered(a.id, conversationId, { kind: 'denied', why: 'failed', detail: String((e as Error)?.message ?? e) }));
  }

  /** The answer to a screenshot request: shown in the chat (with the image), journaled by the broker, and handed to the agent. */
  private shotAnswered(agentId: Id, conversationId: Id, o: ShotOutcome): void {
    const a = this.d.store.getAgent(agentId);
    if (!a) return;
    const who = a.role === 'main' ? 'the lead' : `"${a.title}"`;
    const session = a.role === 'main' ? conversationId : a.parentConversationId;
    if (o.kind === 'captured') {
      const what = `${o.source.kind} "${clip(o.source.name, 80)}"`;
      this.post(conversationId, 'system', `Screenshot of the ${what} captured for ${who}${o.how === 'conversation' ? ' (you allowed this window for this conversation)' : ''}. It goes to the agent with its next turn.`, { agentId: a.id, attachments: [o.attachment] });
      if (a.role !== 'main' && conversationId !== session) this.post(session, 'system', `Screenshot captured for "${a.title}" (shown in its conversation).`, { agentId: a.id });
    } else if (o.why !== 'cancelled') {
      const minutes = Math.max(1, Math.round((this.d.screenshots?.timeoutMs ?? 0) / 60_000));
      this.post(conversationId, 'system', o.why === 'user' ? `You declined the screenshot request from ${who}. Nothing was captured.`
        : o.why === 'timeout' ? `No answer to the screenshot request from ${who} within ${minutes} minute${minutes === 1 ? '' : 's'}: declined, nothing was captured.`
          : `No screenshot for ${who}: ${o.detail}.`, { agentId: a.id });
    }
    // Stopped (the agent, its conversation, or Harbor): nothing is resumed.
    if (o.kind === 'denied' && o.why === 'cancelled') return;
    if (this.shuttingDown || this.stoppedSessions.has(session)) return;
    const idleLead = () => { if (a.role === 'main' && !this.leads.has(conversationId) && this.d.store.getConversation(conversationId)?.activity?.state === 'waiting') this.sessionState(conversationId, 'done', 'The lead has finished its turn.'); };
    const text = screenshotAnswerText(o);
    const shots = o.kind === 'captured' && o.attachment.path ? [o.attachment.path] : undefined;
    // A lead whose request could not even be asked learns it on its next turn; waking it would only spend quota.
    if (a.role === 'main' && o.kind === 'denied' && o.why === 'unavailable') { this.addNote(conversationId, text); idleLead(); return; }
    if (a.role === 'main') {
      if (!this.autoTurn(conversationId)) { this.addNote(conversationId, `${text}${shots ? ` File: ${shots[0]}` : ''}`); idleLead(); return; }
      this.enqueueMain(a.projectId, { kind: 'screenshot', text, ...(shots ? { shots } : {}) }, conversationId);
      return;
    }
    if (a.state !== 'waiting') return;
    this.followUp(a, `Screenshot request: ${text}`, shots);
  }

  // ------------------------------------------------------------ tool permissions

  /**
   * A running CLI asks whether it may run a tool call outside its allowlist. A project rule answers at once; otherwise the
   * user is asked through a `permission` event. Only this run waits: other agents and the queue go on, and an unanswered
   * request is denied after the timeout (or when the run stops), with a message the agent sees.
   */
  private askTool(agent: AgentRecord, conversationId: Id, run: number, req: ToolPermissionRequest, signal: AbortSignal, opts: { noRules?: boolean; prompt?: string } = {}): Promise<ToolPermissionDecision> {
    const projectId = agent.projectId;
    const tool = req.tool || 'unknown tool';
    // The journal gets the tool name only: inputs can hold paths, commands or secrets.
    const journal = (text: string) => this.log({ kind: 'permission', projectId, conversationId, agentId: agent.id, text: `${tool}: ${text}` });
    if (!opts.noRules && this.d.store.listToolRules(projectId).some((r) => matchesToolRule(r, req.tool, req.input))) {
      journal('allowed by a project rule');
      return Promise.resolve({ allow: true });
    }
    // Auto mode switched on while this run was already going: its later asks are answered without the user (edit-capable agents only;
    // sensitive asks, which skip rules, still go to the user).
    if (!opts.noRules && this.autoApplies(agent, conversationId)) {
      journal('allowed: auto mode is on');
      return Promise.resolve({ allow: true });
    }
    if (signal.aborted) {
      journal('denied: the run had already stopped');
      return Promise.resolve({ allow: false, message: 'Harbor denied this tool call because the run was stopping.' });
    }
    const requestId = newId();
    const rule = opts.noRules ? undefined : toolRuleFor(req.tool, req.input);
    const timeoutMs = this.d.toolPermissionTimeoutMs ?? TOOL_PERMISSION_TIMEOUT_MS;
    const n = timeoutMs >= 60_000 ? Math.round(timeoutMs / 60_000) : Math.max(1, Math.round(timeoutMs / 1000));
    const minutes = `${n} ${timeoutMs >= 60_000 ? 'minute' : 'second'}${n === 1 ? '' : 's'}`;
    const who = agent.role === 'main' ? 'The lead agent' : `"${agent.title}"`;
    const what = toolSummary(req);
    const prompt = opts.prompt ?? `${who} asks to run ${tool}${what ? `: ${what}` : ''}`;
    return new Promise<ToolPermissionDecision>((resolve) => {
      let cancelTimer = (): void => {};
      const deadline = Date.now() + timeoutMs;
      const onAbort = (): void => { this.finishToolAsk(requestId, { allow: false, message: 'Harbor cancelled this permission request because the run stopped.' }, 'cancelled: the run stopped'); };
      const timedOut = (): void => {
        this.finishToolAsk(requestId,
          { allow: false, message: `Denied: the user did not answer this permission request within ${minutes}. Continue without this tool call; if you cannot, say what you need in your report.` },
          'denied: no answer in time', `No answer within ${minutes}: denied ${tool}. The agent was told to continue without it.`);
      };
      const arm = (ms: number): void => { cancelTimer(); cancelTimer = (this.d.setTimer ?? defaultTimer)(timedOut, ms); };
      const event: PendingPermission = { type: 'permission', requestId, kind: 'tool', prompt, agentId: agent.id, conversationId, tool, alwaysAllow: !!rule, expiresAt: deadline };
      this.toolAsks.set(requestId, {
        agentId: agent.id, projectId, conversationId, run, tool, rule, noRules: opts.noRules, event, deadline,
        settle: (d) => { cancelTimer(); signal.removeEventListener('abort', onAbort); resolve(d); },
        // After the machine slept the timer may have stalled: the wall-clock deadline decides what is left.
        rearm: () => { const left = deadline - Date.now(); if (left <= 0) timedOut(); else arm(left); }
      });
      signal.addEventListener('abort', onAbort, { once: true });
      arm(timeoutMs);
      const choices = rule ? 'allow once, always allow for this project, or deny' : 'allow once or deny (this call cannot be always-allowed)';
      this.post(conversationId, 'system', `${prompt}\nWaiting for your answer (${choices}). Denied automatically after ${minutes}.`, { agentId: agent.id });
      journal('asked the user');
      this.emit(event);
    });
  }

  private autoApplies(agent: AgentRecord, conversationId: Id): boolean {
    return this.d.store.getConversation(conversationId)?.mode === 'auto' && (agent.role === 'main' || this.canEdit(agent));
  }

  /** The user's answer to a tool permission request; false when the id is not a pending tool request. */
  answerToolPermission(requestId: Id, allow: boolean, always = false): boolean {
    const p = this.toolAsks.get(requestId);
    if (!p) return false;
    if (!allow) {
      return this.finishToolAsk(requestId, { allow: false, message: 'The user denied this tool call. Continue without it, or explain in your report what you need.' }, 'denied by the user', `Denied ${p.tool}.`);
    }
    if (always && p.rule) {
      this.d.store.addToolRule(p.projectId, p.rule);
      return this.finishToolAsk(requestId, { allow: true }, 'always allowed for this project (rule added)', `Allowed. Always allowed in this project from now on: ${describeToolRule(p.rule)}.`);
    }
    return this.finishToolAsk(requestId, { allow: true },
      always ? 'allowed once (always-allow is not available for this call)' : 'allowed once',
      always ? `Allowed ${p.tool} once. This kind of call cannot be always-allowed, so Harbor will ask again next time.` : `Allowed ${p.tool} once.`);
  }

  /** Pending tool permission requests as the events that announced them. */
  pendingToolEvents(): PendingPermission[] { return [...this.toolAsks.values()].map((p) => p.event); }

  /** Request ids of pending tool permission requests (tests and diagnostics). */
  pendingToolAsks(): Id[] { return [...this.toolAsks.keys()]; }

  private denyToolAsks(match: (p: ToolAsk) => boolean, why: string): void {
    for (const [id, p] of [...this.toolAsks]) {
      if (match(p)) this.finishToolAsk(id, { allow: false, message: `Harbor denied this tool call: ${why}.` }, `cancelled: ${why}`, `Permission request for ${p.tool} cancelled: ${why}.`);
    }
  }

  private finishToolAsk(id: Id, d: ToolPermissionDecision, journalText: string, chat?: string): boolean {
    const p = this.toolAsks.get(id);
    if (!p) return false;
    this.toolAsks.delete(id);
    this.log({ kind: 'permission', projectId: p.projectId, conversationId: p.conversationId, agentId: p.agentId, text: `${p.tool}: ${journalText}` });
    if (chat) this.post(p.conversationId, 'system', chat, { agentId: p.agentId });
    p.settle(d);
    return true;
  }

  // ------------------------------------------------------------ spend ceilings (spend.ts)

  /** The task (user request) a run counts towards: the newest user message of the lead's conversation, or the one a helper was delegated under. */
  private spendTaskFor(agent: AgentRecord, conversationId: Id): Id | undefined {
    const lastUser = (c: Id): Id | undefined => this.d.store.listMessages(c).filter((m) => m.role === 'user').at(-1)?.id;
    if (agent.role === 'main') return lastUser(conversationId);
    if (!agent.spendTask) {
      const t = agent.parentConversationId ? lastUser(agent.parentConversationId) : undefined;
      if (!t) return undefined;
      agent.spendTask = t;
      this.d.store.upsertAgent(agent);
    }
    return agent.spendTask;
  }

  /** Every run the ceilings count: recorded usage, runs a crash ended (carried), and the runs in flight now. */
  private spendRuns(now: number): SpendRun[] {
    const runs = this.d.store.listUsage().map(spendRunOf);
    runs.push(...this.d.store.listCarriedSpend());
    for (const f of this.spendFlights.values()) runs.push(f.measure(now));
    return runs;
  }

  /** The first ceiling a run of this project and task has reached (none configured: undefined, without counting anything). */
  private spendHitFor(projectId: Id, taskId: Id | undefined, now: number): SpendHit | undefined {
    const checks = checksFor(this.d.store.getSettings(), projectId, taskId);
    return checks.length ? firstHit(checks, this.spendRuns(now), this.d.store.listSpendGrants(), now) : undefined;
  }

  /** Spend against the ceilings for the UI (getSpendStatus): global ones, a project's, and a conversation's current task. */
  spendStatus(projectId?: Id, conversationId?: Id): SpendStatus {
    const now = this.d.ledger.time();
    const s = this.d.store.getSettings();
    const conv = conversationId ? this.d.store.getConversation(conversationId) : undefined;
    if (conversationId && (!conv || (projectId && conv.projectId !== projectId))) throw new Error('Unknown conversation');
    const pid = projectId ?? conv?.projectId;
    const owner = conv ? this.d.store.getAgent(conv.agentId) : undefined;
    const taskId = conv && owner ? this.spendTaskFor(owner, conv.id) : undefined;
    const checks = pid ? checksFor(s, pid, taskId) : checksFor({ spendCeilings: s.spendCeilings }, '', undefined);
    return { estimate: true, entries: statusOf(checks, this.spendRuns(now), this.d.store.listSpendGrants(), now) };
  }

  /**
   * Before a run starts: a ceiling already reached keeps it from starting unless the user allows one more limit's worth (an explicit
   * yes through a `permission` event; no answer in time is a no, never a yes). Returns why the run may not start, or undefined.
   */
  private async spendGate(agent: AgentRecord, o: RoutedOptions, taskId: Id | undefined): Promise<string | undefined> {
    // Each yes extends one ceiling; another scope may be reached too, so look again (at most once per scope).
    for (let i = 0; i <= SPEND_SCOPES.length; i++) {
      const hit = this.spendHitFor(agent.projectId, taskId, this.d.ledger.time());
      if (!hit) return undefined;
      if (o.signal.aborted) return describeHit(hit);
      if (this.spendDenied.has(hit.key)) return `${describeHit(hit)} You declined to continue; send a new message to be asked again.`;
      if (!(await this.askSpend(agent, o.conversationId, hit, o.signal))) return `${describeHit(hit)} Not continued: Harbor spends more only after your explicit yes.`;
    }
    return undefined;
  }

  /** One question per ceiling: every run waiting on it shares the answer. A yes is persisted; a no holds until the user's next message. */
  private askSpend(agent: AgentRecord, conversationId: Id, hit: SpendHit, signal: AbortSignal): Promise<boolean> {
    const open = this.spendAsks.get(hit.key);
    if (open) return open;
    const journal = (text: string) => this.log({ kind: 'spend', projectId: agent.projectId, conversationId, agentId: agent.id, text: `${hit.scope} ceiling${hit.projectId && hit.scope !== 'task' ? ' (project)' : ''}: ${text}` });
    journal(`reached (${hit.unit}, estimate); asked the user`);
    const pending = this.askTool(agent, conversationId, ++this.runSeq, { tool: SPEND_TOOL, input: {} }, signal, { noRules: true, prompt: continuePrompt(hit) })
      .then((d) => {
        if (d.allow) {
          this.d.store.addSpendGrant(hit.key);
          journal('extended by one limit after the user\'s yes');
          this.post(conversationId, 'system', `Continuing: you allowed one more ${describeLimit(hit.limit)} (estimate) ${hit.scope === 'task' ? 'for this request' : `for the next ${hit.scope === 'day' ? '24 hours' : '7 days'}`}.`, { agentId: agent.id });
        } else if (!signal.aborted) {
          // A no or no answer in time; a request withdrawn because its run stopped is not the user's answer.
          this.spendDenied.set(hit.key, hit.scope === 'task' || hit.projectId ? agent.projectId : undefined);
          journal('not extended');
        }
        return d.allow;
      });
    this.spendAsks.set(hit.key, pending);
    void pending.finally(() => { if (this.spendAsks.get(hit.key) === pending) this.spendAsks.delete(hit.key); });
    return pending;
  }

  /**
   * Measures the runs in flight against the ceilings (on a timer and on every usage report a run streams). A reached ceiling stops
   * every run in its scope; their work so far is kept, and the next run in that scope asks the user first (spendGate). The live
   * measurements are persisted, so a crash does not forget what these runs had spent.
   */
  private spendTick(): void {
    if (!this.spendFlights.size) return;
    const settings = this.d.store.getSettings();
    if (!ceilingsConfigured(settings)) return;
    const now = this.d.ledger.time();
    const runs = this.spendRuns(now);
    const grants = this.d.store.listSpendGrants();
    const live = [...this.spendFlights.values()];
    for (const f of live) this.d.store.setSpendFlight(f.key, f.measure(now));
    const hits = new Map<string, SpendHit>();
    for (const f of live) {
      if (f.stopped) continue;
      const hit = firstHit(checksFor(settings, f.projectId, f.taskId), runs, grants, now);
      if (hit && !hits.has(hit.key)) hits.set(hit.key, hit);
    }
    for (const hit of hits.values()) {
      const caught = live.filter((f) => !f.stopped && counts(hit, f.measure(now), now));
      if (!caught.length) continue;
      for (const f of caught) f.stop(hit);
      const text = `${describeHit(hit)} Harbor stopped ${caught.length === 1 ? 'the run' : `${caught.length} runs`} in this scope; work so far is kept. Harbor asks you before anything in this scope runs again.`;
      for (const c of new Set(caught.map((f) => f.conversationId))) this.post(c, 'system', text);
      this.log({ kind: 'spend', projectId: caught[0]!.projectId, text: `${hit.scope} ceiling reached (${hit.unit}, estimate): stopped ${caught.length} run(s)` });
    }
  }

  // ------------------------------------------------------------ help requests

  private helpRequested(a: AgentRecord, h: HelpRequest): void {
    this.d.store.addCoordination({ projectId: a.projectId, kind: 'help', from: a.id, text: `${h.reason} → ${h.proposedRole}: ${h.instructions}` });
    this.post(this.convFor(a), 'system', `Requested help from the lead: ${h.instructions || h.reason}`, { agentId: a.id });
    // A helper that keeps asking (and a lead that keeps delegating more) is the same runaway loop as any other: it spends the same cap.
    if (!this.autoTurn(a.parentConversationId)) return;
    this.enqueueMain(a.projectId, { kind: 'help', from: a, reason: h.reason, proposedRole: h.proposedRole, instructions: h.instructions, blocked: h.blocked }, a.parentConversationId);
  }

  // ------------------------------------------------------------ routed execution with fallback

  /**
   * Deadline urgency of a conversation's work (0 without a deadline): the deadline against the estimated minutes of its unfinished
   * helpers, summed (deadline.ts explains why a sum). Read on every routing decision, so setting a deadline applies to the next one.
   */
  private urgencyFor(conversationId: Id, now: number, calibration: Calibration | undefined): number {
    const { store } = this.d;
    const conv = store.getConversation(conversationId);
    // A helper's own conversation belongs to the conversation that delegated it: the deadline is that one's.
    const owner = conv?.agentId ? store.getAgent(conv.agentId) : undefined;
    const parent = owner && owner.role !== 'main' ? store.getConversation(owner.parentConversationId) : conv;
    if (parent?.deadline === undefined) return 0;
    const work = store.allAgentRecords().filter((a) => a.role !== 'main' && a.parentConversationId === parent.id && !TERMINAL.includes(a.state)).map((a) => ({ role: a.role, size: a.size }));
    return conversationUrgency({ deadline: parent.deadline, now, work: work.length ? work : [{ role: 'main' as const }], catalog: this.d.catalog ?? DEFAULT_CATALOG, calibration }).urgency;
  }

  /** Folds one finished run into the persisted calibration (partial and failed runs only as lower bounds; see calibration.ts). */
  private learnFrom(event: UsageEvent, role: AgentRole, d: RouteDecision, before: ReportedLimit[], start: number): void {
    try {
      const catalog = this.d.catalog ?? DEFAULT_CATALOG, now = event.time, calibration = this.d.store.getCalibration();
      // Other runs on the same CLI meanwhile burned part of the same delta: finished ones by their counts, running ones estimated.
      const finished = finishedRuns(this.d.store.listUsage().filter((u) => u.id !== event.id && u.cli === event.cli && u.time > start), (c, m) => entryFor(catalog, c, m));
      const running = [...this.inFlight.values()].map((r) => ({ entry: r.entry, start: r.startedAt, end: now, kTok: inFlightKTokSoFar(r, now, calibration) }));
      const overlap = overlapKTok({ cli: event.cli, start, end: now, others: [...finished, ...running] });
      const sample = calibrationSample({ event, role, size: d.size, effort: d.effort, before, start, overlap });
      this.d.store.setCalibration(calibrate([sample], this.d.store.getCalibration(), this.d.catalog ?? DEFAULT_CATALOG));
    } catch (e) { this.log({ kind: 'triage', projectId: event.projectId, text: `calibration update failed: ${String((e as Error).message ?? e)}` }); }
  }

  private async runRouted(agent: AgentRecord, o: RoutedOptions): Promise<RoutedRun> {
    // Edit runs (the lead and edit helpers outside plan/auto mode) ask the user before a tool outside the CLI's allowlist.
    // Read-only and full runs get no handler, so nothing changes for them.
    const run = ++this.runSeq;
    const onToolPermission = o.permission === 'edit'
      ? (req: ToolPermissionRequest, signal: AbortSignal) => this.askTool(agent, o.conversationId, run, req, signal)
      : undefined;
    try {
      return await this.runAttempts(agent, o, onToolPermission);
    } finally {
      this.denyToolAsks((p) => p.run === run, 'the run ended');
    }
  }

  /** Resolves true after `ms`, or false as soon as `signal` aborts. */
  private waitFor(ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onAbort = () => { cancel(); resolve(false); };
      const cancel = (this.d.setTimer ?? defaultTimer)(() => { signal.removeEventListener('abort', onAbort); resolve(true); }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async runAttempts(agent: AgentRecord, o: RoutedOptions,
    onToolPermission: ((req: ToolPermissionRequest, signal: AbortSignal) => Promise<ToolPermissionDecision>) | undefined): Promise<RoutedRun> {
    const { store, ledger } = this.d;
    const exclude: CliId[] = [];
    let pinned = o.requireCli;
    const key = o.sessionKey ?? agent.id;
    let lastError = 'No eligible CLI is available. Open Settings to install or sign in to a supported CLI.';
    // A rate limit now cools down one model, not the CLI, so a CLI may be tried again with a cheaper model before another CLI.
    const maxAttempts = Math.max(1, this.d.getClis().length * 3);
    const transientRetries = new Map<string, number>();
    let retryCli: CliId | undefined; // set for one attempt after a transient failure
    let started = false;
    let toolCalls = 0;
    // Where the working folder stood when this turn began, so a fallback after a started edit run can say what the first attempt changed.
    const editRun = o.permission !== 'read-only';
    const headAtStart = editRun ? await this.d.git.head(o.cwd).catch(() => undefined) : undefined;
    let partialNote = '';
    const wd = this.d.stall ?? {};
    const stallMs = wd.stallMs ?? STALL_MS;
    // Helpers: a soft limit an active run may pass and a hard one (softCap.ts). The lead keeps one flat limit: the user is watching it.
    const capL = agent.role === 'main' ? undefined : capLimits(wd);
    const leadCapMs = wd.leadCapMs ?? LEAD_CAP_MS;
    const wdTimer = wd.setTimer ?? defaultTimer;
    const wdNow = wd.now ?? Date.now;
    // The user request this run's spend counts towards (spend.ts), and the ceilings checked before every attempt.
    const taskId = this.spendTaskFor(agent, o.conversationId);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const ceiling = await this.spendGate(agent, o, taskId);
      if (ceiling) return { ok: false, text: '', error: ceiling, stopped: true, spent: true, started, nonce: o.nonce, toolCalls };
      const link = store.getSession(key);
      // Read every attempt: a settings change applies to the next routing decision, not only to new agents.
      const eff = effectiveSettings(store.getSettings(), agent.projectId);
      // A resumed session keeps the model and effort of its last run (changing either rewrites the prompt cache).
      // An infrastructure retry keeps the failed run's model and effort the same way while it stays on that CLI.
      const keep = o.resume && link?.model ? { cli: link.cli, model: link.model, effort: link.effort as Effort | undefined } : o.keepModel;
      const clock = this.d.now ?? Date.now;
      const calibration = store.getCalibration();
      const input: RouterInput = {
        clis: this.d.getClis(), ledger, enabled: this.d.enabled, hasAdapter: (c) => !!this.d.adapterFor(c),
        load: (c) => store.allAgentRecords().filter((x) => x.cli === c && this.running.has(x.id) && x.id !== agent.id).length,
        verified: this.d.verified, ...(this.d.readOnlySafe ? { readOnlySafe: this.d.readOnlySafe } : {}), catalog: this.d.catalog, now: clock, ...(calibration ? { calibration } : {}),
        history: buildHistory(store.listUsage(), clock()), committed: this.committedNow(clock(), calibration),
        policy: {
          allowedModels: eff.allowedModels, effortPolicy: eff.effortPolicy, lowAllowance: eff.lowAllowancePolicy, reserve: eff.subscriptionReserve,
          preference: o.role === 'main' ? undefined : eff.rolePreferences[o.role]
        }
      };
      const urgency = this.urgencyFor(o.conversationId, clock(), calibration);
      const requestFor = (requireCli?: CliId): RouteRequest => ({
        role: o.role, complexity: o.complexity, tier: o.tier, needs: o.needs, required: o.required, effort: o.effort, fixedEffort: o.fixedEffort, retry: o.retry,
        // Read-only work in the project (planners, reviewers, plan mode) needs a CLI that can keep it read-only. The concierge is
        // exempt: it runs lean in a neutral empty folder, never in the project, so read-only adds nothing there.
        ...(o.permission === 'read-only' && !o.lean ? { readOnly: true } : {}),
        ...(o.difficulty !== undefined ? { difficulty: o.difficulty } : {}), ...(o.difficultySignals ? { difficultySignals: o.difficultySignals } : {}),
        ...(o.size ? { size: o.size } : {}), ...(o.interactive ? { interactive: true } : {}), ...(urgency > 0 ? { urgency } : {}),
        ...(o.escalateFrom ? { escalateFrom: o.escalateFrom } : {}),
        avoid: o.avoid, keep, fanOut: o.fanOut, prefer: o.preferCli, continuity: o.resume ? link?.cli : undefined, left: o.resume ? this.sessionCli.get(key)?.left : undefined, exclude, requireCli
      });
      const routeWith = (requireCli?: CliId) => route(requestFor(requireCli), input);
      const retrying = retryCli;
      retryCli = undefined;
      let decision = routeWith(retrying ?? pinned);
      if (!decision && retrying) decision = routeWith(pinned);
      if (!decision && pinned) {
        // A pin is a preference, not a requirement: never leave the helper without a model because one CLI is missing or exhausted.
        this.post(o.conversationId, 'system', `${agent.title}: pinned CLI ${pinned} is unavailable, using normal routing.`, { agentId: agent.id });
        pinned = undefined;
        decision = routeWith();
      }
      if (!decision) {
        // Say why, and when it clears: every skip with its reset time, instead of a bare "no CLI".
        const why = explainNoRoute(requestFor(), input);
        // A helper that nothing can take only for now (a model is held back by something that clears by itself: reserve, room for the
        // run, a cooldown) waits in the queue for the earliest such reset. Permanent skips (not installed, not auto-routed) are not why.
        if (attempt === 0 && o.role !== 'main') {
          const skips = evaluate(requestFor(), input).skipped.filter((s) => s.transient);
          if (skips.length) {
            const untils = skips.flatMap((s) => (s.until !== undefined ? [s.until] : []));
            return { ok: false, text: '', error: why, started: false, nonce: o.nonce, held: untils.length ? { until: Math.min(...untils) } : {} };
          }
        }
        const clis = this.d.getClis();
        const generic = !clis.length || clis.every((c) => !c.installed) ? ' Open Settings to install or sign in to a supported CLI.' : '';
        return { ok: false, text: '', error: attempt === 0 ? `No eligible CLI is available. ${why}${generic}` : `${lastError} (no remaining CLI to fall back to). ${why}`, started, nonce: o.nonce };
      }
      if (o.resume) {
        const prev = this.sessionCli.get(key) ?? (link ? { cli: link.cli } : undefined);
        this.sessionCli.set(key, prev && prev.cli !== decision.cli ? { cli: decision.cli, left: { cli: prev.cli, at: clock() } } : prev ?? { cli: decision.cli });
      }
      const adapter = this.d.adapterFor(decision.cli)!;
      // One session per (key, CLI): a fallback never replaces the session the other CLI could still resume.
      const resumeId = o.resume ? store.getSession(key, decision.cli)?.sessionId : undefined;
      if (o.resume && !resumeId && link) this.addNote(o.conversationId, `${agent.title}: continuing on ${decision.cli} without the previous ${link.cli} session`);
      this.setState(agent, agent.state, { cli: decision.cli, model: decision.model, effort: decision.effort, attempts: attempt });
      if (agent.role === 'main') {
        const c = store.getConversation(o.conversationId);
        if (c?.activity) store.patchConversation(c.id, { activity: { ...c.activity, cli: decision.cli, model: decision.model, complexity: o.complexity, effort: decision.effort } });
        this.sessionState(o.conversationId, 'working', o.sessionKey?.startsWith('concierge:') ? 'First pass: checking your request.' : 'Lead agent: working on your request.');
      }
      if (attempt > 0 && decision.cli !== retrying) this.post(o.conversationId, 'system', `Falling back to ${decision.cli}: ${lastError}`, { agentId: agent.id });
      let prompt = o.prompt;
      if (!resumeId && o.contextIfNoResume) {
        // Built only now that the session cannot be resumed: the handoff costs git calls.
        const ctx = typeof o.contextIfNoResume === 'function' ? await o.contextIfNoResume() : o.contextIfNoResume;
        if (ctx) prompt = `${ctx}\n\n${prompt}`;
      }
      if (partialNote) prompt = `${partialNote}\n\n${prompt}`;
      // Screenshots depend on the CLI just chosen: handed over as images when it can see them, otherwise named with a note.
      let images = o.images;
      if (o.shots?.length) {
        if (this.seesImages(decision.cli)) images = [...(images ?? []), ...o.shots];
        else prompt = `${prompt}\n\n${noVisionNote(o.shots)}`;
      }
      if (o.nonce) prompt = `${prompt}\n\n${nonceInstruction(o.nonce)}`;
      // Skills depend on the CLI just chosen (native folders, read access, inlining), so they are added per attempt.
      let skills: { system: string; readableDirs: string[] } | undefined;
      if (o.skills && !o.lean && this.d.skillsFor) {
        try { skills = this.d.skillsFor(agent.projectId, decision.cli, o.cwd); }
        catch (e) { this.log({ kind: 'triage', projectId: agent.projectId, text: `skills could not be listed: ${String((e as Error).message ?? e)}` }); }
      }
      const system = skills?.system ? `${o.system}\n\n${skills.system}` : o.system;
      // MCP servers depend on the CLI just chosen too (support, whether it can ask about tool calls, what it can be given).
      let mcp: McpRun | undefined, mcpNotes: string[] = [];
      if (!o.lean && this.d.mcpFor) {
        try { const m = this.d.mcpFor(agent.projectId, decision.cli, { permission: o.permission, asks: !!onToolPermission }); mcp = m?.mcp; mcpNotes = m?.notes ?? []; }
        catch (e) { this.log({ kind: 'triage', projectId: agent.projectId, text: `MCP servers could not be prepared: ${String((e as Error).message ?? e)}` }); }
      }

      // `final` is the CLI's own final answer; the joined `text` also holds mid-run narration that must not become the report.
      let text = '', final = '', ok = false, error: string | undefined, rateLimited = false;
      const usage = new RunUsage();
      let limits: Extract<Chunk, { kind: 'limits' }>['limits'] | undefined;
      // The first reading the CLI prints during the run: a fresh "before" for calibration when the last one Harbor saw is old.
      let firstLimits: Extract<Chunk, { kind: 'limits' }>['limits'] | undefined;
      let streamId: Id | undefined;
      let parsed = 0, exitedClean = false; // parsed = chunks of real output (text, tool calls, usage); a bare session id is not output
      const details = detailsOf(decision);
      if (o.complexityNote) details.reason = `${details.reason}\n• ${o.complexityNote}`;
      if (mcpNotes.length) details.reason = `${details.reason}\n${mcpNotes.map((n) => `• ${n}`).join('\n')}`;
      const t0 = Date.now();
      // The provider's readings just before the run: with those it prints during the run they give a quota-per-token sample.
      const readingsBefore = ledger.readings(decision.cli);
      const startedAt = ledger.time();
      // What the CLI reported as this session's running totals after its previous run (Codex tokens, Claude cost): subtracted below.
      const prevTotals = resumeId ? store.getSession(key, decision.cli)?.totals : undefined;
      const flightKey = Symbol(agent.id);
      const flightEntry = entryFor(this.d.catalog ?? DEFAULT_CATALOG, decision.cli, decision.model);
      if (flightEntry) this.inFlight.set(flightKey, { entry: flightEntry, role: o.role, size: decision.size, effort: decision.effort as Effort, startedAt: clock() });

      // The adapter runs on its own signal so the hard time limit can stop it without pretending the user did.
      const runCtl = new AbortController();
      const onOuterAbort = (): void => runCtl.abort();
      if (o.signal.aborted) runCtl.abort(); else o.signal.addEventListener('abort', onOuterAbort, { once: true });
      let lastChunk = wdNow(), stuck = false;
      const cap: { kind?: CapKind } = {};
      const capStop = (kind: CapKind): void => { if (!cap.kind) { cap.kind = kind; runCtl.abort(); } };
      let cancelStall = (): void => {};
      const armStall = (ms: number): void => {
        cancelStall();
        cancelStall = wdTimer(() => {
          const idle = wdNow() - lastChunk;
          if (idle >= stallMs) { stuck = true; this.markStuck(agent, o, Math.max(1, Math.round(idle / 60_000))); } else armStall(stallMs - idle);
        }, ms);
      };
      let cancelSoft = (): void => {};
      const armSoft = (ms: number): void => {
        cancelSoft();
        cancelSoft = wdTimer(() => {
          const v = softCheck({ idleMs: wdNow() - lastChunk, activeWindowMs: capL!.activeWindowMs });
          if (v.stop) capStop('idle'); else armSoft(v.recheckInMs);
        }, ms);
      };
      if (capL && capL.softMs < capL.hardMs) armSoft(capL.softMs);
      // Loop guard: a helper going in circles is stopped (resumable); the lead only gets a notice, the user decides.
      const lg = wd.loopGuard ?? {};
      const loopWatch = lg.enabled === false ? undefined : new LoopWatch({
        canEdit: editRun, probeCwd: editRun && agent.role !== 'main' && agent.worktree ? o.cwd : undefined, probe: lg.probe ?? gitProgressProbe(this.d.git),
        limits: lg.limits, probeIntervalMs: lg.probeIntervalMs, setTimer: wdTimer, now: wdNow
      });
      const loop: { evidence?: LoopEvidence; noticed?: boolean } = {};
      const cancelCap = wdTimer(() => capStop('hard'), capL ? capL.hardMs : leadCapMs);
      // Spend ceilings: this run is measured with every other run in flight; a reached ceiling stops it like Harbor's time limit does.
      const spend: { hit?: SpendHit } = {};
      const runStart = Date.now();
      const flight: SpendFlight = {
        key: `${agent.id}:${runStart}:${attempt}`, projectId: agent.projectId, ...(taskId ? { taskId } : {}),
        conversationId: agent.role === 'main' ? o.conversationId : agent.parentConversationId || o.conversationId,
        measure: (now) => liveRunOf({ projectId: agent.projectId, taskId, now, elapsedMs: Date.now() - runStart, tokens: perRunUsage(decision.cli, usage.result(false), prevTotals).tokens }),
        stop: (hit) => { if (!spend.hit) { spend.hit = hit; flight.stopped = true; runCtl.abort(); } }
      };
      this.spendFlights.set(flightKey, flight);
      let cancelSpend = (): void => {};
      const armSpend = (): void => { cancelSpend = (this.d.spendTimer ?? defaultTimer)(() => { this.spendTick(); if (!flight.stopped && this.spendFlights.has(flightKey)) armSpend(); }, this.d.spendCheckMs ?? SPEND_CHECK_MS); };
      if (ceilingsConfigured(store.getSettings())) armSpend();
      try {
        o.onAttempt?.();
        armStall(stallMs);
        for await (const c of adapter.run(prompt, { cwd: o.cwd, model: decision.model, effort: decision.effort as Effort, nativeEffort: nativeEffort(entryFor(this.d.catalog ?? DEFAULT_CATALOG, decision.cli, decision.model), decision.effort as Effort), resumeId, permission: o.permission, images, systemPrompt: system, denyGitWrites: o.denyGitWrites, onToolPermission, writableDirs: o.writableDirs, ...(skills?.readableDirs.length || o.files?.length ? { readableDirs: [...new Set([...(skills?.readableDirs ?? []), ...(o.files ?? []).map((f) => dirname(f))])] } : {}), allowedCommands: o.allowedCommands, ...(o.lean ? { lean: true } : {}), ...(mcp ? { mcp } : {}), signal: runCtl.signal }) as AsyncIterable<Chunk>) {
          lastChunk = wdNow();
          if (stuck) { stuck = false; this.clearStuck(agent, o); armStall(stallMs); }
          // A failure the adapter reports without any output (e.g. the CLI could not be spawned) is not a turn that started.
          if (c.kind !== 'done' || c.ok) started = true;
          // Mid-run usage rides along with messages already counted; only a final report counts as output of its own.
          if (c.kind === 'text' || c.kind === 'tool' || (c.kind === 'usage' && !c.partial)) parsed++;
          if (c.kind === 'session') store.setSession({ agentId: key, cli: decision.cli, sessionId: c.id, updated: Date.now(), model: decision.model, effort: decision.effort });
          else if (c.kind === 'text') {
            text += (text ? '\n\n' : '') + c.text;
            if (o.stream) {
              const shown = stripProtocol(c.text, { nonce: o.nonce }); // protocol lines are machine-readable, not transcript
              if (!shown) continue;
              if (!streamId) streamId = this.post(o.conversationId, 'assistant', shown, { agentId: agent.id, details }).id;
              else {
                const m = store.getMessage(streamId)!;
                store.updateMessage(streamId, { text: `${m.text}\n\n${shown}` });
                this.emit({ type: 'messageDelta', messageId: streamId, conversationId: o.conversationId, text: `\n\n${shown}` });
              }
            }
          } else if (c.kind === 'tool') { toolCalls++; if (o.stream) { streamId = undefined; this.post(o.conversationId, 'tool', c.text, { agentId: agent.id }); } }
          else if (c.kind === 'usage') { usage.add(c); this.spendTick(); }
          else if (c.kind === 'limits') { firstLimits ??= c.limits; limits = c.limits; ledger.observe(decision.cli, c.limits); }
          else if (c.kind === 'done') { ok = c.ok; error = c.error; rateLimited = !!c.rateLimited; exitedClean = c.exitCode === 0; if (c.text) final = c.text; }
          const v = loopWatch && !loop.evidence && !loop.noticed ? loopWatch.observe(c) : undefined;
          if (v?.loop && !runCtl.signal.aborted) {
            if (agent.role === 'main') { loop.noticed = true; this.loopNotice(agent, o, v.evidence); }
            else { loop.evidence = v.evidence; runCtl.abort(); }
          }
        }
      } catch (e) { ok = false; error = String((e as Error).message ?? e); }
      finally {
        cancelStall();
        cancelSoft();
        cancelCap();
        cancelSpend();
        loopWatch?.stop();
        this.inFlight.delete(flightKey);
        // Its usage event (recorded below, in the same tick) takes over from the live measurement.
        this.spendFlights.delete(flightKey);
        store.setSpendFlight(flight.key, undefined);
        o.signal.removeEventListener('abort', onOuterAbort);
      }

      const stopped = o.signal.aborted;
      const looped = !!loop.evidence && !stopped && !cap.kind;
      const capped = !!cap.kind && !stopped;
      const spentStop = !!spend.hit && !stopped && !capped;
      // Exit code 0 after real output but without the CLI's closing event: it finished, the stream just did not say so.
      let noCompletion = false;
      if (!ok && !stopped && !capped && !looped && !spentStop && exitedClean && parsed > 0 && !rateLimited) {
        ok = true; noCompletion = true; error = undefined;
        this.post(o.conversationId, 'system', `${agent.title}: ${decision.cli} ended without a completion event (it exited normally after its output). Harbor counted the run as finished; check that the work is complete.`, { agentId: agent.id });
      }
      // "Overloaded" is the provider being busy, not the account being out of quota: no cooldown is held against the model.
      const overloaded = !ok && rateLimited && OVERLOAD_RE.test(error ?? '') && !HARD_LIMIT_RE.test(error ?? '');
      const limited = rateLimited && !overloaded;
      // A CLI that could not be started used no quota; counting it would only push the real runs towards a limit.
      const spawnFailure = !ok && parsed === 0 && SPAWN_FAILURE_RE.test(error ?? '');
      if (!spawnFailure) {
        // A CLI that prints no limits (Codex) still had its windows read meanwhile (its logs): keep those on the event as its history.
        if (!limits) { const during = readingsDuring(ledger.readings(decision.cli), startedAt); if (during.length) limits = during; }
        // A stopped, capped or failed run still costs quota: it records what streamed so far, marked partial (an estimate).
        const own = perRunUsage(decision.cli, usage.result(ok), prevTotals);
        const event = ledger.record({ cli: decision.cli, model: decision.model, projectId: agent.projectId, agentId: agent.id, conversationId: o.conversationId, ...(taskId ? { taskId } : {}), durationMs: Date.now() - t0, ok, rateLimited: limited, ...(limited && !isModelSpecific(error) ? { cliWide: true } : {}), limits, ...own.tokens });
        const sess = store.getSession(key, decision.cli);
        if (sess && own.totals) store.setSession({ ...sess, totals: own.totals });
        this.learnFrom(event, o.role, decision, [...readingsBefore, ...(firstLimits ?? [])], startedAt);
        this.emit({ type: 'usage', windows: ledger.windows(this.d.getClis().map((c) => c.id)) });
      }
      if (limited) void this.d.freeReset?.maybePropose(decision.cli).catch(() => {});
      const base = { decision, nonce: o.nonce, toolCalls };
      if (ok) return { ok: true, text: final || text, allText: text, started: true, ...base, ...(noCompletion ? { noCompletion: true } : {}) };
      // The prompt was already handed to the adapter: a stop, even a silent one, may have come after the CLI read it.
      if (stopped) return { ok: false, text, allText: text, stopped: true, error: 'stopped', started: true, ...base };
      // Harbor's loop guard: stopped, resumable with a different instruction, never retried elsewhere (it would loop there too).
      if (looped) return { ok: false, text, allText: text, stopped: true, loop: loop.evidence, error: `Harbor stopped this run: ${describeLoop(loop.evidence!)}`, started: true, ...base };
      // Harbor's own hard limit: stopped, resumable, and not retried elsewhere (another CLI would only run just as long).
      if (capped) {
        const error = capL ? `Harbor stopped this run: ${capReason(cap.kind!, capL)}` : `Harbor stopped this run at its ${Math.round(leadCapMs / 60_000)} minute limit`;
        return { ok: false, text, allText: text, stopped: true, capped: true, capKind: cap.kind, error, started: true, ...base };
      }
      // A spend ceiling: stopped, resumable once the user allows more, never retried elsewhere (that would spend the same budget).
      if (spentStop) return { ok: false, text, allText: text, stopped: true, spent: true, error: `Harbor stopped this run: ${describeHit(spend.hit!)}`, started: true, ...base };
      lastError = `${decision.cli} failed${limited ? ' (rate limit)' : overloaded ? ' (overloaded)' : ''}: ${clip(error ?? 'unknown error', 300)}`;
      const retryKind: 'oauth' | 'network' | 'overload' | undefined = limited ? undefined : overloaded ? 'overload' : transientKind(error);
      if (retryKind) {
        const delays = retryKind === 'oauth' ? TRANSIENT_RETRY_DELAYS_MS : retryKind === 'network' ? NETWORK_RETRY_DELAYS_MS : [OVERLOAD_RETRY_DELAY_MS];
        const retriesKey = `${decision.cli}:${retryKind}`;
        const retried = transientRetries.get(retriesKey) ?? 0;
        if (retried < delays.length) {
          // Not the CLI's fault and not a quota: wait and run the same CLI again rather than excluding it.
          transientRetries.set(retriesKey, retried + 1);
          const wait = delays[retried]!;
          const why = retryKind === 'oauth' ? 'a temporary sign-in refresh problem' : retryKind === 'network' ? 'a network problem' : 'an overloaded provider';
          this.post(o.conversationId, 'system', `${agent.title}: ${decision.cli} had ${why}; retrying in ${Math.round(wait / 1000)}s${delays.length > 1 ? ` (retry ${retried + 1} of ${delays.length})` : ''}.`, { agentId: agent.id });
          if (!(await this.waitFor(wait, o.signal))) return { ok: false, text, stopped: true, error: 'stopped', started, ...base };
          retryCli = decision.cli;
          attempt--; // the retry does not use up a fallback attempt
          continue;
        }
      }
      // A rate limit is held against the model in the ledger (it may be a per-model cap); anything else is a CLI-level failure.
      if (!limited) exclude.push(decision.cli);
      store.patchAgent(agent.id, { attempts: attempt + 1 });
      // An edit run that already worked in the folder must not be repeated blindly by the next CLI: it is told what is there.
      partialNote = editRun && parsed > 0 ? await this.partialWorkNote(o.cwd, headAtStart, text, decision.cli, error) : '';
    }
    return { ok: false, text: '', error: lastError, started, nonce: o.nonce, toolCalls };
  }

  /** What a fallback attempt is told about an earlier attempt that stopped part-way: git's view of the folder and what was said so far. */
  private async partialWorkNote(cwd: string, since: string | undefined, text: string, cli: string, error: string | undefined): Promise<string> {
    const { git } = this.d;
    const [status, stat] = await Promise.all([git.exec(cwd, ['status', '--short']), git.exec(cwd, ['diff', '--stat', ...(since ? [since] : [])])]);
    const said = text.split(/\r?\n/).filter((l) => !/^\s*HARBOR_/.test(l)).join('\n').trim();
    const lines = [`Harbor note: an earlier attempt at this task on ${cli} stopped part-way (${clip(error ?? 'unknown error', 160)}). It may already have changed files in your working folder. Do not start over and do not repeat steps that already completed (commits, installs, any action with external effects): inspect what is there, then finish only what is missing.`];
    if (status.ok && status.stdout.trim()) lines.push(`git status --short:\n${clip(status.stdout.trim(), 1500)}`);
    if (stat.ok && stat.stdout.trim()) lines.push(`git diff --stat${since ? ` ${since.slice(0, 7)}` : ''}:\n${clip(stat.stdout.trim(), 1500)}`);
    if (said) lines.push(`What the earlier attempt had written so far:\n${clip(said, 1500)}`);
    return lines.join('\n\n');
  }

  /** No output for a long time: say so once and offer Stop; the run itself is left alone (it may be waiting on a slow command). */
  private markStuck(agent: AgentRecord, o: RoutedOptions, minutes: number): void {
    const who = agent.role === 'main' ? 'the lead' : `"${agent.title}"`;
    // Where the user is looking: the lead's own conversation, or the conversation that delegated this helper.
    const where = agent.role === 'main' ? o.conversationId : agent.parentConversationId || o.conversationId;
    this.post(where, 'system', `No output from ${who} for ${minutes} minutes: it may be stuck (a slow command, or the network). Use Stop to end it, or leave it running.`, { agentId: agent.id });
    if (agent.role === 'main') this.sessionState(o.conversationId, 'working', `Possibly stuck: no output for ${minutes} minutes.`);
    else this.setState(agent, agent.state, { summary: 'possibly stuck' });
    this.log({ kind: 'triage', projectId: agent.projectId, conversationId: o.conversationId, agentId: agent.id, text: `${agent.role} "${agent.title}": no output for ${minutes} minutes (possibly stuck)` });
  }

  /** The lead looks like it is going in circles: say so once and offer Stop. A lead is never stopped automatically. */
  private loopNotice(agent: AgentRecord, o: RoutedOptions, e: LoopEvidence): void {
    const what = describeLoop(e);
    this.post(o.conversationId, 'system', `The lead may be going in circles: ${what}. Use Stop to end it, or leave it running.`, { agentId: agent.id });
    this.log({ kind: 'loop', projectId: agent.projectId, conversationId: o.conversationId, agentId: agent.id, text: `lead: ${what} (notice only)` });
  }

  private clearStuck(agent: AgentRecord, o: RoutedOptions): void {
    if (agent.role === 'main') this.sessionState(o.conversationId, 'working', 'Lead agent: working on your request.');
    else if (agent.summary === 'possibly stuck') this.setState(agent, agent.state, { summary: undefined });
  }
}

// ---------------------------------------------------------------- helpers

const reportKey = (a: ReportMark | AgentRecord): string => {
  const m = 'role' in a ? currentResult(a) : a;
  return `${m.id}:${m.revision}:${m.gen ?? 0}:${m.state}`;
};
/** The delivery mark of exactly this result (revision, delivery generation and state), if any. */
const deliveryOf = (a: AgentRecord): ReportDelivery | undefined => {
  const d = a.reportDelivery;
  return d && d.revision === a.revision && d.state === a.state && (d.gen ?? 0) === (a.reportGen ?? 0) ? d : undefined;
};
/** The lead may or may not have read these. */
const UNCERTAIN: ReportDelivery['status'][] = ['attempted', 'unknown'];
const resultRef = (a: AgentRecord): string => `${a.title} (id=${a.id}, ${a.state})`;
/** References in notices are bounded too: a long backlog must not flood the transcript. */
const MAX_HELD_REFS = 10;
const reportRefs = (items: AgentRecord[]): string =>
  items.slice(0, MAX_HELD_REFS).map(resultRef).join(', ') + (items.length > MAX_HELD_REFS ? `, and ${items.length - MAX_HELD_REFS} more` : '');
const markRefs = (marks: ReportMark[], title: (id: Id) => string | undefined): string =>
  marks.slice(0, MAX_HELD_REFS).map((m) => `${title(m.id) ?? 'helper'} (id=${m.id}, ${m.state})`).join(', ') + (marks.length > MAX_HELD_REFS ? `, and ${marks.length - MAX_HELD_REFS} more` : '');

/** Results join a batch with their current mark, so a turn that never reaches a CLI can put it back. */
function joinBatch(batch: ReportBatch, items: AgentRecord[]): void {
  for (const x of items) {
    batch.marks.push(currentResult(x));
    batch.prev.set(x.id, x.reportDelivery && structuredClone(x.reportDelivery));
  }
}

/** Held reports one turn carries at most, by count and by report text (each report is clipped to REPORT_CHARS anyway). */
export const MAX_HELD_REPORTS = 4;
export const MAX_HELD_CHARS = 16000;

/**
 * Which held reports go now: never-delivered ones first, then interrupted, then upgraded-file ones, oldest first, within
 * the bounds (the first always fits). The rest stay held, so later turns drain the backlog.
 */
export function pickHeld(held: AgentRecord[]): { items: AgentRecord[]; omitted: AgentRecord[] } {
  const rank = (a: AgentRecord) => { const s = deliveryOf(a)?.status; return !s ? 0 : s === 'attempted' ? 1 : 2; };
  const sorted = [...held].sort((x, y) => rank(x) - rank(y) || x.created - y.created);
  const items: AgentRecord[] = [], omitted: AgentRecord[] = [];
  let chars = 0;
  for (const a of sorted) {
    const size = Math.min((a.report ?? a.error ?? '').length, REPORT_CHARS);
    if (items.length && (items.length >= MAX_HELD_REPORTS || chars + size > MAX_HELD_CHARS)) { omitted.push(a); continue; }
    items.push(a);
    chars += size;
  }
  return { items, omitted };
}

/** The result as queued: later changes to the helper must not change what this turn reports. Uncertain ones say so. */
function reportSnapshot(a: AgentRecord): AgentRecord {
  const s = structuredClone(a);
  const d = deliveryOf(a);
  if (!d || !UNCERTAIN.includes(d.status)) return s;
  const why = d.status === 'unknown'
    ? 'it finished before Harbor recorded report delivery'
    : 'an earlier turn of yours carrying it was interrupted (stopped, failed, or Harbor restarted)';
  s.report = `[Harbor: you may already have seen this report: ${why}. Check what was already done before acting on it again.]\n${a.report ?? a.error ?? '(no report)'}`;
  return s;
}

export function toAgent(a: AgentRecord): Agent {
  return { id: a.id, projectId: a.projectId, parentId: a.parentId, role: a.role, title: a.title, state: a.state, cli: a.cli, model: a.model, effort: a.effort, worktree: a.worktree, priority: a.priority, paused: a.paused || undefined, testedCommit: a.testedCommit, outdated: a.testedCommit ? a.outdated : undefined, result: a.result, checks: a.checks?.map(({ cmd, ok, exitCode, timedOut, durationMs }) => ({ cmd, ok, exitCode, timedOut, durationMs })), integration: a.integration && structuredClone(a.integration), rollback: a.rollback && structuredClone(a.rollback), conversationId: a.parentConversationId || undefined, summary: a.state === 'done' ? a.summary : (a.summary ?? a.error), ...(a.estimatedMinutes !== undefined ? { estimatedMinutes: a.estimatedMinutes } : {}), ...(a.state === 'stopped' && a.stopKind ? { stopKind: a.stopKind } : {}) };
}

/** What the user sees about a tool call: the command, path or URL it acts on, clipped. */
function toolSummary(req: ToolPermissionRequest): string {
  const i = (req.input ?? {}) as Record<string, unknown>;
  const v = [i['command'], i['file_path'], i['notebook_path'], i['url'], i['path'], i['pattern'], i['query']].find((x) => typeof x === 'string' && x.trim());
  const parts = [typeof v === 'string' ? clip(v.trim(), 300) : '', req.description ? clip(req.description, 200) : ''].filter(Boolean);
  return parts.join(' (') + (parts.length > 1 ? ')' : '');
}

const firstLine = (s: string): string => clip(s.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) ?? s, 200).trim();

/** The lead reads and edits code whatever the front desk guessed: `code` is always among its needs. */
export const withCodeNeed = (needs: Need[]): Need[] => (needs.includes('code') ? needs : [...needs, 'code']);

/**
 * What the user and the lead must know about a checkpoint beyond "it worked": git failing or timing out (work may still be
 * uncommitted), and credential-looking files that were deliberately left out. `announceCommit` also says that work was committed.
 */
export function checkpointNote(cp: { committed: boolean; excluded?: string[]; timedOut?: boolean; error?: string }, branch: string | undefined, announceCommit = true): string {
  const parts: string[] = [];
  if (cp.timedOut) parts.push(`WARNING: git timed out while Harbor committed the helper's uncommitted work${branch ? ` to ${branch}` : ''}; it may still be uncommitted in the worktree.`);
  else if (cp.error) parts.push(`WARNING: Harbor could not commit the helper's uncommitted work${branch ? ` to ${branch}` : ''} (${cp.error}); it may still be uncommitted in the worktree.`);
  else if (announceCommit && cp.committed) parts.push(`Uncommitted work was committed to ${branch ?? 'the branch'} by Harbor.`);
  if (cp.excluded?.length) parts.push(`Credential-looking files were left out of the commit and stay uncommitted: ${cp.excluded.slice(0, 8).join(', ')}${cp.excluded.length > 8 ? ', ...' : ''}.`);
  return parts.join(' ');
}

/** Bash command prefixes a Claude edit run may use unasked: the project's own check commands, when they are plain commands (no chaining or redirection). */
export function commandPrefixes(cmds: string[]): string[] {
  return cmds.map((c) => c.trim()).filter((c) => c && !/[;&|<>`$()\r\n]/.test(c));
}

const BARE_PROTOCOL_LINE = /^\s*HARBOR_(?:REQUEST_HELP|ASK|DELEGATE|IMAGE_BRIEF|RESULT|GOAL_DONE|PEER|DECISION|NOTE|REPLY|SCREENSHOT|SHOW_IMAGE|OPEN_DOCUMENT)\s*:/;

/**
 * Protocol lines Harbor did not act on: lines that were malformed, and (when a tag was required) lines written without it,
 * which Harbor reads as quoted text. Fenced, indented and quoted lines are ignored on purpose and not counted.
 */
export function ignoredProtocolLines(text: string, proto: Protocol, nonce?: string): string[] {
  const out = [...proto.malformed];
  if (nonce) {
    let fenced = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^ {0,3}(`{3,}|~{3,})/.test(line)) { fenced = !fenced; continue; }
      if (fenced || /^(\t| {4})/.test(line) || /^\s*>/.test(line)) continue;
      if (BARE_PROTOCOL_LINE.test(line)) out.push(clip(line.trim(), 300));
    }
  }
  return out;
}
