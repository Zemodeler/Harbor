import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CliId, Conversation, EffortPolicy, Id, LowAllowancePolicy, Message, Project, ProjectSettings, RolePreference, Settings, ToolRule } from '../shared/api';
import type { TrackedProcess } from './proc';
import type { AgentRecord, CoordinationEntry, FileLock, ReportDelivery, SessionLink, State, UsageEvent } from './types';

/**
 * State plus fields added after version 1; all optional so older files still load. `reportLedger` says the file records
 * report delivery (`AgentRecord.reportDelivery`); its absence means a file written before that existed.
 */
type Persisted = State & { processes?: TrackedProcess[]; reportLedger?: 1 };

/** One helper result, as captured when its report was queued for the lead. */
export type ReportMark = Pick<AgentRecord, 'id' | 'revision' | 'state'>;

const TERMINAL_STATES = ['done', 'failed', 'stopped'];
/** A mark never moves to a weaker status for the same result. */
const DELIVERY_RANK: Record<ReportDelivery['status'], number> = { unknown: 0, attempted: 1, skipped: 2, confirmed: 3 };
const sameResult = (d: ReportDelivery | undefined, m: ReportMark): boolean => !!d && d.revision === m.revision && d.state === m.state;

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
    if (!this.file || !existsSync(this.file)) return { ...emptyState(), reportLedger: 1 };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Persisted>;
      const state: Persisted = { ...emptyState(), ...raw, settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) } };
      if (!state.reportLedger) markLegacyReports(state);
      return state;
    } catch {
      // Keep the unreadable file for inspection rather than silently overwriting it.
      try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      return { ...emptyState(), reportLedger: 1 };
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
    if (this.state.toolRules?.[id]) { const { [id]: _gone, ...rest } = this.state.toolRules; this.state.toolRules = rest; }
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

  /**
   * Records how far these results got towards the lead. Written to disk at once: a crash must not lose an `attempted` mark
   * (the report would come back as never sent) or a `confirmed` one (it would come back as uncertain). A mark never moves
   * to a weaker status for the same result, and a mark for a stale result never replaces the mark of the current one.
   */
  markReports(marks: ReportMark[], status: ReportDelivery['status']): void {
    const time = Date.now();
    for (const m of marks) {
      const a = this.getAgent(m.id);
      const cur = a?.reportDelivery;
      if (!a) continue;
      if (sameResult(cur, m) ? DELIVERY_RANK[cur!.status] >= DELIVERY_RANK[status] : cur && (cur.revision > m.revision || sameResult(cur, a))) continue;
      a.reportDelivery = { v: 1, revision: m.revision, state: m.state, status, time };
    }
    this.flush();
  }
  /** A turn marked `attempted` never reached a CLI after all (no output): the results get the mark they had before it. */
  restoreReports(entries: Array<{ mark: ReportMark; prev: ReportDelivery | undefined }>): void {
    for (const { mark, prev } of entries) {
      const a = this.getAgent(mark.id);
      if (!a || !sameResult(a.reportDelivery, mark) || a.reportDelivery!.status !== 'attempted') continue;
      if (prev) a.reportDelivery = prev; else delete a.reportDelivery;
    }
    this.flush();
  }
  /** The user was told these results may not have reached the lead. */
  noticeReports(marks: ReportMark[]): void {
    const time = Date.now();
    for (const m of marks) {
      const a = this.getAgent(m.id);
      if (a && sameResult(a.reportDelivery, m)) a.reportDelivery!.noticed = time;
    }
    this.dirty();
  }
  /** A stopped agent resumed in place keeps its revision: its old mark must not hide the outcome of the resumed run. */
  clearReportDelivery(id: Id): void {
    const a = this.getAgent(id);
    if (a?.reportDelivery) { delete a.reportDelivery; this.dirty(); }
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
  trackProcess(p: TrackedProcess): void {
    this.state.processes = [...(this.state.processes ?? []).filter((x) => x.pid !== p.pid), p];
    // A spawn must survive a crash immediately; ordinary state changes remain debounced.
    this.flush();
  }
  untrackProcess(pid: number, started?: number): void {
    // Callers without an identity cannot safely remove a potentially reused PID.
    if (!this.state.processes?.some((x) => x.pid === pid && x.started === started)) return;
    this.state.processes = this.state.processes.filter((x) => x.pid !== pid || x.started !== started);
    this.dirty();
  }
  clearTrackedProcesses(): void { if (this.state.processes?.length) { this.state.processes = []; this.dirty(); } }

  // ---- "always allow for this project" tool rules
  listToolRules(projectId: Id): ToolRule[] { return [...(this.state.toolRules?.[projectId] ?? [])]; }
  /** Adds a rule unless an identical one exists; returns the stored rule. */
  addToolRule(projectId: Id, draft: ToolRuleDraft): ToolRule {
    const rules = this.state.toolRules?.[projectId] ?? [];
    const same = rules.find((r) => r.tool === draft.tool && r.prefix === draft.prefix);
    if (same) return same;
    const rule: ToolRule = { id: newId(), tool: draft.tool, ...(draft.prefix ? { prefix: draft.prefix } : {}), created: Date.now() };
    this.state.toolRules = { ...(this.state.toolRules ?? {}), [projectId]: [...rules, rule] };
    this.dirty(); return rule;
  }
  removeToolRule(projectId: Id, ruleId: Id): void {
    const rules = this.state.toolRules?.[projectId];
    if (!rules?.some((r) => r.id === ruleId)) return;
    this.state.toolRules = { ...this.state.toolRules, [projectId]: rules.filter((r) => r.id !== ruleId) };
    this.dirty();
  }

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

/**
 * A file written before report delivery was recorded. Its finished helpers were probably reported as they finished, but a
 * report may also have been waiting for a lead turn when that Harbor stopped. Nothing proves either, so they are marked
 * `unknown`: the report is kept and reaches the lead flagged as possibly seen, instead of being dropped or replayed silently.
 * Helpers still running then are left alone: after recovery stops them, their outcome is an ordinary pending report.
 */
function markLegacyReports(state: Persisted): void {
  const time = Date.now();
  for (const a of state.agents) {
    if (a.role !== 'main' && !a.byUser && !a.reportDelivery && TERMINAL_STATES.includes(a.state)) a.reportDelivery = { v: 1, revision: a.revision, state: a.state, status: 'unknown', time };
  }
  state.reportLedger = 1;
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
  if ('keepRunningInBackground' in patch && patch.keepRunningInBackground !== undefined && typeof patch.keepRunningInBackground !== 'boolean') {
    throw new Error('keepRunningInBackground must be a boolean.');
  }
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

// ---- tool permission rules (pure)

/** What an "always allow" answer would store: a Bash command prefix, or an exact tool name. */
export interface ToolRuleDraft { tool: string; prefix?: string }

/**
 * Tools that may be allowed once but never always: they write outside the workspace (the CLI only asks for those) or reach
 * the network. Task/Agent are blocked by the adapter and never get here.
 */
const NEVER_ALWAYS_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch']);
/** Chaining, substitution or redirection: the prefix would no longer describe what runs. */
const SHELL_META = /[;&|`<>\r\n]|\$\(/;
/**
 * Commands that are only ever allowed once. Conservative on purpose: a false match costs one more prompt.
 * Git history rewrites and pushes, recursive or forced deletes, privilege and process control, publishing, network
 * transfer tools and URLs (exfiltration), and interpreters running inline code.
 */
const NEVER_ALWAYS_COMMANDS: RegExp[] = [
  /\bgit\b.*\s(?:merge|rebase|cherry-pick|reset|push|clean|restore|filter-branch|filter-repo|update-ref|gc|prune|reflog)(?![\w-])/i,
  /\bgit\b.*\sbranch\b.*\s-[a-z]*d/i,
  /\bgit\b.*\s(?:worktree\s+remove|checkout\s+(?:.*\s)?--(?:\s|$)|stash\s+(?:drop|clear))/i,
  /\brm\b.*\s-[a-z]*[rf]/i, /\b(?:rmdir|rd|del|erase|format|mkfs\S*|shred|dd|diskpart)\b/i,
  /\bremove-item\b/i, /\bfind\b.*\s-(?:delete|exec)/i, /\bxargs\b/i,
  /\b(?:sudo|su|runas|chmod|chown|icacls|takeown|kill|killall|pkill|taskkill|stop-process|shutdown|reboot|reg|setx)\b/i,
  /\b(?:npm|pnpm|yarn)\s+(?:publish|unpublish|login|adduser|token)\b/i,
  /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|start-bitstransfer|bitsadmin|certutil|scp|sftp|ssh|nc|ncat|netcat|telnet|ftp|tftp|rsync|gh|az|aws|gcloud)\b/i,
  /\b[a-z][a-z0-9+.-]*:\/\//i,
  /\b(?:bash|sh|zsh|dash|cmd|powershell|pwsh|node|deno|bun|python[\d.]*|py|perl|ruby|php|wsl)(?:\.exe)?\b.*\s(?:-c|-e|-p|-r|--eval|--print|-command|-encodedcommand|-enc|\/c|\/k)(?:\s|$)/i
];
const INTERPRETER = /^(?:bash|sh|zsh|dash|cmd|powershell|pwsh|node|deno|bun|python[\d.]*|py|perl|ruby|php|wsl|npx|env)(?:\.exe)?$/i;

const bashCommand = (input: unknown): string | undefined => {
  const c = (input as { command?: unknown } | null)?.command;
  return typeof c === 'string' ? c.trim().replace(/\s+/g, ' ') : undefined;
};

/** True when this call may be allowed once only (never stored or matched as a project rule). */
export function neverAlwaysAllow(tool: string, input: unknown): boolean {
  if (NEVER_ALWAYS_TOOLS.has(tool) || !tool) return true;
  if (tool !== 'Bash') return false;
  const cmd = bashCommand(input);
  return !cmd || SHELL_META.test(cmd) || NEVER_ALWAYS_COMMANDS.some((re) => re.test(cmd));
}

/**
 * The rule "always allow" would store for this call, or undefined when it may only be allowed once. Bash rules are the
 * first one or two plain words of the command (`npm test`, `ls`), never the bare tool: Bash itself is never always-allowed.
 */
export function toolRuleFor(tool: string, input: unknown): ToolRuleDraft | undefined {
  if (neverAlwaysAllow(tool, input)) return undefined;
  if (tool !== 'Bash') return { tool };
  const words = bashCommand(input)!.split(' ');
  const plain = (w: string | undefined) => !!w && /^[\w./:@=+-]+$/.test(w) && !w.startsWith('-');
  if (!plain(words[0])) return undefined;
  if (plain(words[1])) return { tool, prefix: `${words[0]} ${words[1]}` };
  // A shell or interpreter alone would cover any script it is given.
  return INTERPRETER.test(words[0]!) ? undefined : { tool, prefix: words[0] };
}

/** Whether a stored rule covers this call. The never-always checks run again, so no rule can allow a dangerous call. */
export function matchesToolRule(rule: ToolRuleDraft, tool: string, input: unknown): boolean {
  if (rule.tool !== tool || neverAlwaysAllow(tool, input)) return false;
  if (tool !== 'Bash') return !rule.prefix;
  if (!rule.prefix) return false;
  const cmd = bashCommand(input)!;
  return cmd === rule.prefix || cmd.startsWith(`${rule.prefix} `);
}

export const describeToolRule = (r: ToolRuleDraft): string => (r.prefix ? `${r.tool}(${r.prefix} ...)` : r.tool);

export function normPath(p: string): string {
  return p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}
