import type { Agent, AgentRole, AgentState, Attachment, CliId, Conversation, ConversationMode, HarborEvent, Id, Message, Project, SessionActivity } from '../shared/api';
import type { Chunk, CliAdapter, Effort } from './adapters/types';
import type { CatalogEntry, Need, Tier } from './clis/capabilities';
import { loadChecks as loadProjectChecks, runShellCheck, type CheckRunner } from './checks';
import type { ResolvedCli } from './clis/discovery';
import type { Git } from './git';
import { breakCycles } from './graph';
import { Journal, journalDigest, type JournalEntry } from './journal';
import { LockTable, WHOLE_PROJECT } from './locks';
import {
  CONCIERGE_SYSTEM, LEAD_SYSTEM, clip, conciergePrompt, historyText, imageBriefText, isApproval, leadPrompt, needsWorkspace, parseConcierge, parseProtocol, stripProtocol, subagentPrompt, systemFor,
  type AskRequest, type Escalation, type HelpRequest, type LeadTrigger, type PlannedTask
} from './prompts';
import { matchesTracked, setSpawnObserver, systemKiller, type ProcessKiller } from './proc';
import { effortFor, route, type Complexity, type RouteDecision } from './router';
import { DEFAULT_CONCURRENCY, effectiveSettings, newId, type Store } from './store';
import type { AgentRecord, CheckRun } from './types';
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
  ask: (kind: 'freeReset' | 'tool' | 'conflict', prompt: string, agentId?: Id) => Promise<boolean>;
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
}

export interface OrphanSweep { killed: number[]; skipped: number[] }

const RESUME_PROMPT = 'Harbor was interrupted while you were working and has restarted. Continue your assignment from your session. First check the current state (git status and git log in your worktree, and any files you were changing). Do not repeat steps that already completed, in particular commits, pushes, installs, or any other action with external effects; do only what is still missing, then report.';

