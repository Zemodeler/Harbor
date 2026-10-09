import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CliId, Conversation, EffortPolicy, Id, LowAllowancePolicy, Message, Project, ProjectSettings, RolePreference, Settings } from '../shared/api';
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
  /** Internal (not part of the API contract): a goal-mode conversation paused by a question or failure stops auto-continuing until the user writes. */
  isGoalPaused(id: Id): boolean { return !!(this.getConversation(id) as (Conversation & { goalPaused?: boolean }) | undefined)?.goalPaused; }
  setGoalPaused(id: Id, paused: boolean): void {
    const c = this.getConversation(id) as (Conversation & { goalPaused?: boolean }) | undefined;
    if (!c || !!c.goalPaused === paused) return;
    if (paused) c.goalPaused = true; else delete c.goalPaused;
    this.dirty();
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
  /** Validates first (throws on malformed values, so nothing is half-applied); `undefined` on a routing key resets it. */
  setSettings(patch: Partial<Settings>): Settings {
    const p = normalizeSettingsPatch(patch);
    const cur = this.state.settings;
    const next: Settings = { ...cur, ...p, cliOverrides: { ...cur.cliOverrides, ...(p.cliOverrides ?? {}) } };
    if ('projectOverrides' in p && p.projectOverrides) {
      // Per project: an entry replaces that project's overrides; an empty or undefined entry removes them.
      const merged: Record<Id, ProjectSettings> = { ...(cur.projectOverrides ?? {}) };
      for (const [id, o] of Object.entries(p.projectOverrides)) { if (o && Object.keys(o).length) merged[id] = o; else delete merged[id]; }
      next.projectOverrides = merged;
    }
    for (const k of [...SCOPED_KEYS, 'projectOverrides'] as const) {
      if (next[k] === undefined || (k === 'projectOverrides' && !Object.keys(next[k]!).length)) delete next[k];
    }
    this.state.settings = next;
    this.dirty(); return this.state.settings;
  }
}

// ---- settings validation and resolution (pure)

export const DEFAULT_CONCURRENCY = 4;
export const CONCURRENCY_RANGE = [1, 8] as const;
/** At most half the allowance can be reserved, or automatic routing would rarely have anything to use. */
export const RESERVE_RANGE = [0, 50] as const;
const HELPER_ROLES = ['planner', 'implementer', 'reviewer', 'other'] as const;
const EFFORT_POLICIES: readonly EffortPolicy[] = ['adaptive', 'conserve', 'quality'];
const LOW_ALLOWANCE_POLICIES: readonly LowAllowancePolicy[] = ['reduceEffort', 'switch'];
/** Settings a project can override. */
const SCOPED_KEYS = ['concurrencyLimit', 'allowedModels', 'rolePreferences', 'effortPolicy', 'lowAllowancePolicy', 'subscriptionReserve'] as const;

