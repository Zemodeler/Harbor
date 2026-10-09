import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Conversation, Id, Message, Project, Settings } from '../shared/api';
import type { TrackedProcess } from './proc';
import type { AgentRecord, CoordinationEntry, FileLock, SessionLink, State, UsageEvent } from './types';

/** State plus fields added after version 1; `processes` is optional so older files still load. */
type Persisted = State & { processes?: TrackedProcess[] };

export const DEFAULT_SETTINGS: Settings = { routing: 'auto', cliOverrides: {}, allowFreeReset: 'ask' };

const emptyState = (): State => ({
  version: 1, projects: [], conversations: [], messages: [], agents: [], sessions: [], usage: [],
  coordination: [], locks: [], resetApprovals: [], settings: { ...DEFAULT_SETTINGS }
});

export const newId = (): Id => randomUUID();

/**
 * Small JSON-file store (atomic write via temp + rename, debounced).
 * Chosen over SQLite to avoid a native build step on Windows; the interface is what the rest
 * of the app depends on, so it can be swapped later.
 */
export class Store {
  private state: Persisted;
  private file: string | undefined;
  private timer: NodeJS.Timeout | undefined;

  /** dir undefined => purely in-memory (tests). */
  constructor(dir?: string) {
    this.file = dir ? join(dir, 'state.json') : undefined;
    this.state = this.load();
  }