const EDIT_ROLES: AgentRole[] = ['implementer', 'other'];
const CX_UP_ORDER: Complexity[] = ['low', 'medium', 'high'];
const TERMINAL: AgentState[] = ['done', 'failed', 'stopped'];
const DEFAULT_TITLE = 'New conversation';
const GOAL_MAX_CONTINUATIONS = 8;

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
  /** Edit helpers already told they are held back by plan mode (one note each). */
  private planHeldNoted = new Set<Id>();
  /** Open questions to the user. In memory only: after a restart the question text is still in the chat to answer by typing. */
  private questions = new Map<Id, { agentId: Id; conversationId: Id }>();
  private sessionGeneration = new Map<Id, number>();
  private stoppedSessions = new Set<Id>();

  private startedAt = Date.now();
  /** Settles when the orphan sweep started by recover() is done. */
  private sweep: Promise<OrphanSweep> = Promise.resolve({ killed: [], skipped: [] });
  readonly journal: Journal;

  constructor(private d: OrchestratorDeps) {
    this.locks = new LockTable(() => d.store.locks, (l) => d.store.setLocks(l));
    this.journal = d.journal ?? new Journal();
    // Every CLI process this run starts is persisted, so a crash cannot leave one that the next run cannot identify.
    setSpawnObserver({ spawned: (p) => d.store.trackProcess(p), exited: (pid) => d.store.untrackProcess(pid) });
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
    for (const a of this.d.store.allAgentRecords()) {
      if (a.state === 'working') {
        this.setState(a, 'stopped', { error: 'Harbor restarted while this agent was running. Its worktree and any commits are preserved; send a message to continue.' });
      }
      if (a.role === 'main') this.setState(a, 'waiting');
    }
    this.d.store.setLocks(this.d.store.locks.filter((l) => this.running.has(l.agentId)));
    for (const p of this.d.store.listProjects()) this.pump(p.id);
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
    for (const t of old) store.untrackProcess(t.pid);
    const out: OrphanSweep = { killed: [], skipped: [] };
    for (const t of old) {
      try {
        if (matchesTracked(t, await killer.inspect(t.pid))) { await killer.kill(t.pid); out.killed.push(t.pid); } else out.skipped.push(t.pid);
      } catch { out.skipped.push(t.pid); }
    }
    return out;
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
    if (!this.d.store.getSession(a.id)) throw new Error('This agent has no saved session to resume. Send it a message instead.');
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
      for (const [, l] of active) l.ctl.abort();
      return;
    }
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

  /** The working agent: reads, edits, runs commands, and delegates through HARBOR_DELEGATE lines when that pays off. */
  private async leadTurn(project: Project, main: AgentRecord, trigger: LeadTrigger, conversationId: Id, plan: Escalation, signal: AbortSignal): Promise<void> {
    const notes = this.notes.get(conversationId) ?? [];
    this.notes.delete(conversationId);
    const history = this.chatHistory(conversationId, trigger.kind === 'user');
    const tier: Tier = plan.complexity === 'high' ? 'strong' : plan.complexity === 'low' ? 'cheap' : 'standard';
    const conv = this.d.store.getConversation(conversationId);
    const mode = conv?.mode ?? 'default';
    const goal = mode === 'goal' ? conv?.goal : undefined;
    const goalMode = !!goal;
    const out = await this.runRouted(main, {
      prompt: leadPrompt(project.name, this.registerFor(project.id, conversationId), trigger, { notes, mode, goal }), system: LEAD_SYSTEM,
      contextIfNoResume: history.length ? `Conversation so far (your earlier session is not available):\n${historyText(history)}` : undefined,
      role: 'main', complexity: plan.complexity, tier, effort: plan.effort ?? effortFor('main', plan.complexity), fixedEffort: plan.effort !== undefined, needs: plan.needs,
      permission: mode === 'plan' ? 'read-only' : mode === 'auto' ? 'full' : 'edit', cwd: project.path,
      images: trigger.kind === 'user' ? trigger.images : undefined,
      signal, resume: true, conversationId, stream: true, sessionKey: `lead:${conversationId}`
    });
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
    const created = this.createTasks(project, delegations, conversationId, trigger.kind === 'help' ? trigger.from.id : undefined);
    for (const b of proto.image) this.post(conversationId, 'assistant', imageBriefText(b), { agentId: main.id });
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

  /** True while any helper of the conversation (not only this turn's) is queued, running or waiting. */
  private helpersActive(projectId: Id, conversationId: Id): boolean {
    return this.registerFor(projectId, conversationId).some((x) => x.state === 'queued' || x.state === 'working' || x.state === 'waiting');
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
    for (const t of tasks) {
      const id = refToId.get(t.ref)!;
      const deps = new Set(t.dependsOn.map(resolve).filter((x): x is Id => !!x && x !== id));
      const spec = t.specFrom ? resolve(t.specFrom) : undefined;
      if (spec && spec !== id) deps.add(spec);
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
      const bad = deps.find((x) => x.state === 'failed' || x.state === 'stopped');
      if (bad) {
        this.setState(a, 'failed', { error: `Blocked: dependency "${bad.title}" ${bad.state}. Nothing was run.` });
        this.finished(a);
        continue;
      }
      const pending = deps.find((x) => x.state !== 'done');
      if (pending) { if (a.state !== 'queued' || a.error !== `Waiting for "${pending.title}"`) this.setState(a, 'queued', { error: `Waiting for "${pending.title}"` }); continue; }
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
    if (!this.canEdit(a) || a.sharedOk) return true;
    const files = a.files?.length ? a.files : [WHOLE_PROJECT];
    const r = this.locks.acquire(a.projectId, a.id, files);
    if (r.ok) return true;
    const holder = this.d.store.getAgent(r.conflicts[0]!.holder);
    const summary = `Waiting for "${holder?.title ?? 'another agent'}" to release ${r.conflicts.map((c) => c.file).join(', ')}`;
    if (a.error !== summary) this.setState(a, 'queued', { error: summary });
    if (!this.conflictAsked.has(a.id)) {
      this.conflictAsked.add(a.id);
      this.d.store.addCoordination({ projectId: a.projectId, kind: 'conflict', from: a.id, to: holder?.id, text: summary, files: r.conflicts.map((c) => c.file) });
      this.post(a.parentConversationId, 'system', `File conflict: "${a.title}" needs ${r.conflicts.map((c) => c.file).join(', ')} which "${holder?.title}" is editing.`);
      void this.d.ask('conflict', `"${a.title}" wants to edit ${r.conflicts.map((c) => c.file).join(', ')}, currently owned by "${holder?.title}". Allow it to proceed in parallel? (Each works in its own worktree; the results will need integration.) Choose No to make it wait.`, a.id).then((allow) => {
        this.d.store.addCoordination({ projectId: a.projectId, kind: 'decision', text: `User ${allow ? 'allowed parallel editing' : 'chose to serialize'} for "${a.title}"`, from: a.id });
        if (allow) { a.sharedOk = true; this.d.store.upsertAgent(a); }
        this.pump(a.projectId);
      });
    }
    return false;
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
      resume: o.resume, conversationId: this.convFor(a), stream: true
    });
  }

  /** Flag verification of a branch as outdated once its head differs from the commit that was tested. */
  private markOutdated(projectId: Id, worktree: string, head: string): void {
    for (const x of this.d.store.listAgentRecords(projectId)) {
      if (x.testedWorktree !== worktree || !x.testedCommit) continue;
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

  private finished(a: AgentRecord): void {
    const { store } = this.d;
    this.conflictAsked.delete(a.id);
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
    this.maybeReportToMain(a);
  }

  /** Resume the lead only when its judgement is needed: planner done, any failure, or all work finished. */
  private maybeReportToMain(a: AgentRecord): void {
    const { store } = this.d;
    const agents = store.listAgentRecords(a.projectId).filter((x) => x.role !== 'main' && x.parentConversationId === a.parentConversationId);
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

  // ------------------------------------------------------------ help requests

  private helpRequested(a: AgentRecord, h: HelpRequest): void {
    this.d.store.addCoordination({ projectId: a.projectId, kind: 'help', from: a.id, text: `${h.reason} → ${h.proposedRole}: ${h.instructions}` });
    this.post(this.convFor(a), 'system', `Requested help from the lead: ${h.instructions || h.reason}`, { agentId: a.id });
    this.enqueueMain(a.projectId, { kind: 'help', from: a, reason: h.reason, proposedRole: h.proposedRole, instructions: h.instructions, blocked: h.blocked }, a.parentConversationId);
  }

  // ------------------------------------------------------------ routed execution with fallback

  private async runRouted(agent: AgentRecord, o: RoutedOptions): Promise<RoutedRun> {
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
      const routeWith = (requireCli?: CliId) => route({ role: o.role, complexity: o.complexity, tier: o.tier, needs: o.needs, effort: o.effort, fixedEffort: o.fixedEffort, retry: o.retry, continuity: o.resume ? link?.cli : undefined, exclude, requireCli }, {
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
        for await (const c of adapter.run(prompt, { cwd: o.cwd, model: decision.model, effort: decision.effort as Effort, resumeId, permission: o.permission, images: o.images, systemPrompt: o.system, signal: o.signal }) as AsyncIterable<Chunk>) {
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
  return { id: a.id, projectId: a.projectId, parentId: a.parentId, role: a.role, title: a.title, state: a.state, cli: a.cli, model: a.model, effort: a.effort, worktree: a.worktree, priority: a.priority, paused: a.paused || undefined, testedCommit: a.testedCommit, outdated: a.testedCommit ? a.outdated : undefined, result: a.result, checks: a.checks?.map(({ cmd, ok, exitCode, timedOut, durationMs }) => ({ cmd, ok, exitCode, timedOut, durationMs })), conversationId: a.parentConversationId || undefined, summary: a.state === 'done' ? a.summary : (a.summary ?? a.error) };
}

const firstLine = (s: string): string => clip(s.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) ?? s, 200).trim();
