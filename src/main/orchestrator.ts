import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, AgentRole, AgentState, Attachment, CliId, Conversation, ConversationMode, HarborEvent, Id, IntegrationSource, Message, PendingPermission, Project, SessionActivity } from '../shared/api';
import type { Chunk, CliAdapter, Effort, ToolPermissionDecision, ToolPermissionRequest } from './adapters/types';
import type { CatalogEntry, Need, Tier } from './clis/capabilities';
import { loadChecks as loadProjectChecks, runShellCheck, type CheckRunner } from './checks';
import type { ResolvedCli } from './clis/discovery';
import type { Git } from './git';
import { breakCycles } from './graph';
import { Journal, journalDigest, type JournalEntry, type JournalKind } from './journal';
import { LockTable, WHOLE_PROJECT } from './locks';
import {
  CONCIERGE_SYSTEM, LEAD_SYSTEM, MAX_PEERS_PER_TURN, clip, conciergePrompt, historyText, imageBriefText, isApproval, leadPrompt, needsWorkspace, parseConcierge, parseProtocol, requestedCli, stripProtocol, subagentPrompt, systemFor,
  type AskRequest, type Escalation, type HelpRequest, type LeadTrigger, type PeerMessage, type PeerRequest, type PlannedTask, type SessionPeer
} from './prompts';
import { buildHandoff, type HandoffEvidence } from './handoff';
import { reapTrackedProcesses, setSpawnObserver, systemKiller, type ProcessKiller } from './proc';
import { EXTERNAL_EFFECTS_NOTE, previewRollback, relatedAgents } from './rollback';
import { effortFor, route, type Complexity, type RouteDecision } from './router';
import { DEFAULT_CONCURRENCY, describeToolRule, effectiveSettings, matchesToolRule, newId, normPath, toolRuleFor, type Store, type ToolRuleDraft } from './store';
import type { AgentRecord, CheckRun, TaskSnapshot } from './types';
import type { FreeResetCoordinator, UsageLedger } from './usage';
import type { EventBus } from './events';

export interface OrchestratorDeps {
  store: Store;
  bus: EventBus;
  ledger: UsageLedger;
  git: Git;
  getClis: () => ResolvedCli[];
  adapterFor: (cli: CliId) => CliAdapter | undefined;
  enabled: (cli: CliId) => boolean;
  verified?: (cli: CliId) => boolean;
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
}

/** An unanswered tool permission request is denied after this long, so it can never hold a run (and its queue slot) forever. */
export const TOOL_PERMISSION_TIMEOUT_MS = 5 * 60_000;
// JournalKind (journal.ts, outside this module's ownership) has no 'permission' member yet; the journal stores any kind string.
const PERMISSION_KIND = 'permission' as string as JournalKind;

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

/** A tool call waiting for the user's answer. In memory only: a restart ends the run that asked. */
interface ToolAsk { agentId: Id; projectId: Id; conversationId: Id; run: number; tool: string; rule?: ToolRuleDraft; event: PendingPermission; settle(d: ToolPermissionDecision): void }

const MAX_SNAPSHOTS = 5;

export interface OrphanSweep { killed: number[]; skipped: number[] }

/** The error of an agent `recover()` stopped; persisted, so it also marks restart-stopped agents after a later restart. */
const RESTART_ERROR = 'Harbor restarted while this agent was running. Its worktree and any commits are preserved; send a message to continue.';

const RESUME_PROMPT ='Harbor was interrupted while you were working and has restarted. Continue your assignment from your session. First check the current state (git status and git log in your worktree, and any files you were changing). Do not repeat steps that already completed, in particular commits, pushes, installs, or any other action with external effects; do only what is still missing, then report.';

const EDIT_ROLES: AgentRole[] = ['implementer', 'other'];
const CX_UP_ORDER: Complexity[] = ['low', 'medium', 'high'];
const TERMINAL: AgentState[] = ['done', 'failed', 'stopped'];
const DEFAULT_TITLE = 'New conversation';
const GOAL_MAX_CONTINUATIONS = 8;
const MAX_PEER_WAKES = 2;
const MAX_PEER_INBOX = 10;

interface RoutedRun {
  ok: boolean;
  text: string;
  /** Every text chunk of the run, not only the final answer: protocol lines can be anywhere. */
  allText?: string;
  error?: string;
  stopped?: boolean;
  decision?: RouteDecision;
}

interface RoutedOptions {
  prompt: string;
  system: string;
  /** Prepended when the native session cannot be resumed (first turn, or the CLI changed). */
  contextIfNoResume?: string;
  role: AgentRole;
  complexity: Complexity;
  tier?: Tier;
  needs?: Need[];
  effort?: Effort;
  /** Keep `effort` as given: the effort policy does not apply. */
  fixedEffort?: boolean;
  retry?: boolean;
  /** CLI the user asked for by name. */
  preferCli?: CliId;
  permission: 'read-only' | 'edit' | 'full';
  /** Absolute paths of images for this turn only. */
  images?: string[];
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
}

export class Orchestrator {
  private locks: LockTable;
  private controllers = new Map<Id, AbortController>();
  private running = new Set<Id>();
  private mainChain = new Map<Id, Promise<void>>();
  private followups = new Map<Id, string[]>();
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
  /** Conversations where the lead asked a question: the next user message answers it and skips the concierge. */
  private leadAsked = new Set<Id>();
  private conflictAsked = new Set<Id>();
  /** Withdraws an agent's open conflict question once it is moot (the agent got its files, or ended). */
  private conflictAsks = new Map<Id, AbortController>();
  /** Edit helpers already told they are held back by plan mode (one note each). */
  private planHeldNoted = new Set<Id>();
  /** Open questions to the user. In memory only: after a restart the question text is still in the chat to answer by typing. */
  private questions = new Map<Id, { agentId: Id; conversationId: Id }>();
  /** Peer messages waiting for a lead's next turn, by target conversation. In memory: a restart ends the sessions they were meant for. */
  private peerInbox = new Map<Id, PeerMessage[]>();
  /** Urgent wake-ups of an idle lead since the user last wrote to it; bounded so two leads cannot wake each other forever. */
  private peerWakes = new Map<Id, number>();
  private sessionGeneration = new Map<Id, number>();
  private stoppedSessions = new Set<Id>();
  /** Pending tool permission requests by request id. */
  private toolAsks = new Map<Id, ToolAsk>();
  private runSeq = 0;

  private startedAt = Date.now();
  /** Settles when the orphan sweep started by recover() is done. */
  private sweep: Promise<OrphanSweep> = Promise.resolve({ killed: [], skipped: [] });
  readonly journal: Journal;