  private load(): Persisted {
    if (!this.file || !existsSync(this.file)) return emptyState();
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<State>;
      return { ...emptyState(), ...raw, settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) } };
    } catch {
      // Keep the unreadable file for inspection rather than silently overwriting it.
      try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      return emptyState();
    }
  }

  private dirty(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 150);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }

  // ---- projects
  listProjects(): Project[] { return [...this.state.projects].sort((a, b) => b.lastOpened - a.lastOpened); }
  getProject(id: Id): Project | undefined { return this.state.projects.find((p) => p.id === id); }
  findProjectByPath(path: string): Project | undefined {
    const n = normPath(path);
    return this.state.projects.find((p) => normPath(p.path) === n);
  }
  upsertProject(p: Project): Project {
    const i = this.state.projects.findIndex((x) => x.id === p.id);
    if (i >= 0) this.state.projects[i] = p; else this.state.projects.push(p);
    this.dirty(); return p;
  }
  /** Removes only Harbor's records for the project; never touches files on disk. */
  removeProject(id: Id): void {
    const convIds = new Set(this.state.conversations.filter((c) => c.projectId === id).map((c) => c.id));
    this.state.projects = this.state.projects.filter((p) => p.id !== id);
    this.state.conversations = this.state.conversations.filter((c) => c.projectId !== id);
    this.state.messages = this.state.messages.filter((m) => !convIds.has(m.conversationId));
    this.state.agents = this.state.agents.filter((a) => a.projectId !== id);
    this.state.locks = this.state.locks.filter((l) => l.projectId !== id);
    this.dirty();
  }

  // ---- conversations
  listConversations(projectId: Id): Conversation[] {
    return this.state.conversations.filter((c) => c.projectId === projectId).sort((a, b) => b.updated - a.updated);
  }
  getConversation(id: Id): Conversation | undefined { return this.state.conversations.find((c) => c.id === id); }
  findConversationByAgent(agentId: Id): Conversation | undefined { return this.state.conversations.find((c) => c.agentId === agentId); }
  /** Removes the conversation and its messages only; agents, worktrees and files are untouched. */
  removeConversation(id: Id): void {
    this.state.conversations = this.state.conversations.filter((c) => c.id !== id);
    this.state.messages = this.state.messages.filter((m) => m.conversationId !== id);
    this.dirty();
  }
  addConversation(c: Conversation): Conversation { this.state.conversations.push(c); this.dirty(); return c; }
  patchConversation(id: Id, patch: Partial<Conversation>): Conversation | undefined {
    const c = this.getConversation(id);
    if (c) { Object.assign(c, patch); this.dirty(); }
    return c;
  }
  touchConversation(id: Id, patch: Partial<Pick<Conversation, 'title'>> = {}): void {
    const c = this.getConversation(id);
    if (c) { Object.assign(c, patch, { updated: Date.now() }); this.dirty(); }
  }

  // ---- messages
  listMessages(conversationId: Id): Message[] {
    return this.state.messages.filter((m) => m.conversationId === conversationId).sort((a, b) => a.time - b.time);
  }
  getMessage(id: Id): Message | undefined { return this.state.messages.find((m) => m.id === id); }
  addMessage(m: Message): Message { this.state.messages.push(m); this.touchConversation(m.conversationId); this.dirty(); return m; }
  updateMessage(id: Id, patch: Partial<Message>): void {
    const m = this.getMessage(id);
    if (m) { Object.assign(m, patch); this.dirty(); }
  }

  // ---- agents
  listAgentRecords(projectId: Id): AgentRecord[] { return this.state.agents.filter((a) => a.projectId === projectId); }
  allAgentRecords(): AgentRecord[] { return this.state.agents; }
  getAgent(id: Id): AgentRecord | undefined { return this.state.agents.find((a) => a.id === id); }
  mainAgent(projectId: Id): AgentRecord | undefined { return this.state.agents.find((a) => a.projectId === projectId && a.role === 'main'); }
  upsertAgent(a: AgentRecord): AgentRecord {
    const i = this.state.agents.findIndex((x) => x.id === a.id);
    if (i >= 0) this.state.agents[i] = a; else this.state.agents.push(a);
    this.dirty(); return a;
  }
  patchAgent(id: Id, patch: Partial<AgentRecord>): AgentRecord | undefined {
    const a = this.getAgent(id);
    if (a) { Object.assign(a, patch); this.dirty(); }
    return a;
  }

  // ---- sessions (native CLI session ids)
  getSession(agentId: Id): SessionLink | undefined { return this.state.sessions.find((s) => s.agentId === agentId); }
  setSession(link: SessionLink): void {
    const i = this.state.sessions.findIndex((s) => s.agentId === link.agentId);
    if (i >= 0) this.state.sessions[i] = link; else this.state.sessions.push(link);
    this.dirty();
  }
  clearSession(agentId: Id): void { this.state.sessions = this.state.sessions.filter((s) => s.agentId !== agentId); this.dirty(); }

  // ---- usage
  addUsage(u: UsageEvent): void { this.state.usage.push(u); this.dirty(); }
  listUsage(): UsageEvent[] { return this.state.usage; }
  addResetApproval(r: State['resetApprovals'][number]): void { this.state.resetApprovals.push(r); this.dirty(); }
  listResetApprovals(): State['resetApprovals'] { return this.state.resetApprovals; }

  // ---- coordination + locks
  addCoordination(e: Omit<CoordinationEntry, 'id' | 'time'> & Partial<Pick<CoordinationEntry, 'id' | 'time'>>): CoordinationEntry {
    const entry: CoordinationEntry = { id: newId(), time: Date.now(), ...e };
    this.state.coordination.push(entry); this.dirty(); return entry;
  }
  listCoordination(projectId: Id): CoordinationEntry[] { return this.state.coordination.filter((c) => c.projectId === projectId); }
  get locks(): FileLock[] { return this.state.locks; }
  setLocks(l: FileLock[]): void { this.state.locks = l; this.dirty(); }

  // ---- CLI processes Harbor started (so a later run can kill orphans)
  listTrackedProcesses(): TrackedProcess[] { return [...(this.state.processes ?? [])]; }
  trackProcess(p: TrackedProcess): void { this.state.processes = [...(this.state.processes ?? []).filter((x) => x.pid !== p.pid), p]; this.dirty(); }
  untrackProcess(pid: number): void {
    if (!this.state.processes?.some((x) => x.pid === pid)) return;
    this.state.processes = this.state.processes.filter((x) => x.pid !== pid);
    this.dirty();
  }
  clearTrackedProcesses(): void { if (this.state.processes?.length) { this.state.processes = []; this.dirty(); } }

  // ---- settings
  getSettings(): Settings { return this.state.settings; }
  setSettings(patch: Partial<Settings>): Settings {
    this.state.settings = { ...this.state.settings, ...patch, cliOverrides: { ...this.state.settings.cliOverrides, ...(patch.cliOverrides ?? {}) } };
    this.dirty(); return this.state.settings;
  }
}

export function normPath(p: string): string {
  return p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}
