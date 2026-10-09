import type { Agent, AgentRole, AgentState, CliId, Conversation, HarborEvent, Id, Message, Project, SessionActivity } from '../shared/api';
import type { Chunk, CliAdapter, Effort } from './adapters/types';
import type { CatalogEntry, Need, Tier } from './clis/capabilities';
import { loadChecks as loadProjectChecks, runShellCheck, type CheckRunner } from './checks';
import type { ResolvedCli } from './clis/discovery';
import type { Git } from './git';
import { breakCycles } from './graph';
import { Journal, journalDigest, type JournalEntry } from './journal';
import { LockTable, WHOLE_PROJECT } from './locks';
import {
  CONCIERGE_SYSTEM, LEAD_SYSTEM, clip, conciergePrompt, historyText, imageBriefText, leadPrompt, needsWorkspace, parseConcierge, parseProtocol, stripProtocol, subagentPrompt, systemFor,
  type AskRequest, type Escalation, type HelpRequest, type LeadTrigger, type PlannedTask
} from './prompts';
import { route, type Complexity, type RouteDecision } from './router';
import { newId, type Store } from './store';
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
}

const EDIT_ROLES: AgentRole[] = ['implementer', 'other'];
const CX_UP_ORDER: Complexity[] = ['low', 'medium', 'high'];
const TERMINAL: AgentState[] = ['done', 'failed', 'stopped'];
const DEFAULT_TITLE = 'New conversation';

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
  permission: 'read-only' | 'edit';
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
  /** Running lead turns by conversation, so Stop can reach them and conversations never block each other. */
  private leads = new Map<Id, { ctl: AbortController; projectId: Id }>();
  private leadActive = new Map<Id, number>();
  /** What the concierge last decided per conversation: the lead keeps its tier for report and help turns. */
  private plans = new Map<Id, Escalation>();
  /** Conversations where the lead asked a question: the next user message answers it and skips the concierge. */
  private leadAsked = new Set<Id>();
  private conflictAsked = new Set<Id>();
  /** Open questions to the user. In memory only: after a restart the question text is still in the chat to answer by typing. */
  private questions = new Map<Id, { agentId: Id; conversationId: Id }>();
  private sessionGeneration = new Map<Id, number>();
  private stoppedSessions = new Set<Id>();
  /** Last front-desk outcome per conversation, to notice the user overriding an answer with /deep. */
  private lastTriage = new Map<Id, 'answer' | 'escalate'>();
  readonly journal: Journal;

  constructor(private d: OrchestratorDeps) {
    this.locks = new LockTable(() => d.store.locks, (l) => d.store.setLocks(l));
    this.journal = d.journal ?? new Journal();
  }

  get lockTable(): LockTable { return this.locks; }

  private log(e: Omit<JournalEntry, 'time'>): void { this.journal.add(e); }

  // ------------------------------------------------------------ plumbing

  private emit(e: HarborEvent): void { this.d.bus.emit(e); }

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

  // ------------------------------------------------------------ user input

  async userMessage(conversationId: Id, text: string): Promise<void> {
    const conv = this.d.store.getConversation(conversationId);
    if (!conv) throw new Error('Unknown conversation');
    const agent = this.d.store.getAgent(conv.agentId);
    if (!agent) throw new Error('Conversation has no agent');
    if (conv.archived) throw new Error('Restore this conversation before sending a message.');
    const posted = this.post(conversationId, 'user', text, { agentId: agent.id });
    for (const [id, q] of this.questions) if (q.conversationId === conversationId) this.questions.delete(id);
    if (conv.title === DEFAULT_TITLE && !conv.customTitle) this.d.store.touchConversation(conv.id, { title: clip(text.replace(/\s+/g, ' '), 50) });
    if (agent.role === 'main') {
      this.autoTurns.set(conversationId, 0);
      this.enqueueMain(agent.projectId, { kind: 'user', text, messageId: posted.id }, conversationId);
    } else {
      this.direct(agent, text, conversationId);
    }
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
        const journal = /^\/journal\b\s*(review)?/i.exec(trigger.text);
        if (journal && !journal[1]) { this.post(conversationId, 'system', journalDigest(this.journal.list(projectId)), { agentId: main.id }); return; }
        const deep = /^\/deep\b\s*/i.exec(trigger.text);
        if (journal) {
          // Harbor reviewing its own failures: the lead turns recurring patterns into backlog items.
          plan = { complexity: 'medium', needs: ['planning', 'review'], ack: '' };
          trigger = { ...trigger, text: `Review Harbor's run journal for this project and find recurring problems (prompt-format drift, failing helpers, fallbacks, failed checks, wrong triage). For each real pattern, propose one concrete, bounded BACKLOG.md item with the evidence. Do not change code.\n\n${journalDigest(this.journal.list(projectId), 200)}` };
        } else if (deep) {
          // "/deep" skips the front desk and gives the lead a strong model.
          if (this.lastTriage.get(conversationId) === 'answer') this.log({ kind: 'triage', projectId, conversationId, text: `User re-asked with /deep after a front-desk answer: ${clip(trigger.text, 200)}` });
          plan = { complexity: 'high', needs: ['planning', 'code'], ack: '' };
          trigger = { ...trigger, text: trigger.text.slice(deep[0].length) || trigger.text };
        } else if (!this.leadAsked.has(conversationId)) {
          const c = await this.concierge(project, main, conversationId, trigger.text, ctl.signal, trigger.messageId);
          if (c === 'handled') return;
          plan = c;
        } // else: this message answers the lead's own question, so there is nothing to triage
        this.plans.set(conversationId, plan);
      }
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

  /**
   * Chat history up to (not including) the triggering user message. Cut by id, not position: the concierge's
   * acknowledgement is posted after the user message, so "drop the last one" dropped the ack and kept the prompt twice.
   */
  private chatHistory(conversationId: Id, before?: Id): Message[] {
    let msgs = this.d.store.listMessages(conversationId);
    const i = before ? msgs.findIndex((m) => m.id === before) : -1;
    if (i >= 0) msgs = msgs.slice(0, i);
    return msgs.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-10);
  }

  /** Cheap model: answers simple messages itself, otherwise says what the work needs. Never uses tools. */
  private async concierge(project: Project, main: AgentRecord, conversationId: Id, text: string, signal: AbortSignal, messageId?: Id): Promise<'handled' | Escalation> {
    const out = await this.runRouted(main, {
      prompt: conciergePrompt(project.name, this.registerFor(project.id, conversationId), this.chatHistory(conversationId, messageId).slice(-8), text), system: CONCIERGE_SYSTEM,
      role: 'main', complexity: 'low', tier: 'cheap', effort: 'low', needs: ['chat'], permission: 'read-only', cwd: project.path,
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
    if (d.kind === 'answer' && needsWorkspace(text)) {
      this.log({ kind: 'triage', projectId: project.id, conversationId, text: `Front desk tried to answer a workspace request; escalated instead: ${clip(text, 200)}` });
      this.lastTriage.set(conversationId, 'escalate');
      return { complexity: 'medium', needs: ['code'], ack: '' };
    }
    if (d.kind === 'answer') { this.lastTriage.set(conversationId, 'answer'); this.post(conversationId, 'assistant', d.text, { agentId: main.id, details }); return 'handled'; }
    this.lastTriage.set(conversationId, 'escalate');
    if (!d.parsed) this.log({ kind: 'triage', projectId: project.id, conversationId, text: `Front desk reply was not valid JSON (escalated by default): ${clip(out.text, 200)}` });
    if (d.escalation.ack) this.post(conversationId, 'assistant', d.escalation.ack, { agentId: main.id, details });
    return d.escalation;
  }

  /** The working agent: reads, edits, runs commands, and delegates through HARBOR_DELEGATE lines when that pays off. */
  private async leadTurn(project: Project, main: AgentRecord, trigger: LeadTrigger, conversationId: Id, plan: Escalation, signal: AbortSignal): Promise<void> {
    const notes = this.notes.get(conversationId) ?? [];
    this.notes.delete(conversationId);
    const history = this.chatHistory(conversationId, trigger.kind === 'user' ? trigger.messageId : undefined);
    const tier: Tier = plan.complexity === 'high' ? 'strong' : plan.complexity === 'low' ? 'cheap' : 'standard';
    // Only claim a lost session when there was one: otherwise the model acts as if it forgot something.
    const hadSession = !!this.d.store.getSession(`lead:${conversationId}`);
    const out = await this.runRouted(main, {
      prompt: leadPrompt(project.name, this.registerFor(project.id, conversationId), trigger, { notes }), system: LEAD_SYSTEM,
      contextIfNoResume: history.length ? `Conversation so far${hadSession ? ' (your earlier session could not be resumed)' : ''}:\n${historyText(history)}` : undefined,
      role: 'main', complexity: plan.complexity, tier, effort: plan.complexity, needs: plan.needs, permission: 'edit', cwd: project.path,
      signal, resume: true, conversationId, stream: true, sessionKey: `lead:${conversationId}`
    });
    if (!out.ok) {
      this.sessionState(conversationId, out.stopped ? 'stopped' : 'failed', out.error);
      this.post(conversationId, 'system', out.stopped ? 'Stopped.' : `The lead agent could not run: ${out.error}`, { agentId: main.id });
      if (!out.stopped) this.log({ kind: 'lead-failed', projectId: project.id, conversationId, text: out.error ?? 'unknown error' });
      return;
    }
    const proto = parseProtocol(out.allText ?? out.text);
    if (proto.malformed.length) {
      // Tell the lead next turn, so a broken delegation is redone instead of silently missing.
      this.addNote(conversationId, `Harbor ignored ${proto.malformed.length} malformed protocol line(s) from your last turn: ${proto.malformed.map((l) => clip(l, 120)).join(' | ')}`);
      for (const l of proto.malformed) this.log({ kind: 'protocol', projectId: project.id, conversationId, agentId: main.id, text: `lead: ${l}` });
    }
    const created = this.createTasks(project, proto.delegate, conversationId, trigger.kind === 'help' ? trigger.from.id : undefined);
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
        effort: complexity, task: t.instructions, files: t.files, dependsOn: [...deps], specFromId,
        needs: t.needs, readOnly: t.access === 'read',
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
    const max = this.d.maxActivePerProject ?? 4;
    const all = store.listAgentRecords(projectId).filter((a) => a.role !== 'main').sort((a, b) => a.created - b.created);
    const byId = new Map(all.map((a) => [a.id, a]));
    for (const a of all) {
      if (a.state !== 'queued') continue;
      if (this.running.has(a.id)) continue;
      const deps = a.dependsOn.map((id) => byId.get(id)).filter((x): x is AgentRecord => !!x);
      const bad = deps.find((x) => x.state === 'failed' || x.state === 'stopped');
      if (bad) {
        this.setState(a, 'failed', { error: `Blocked: dependency "${bad.title}" ${bad.state}. Nothing was run.` });
        this.finished(a);
        continue;
      }
      const pending = deps.find((x) => x.state !== 'done');
      if (pending) { if (a.state !== 'queued' || a.error !== `Waiting for "${pending.title}"`) this.setState(a, 'queued', { error: `Waiting for "${pending.title}"` }); continue; }
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
      if (a.role === 'reviewer' && reviewed?.worktree) cwd = reviewed.worktree;
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
    return this.runRouted(a, {
      prompt, system: systemFor(a.role as Exclude<AgentRole, 'main'>), role: a.role, complexity: a.complexity ?? 'medium', needs: a.needs,
      permission: this.canEdit(a) ? 'edit' : 'read-only', cwd: o.cwd, signal: ctl.signal,
      resume: o.resume, conversationId: this.convFor(a), stream: true
    });
  }

  private async afterRun(a: AgentRecord, res: RoutedRun): Promise<void> {
    const { store, git } = this.d;
    // Still "running" while Harbor checkpoints and checks, so stop() aborts the checks instead of finishing the agent twice.
    const ctl = this.controllers.get(a.id);
    let report = stripProtocol(res.text);
    const proto = parseProtocol(res.allText ?? res.text);
    if (proto.result) a.result = proto.result;
    for (const l of proto.malformed) this.log({ kind: 'protocol', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: `${a.role} "${a.title}": ${l}` });
    if (!res.ok && !res.stopped) this.log({ kind: 'helper-failed', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: `${a.role} "${a.title}" on ${a.cli}/${a.model}: ${res.error ?? 'failed'}` });

    if (res.ok && a.worktree && a.baseCommit) {
      const cp = await git.checkpoint(a.worktree, `harbor: ${a.title}`);
      if (cp.head) a.headCommit = cp.head;
      const stat = await git.diffStat(a.worktree, a.baseCommit);
      const files = await git.changedFiles(a.worktree, a.baseCommit);
      if (stat) report += `\n\nChanges on ${a.branch}${cp.committed ? ' (uncommitted work was checkpointed by Harbor)' : ''}:\n${stat}`;
      else report += `\n\nNo changes were committed on ${a.branch}.`;
      const claimed = (a.files ?? []).map((f) => f.replace(/\\/g, '/').toLowerCase());
      const outside = claimed.length ? files.filter((f) => !claimed.some((c) => f.toLowerCase() === c || f.toLowerCase().startsWith(c.replace(/\/?$/, '/')))) : [];
      if (outside.length) {
        const msg = `"${a.title}" changed files outside its claim: ${outside.join(', ')}. Needs coordination before integration.`;
        store.addCoordination({ projectId: a.projectId, kind: 'conflict', from: a.id, text: msg, files: outside });
        this.post(a.parentConversationId, 'system', msg, { agentId: a.id });
        this.log({ kind: 'outside-claim', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: msg });
        report += `\n\nWARNING: edits outside claimed files: ${outside.join(', ')}`;
      }
      if (stat && this.canEdit(a)) report += await this.runChecks(a, ctl?.signal);
    }

    this.running.delete(a.id);
    this.controllers.delete(a.id);
    const stopped = res.stopped || !!ctl?.signal.aborted;
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
   * checks are claims. Returns the text appended to the report.
   */
  private async runChecks(a: AgentRecord, signal?: AbortSignal): Promise<string> {
    const project = this.project(a.projectId);
    const cmds = (this.d.loadChecks ?? loadProjectChecks)(project.path);
    if (!cmds.length || !a.worktree) return '';
    const run = this.d.runCheck ?? runShellCheck;
    this.post(this.convFor(a), 'system', `Harbor is running checks on ${a.branch}: ${cmds.join(', ')}`, { agentId: a.id });
    const runs: CheckRun[] = [];
    for (const cmd of cmds) {
      if (signal?.aborted) break;
      runs.push({ cmd, ...(await run(cmd, a.worktree, signal)) });
    }
    a.checks = runs;
    a.testedCommit = a.headCommit;
    const failed = runs.filter((r) => !r.ok);
    if (failed.length && !signal?.aborted) {
      this.log({ kind: 'checks-failed', projectId: a.projectId, conversationId: a.parentConversationId, agentId: a.id, text: `"${a.title}" on ${a.headCommit?.slice(0, 10) ?? a.branch}: ${failed.map((f) => `${f.cmd} (${f.timedOut ? 'timed out' : `exit ${f.exitCode}`})`).join(', ')}` });
    }
    const lines = runs.map((r) => `- ${r.cmd}: ${r.ok ? 'PASS' : `FAIL (${r.timedOut ? 'timed out' : `exit ${r.exitCode}`})`}${r.ok ? '' : `\n${clip(r.output.split(/\r?\n/).slice(-15).join('\n'), 1500)}`}`);
    return `\n\nChecks Harbor ran on ${a.headCommit?.slice(0, 10) ?? a.branch}:\n${lines.join('\n')}`;
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
      const cwd = a.worktree ?? this.project(a.projectId).path;
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
    const key = o.sessionKey ?? agent.id;
    let lastError = 'No eligible CLI is available. Open Settings to install or sign in to a supported CLI.';
    // A rate limit now cools down one model, not the CLI, so a CLI may be tried again with a cheaper model before another CLI.
    const maxAttempts = Math.max(1, this.d.getClis().length * 3);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const link = store.getSession(key);
      const decision = route({ role: o.role, complexity: o.complexity, tier: o.tier, needs: o.needs, effort: o.effort, continuity: o.resume ? link?.cli : undefined, exclude }, {
        clis: this.d.getClis(), ledger, enabled: this.d.enabled, hasAdapter: (c) => !!this.d.adapterFor(c),
        load: (c) => store.allAgentRecords().filter((x) => x.cli === c && this.running.has(x.id) && x.id !== agent.id).length,
        verified: this.d.verified, catalog: this.d.catalog
      });
      if (!decision) return { ok: false, text: '', error: attempt === 0 ? lastError : `${lastError} (no remaining CLI to fall back to)` };
      const adapter = this.d.adapterFor(decision.cli)!;
      const resumeId = o.resume && link?.cli === decision.cli ? link.sessionId : undefined;
      if (o.resume && !resumeId && link) this.addNote(o.conversationId, `${agent.title}: continuing on ${decision.cli} without the previous ${link.cli} session`);
      this.setState(agent, agent.state, { cli: decision.cli, model: decision.model, effort: decision.effort, attempts: attempt });
      if (agent.role === 'main') {
        const c = store.getConversation(o.conversationId);
        if (c?.activity) store.patchConversation(c.id, { activity: { ...c.activity, cli: decision.cli, model: decision.model } });
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
        for await (const c of adapter.run(prompt, { cwd: o.cwd, model: decision.model, effort: decision.effort as Effort, resumeId, permission: o.permission, systemPrompt: o.system, signal: o.signal }) as AsyncIterable<Chunk>) {
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
      this.log({ kind: 'fallback', projectId: agent.projectId, conversationId: o.conversationId, agentId: agent.id, text: `${agent.role} "${agent.title}" on ${decision.cli}/${decision.model}: ${lastError}` });
      // A rate limit is held against the model in the ledger (it may be a per-model cap); anything else is a CLI-level failure.
      if (!rateLimited) exclude.push(decision.cli);
      store.patchAgent(agent.id, { attempts: attempt + 1 });
    }
    return { ok: false, text: '', error: lastError };
  }
}

// ---------------------------------------------------------------- helpers

export function toAgent(a: AgentRecord): Agent {
  return { id: a.id, projectId: a.projectId, parentId: a.parentId, role: a.role, title: a.title, state: a.state, cli: a.cli, model: a.model, effort: a.effort, worktree: a.worktree, conversationId: a.parentConversationId || undefined, summary: a.state === 'done' ? a.summary : (a.summary ?? a.error) };
}

const firstLine = (s: string): string => clip(s.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) ?? s, 200).trim();