  constructor(private d: OrchestratorDeps) {
    this.locks = new LockTable(() => d.store.locks, (l) => d.store.setLocks(l));
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
    Object.assign(a, patch, { state });
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
    for (;;) {
      const busy = this.running.size > 0 || this.mainBusy > 0;
      const pending = this.d.store.allAgentRecords().some((a) => a.role !== 'main' && (a.state === 'queued' || a.state === 'working'));
      if (!busy && !pending) return;
      if (Date.now() - start > timeoutMs) throw new Error('whenIdle timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  private mainBusy = 0;

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
    for (const a of this.d.store.allAgentRecords()) {
      if (a.state === 'working') this.setState(a, 'stopped', { error: RESTART_ERROR });
      if (a.role === 'main') this.setState(a, 'waiting');
    }
    this.d.store.setLocks(this.d.store.locks.filter((l) => this.running.has(l.agentId)));
    for (const p of this.d.store.listProjects()) this.pump(p.id);
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
    this.reported.delete(`${a.id}:${a.revision}:${a.state}`);
    this.post(this.convFor(a), 'system', 'Resuming from the saved session.', { agentId: a.id });
    this.followUp(a, RESUME_PROMPT);
  }

  // ------------------------------------------------------------ user input

  /** `attachments` are already validated and written to disk by the service (each has a `path`). */
  async userMessage(conversationId: Id, text: string, attachments: Attachment[] = []): Promise<void> {
    const conv = this.d.store.getConversation(conversationId);
    if (!conv) throw new Error('Unknown conversation');
    const agent = this.d.store.getAgent(conv.agentId);
    if (!agent) throw new Error('Conversation has no agent');
    if (conv.archived) throw new Error('Restore this conversation before sending a message.');
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
    this.d.store.setGoalPaused(conversationId, false); // a new message clears a goal pause
    for (const [id, q] of this.questions) if (q.conversationId === conversationId) this.questions.delete(id);
    if (conv.title === DEFAULT_TITLE && !conv.customTitle) this.d.store.touchConversation(conv.id, { title: clip(text.replace(/\s+/g, ' '), 50) });
    if (agent.role === 'main') {
      this.autoTurns.set(conversationId, 0);
      this.peerWakes.delete(conversationId);
      const images = attachments.map((a) => a.path).filter((p): p is string => !!p);
      this.enqueueMain(agent.projectId, { kind: 'user', text, ...(images.length ? { images } : {}) }, conversationId);
    } else {
      this.direct(agent, text, conversationId);
    }
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
      this.post(conversationId, 'system', 'Auto mode applies to runs that start from now on; helpers already running keep their current permissions.');
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
      for (const [, l] of active) l.ctl.abort();
      return;
    }
    this.denyToolAsks((p) => p.agentId === a.id, 'the agent was stopped');
    this.controllers.get(a.id)?.abort();
    if (!this.running.has(a.id) && !TERMINAL.includes(a.state)) {
      this.setState(a, 'stopped', { error: 'Stopped by the user before it started.' });
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

  private enqueueMain(projectId: Id, trigger: LeadTrigger, conversationId: Id): void {
    if (trigger.kind !== 'user' && this.stoppedSessions.has(conversationId)) return;
    if (trigger.kind === 'user') this.stoppedSessions.delete(conversationId);
    // One chain per conversation: a long turn in one conversation must not block another.
    const prev = this.mainChain.get(conversationId) ?? Promise.resolve();
    const generation = this.sessionGeneration.get(conversationId) ?? 0;
    if (!this.leads.has(conversationId)) this.sessionState(conversationId, 'queued', 'Waiting to start.');
    this.mainBusy++;
    const next = prev.then(() => generation === (this.sessionGeneration.get(conversationId) ?? 0) ? this.mainTurn(projectId, trigger, conversationId) : undefined).catch((e) => {
      this.post(conversationId, 'system', `Lead agent error: ${String(e?.message ?? e)}`);
      this.sessionState(conversationId, 'failed', String(e?.message ?? e));
    }).finally(() => { this.mainBusy--; if (this.mainChain.get(conversationId) === next) this.mainChain.delete(conversationId); });
    this.mainChain.set(conversationId, next);
  }

  /** Every user prompt: a cheap concierge first, then (only when it escalates) a lead chosen for the work. */
  private async mainTurn(projectId: Id, trigger: LeadTrigger, conversationId: Id): Promise<void> {
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
        if (deep) {
          // "/deep" skips the front desk and gives the lead a strong model.
          plan = { complexity: 'high', needs: ['planning', 'code'], ack: '', effort: 'high' };
          trigger = { ...trigger, text: trigger.text.slice(deep[0].length) || trigger.text };
        } else if (trigger.images?.length) {
          // The front desk cannot see images, so it never triages them: straight to a lead that can.
          plan = { complexity: 'medium', needs: ['code'], ack: '' };
        } else if ((this.plans.has(conversationId) || this.goAhead.has(conversationId)) && isApproval(trigger.text)) {
          // A go-ahead continues the last request at its size: no front-desk call, no fresh guess. A one-off "/deep" is not inherited.
          plan = { ...plan, effort: undefined };
        } else if (!this.leadAsked.has(conversationId)) {
          const c = await this.concierge(project, main, conversationId, trigger.text, ctl.signal);
          if (c === 'handled') return;
          plan = c;
        } // else: this message answers the lead's own question, so there is nothing to triage
        // An explicit "use codex" applies to this request (and its go-aheads); other messages keep the earlier choice.
        const asked = requestedCli(trigger.text);
        if (asked) plan = { ...plan, preferCli: asked };
        this.plans.set(conversationId, plan);
        // Vision is a need of this turn only; later go-ahead turns must not inherit it.
        if (trigger.images?.length && !plan.needs.includes('vision')) plan = { ...plan, needs: [...plan.needs, 'vision'] };
      }
      this.goAhead.delete(conversationId);
      this.leadAsked.delete(conversationId);
      await this.leadTurn(project, main, trigger, conversationId, plan, ctl.signal);
    } finally {
      this.leads.delete(conversationId);
      if (ctl.signal.aborted) this.sessionState(conversationId, 'stopped', 'Stopped by you.');
      else if (this.d.store.getConversation(conversationId)?.activity?.state === 'working') this.sessionState(conversationId, 'done', 'The lead has finished its turn.');
      const n = (this.leadActive.get(projectId) ?? 1) - 1;
      if (n <= 0) { this.leadActive.delete(projectId); this.setState(main, 'waiting'); } else this.leadActive.set(projectId, n);
    }
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

  /** Cheap model: answers simple messages itself, otherwise says what the work needs. Never uses tools. */
  private async concierge(project: Project, main: AgentRecord, conversationId: Id, text: string, signal: AbortSignal): Promise<'handled' | Escalation> {
    const out = await this.runRouted(main, {
      prompt: conciergePrompt(project.name, this.registerFor(project.id, conversationId), this.chatHistory(conversationId, true).slice(-8), text), system: CONCIERGE_SYSTEM,
      role: 'main', complexity: 'low', tier: 'cheap', effort: 'low', fixedEffort: true, needs: ['chat'], permission: 'read-only', cwd: project.path,
      signal, resume: false, conversationId, stream: false, sessionKey: `concierge:${conversationId}`
    });
    if (!out.ok) {
      this.sessionState(conversationId, out.stopped ? 'stopped' : 'failed', out.error);
      this.post(conversationId, 'system', out.stopped ? 'Stopped.' : `Harbor could not run: ${out.error}`, { agentId: main.id });
      return 'handled';
    }
    const details = out.decision && { cli: out.decision.cli, model: out.decision.model, effort: out.decision.effort, reason: out.decision.reason };
    const d = parseConcierge(out.text);
    // The front desk cannot read files: an answer to a message that clearly needs the workspace is a guess, so the lead takes it.
    // Medium (not high): the guard knows work is needed, not how hard it is, and must not buy Opus for a trivial edit.
    if (d.kind === 'answer' && needsWorkspace(text)) return { complexity: 'medium', needs: ['code'], ack: '' };
    if (d.kind === 'answer') { this.post(conversationId, 'assistant', d.text, { agentId: main.id, details }); return 'handled'; }
    if (d.escalation.ack) this.post(conversationId, 'assistant', d.escalation.ack, { agentId: main.id, details });
    return d.escalation;
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
      mode: conv?.mode, goal: conv?.goal,
      decisions: store.listCoordination(project.id).filter((c) => c.kind === 'decision').map((c) => c.text),
      work: agents.filter((a) => !a.integration && !a.rollback).map((a) => ({ title: a.title, role: a.role, state: a.state, branch: a.branch, note: a.state === 'done' ? undefined : a.error ?? a.summary })),
      evidence,
      applied: agents.filter((a) => (a.integration?.applied || a.rollback?.applied)).map((a) => `${a.title} → ${a.integration?.target ?? a.rollback?.target ?? 'target'}`)
    });
  }

