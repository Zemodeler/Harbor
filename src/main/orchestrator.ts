import type { Agent, AgentRole, AgentState, CliId, Conversation, HarborEvent, Id, Message, Project } from '../shared/api';
import type { Chunk, CliAdapter, Effort } from './adapters/types';
import type { ResolvedCli } from './clis/discovery';
import type { Git } from './git';
import { breakCycles } from './graph';
import { LockTable, WHOLE_PROJECT } from './locks';
import {
  MAIN_SYSTEM, clip, mainPrompt, parseMainOutput, parseProtocol, stripProtocol, subagentPrompt, systemFor,
  type HelpRequest, type MainTrigger, type PlannedTask
} from './prompts';
import { route, type Complexity, type RouteDecision } from './router';
import { newId, type Store } from './store';
import type { AgentRecord } from './types';
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
  worktreesRoot: string;
  /** Raise a permission event and resolve with the user's answer. */
  ask: (kind: 'freeReset' | 'tool' | 'conflict', prompt: string, agentId?: Id) => Promise<boolean>;
  freeReset?: FreeResetCoordinator;
  maxActivePerProject?: number;
  /** Cap on automatic main-agent turns after one user message (guards against runaway loops). */
  maxAutoTurns?: number;
}

const EDIT_ROLES: AgentRole[] = ['implementer', 'other'];
const TERMINAL: AgentState[] = ['done', 'failed', 'stopped'];
const DEFAULT_TITLE = 'New conversation';

interface RoutedRun { ok: boolean; text: string; error?: string; stopped?: boolean; decision?: RouteDecision }

export class Orchestrator {
  private locks: LockTable;
  private controllers = new Map<Id, AbortController>();
  private running = new Set<Id>();
  private mainChain = new Map<Id, Promise<void>>();
  private mailbox = new Map<Id, string[]>();
  private followups = new Map<Id, string[]>();
  private reported = new Set<Id>();
  private notes = new Map<Id, string[]>();
  private autoTurns = new Map<Id, number>();
  private conflictAsked = new Set<Id>();
  private idle = new Set<() => void>();

  constructor(private d: OrchestratorDeps) {
    this.locks = new LockTable(() => d.store.locks, (l) => d.store.setLocks(l));
  }

  get lockTable(): LockTable { return this.locks; }

  // ------------------------------------------------------------ plumbing

  private emit(e: HarborEvent): void { this.d.bus.emit(e); }

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

  private addNote(projectId: Id, note: string): void {
    const n = this.notes.get(projectId) ?? [];
    n.push(clip(note, 300));
    this.notes.set(projectId, n.slice(-10));
  }