type HelperRole = typeof HELPER_ROLES[number];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function clampInt(v: unknown, [lo, hi]: readonly [number, number], name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a number.`);
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], name: string): T {
  if (!allowed.includes(v as T)) throw new Error(`${name} must be one of: ${allowed.join(', ')}.`);
  return v as T;
}

const cleanName = (v: unknown, name: string): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`${name} must be text.`);
  return v.trim() || undefined;
};

/** Empty lists mean "no restriction" and are dropped, so a typo cannot silently take a CLI out of routing. */
function allowedModels(v: unknown): Record<CliId, string[]> | undefined {
  if (!isObj(v)) throw new Error('allowedModels must map a CLI id to a list of model names.');
  const out: Record<CliId, string[]> = {};
  for (const [cli, list] of Object.entries(v)) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error(`allowedModels.${cli} must be a list of model names.`);
    const names = [...new Set(list.map((m) => cleanName(m, `allowedModels.${cli}`)).filter((m): m is string => !!m))];
    if (names.length) out[cli] = names;
  }
  return Object.keys(out).length ? out : undefined;
}

function rolePreferences(v: unknown): Settings['rolePreferences'] {
  if (!isObj(v)) throw new Error('rolePreferences must map a role to { cli, model }.');
  const out: Partial<Record<HelperRole, RolePreference>> = {};
  for (const role of HELPER_ROLES) {
    const p = v[role];
    if (p === undefined) continue;
    if (!isObj(p)) throw new Error(`rolePreferences.${role} must be { cli, model }.`);
    const cli = cleanName(p['cli'], `rolePreferences.${role}.cli`), model = cleanName(p['model'], `rolePreferences.${role}.model`);
    if (cli || model) out[role] = { ...(cli ? { cli } : {}), ...(model ? { model } : {}) };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Validates the project-scoped fields of `v`. Keys present with `undefined` stay present (they mean "reset"). */
function scoped(v: Record<string, unknown>): ProjectSettings {
  const out: ProjectSettings = {};
  const has = (k: string) => k in v;
  if (has('concurrencyLimit')) out.concurrencyLimit = v['concurrencyLimit'] === undefined ? undefined : clampInt(v['concurrencyLimit'], CONCURRENCY_RANGE, 'concurrencyLimit');
  if (has('subscriptionReserve')) out.subscriptionReserve = v['subscriptionReserve'] === undefined ? undefined : clampInt(v['subscriptionReserve'], RESERVE_RANGE, 'subscriptionReserve');
  if (has('effortPolicy')) out.effortPolicy = v['effortPolicy'] === undefined ? undefined : oneOf(v['effortPolicy'], EFFORT_POLICIES, 'effortPolicy');
  if (has('lowAllowancePolicy')) out.lowAllowancePolicy = v['lowAllowancePolicy'] === undefined ? undefined : oneOf(v['lowAllowancePolicy'], LOW_ALLOWANCE_POLICIES, 'lowAllowancePolicy');
  if (has('allowedModels')) out.allowedModels = v['allowedModels'] === undefined ? undefined : allowedModels(v['allowedModels']);
  if (has('rolePreferences')) out.rolePreferences = v['rolePreferences'] === undefined ? undefined : rolePreferences(v['rolePreferences']);
  return out;
}

/** Throws on values that cannot be interpreted; clamps numbers into range. Fields outside the routing settings pass through. */
export function normalizeSettingsPatch(patch: Partial<Settings>): Partial<Settings> {
  if (!isObj(patch)) throw new Error('Settings must be an object.');
  const out: Partial<Settings> = { ...patch, ...scoped(patch as Record<string, unknown>) };
  if ('projectOverrides' in patch) {
    const po: unknown = patch.projectOverrides;
    if (po === undefined) out.projectOverrides = undefined;
    else {
      if (!isObj(po)) throw new Error('projectOverrides must map a project id to its settings.');
      const map: Record<Id, ProjectSettings> = {};
      for (const [id, o] of Object.entries(po)) {
        if (o !== undefined && !isObj(o)) throw new Error(`projectOverrides.${id} must be an object.`);
        // Drop reset markers: a project entry is stored whole, so an absent key already means "inherit".
        map[id] = o ? Object.fromEntries(Object.entries(scoped(o)).filter(([, x]) => x !== undefined)) : {};
      }
      out.projectOverrides = map;
    }
  }
  return out;
}

/** Settings that apply to one project: project values win per field, per CLI (allowedModels) and per role (rolePreferences). */
export interface EffectiveSettings {
  /** Undefined = the caller's default (Harbor's is DEFAULT_CONCURRENCY). */
  concurrencyLimit?: number;
  allowedModels: Record<CliId, string[]>;
  rolePreferences: Partial<Record<HelperRole, RolePreference>>;
  effortPolicy: EffortPolicy;
  lowAllowancePolicy: LowAllowancePolicy;
  subscriptionReserve: number;
}

export function effectiveSettings(s: Settings, projectId?: Id): EffectiveSettings {
  const p: ProjectSettings = (projectId && s.projectOverrides?.[projectId]) || {};
  return {
    concurrencyLimit: p.concurrencyLimit ?? s.concurrencyLimit,
    allowedModels: { ...(s.allowedModels ?? {}), ...(p.allowedModels ?? {}) },
    rolePreferences: { ...(s.rolePreferences ?? {}), ...(p.rolePreferences ?? {}) },
    effortPolicy: p.effortPolicy ?? s.effortPolicy ?? 'adaptive',
    lowAllowancePolicy: p.lowAllowancePolicy ?? s.lowAllowancePolicy ?? 'reduceEffort',
    subscriptionReserve: p.subscriptionReserve ?? s.subscriptionReserve ?? 0
  };
}

export function normPath(p: string): string {
  return p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}