  /** The working agent: reads, edits, runs commands, and delegates through HARBOR_DELEGATE lines when that pays off. */
  private async leadTurn(project: Project, main: AgentRecord, trigger: LeadTrigger, conversationId: Id, plan: Escalation, signal: AbortSignal): Promise<void> {
    const notes = this.notes.get(conversationId) ?? [];
    this.notes.delete(conversationId);
    const history = this.chatHistory(conversationId, trigger.kind === 'user');
    const tier: Tier = plan.complexity === 'high' ? 'strong' : plan.complexity === 'low' ? 'cheap' : 'standard';
    const inbox = this.peerInbox.get(conversationId) ?? [];
    this.peerInbox.delete(conversationId);
    const conv = this.d.store.getConversation(conversationId);
    const mode = conv?.mode ?? 'default';
    const goal = mode === 'goal' ? conv?.goal : undefined;
    const goalMode = !!goal;
    const headBefore = await this.d.git.head(project.path).catch(() => undefined);
    // Only used when the lead's native session cannot be resumed (new conversation, lost session, or another CLI took over).
    const handoff = await this.handoffFor(project, conversationId).catch(() => '');
    const out = await this.runRouted(main, {
      prompt: leadPrompt(project.name, this.registerFor(project.id, conversationId), trigger, { notes, mode, goal, peers: this.sessionPeers(project.id, conversationId), inbox }), system: LEAD_SYSTEM,
      contextIfNoResume: [handoff, history.length ? `Conversation so far (your earlier session is not available):\n${historyText(history)}` : ''].filter(Boolean).join('\n\n') || undefined,
      role: 'main', complexity: plan.complexity, tier, effort: plan.effort ?? effortFor('main', plan.complexity), fixedEffort: plan.effort !== undefined, needs: plan.needs, preferCli: plan.preferCli,
      permission: mode === 'plan' ? 'read-only' : mode === 'auto' ? 'full' : 'edit', cwd: project.path,
      images: trigger.kind === 'user' ? trigger.images : undefined,
      signal, resume: true, conversationId, stream: true, sessionKey: `lead:${conversationId}`, denyGitWrites: true
    });
    await this.detectLeadMerge(project, main, conversationId, headBefore);
    if (!out.ok) {
      this.sessionState(conversationId, out.stopped ? 'stopped' : 'failed', out.error);
      this.post(conversationId, 'system', out.stopped ? 'Stopped.' : `The lead agent could not run: ${out.error}`, { agentId: main.id });
      if (goalMode) this.d.store.setGoalPaused(conversationId, true);
      if (goalMode) this.post(conversationId, 'system', out.stopped ?'Goal mode paused: you stopped the session. Send a message to continue toward the goal.' : 'Goal mode paused: the lead\'s turn failed.');
      return;
    }
    const proto = parseProtocol(out.allText ?? out.text);
    let delegations = proto.delegate;
    if (mode === 'plan') {
      const edits = delegations.filter((t) => t.access === 'edit');
      if (edits.length) {
        delegations = delegations.filter((t) => t.access !== 'edit');
        this.post(conversationId, 'system', `Plan mode: ignored ${edits.length} edit helper(s) (${edits.map((t) => t.title).join(', ')}). Approve the plan to let the lead carry it out.`);
      }
    }
    for (const text of proto.decision) this.d.store.addCoordination({ projectId: project.id, kind: 'decision', from: main.id, text });
    const created = this.createTasks(project, delegations, conversationId, trigger.kind === 'help' ? trigger.from.id : undefined);
    for (const b of proto.image) this.post(conversationId, 'assistant', imageBriefText(b), { agentId: main.id });
    for (const p of proto.peer.slice(0, MAX_PEERS_PER_TURN)) this.deliverPeer(project.id, conversationId, p);
    if (created.length) {
      this.post(conversationId, 'system', 'Delegated: ' + created.map((c, i) => `${i + 1}. ${c.title}${c.dependsOn.length ? ' (after earlier steps)' : ''}`).join('  '), { agentId: main.id });
    }
    const asking = proto.ask[0];
    if (asking) {
      this.leadAsked.add(conversationId);
      if (!stripProtocol(out.text).includes(asking.question)) this.post(conversationId, 'assistant', asking.question, { agentId: main.id });
      this.askUser(main.id, conversationId, asking);
    }
    if (trigger.kind === 'help' && !created.some((c) => c.helpFor === trigger.from.id)) {
      // No helper assigned: tell the blocked agent so it can continue on its own judgment.
      this.followUp(trigger.from, `The lead did not assign another helper for your request. Response: ${stripProtocol(out.text) || 'proceed with your best judgment within scope, or report that you are blocked.'}`);
    }
    this.pump(project.id);
    if (goalMode) this.goalStep(project.id, conversationId, proto.goalDone?.summary, !!asking);
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
  private goalStep(projectId: Id, conversationId: Id, doneSummary: string | undefined, asked: boolean): void {
    const { store } = this.d;
    if (doneSummary !== undefined) { this.post(conversationId, 'system', `Goal reached: ${doneSummary || 'the lead reports the goal is done.'}`); return; }
    if (asked) { store.setGoalPaused(conversationId, true); this.post(conversationId, 'system', 'Goal mode paused: the lead is waiting for your answer.'); return; }
    if (store.isGoalPaused(conversationId)) return; // a report or failure resumed the lead once; only the user restarts the loop
    if (this.helpersActive(projectId, conversationId)) return; // the last helper's report resumes the lead, and that turn comes back here
    const n = this.goalTurns.get(conversationId) ?? 0;
    if (n >= GOAL_MAX_CONTINUATIONS) { this.post(conversationId, 'system', `Goal mode paused after ${GOAL_MAX_CONTINUATIONS} automatic continuations. Send a message to continue toward the goal.`); return; }
    this.goalTurns.set(conversationId, n + 1);
    this.enqueueMain(projectId, { kind: 'goal', continuation: n + 1, max: GOAL_MAX_CONTINUATIONS }, conversationId);
  }

  private createTasks(project: Project, tasks: PlannedTask[], conversationId: Id, requester?: Id): AgentRecord[] {
    const { store } = this.d;
    const refToId = new Map<string, Id>(tasks.map((t) => [t.ref, newId()]));
    const resolve = (r: string): Id | undefined => refToId.get(r) ?? store.listAgentRecords(project.id).find((a) => a.id === r)?.id;
    const out: AgentRecord[] = [];
    // Resolve the whole dependency graph first so cycles can be detected and broken (never left waiting forever).
    const graph = new Map<Id, Set<Id>>();
    const sourcesOf = new Map<Id, Id[]>();
    for (const t of tasks) {
      const id = refToId.get(t.ref)!;
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
    for (const t of tasks) {
      const id = refToId.get(t.ref)!;
      const deps = graph.get(id)!;
      const wantedSpec = t.specFrom ? resolve(t.specFrom) : undefined;
      const specFromId = wantedSpec && deps.has(wantedSpec) ? wantedSpec : undefined;
      // A retry of failed or rejected work moves up one complexity level, i.e. one model tier, never beyond high.
      const prior = t.retryOf ? store.listAgentRecords(project.id).find((a) => a.id === t.retryOf) : undefined;
      const rejected = prior && (prior.state === 'failed' || prior.result?.verdict === 'changes' || prior.result?.outcome === 'blocked' || prior.checks?.some((c) => !c.ok));
      const complexity: Complexity = rejected ? (CX_UP_ORDER[Math.max(CX_UP_ORDER.indexOf(t.complexity), CX_UP_ORDER.indexOf(prior.complexity ?? 'medium')) + 1] ?? 'high') : t.complexity;
      if (rejected && complexity !== t.complexity) this.post(conversationId, 'system', `Retrying "${t.title}" with a stronger model (${t.complexity} → ${complexity}) because "${prior.title}" did not succeed.`);
      const rec: AgentRecord = {
        id, projectId: project.id, parentId: this.d.store.mainAgent(project.id)?.id, role: t.role, title: t.title, state: 'queued', cli: 'auto', model: 'auto',
        effort: effortFor(t.role, complexity, !!rejected), retry: rejected ? true : undefined, task: t.instructions, files: t.files, dependsOn: [...deps], specFromId,
        needs: t.needs, readOnly: t.access === 'read', pinnedCli: t.cli,
        helpFor: t.helpFor ?? requester, revision: 1, complexity,
        parentConversationId: conversationId, attempts: 0, created: Date.now(),
        // A clear edit goes straight to one implementer; its instructions are the spec.
        spec: t.role === 'implementer' && !specFromId ? t.instructions : undefined
      };
      if (t.integrate) {
        Object.assign(rec, { cli: 'harbor', model: 'git', effort: 'low', needs: undefined, pinnedCli: undefined, retry: undefined });
        rec.integration = { target: t.integrate.target, sources: (sourcesOf.get(id) ?? []).map((agentId) => ({ agentId, state: 'pending' as const })) };
      }
      store.upsertAgent(rec);
      store.addConversation({ id: newId(), projectId: project.id, title: `${t.role}: ${t.title}`, updated: Date.now(), agentId: id });
      this.publish(rec);
      out.push(rec);
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

  pump(projectId: Id): void {
    const { store } = this.d;
    const max = effectiveSettings(store.getSettings(), projectId).concurrencyLimit ?? this.d.maxActivePerProject ?? DEFAULT_CONCURRENCY;
    // Higher priority first, then oldest first.
    const all = store.listAgentRecords(projectId).filter((a) => a.role !== 'main').sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.created - b.created);
    const byId = new Map(all.map((a) => [a.id, a]));
    for (const a of all) {
      if (a.state !== 'queued') continue;
      if (this.running.has(a.id)) continue;
      if (a.paused) continue;
      const deps = a.dependsOn.map((id) => byId.get(id)).filter((x): x is AgentRecord => !!x);
      // An integrator waits for reviewers only so its gate sees final verdicts: a failed or stopped review is settled, and the
      // gate (latest verdict on the current head) decides. Work stopped by a restart is not settled: it waits to be resumed.
      const settled = (x: AgentRecord) => !!a.integration && x.role === 'reviewer' && TERMINAL.includes(x.state) && !this.restartStopped(x);
      const bad = deps.find((x) => (x.state === 'failed' || x.state === 'stopped') && !settled(x) && !this.restartStopped(x));
      if (bad) {
        this.setState(a, 'failed', { error: `Blocked: dependency "${bad.title}" ${bad.state}. Nothing was run.` });
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
      if (!this.claim(a)) continue;
      this.begin(a.id);
      void this.runAgent(a).catch((e) => this.failAgent(a, `Internal error: ${String(e?.message ?? e)}`));
    }
  }

  /** Acquire file ownership for edit helpers. On conflict, ask the user whether to proceed in parallel. */
  private claim(a: AgentRecord): boolean {
    // An integrator or rollback only writes its own new branch, never files another helper is editing.
    if (!this.canEdit(a) || a.sharedOk || a.integration || a.rollback) return true;
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

  private async runAgent(a: AgentRecord): Promise<void> {
    if (a.integration) return this.runIntegration(a);
    if (a.rollback) return this.runRollback(a);
    const project = this.project(a.projectId);
    const { store } = this.d;
    const conv = this.convFor(a);
    this.setState(a, 'working', { error: undefined });
    this.post(conv, 'system', `Assignment (${a.role}, rev ${a.revision}): ${a.title}\n\n${a.task}`, { agentId: a.id });

    // Workspace: edit helpers get an isolated worktree; read-only helpers read the project (or the change under review).
    let cwd = project.path;
    let worktreeNote: string | undefined;
    let depsLinked = false;
    const upstream = a.dependsOn.map((id) => store.getAgent(id)).filter((x): x is AgentRecord => !!x);
    if (this.canEdit(a)) {
      if (!a.worktree && (await this.d.git.isRepoWithCommits(project.path))) {
        try {
          const wt = await this.d.git.createWorktree(project.path, this.d.worktreesRoot, project.id.slice(0, 8), a.title, a.id);
          this.setState(a, 'working', { worktree: wt.path, branch: wt.branch, baseCommit: wt.baseCommit });
          depsLinked = await this.d.git.linkDependencies(project.path, wt.path);
        } catch (e) { return this.failAgent(a, `Could not create a git worktree: ${String((e as Error).message)}`); }
      }
      if (a.worktree) {
        cwd = a.worktree;
        worktreeNote = `You work in an isolated git worktree on branch ${a.branch}. Commit your work to this branch. Do not touch other directories.${depsLinked ? ' node_modules is linked from the main checkout: do not run npm install and never delete node_modules.' : ''}`;
      }
      else worktreeNote = 'This project is not a git repository with commits, so you edit the project directory directly while holding exclusive ownership. Keep changes minimal and scoped.';
    } else {
      const reviewed = upstream.find((u) => u.worktree);
      if (a.role === 'reviewer' && reviewed?.worktree) {
        cwd = reviewed.worktree;
        // Pin the exact version under review now; the branch may move while the reviewer works.
        const tested = await this.d.git.head(cwd);
        if (tested) this.setState(a, 'working', { testedCommit: tested, testedWorktree: cwd, outdated: false });
      }
      worktreeNote = 'Read-only: do not modify files.';
    }

    // The planner's report is the implementer's specification, verbatim.
    if (a.specFromId) {
      const src = store.getAgent(a.specFromId);
      if (src?.report) { a.spec = src.report; store.upsertAgent(a); }
    }

    const prompt = subagentPrompt(a, { projectName: project.name, upstream, worktreeNote });
    const res = await this.execute(a, prompt, { cwd, resume: false });
    await this.afterRun(a, res);
  }

  /** One CLI run for a helper (initial or follow-up), streaming into its conversation. */
  private async execute(a: AgentRecord, prompt: string, o: { cwd: string; resume: boolean }): Promise<RoutedRun> {
    const ctl = this.controllers.get(a.id) ?? new AbortController();
    // Auto mode lifts prompts and the sandbox for edit helpers only; reviewers and read-only helpers stay read-only.
    // Plan mode wins over everything: every helper that starts (or resumes) in it is read-only.
    const mode = this.d.store.getConversation(a.parentConversationId)?.mode;
    return this.runRouted(a, {
      prompt, system: systemFor(a.role as Exclude<AgentRole, 'main'>), role: a.role, complexity: a.complexity ?? 'medium', needs: a.needs, retry: a.retry,
      requireCli: a.pinnedCli,
      permission: mode === 'plan' || !this.canEdit(a) ? 'read-only' : mode === 'auto' ? 'full' : 'edit', cwd: o.cwd, signal: ctl.signal,
      resume: o.resume, conversationId: this.convFor(a), stream: true,
      contextIfNoResume: o.resume ? this.helperContext(a) : undefined
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
    let report = stripProtocol(res.text);
    const proto = parseProtocol(res.allText ?? res.text);
    for (const l of proto.malformed) this.log({ kind: 'protocol', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: `${a.role} "${a.title}": ${l}` });
    if (!res.ok && !res.stopped) this.log({ kind: 'helper-failed', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: `${a.role} "${a.title}" on ${a.cli}/${a.model}: ${res.error ?? 'failed'}` });

    if (res.ok && a.worktree && a.baseCommit) {
      const cp = await git.checkpoint(a.worktree, `harbor: ${a.title}`);
      const stat = await git.diffStat(a.worktree, a.baseCommit);
      const files = await git.changedFiles(a.worktree, a.baseCommit);
      if (stat) report += `\n\nChanges on ${a.branch}${cp.committed ? ' (uncommitted work was checkpointed by Harbor)' : ''}:\n${stat}`;
      else report += `\n\nNo changes were committed on ${a.branch}.`;
      if (cp.head) { a.headCommit = cp.head; this.markOutdated(a.projectId, a.worktree, cp.head); }
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
      if (cp.head && this.canEdit(a)) report += await this.runChecks(a, cp.head, ctl?.signal);
    }

    // Each run replaces the previous result: a verdict from an earlier revision must not outlive it.
    // The commit ties the result to what was examined: the reviewed head pinned at start, or the helper's own head.
    const examined = a.role === 'reviewer' ? a.testedCommit : this.canEdit(a) ? a.headCommit : undefined;
    a.result = proto.result ? { ...proto.result, ...(examined ? { commit: examined } : {}) } : undefined;

    this.running.delete(a.id);
    this.controllers.delete(a.id);
    const stopped = !!res.stopped || !!ctl?.signal.aborted;
    const blocked = res.ok && proto.help.some((h) => h.blocked);
    const asking = res.ok && !stopped && proto.ask[0];
    const summary = a.result?.summary || firstLine(report);
    this.locks.release(a.id);
    if (stopped) this.setState(a, 'stopped', { report, error: 'Stopped by the user.' });
    else if (!res.ok) this.setState(a, 'failed', { report, error: res.error ?? 'failed' });
    else if (asking) this.setState(a, 'waiting', { report, summary, error: 'Waiting for your answer.' });
    else if (blocked) this.setState(a, 'waiting', { report, summary, error: 'Blocked: waiting for another helper requested through the lead.' });
    else this.setState(a, 'done', { report, summary, error: undefined });

    if (asking) {
      const conv = this.convFor(a);
      this.post(conv, 'assistant', asking.question, { agentId: a.id });
      this.post(a.parentConversationId, 'system', `"${a.title}" is waiting for your answer: ${clip(asking.question, 160)}`, { agentId: a.id });
      this.askUser(a.id, conv, asking);
    }
    for (const h of proto.help) this.helpRequested(a, h);

    // Direct prompts that arrived while running are delivered now, resuming this agent's session.
    const queued = this.followups.get(a.id)?.splice(0) ?? [];
    if (queued.length && !stopped) { this.followUp(a, queued.join('\n\n')); return; }
    if (a.state !== 'waiting') this.finished(a);
    else this.pump(a.projectId);
  }

  /**
   * Run the project's checks on the helper's committed branch head. These are evidence; the helper's own HARBOR_RESULT
   * checks are claims. With no checks configured nothing changes. Returns the text appended to the report.
   */
  private async runChecks(a: AgentRecord, head: string, signal?: AbortSignal): Promise<string> {
    const cmds = (this.d.loadChecks ?? loadProjectChecks)(this.project(a.projectId).path);
    if (!cmds.length || !a.worktree) return '';
    const run = this.d.runCheck ?? runShellCheck;
    this.post(this.convFor(a), 'system', `Harbor is running checks on ${a.branch}: ${cmds.join(', ')}`, { agentId: a.id });
    const runs: CheckRun[] = [];
    for (const cmd of cmds) {
      if (signal?.aborted) break;
      runs.push({ cmd, ...(await run(cmd, a.worktree, signal)) });
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
        const patch = await this.d.git.diffBinary(worktree, base, head, hidden);
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

    this.pump(a.projectId);
    if (!a.byUser) this.maybeReportToMain(a);
  }

  /** Resume the lead only when its judgement is needed: planner done, any failure, or all work finished. */
  private maybeReportToMain(a: AgentRecord): void {
    const { store } = this.d;
    // User-started integrations and rollbacks are left out: they never report, so they must not hold back the lead's report either.
    const agents = store.listAgentRecords(a.projectId).filter((x) => x.role !== 'main' && !x.byUser && x.parentConversationId === a.parentConversationId);
    const active = agents.some((x) => x.state === 'queued' || x.state === 'working' || x.state === 'waiting');
    const needsMain = a.role === 'planner' || a.state === 'failed' || !active;
    if (!needsMain) return;
    const unreported = agents.filter((x) => TERMINAL.includes(x.state) && !this.reported.has(`${x.id}:${x.revision}:${x.state}`));
    if (!unreported.length) return;
    // A stop-all should not trigger a flurry of lead turns.
    if (unreported.every((x) => x.state === 'stopped')) { unreported.forEach((x) => this.reported.add(`${x.id}:${x.revision}:${x.state}`)); return; }
    const turns = (this.autoTurns.get(a.parentConversationId) ?? 0) + 1;
    this.autoTurns.set(a.parentConversationId, turns);
    if (turns > (this.d.maxAutoTurns ?? 12)) {
      this.post(a.parentConversationId, 'system', 'Paused automatic coordination after many consecutive steps. Send a message to continue.');
      return;
    }
    unreported.forEach((x) => this.reported.add(`${x.id}:${x.revision}:${x.state}`));
    this.enqueueMain(a.projectId, { kind: 'reports', items: unreported }, a.parentConversationId);
  }

  // ------------------------------------------------------------ integration (Harbor's own git code, no CLI)

  /** Reviewers of a helper: those that waited for it, or examined its worktree. */
  private reviewersOf(projectId: Id, src: AgentRecord): AgentRecord[] {
    return this.d.store.listAgentRecords(projectId).filter((r) => r.role === 'reviewer' &&
      (r.dependsOn.includes(src.id) || (!!src.worktree && !!r.testedWorktree && normPath(r.testedWorktree) === normPath(src.worktree))));
  }

  /** The user asks Harbor to integrate finished helpers' branches. Queued like a helper, after the sources and their reviewers. */
  integrateBranches(projectId: Id, agentIds: Id[], target?: string): AgentRecord {
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
    const rec: AgentRecord = {
      id: newId(), projectId, parentId: store.mainAgent(projectId)?.id, role: 'other', title, state: 'queued', cli: 'harbor', model: 'git', effort: 'low',
      task: `Merge the approved branches of ${sources.map((s) => `"${s.title}" (${s.branch})`).join(', ')} into a new integration branch${target ? ` for ${target.trim()}` : ''}.`,
      dependsOn: [...deps], revision: 1, attempts: 0, created: Date.now(), byUser: true,
      parentConversationId: sources.find((s) => s.parentConversationId)?.parentConversationId ?? this.ensureProject(project).conversation.id,
      integration: { target: target?.trim(), sources: sources.map((s) => ({ agentId: s.id, state: 'pending' })) }
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
      this.setState(a, state, { report, summary, error });
      this.finished(a);
    };
    const refuse = (why: string) => end('failed', `Integration refused. Nothing was merged.\n${why}`, `Refused: ${why}`);

    if (!(await git.isRepoWithCommits(project.path))) return refuse('the project folder is not a git repository with commits.');
    // 1. Target (as the ref is really spelled: on Windows "Main" reaches "main") and base. A re-run keeps the base its
    // integration branch was built on while the target is still there; once the target moved it starts fresh from the new head.
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
    if (signal?.aborted) return end('stopped', `${report}\n\nStopped by the user.`, 'Stopped by the user.');
    if (conflict) {
      const why = conflict.paths.length ? `"${conflict.title}" conflicts in ${conflict.paths.join(', ')}` : `"${conflict.title}" could not be merged: ${clip(conflict.output, 300)}`;
      report += `\n\nThe merge was aborted; branches merged before it stay on ${a.branch}. Resolve the conflict on the source branch (or in a new helper), have it reviewed again, then run the integration again.`;
      return end('failed', report, `Merge conflict: ${why}`);
    }

    // 5. Checks on the combined result: the sources' own checks do not cover it.
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
      if (await git.isDirty(project.path)) throw new Error('The project folder has uncommitted changes. Commit or stash them first; Harbor does not overwrite your work.');
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
      this.setState(a, state, { report, summary, error });
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
    // The journal has no rollback kind yet (journal.ts is owned elsewhere); 'triage' marks it as something to look back at.
    this.log({ kind: 'triage', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id,
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
  private followUp(a: AgentRecord, text: string): void {
    if (this.running.has(a.id)) { const q = this.followups.get(a.id) ?? []; q.push(text); this.followups.set(a.id, q); return; }
    this.begin(a.id);
    // An integrator has no CLI session: any message (or resume) runs the integration again, which is idempotent.
    if (a.integration) { void this.runIntegration(a).catch((e) => this.failAgent(a, `Internal error: ${String(e?.message ?? e)}`)); return; }
    if (a.rollback) { void this.runRollback(a).catch((e) => this.failAgent(a, `Internal error: ${String(e?.message ?? e)}`)); return; }
    void (async () => {
      let cwd = a.worktree ?? this.project(a.projectId).path;
      if (a.role === 'reviewer' && a.testedWorktree) {
        // A reviewer's follow-up looks at the reviewed branch again, so its next verdict covers the head it sees now.
        const tested = await this.d.git.head(a.testedWorktree).catch(() => undefined);
        if (tested) { cwd = a.testedWorktree; Object.assign(a, { testedCommit: tested, outdated: false }); }
      }
      if (this.canEdit(a) && !a.worktree) {
        const r = this.locks.acquire(a.projectId, a.id, a.files?.length ? a.files : [WHOLE_PROJECT]);
        if (!r.ok) { this.running.delete(a.id); this.post(this.convFor(a), 'system', 'Another agent owns the files this agent needs; try again when it finishes.', { agentId: a.id }); return; }
      }
      this.setState(a, 'working', { error: undefined });
      const res = await this.execute(a, text, { cwd, resume: true });
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
    this.emit({ type: 'question', requestId, conversationId, agentId, prompt: ask.question, options: ask.options.length ? ask.options : undefined, allowText: ask.allowText });
  }

  async answerQuestion(requestId: Id, answer: string): Promise<void> {
    const q = this.questions.get(requestId);
    if (!q) throw new Error('This question is no longer pending. Answer in the chat instead.');
    if (!answer.trim()) throw new Error('Choose an option or type an answer.');
    this.questions.delete(requestId);
    await this.userMessage(q.conversationId, answer.trim());
  }

  // ------------------------------------------------------------ tool permissions

  /**
   * A running CLI asks whether it may run a tool call outside its allowlist. A project rule answers at once; otherwise the
   * user is asked through a `permission` event. Only this run waits: other agents and the queue go on, and an unanswered
   * request is denied after the timeout (or when the run stops), with a message the agent sees.
   */
  private askTool(agent: AgentRecord, conversationId: Id, run: number, req: ToolPermissionRequest, signal: AbortSignal): Promise<ToolPermissionDecision> {
    const projectId = agent.projectId;
    const tool = req.tool || 'unknown tool';
    // The journal gets the tool name only: inputs can hold paths, commands or secrets.
    const journal = (text: string) => this.log({ kind: PERMISSION_KIND, projectId, conversationId, agentId: agent.id, text: `${tool}: ${text}` });
    if (this.d.store.listToolRules(projectId).some((r) => matchesToolRule(r, req.tool, req.input))) {
      journal('allowed by a project rule');
      return Promise.resolve({ allow: true });
    }
    if (signal.aborted) {
      journal('denied: the run had already stopped');
      return Promise.resolve({ allow: false, message: 'Harbor denied this tool call because the run was stopping.' });
    }
    const requestId = newId();
    const rule = toolRuleFor(req.tool, req.input);
    const timeoutMs = this.d.toolPermissionTimeoutMs ?? TOOL_PERMISSION_TIMEOUT_MS;
    const n = timeoutMs >= 60_000 ? Math.round(timeoutMs / 60_000) : Math.max(1, Math.round(timeoutMs / 1000));
    const minutes = `${n} ${timeoutMs >= 60_000 ? 'minute' : 'second'}${n === 1 ? '' : 's'}`;
    const who = agent.role === 'main' ? 'The lead agent' : `"${agent.title}"`;
    const what = toolSummary(req);
    const prompt = `${who} asks to run ${tool}${what ? `: ${what}` : ''}`;
    return new Promise<ToolPermissionDecision>((resolve) => {
      let cancelTimer = (): void => {};
      const onAbort = (): void => { this.finishToolAsk(requestId, { allow: false, message: 'Harbor cancelled this permission request because the run stopped.' }, 'cancelled: the run stopped'); };
      const event: PendingPermission = { type: 'permission', requestId, kind: 'tool', prompt, agentId: agent.id, conversationId, tool, alwaysAllow: !!rule, expiresAt: Date.now() + timeoutMs };
      this.toolAsks.set(requestId, {
        agentId: agent.id, projectId, conversationId, run, tool, rule, event,
        settle: (d) => { cancelTimer(); signal.removeEventListener('abort', onAbort); resolve(d); }
      });
      signal.addEventListener('abort', onAbort, { once: true });
      cancelTimer = (this.d.setTimer ?? defaultTimer)(() => {
        this.finishToolAsk(requestId,
          { allow: false, message: `Denied: the user did not answer this permission request within ${minutes}. Continue without this tool call; if you cannot, say what you need in your report.` },
          'denied: no answer in time', `No answer within ${minutes}: denied ${tool}. The agent was told to continue without it.`);
      }, timeoutMs);
      const choices = rule ? 'allow once, always allow for this project, or deny' : 'allow once or deny (this call cannot be always-allowed)';
      this.post(conversationId, 'system', `${prompt}\nWaiting for your answer (${choices}). Denied automatically after ${minutes}.`, { agentId: agent.id });
      journal('asked the user');
      this.emit(event);
    });
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
    this.log({ kind: PERMISSION_KIND, projectId: p.projectId, conversationId: p.conversationId, agentId: p.agentId, text: `${p.tool}: ${journalText}` });
    if (chat) this.post(p.conversationId, 'system', chat, { agentId: p.agentId });
    p.settle(d);
    return true;
  }

  // ------------------------------------------------------------ help requests

  private helpRequested(a: AgentRecord, h: HelpRequest): void {
    this.d.store.addCoordination({ projectId: a.projectId, kind: 'help', from: a.id, text: `${h.reason} → ${h.proposedRole}: ${h.instructions}` });
    this.post(this.convFor(a), 'system', `Requested help from the lead: ${h.instructions || h.reason}`, { agentId: a.id });
    this.enqueueMain(a.projectId, { kind: 'help', from: a, reason: h.reason, proposedRole: h.proposedRole, instructions: h.instructions, blocked: h.blocked }, a.parentConversationId);
  }

  // ------------------------------------------------------------ routed execution with fallback

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

  private async runAttempts(agent: AgentRecord, o: RoutedOptions,
    onToolPermission: ((req: ToolPermissionRequest, signal: AbortSignal) => Promise<ToolPermissionDecision>) | undefined): Promise<RoutedRun> {
    const { store, ledger } = this.d;
    const exclude: CliId[] = [];
    let pinned = o.requireCli;
    const key = o.sessionKey ?? agent.id;
    let lastError = 'No eligible CLI is available. Open Settings to install or sign in to a supported CLI.';
    // A rate limit now cools down one model, not the CLI, so a CLI may be tried again with a cheaper model before another CLI.
    const maxAttempts = Math.max(1, this.d.getClis().length * 3);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const link = store.getSession(key);
      // Read every attempt: a settings change applies to the next routing decision, not only to new agents.
      const eff = effectiveSettings(store.getSettings(), agent.projectId);
      const routeWith = (requireCli?: CliId) => route({ role: o.role, complexity: o.complexity, tier: o.tier, needs: o.needs, effort: o.effort, fixedEffort: o.fixedEffort, retry: o.retry, prefer: o.preferCli, continuity: o.resume ? link?.cli : undefined, exclude, requireCli }, {
        clis: this.d.getClis(), ledger, enabled: this.d.enabled, hasAdapter: (c) => !!this.d.adapterFor(c),
        load: (c) => store.allAgentRecords().filter((x) => x.cli === c && this.running.has(x.id) && x.id !== agent.id).length,
        verified: this.d.verified, catalog: this.d.catalog,
        policy: {
          allowedModels: eff.allowedModels, effortPolicy: eff.effortPolicy, lowAllowance: eff.lowAllowancePolicy, reserve: eff.subscriptionReserve,
          preference: o.role === 'main' ? undefined : eff.rolePreferences[o.role]
        }
      });
      let decision = routeWith(pinned);
      if (!decision && pinned) {
        // A pin is a preference, not a requirement: never leave the helper without a model because one CLI is missing or exhausted.
        this.post(o.conversationId, 'system', `${agent.title}: pinned CLI ${pinned} is unavailable, using normal routing.`, { agentId: agent.id });
        pinned = undefined;
        decision = routeWith();
      }
      if (!decision) return { ok: false, text: '', error: attempt === 0 ? lastError : `${lastError} (no remaining CLI to fall back to)` };
      const adapter = this.d.adapterFor(decision.cli)!;
      const resumeId = o.resume && link?.cli === decision.cli ? link.sessionId : undefined;
      if (o.resume && !resumeId && link) this.addNote(o.conversationId, `${agent.title}: continuing on ${decision.cli} without the previous ${link.cli} session`);
      this.setState(agent, agent.state, { cli: decision.cli, model: decision.model, effort: decision.effort, attempts: attempt });
      if (agent.role === 'main') {
        const c = store.getConversation(o.conversationId);
        if (c?.activity) store.patchConversation(c.id, { activity: { ...c.activity, cli: decision.cli, model: decision.model, complexity: o.complexity, effort: decision.effort } });
        this.sessionState(o.conversationId, 'working', o.sessionKey?.startsWith('concierge:') ? 'First pass: checking your request.' : 'Lead agent: working on your request.');
      }
      if (attempt > 0) this.post(o.conversationId, 'system', `Falling back to ${decision.cli}: ${lastError}`, { agentId: agent.id });
      const prompt = !resumeId && o.contextIfNoResume ? `${o.contextIfNoResume}\n\n${o.prompt}` : o.prompt;

      // `final` is the CLI's own final answer; the joined `text` also holds mid-run narration that must not become the report.
      let text = '', final = '', ok = false, error: string | undefined, rateLimited = false, usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } = {};
      let limits: Extract<Chunk, { kind: 'limits' }>['limits'] | undefined;
      let streamId: Id | undefined;
      const details = { cli: decision.cli, model: decision.model, effort: decision.effort, reason: decision.reason };
      const t0 = Date.now();
      try {
        for await (const c of adapter.run(prompt, { cwd: o.cwd, model: decision.model, effort: decision.effort as Effort, resumeId, permission: o.permission, images: o.images, systemPrompt: o.system, denyGitWrites: o.denyGitWrites, onToolPermission, signal: o.signal }) as AsyncIterable<Chunk>) {
          if (c.kind === 'session') store.setSession({ agentId: key, cli: decision.cli, sessionId: c.id, updated: Date.now() });
          else if (c.kind === 'text') {
            text += (text ? '\n\n' : '') + c.text;
            if (o.stream) {
              const shown = stripProtocol(c.text); // protocol lines are machine-readable, not transcript
              if (!shown) continue;
              if (!streamId) streamId = this.post(o.conversationId, 'assistant', shown, { agentId: agent.id, details }).id;
              else {
                const m = store.getMessage(streamId)!;
                store.updateMessage(streamId, { text: `${m.text}\n\n${shown}` });
                this.emit({ type: 'messageDelta', messageId: streamId, conversationId: o.conversationId, text: `\n\n${shown}` });
              }
            }
          } else if (c.kind === 'tool') { if (o.stream) { streamId = undefined; this.post(o.conversationId, 'tool', c.text, { agentId: agent.id }); } }
          else if (c.kind === 'usage') usage = { ...usage, ...c };
          else if (c.kind === 'limits') limits = c.limits;
          else if (c.kind === 'done') { ok = c.ok; error = c.error; rateLimited = !!c.rateLimited; if (c.text) final = c.text; }
        }
      } catch (e) { ok = false; error = String((e as Error).message ?? e); }

      const stopped = o.signal.aborted;
      ledger.record({ cli: decision.cli, model: decision.model, projectId: agent.projectId, agentId: agent.id, conversationId: o.conversationId, durationMs: Date.now() - t0, ok, rateLimited, limits, ...usage });
      this.emit({ type: 'usage', windows: ledger.windows(this.d.getClis().map((c) => c.id)) });
      if (rateLimited) void this.d.freeReset?.maybePropose(decision.cli).catch(() => {});
      if (ok) return { ok: true, text: final || text, allText: text, decision };
      if (stopped) return { ok: false, text, stopped: true, decision, error: 'stopped' };
      lastError = `${decision.cli} failed${rateLimited ? ' (rate limit)' : ''}: ${clip(error ?? 'unknown error', 300)}`;
      // A rate limit is held against the model in the ledger (it may be a per-model cap); anything else is a CLI-level failure.
      if (!rateLimited) exclude.push(decision.cli);
      store.patchAgent(agent.id, { attempts: attempt + 1 });
    }
    return { ok: false, text: '', error: lastError };
  }
}

// ---------------------------------------------------------------- helpers

export function toAgent(a: AgentRecord): Agent {
  return { id: a.id, projectId: a.projectId, parentId: a.parentId, role: a.role, title: a.title, state: a.state, cli: a.cli, model: a.model, effort: a.effort, worktree: a.worktree, priority: a.priority, paused: a.paused || undefined, testedCommit: a.testedCommit, outdated: a.testedCommit ? a.outdated : undefined, result: a.result, checks: a.checks?.map(({ cmd, ok, exitCode, timedOut, durationMs }) => ({ cmd, ok, exitCode, timedOut, durationMs })), integration: a.integration && structuredClone(a.integration), rollback: a.rollback && structuredClone(a.rollback), conversationId: a.parentConversationId || undefined, summary: a.state === 'done' ? a.summary : (a.summary ?? a.error) };
}

/** What the user sees about a tool call: the command, path or URL it acts on, clipped. */
function toolSummary(req: ToolPermissionRequest): string {
  const i = (req.input ?? {}) as Record<string, unknown>;
  const v = [i['command'], i['file_path'], i['notebook_path'], i['url'], i['path'], i['pattern'], i['query']].find((x) => typeof x === 'string' && x.trim());
  const parts = [typeof v === 'string' ? clip(v.trim(), 300) : '', req.description ? clip(req.description, 200) : ''].filter(Boolean);
  return parts.join(' (') + (parts.length > 1 ? ')' : '');
}

const firstLine = (s: string): string => clip(s.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) ?? s, 200).trim();