  /** Resolves when no agent work or main turn is in flight (used by tests and the smoke script). */
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
        id: newId(), projectId: project.id, role: 'main', title: 'Main agent', state: 'waiting',
        cli: 'auto', model: 'auto', effort: 'low', task: 'Coordinate project work', dependsOn: [], revision: 1,
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
    this.post(conversationId, 'user', text, { agentId: agent.id });
    if (conv.title === DEFAULT_TITLE) this.d.store.touchConversation(conv.id, { title: clip(text.replace(/\s+/g, ' '), 50) });
    if (agent.role === 'main') {
      this.autoTurns.set(agent.projectId, 0);
      this.enqueueMain(agent.projectId, { kind: 'user', text }, conversationId);
    } else {
      this.direct(agent, text, conversationId);
    }
  }

  stop(agentId: Id): void {
    const a = this.d.store.getAgent(agentId);
    if (!a) return;
    if (a.role === 'main') {
      for (const s of this.d.store.listAgentRecords(a.projectId)) if (s.role !== 'main') this.stop(s.id);
      this.controllers.get(a.id)?.abort();
      return;
    }
    this.controllers.get(a.id)?.abort();
    if (!this.running.has(a.id) && !TERMINAL.includes(a.state)) {
      this.setState(a, 'stopped', { error: 'Stopped by the user before it started.' });
      this.locks.release(a.id);
      this.finished(a);
    }
  }

  // ------------------------------------------------------------ main agent

  private enqueueMain(projectId: Id, trigger: MainTrigger, conversationId: Id): void {
    const prev = this.mainChain.get(projectId) ?? Promise.resolve();
    this.mainBusy++;
    const next = prev.then(() => this.mainTurn(projectId, trigger, conversationId)).catch((e) => {
      this.post(conversationId, 'system', `Main agent error: ${String(e?.message ?? e)}`);
    }).finally(() => { this.mainBusy--; if (this.mainChain.get(projectId) === next) this.mainChain.delete(projectId); });
    this.mainChain.set(projectId, next);
  }

  private async mainTurn(projectId: Id, trigger: MainTrigger, conversationId: Id): Promise<void> {
    const project = this.project(projectId);
    const main = this.ensureProject(project).main;
    const notes = this.notes.get(projectId) ?? [];
    this.notes.delete(projectId);
    const agents = this.d.store.listAgentRecords(projectId);
    let prompt = mainPrompt(project.name, agents, trigger, notes);
    const ctl = new AbortController();
    this.controllers.set(main.id, ctl);
    this.setState(main, 'working');
    try {
      let out = await this.runRouted(main, { prompt, system: MAIN_SYSTEM, role: 'main', complexity: 'low', permission: 'read-only', cwd: project.path, signal: ctl.signal, resume: false, conversationId, stream: false });
      if (!out.ok) {
        this.post(conversationId, 'system', out.stopped ? 'Stopped.' : `The main agent could not run: ${out.error}`, { agentId: main.id });
        return;
      }
      let parsed = parseMainOutput(out.text);
      if (!parsed.parsed) {
        prompt += '\n\nYour previous answer was not valid JSON. Reply with ONE JSON object only, in the specified format.';
        const retry = await this.runRouted(main, { prompt, system: MAIN_SYSTEM, role: 'main', complexity: 'low', permission: 'read-only', cwd: project.path, signal: ctl.signal, resume: false, conversationId, stream: false });
        if (retry.ok) { out = retry; parsed = parseMainOutput(retry.text); }
      }
      const details = out.decision && { cli: out.decision.cli, model: out.decision.model, effort: out.decision.effort, reason: out.decision.reason };
      const created = this.createTasks(project, parsed.tasks, conversationId, trigger.kind === 'help' ? trigger.from.id : undefined);
      const reply = parsed.reply || (created.length ? `Working on it: ${created.map((c) => c.title).join('; ')}.` : '');
      if (reply) this.post(conversationId, 'assistant', reply, { agentId: main.id, details });
      if (created.length > 1 || created.some((c) => c.dependsOn.length)) {
        this.post(conversationId, 'system', 'Plan: ' + created.map((c, i) => `${i + 1}. [${c.role}] ${c.title}${c.dependsOn.length ? ' (after earlier steps)' : ''}`).join('  '), { agentId: main.id });
      }
      if (trigger.kind === 'help' && !created.some((c) => c.helpFor === trigger.from.id)) {
        // No sibling assigned: tell the blocked agent so it can continue on its own judgment.
        this.followUp(trigger.from, `The main agent did not assign a sibling for your request. Response: ${reply || 'proceed with your best judgment within scope, or report that you are blocked.'}`);
      }
      this.pump(projectId);
    } finally {
      this.controllers.delete(main.id);
      this.setState(main, 'waiting');
    }
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
      const rec: AgentRecord = {
        id, projectId: project.id, parentId: this.d.store.mainAgent(project.id)?.id, role: t.role, title: t.title, state: 'queued', cli: 'auto', model: 'auto',
        effort: t.complexity, task: t.instructions, files: t.files, dependsOn: [...deps], specFromId,
        helpFor: t.helpFor ?? requester, revision: 1, complexity: t.complexity,
        parentConversationId: conversationId, attempts: 0, created: Date.now(),
        // Fast path: a clear small change goes straight to one implementer; its instructions are the spec.
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

  pump(projectId: Id): void {
    const { store } = this.d;
    const max = this.d.maxActivePerProject ?? 3;
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

  /** Acquire file ownership for edit roles. On conflict, ask the user whether to proceed in parallel. */
  private claim(a: AgentRecord): boolean {
    if (!EDIT_ROLES.includes(a.role) || a.sharedOk) return true;
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

  // ------------------------------------------------------------ running subagents

  private failAgent(a: AgentRecord, error: string): void {
    this.running.delete(a.id);
    this.controllers.delete(a.id);
    this.locks.release(a.id);
    this.setState(a, 'failed', { error });
    this.post(this.convFor(a), 'system', `Failed: ${error}`, { agentId: a.id });
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

    // Workspace: edit roles get an isolated worktree; read-only roles read the project (or the change under review).
    let cwd = project.path;
    let worktreeNote: string | undefined;
    let depsLinked = false;
    const upstream = a.dependsOn.map((id) => store.getAgent(id)).filter((x): x is AgentRecord => !!x);
    if (EDIT_ROLES.includes(a.role)) {
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

    const prompt = subagentPrompt(a, {
      projectName: project.name, upstream, siblings: store.listAgentRecords(a.projectId),
      mailbox: this.drainMailbox(a.id), worktreeNote
    });
    const res = await this.execute(a, prompt, { cwd, resume: false });
    await this.afterRun(a, res);
  }

  /** One CLI run for an agent (initial or follow-up), streaming into its conversation. */
  private async execute(a: AgentRecord, prompt: string, o: { cwd: string; resume: boolean }): Promise<RoutedRun> {
    const ctl = this.controllers.get(a.id) ?? new AbortController();
    return this.runRouted(a, {
      prompt, system: systemFor(a.role as Exclude<AgentRole, 'main'>), role: a.role, complexity: a.complexity ?? 'medium',
      permission: EDIT_ROLES.includes(a.role) ? 'edit' : 'read-only', cwd: o.cwd, signal: ctl.signal,
      resume: o.resume, conversationId: this.convFor(a), stream: true
    });
  }

  private async afterRun(a: AgentRecord, res: RoutedRun): Promise<void> {
    const { store, git } = this.d;
    this.running.delete(a.id);
    this.controllers.delete(a.id);
    let report = stripProtocol(res.text);
    const proto = parseProtocol(res.text);

    if (res.ok && a.worktree && a.baseCommit) {
      const cp = await git.checkpoint(a.worktree, `harbor: ${a.title}`);
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
        report += `\n\nWARNING: edits outside claimed files: ${outside.join(', ')}`;
      }
    }

    const blocked = res.ok && proto.help.some((h) => h.blocked);
    this.locks.release(a.id);
    if (res.stopped) this.setState(a, 'stopped', { report, error: 'Stopped by the user.' });
    else if (!res.ok) this.setState(a, 'failed', { report, error: res.error ?? 'failed' });
    else if (blocked) this.setState(a, 'waiting', { report, summary: firstLine(report), error: 'Blocked: waiting for a sibling requested through the main agent.' });
    else this.setState(a, 'done', { report, summary: firstLine(report), error: undefined });

    for (const h of proto.help) this.helpRequested(a, h);
    for (const p of proto.peer) this.sendPeer(a, p.to, p.text);

    // Direct prompts that arrived while running are delivered now, resuming this agent's session.
    const queued = this.followups.get(a.id)?.splice(0) ?? [];
    if (queued.length && !res.stopped) { this.followUp(a, queued.join('\n\n')); return; }
    if (a.state !== 'waiting') this.finished(a);
    else this.pump(a.projectId);
  }

  private finished(a: AgentRecord): void {
    const { store } = this.d;
    this.conflictAsked.delete(a.id);
    const parent = a.parentConversationId;
    const verb = a.state === 'done' ? 'finished' : a.state === 'stopped' ? 'was stopped' : 'failed';
    this.post(parent, 'system', `${a.state === 'done' ? '✓' : '✗'} ${a.title} ${verb}${a.summary ? `: ${clip(a.summary, 200)}` : a.error ? `: ${clip(a.error, 200)}` : ''}`, { agentId: a.id });

    // A sibling helping a blocked agent: hand its report back.
    if (a.helpFor && a.state === 'done') {
      const req = store.getAgent(a.helpFor);
      if (req && req.state === 'waiting') this.followUp(req, `Your requested sibling "${a.title}" finished. Its report:\n${clip(a.report ?? '', 5000)}\n\nContinue your assignment.`);
    }

    this.pump(a.projectId);
    this.maybeReportToMain(a);
  }

  /** Call the main agent only when its judgement is needed: planner done, any failure, or all work finished. */
  private maybeReportToMain(a: AgentRecord): void {
    const { store } = this.d;
    const agents = store.listAgentRecords(a.projectId).filter((x) => x.role !== 'main');
    const active = agents.some((x) => x.state === 'queued' || x.state === 'working' || x.state === 'waiting');
    const needsMain = a.role === 'planner' || a.state === 'failed' || !active;
    if (!needsMain) return;
    const unreported = agents.filter((x) => TERMINAL.includes(x.state) && !this.reported.has(`${x.id}:${x.revision}:${x.state}`));
    if (!unreported.length) return;
    // A stop-all should not trigger a flurry of main turns.
    if (unreported.every((x) => x.state === 'stopped')) { unreported.forEach((x) => this.reported.add(`${x.id}:${x.revision}:${x.state}`)); return; }
    const turns = (this.autoTurns.get(a.projectId) ?? 0) + 1;
    this.autoTurns.set(a.projectId, turns);
    if (turns > (this.d.maxAutoTurns ?? 12)) {
      this.post(a.parentConversationId, 'system', 'Paused automatic coordination after many consecutive steps. Send a message to continue.');
      return;
    }
    unreported.forEach((x) => this.reported.add(`${x.id}:${x.revision}:${x.state}`));
    this.enqueueMain(a.projectId, { kind: 'reports', items: unreported.map((agent) => ({ agent })) }, a.parentConversationId);
  }

  // ------------------------------------------------------------ direct prompts and follow-ups

  private direct(a: AgentRecord, text: string, conversationId: Id): void {
    this.d.store.addCoordination({ projectId: a.projectId, kind: 'direct', to: a.id, text });
    this.addNote(a.projectId, `User sent "${a.title}" directly: ${text}`);
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

  /** Continue an agent's own session with a new message. */
  private followUp(a: AgentRecord, text: string): void {
    if (this.running.has(a.id)) { const q = this.followups.get(a.id) ?? []; q.push(text); this.followups.set(a.id, q); return; }
    this.begin(a.id);
    void (async () => {
      const cwd = a.worktree ?? this.project(a.projectId).path;
      if (EDIT_ROLES.includes(a.role) && !a.worktree) {
        const r = this.locks.acquire(a.projectId, a.id, a.files?.length ? a.files : [WHOLE_PROJECT]);
        if (!r.ok) { this.running.delete(a.id); this.post(this.convFor(a), 'system', 'Another agent owns the files this agent needs; try again when it finishes.', { agentId: a.id }); return; }
      }
      this.setState(a, 'working', { error: undefined });
      const mail = this.drainMailbox(a.id);
      const prompt = mail.length ? `${text}\n\nMessages delivered to you:\n${mail.map((m) => `- ${m}`).join('\n')}` : text;
      const res = await this.execute(a, prompt, { cwd, resume: true });
      await this.afterRun(a, res);
    })().catch((e) => this.failAgent(a, `Internal error: ${String(e?.message ?? e)}`));
  }

  // ------------------------------------------------------------ collaboration

  private helpRequested(a: AgentRecord, h: HelpRequest): void {
    this.d.store.addCoordination({ projectId: a.projectId, kind: 'help', from: a.id, text: `${h.reason} → ${h.proposedRole}: ${h.instructions}` });
    this.post(this.convFor(a), 'system', `Requested help from the main agent: ${h.instructions || h.reason}`, { agentId: a.id });
    this.enqueueMain(a.projectId, { kind: 'help', from: a, reason: h.reason, proposedRole: h.proposedRole, instructions: h.instructions, blocked: h.blocked }, a.parentConversationId);
  }

  private drainMailbox(agentId: Id): string[] { return this.mailbox.get(agentId)?.splice(0) ?? []; }

  /** Sibling message through the in-process bus: logged to both conversations and the coordination record. */
  sendPeer(from: AgentRecord, to: string, text: string): boolean {
    const sibs = this.d.store.listAgentRecords(from.projectId).filter((s) => s.role !== 'main' && s.id !== from.id);
    const q = to.toLowerCase();
    const matches = sibs.filter((s) => s.id === to || s.title.toLowerCase() === q);
    const target = matches[0] ?? (sibs.filter((s) => s.title.toLowerCase().includes(q)).length === 1 ? sibs.find((s) => s.title.toLowerCase().includes(q)) : undefined);
    if (!target) {
      this.post(this.convFor(from), 'system', `Peer message not delivered: no unique sibling matches "${to}".`, { agentId: from.id });
      return false;
    }
    const box = this.mailbox.get(target.id) ?? [];
    box.push(`from "${from.title}": ${text}`);
    this.mailbox.set(target.id, box);
    this.d.store.addCoordination({ projectId: from.projectId, kind: 'peer', from: from.id, to: target.id, text });
    const line = `[sibling] ${from.title} → ${target.title}: ${text}`;
    this.post(this.convFor(from), 'system', line, { agentId: from.id });
    this.post(this.convFor(target), 'system', line, { agentId: from.id });
    this.addNote(from.projectId, line);
    return true;
  }

  // ------------------------------------------------------------ routed execution with fallback

  private async runRouted(
    agent: AgentRecord,
    o: { prompt: string; system: string; role: AgentRole; complexity: Complexity; permission: 'read-only' | 'edit'; cwd: string; signal: AbortSignal; resume: boolean; conversationId: Id; stream: boolean }
  ): Promise<RoutedRun> {
    const { store, ledger } = this.d;
    const exclude: CliId[] = [];
    let lastError = 'No eligible CLI is available. Open Settings to install or sign in to a supported CLI.';
    const maxAttempts = Math.max(1, this.d.getClis().length);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const link = store.getSession(agent.id);
      const decision = route({ role: o.role, complexity: o.complexity, continuity: link?.cli, exclude }, {
        clis: this.d.getClis(), ledger, enabled: this.d.enabled, hasAdapter: (c) => !!this.d.adapterFor(c),
        load: (c) => store.allAgentRecords().filter((x) => x.cli === c && this.running.has(x.id) && x.id !== agent.id).length,
        verified: this.d.verified
      });
      if (!decision) return { ok: false, text: '', error: attempt === 0 ? lastError : `${lastError} (no remaining CLI to fall back to)` };
      const adapter = this.d.adapterFor(decision.cli)!;
      const resumeId = o.resume && link?.cli === decision.cli ? link.sessionId : undefined;
      if (o.resume && !resumeId && link) this.addNote(agent.projectId, `${agent.title}: continuing on ${decision.cli} without the previous ${link.cli} session`);
      this.setState(agent, agent.state, { cli: decision.cli, model: decision.model, effort: decision.effort, attempts: attempt });
      if (attempt > 0) this.post(o.conversationId, 'system', `Falling back to ${decision.cli}: ${lastError}`, { agentId: agent.id });

      // `final` is the CLI's own final answer; the joined `text` also holds mid-run narration that must not become the report.
      let text = '', final = '', ok = false, error: string | undefined, rateLimited = false, usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } = {};
      let limits: Extract<Chunk, { kind: 'limits' }>['limits'] | undefined;
      let streamId: Id | undefined;
      const details = { cli: decision.cli, model: decision.model, effort: decision.effort, reason: decision.reason };
      const t0 = Date.now();
      try {
        for await (const c of adapter.run(o.prompt, { cwd: o.cwd, model: decision.model, effort: decision.effort as Effort, resumeId, permission: o.permission, systemPrompt: o.system, signal: o.signal }) as AsyncIterable<Chunk>) {
          if (c.kind === 'session') store.setSession({ agentId: agent.id, cli: decision.cli, sessionId: c.id, updated: Date.now() });
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
      if (ok) {
        if (!o.stream) { /* main replies are posted by the caller with details */ }
        return { ok: true, text: final || text, decision };
      }
      if (stopped) return { ok: false, text, stopped: true, decision, error: 'stopped' };
      lastError = `${decision.cli} failed${rateLimited ? ' (rate limit)' : ''}: ${clip(error ?? 'unknown error', 300)}`;
      exclude.push(decision.cli);
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
