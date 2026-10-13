import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CliId, Conversation, EffortPolicy, Id, LowAllowancePolicy, Message, Project, ProjectSettings, RolePreference, Settings, ToolRule } from '../shared/api';
import { isEditorId } from './launcher';
import type { TrackedProcess } from './proc';
import type { Calibration } from './calibration';
import type { AgentRecord, CoordinationEntry, FileLock, ReportDelivery, SessionLink, State, UsageEvent } from './types';

/**
 * State plus fields added after version 1; all optional so older files still load. `reportLedger` says the file records
 * report delivery (`AgentRecord.reportDelivery`); its absence means a file written before that existed.
 */
type Persisted = State & { processes?: TrackedProcess[]; reportLedger?: 1; usageArchive?: UsageArchive; calibration?: Calibration };

/** Totals of usage events pruned from `usage`, so lifetime cost figures survive pruning. */
export interface UsageTotals { runs: number; inputTokens: number; outputTokens: number; costUsd: number }
export interface UsageArchive { total: UsageTotals; byProject: Record<Id, UsageTotals> }

/** Usage events older than this are folded into the archive (longest window the ledger reads is 7 days). */
export const USAGE_KEEP_MS = 8 * 86_400_000;
const USAGE_PRUNE_AT = 2000;
/** Stored helper reports longer than this are clipped in state.json; the full text lives in a side file. */
export const REPORT_STORE_CHARS = 20_000;
const REPORT_MARK = '\n[Harbor: report clipped in state; full text in the side file]';
const emptyTotals = (): UsageTotals => ({ runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });

export interface StoreOptions {
  /** Minimum gap between rolling state.json.bak copies (default 30 s; 0 = every flush). */
  bakIntervalMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export interface FlushError { time: number; message: string }

function sleepSync(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* not available: retry immediately */ }
}

/** One helper result, as captured when its report was queued for the lead. `gen` is its `AgentRecord.reportGen`. */
export type ReportMark = Pick<AgentRecord, 'id' | 'revision' | 'state'> & { gen?: number };
/** The result an agent holds now, as a mark. */
export const currentResult = (a: AgentRecord): ReportMark => ({ id: a.id, revision: a.revision, state: a.state, gen: a.reportGen ?? 0 });

const TERMINAL_STATES = ['done', 'failed', 'stopped'];
/** A mark never moves to a weaker status for the same result. */
const DELIVERY_RANK: Record<ReportDelivery['status'], number> = { unknown: 0, attempted: 1, skipped: 2, confirmed: 3 };
const sameResult = (d: ReportDelivery | undefined, m: ReportMark): boolean =>
  !!d && d.revision === m.revision && d.state === m.state && (d.gen ?? 0) === (m.gen ?? 0);

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
  private now: () => number;
  private bakIntervalMs: number;
  private lastBak = 0;
  private notices: string[] = [];
  private flushError: FlushError | undefined;
  /** Called when a flush failed even after retries (the state stays in memory and is retried). */
  onFlushError?: (e: FlushError) => void;
  private byConversation = new Map<Id, Message[]>();
  private messageById = new Map<Id, Message>();
  /** What was last written to a side file, so unchanged reports are not rewritten on every flush. */
  private sideWritten = new Map<string, number>();

  /** dir undefined => purely in-memory (tests). */
  constructor(dir?: string, opts: StoreOptions = {}) {
    this.file = dir ? join(dir, 'state.json') : undefined;
    this.now = opts.now ?? Date.now;
    this.bakIntervalMs = opts.bakIntervalMs ?? 30_000;
    this.state = this.load();
    this.indexMessages();
    this.pruneUsage();
  }

  /** Things worth telling the user once at startup (restored from backup, unreadable state, ...). */
  get startupNotices(): readonly string[] { return this.notices; }
  /** The last flush failure, cleared by the next successful flush. */
  get lastFlushError(): FlushError | undefined { return this.flushError; }

  private indexMessages(): void {
    this.byConversation.clear(); this.messageById.clear();
    for (const m of this.state.messages) this.indexMessage(m);
  }
  private indexMessage(m: Message): void {
    const list = this.byConversation.get(m.conversationId);
    if (list) list.push(m); else this.byConversation.set(m.conversationId, [m]);
    this.messageById.set(m.id, m);
  }
  private unindexConversation(id: Id): void {
    for (const m of this.byConversation.get(id) ?? []) this.messageById.delete(m.id);
    this.byConversation.delete(id);
  }

  private parseFile(path: string): Persisted {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Persisted>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('state is not an object');
    const state: Persisted = { ...emptyState(), ...raw, settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) } };
    if (!state.reportLedger) markLegacyReports(state);
    this.rehydrateSideFiles(state);
    return state;
  }

  private load(): Persisted {
    if (!this.file) return { ...emptyState(), reportLedger: 1 };
    const bak = `${this.file}.bak`;
    if (!existsSync(this.file)) {
      if (!existsSync(bak)) return { ...emptyState(), reportLedger: 1 };
      try {
        const st = this.parseFile(bak);
        this.notices.push('state.json was missing; Harbor restored its last backup. Changes from the last moments before the previous exit may be missing.');
        return st;
      } catch { return { ...emptyState(), reportLedger: 1 }; }
    }
    try {
      return this.parseFile(this.file);
    } catch {
      // Keep the unreadable file for inspection rather than silently overwriting it.
      const kept = `${this.file}.corrupt-${this.now()}`;
      let quarantined = true;
      try { renameSync(this.file, kept); } catch { quarantined = false; }
      const where = quarantined ? ` The unreadable file was kept as ${kept}.` : '';
      if (existsSync(bak)) {
        try {
          const st = this.parseFile(bak);
          this.notices.push(`state.json could not be read; Harbor restored its last backup. Recent changes may be missing.${where}`);
          return st;
        } catch { /* backup unreadable too */ }
      }
      this.notices.push(`state.json could not be read and no usable backup exists, so Harbor started empty.${where}`);
      return { ...emptyState(), reportLedger: 1 };
    }
  }

  private get sideDir(): string | undefined { return this.file ? join(dirname(this.file), 'side') : undefined; }

  /** Puts full reports and snapshot file lists back from their side files (state.json only holds clipped reports and counts). */
  private rehydrateSideFiles(state: Persisted): void {
    const dir = this.file ? join(dirname(this.file), 'side') : undefined;
    if (!dir) return;
    for (const a of state.agents) {
      if (a.report?.endsWith(REPORT_MARK)) {
        try { a.report = readFileSync(join(dir, `report-${safeName(a.id)}.txt`), 'utf8'); } catch { /* keep the clipped text */ }
      }
      for (const sn of a.snapshots ?? []) {
        const n = (sn as { fileCount?: number }).fileCount;
        if (n === undefined) continue;
        try { sn.files = JSON.parse(readFileSync(join(dir, `snap-${safeName(a.id)}-${sn.revision}.json`), 'utf8')); } catch { /* counts only */ }
        delete (sn as { fileCount?: number }).fileCount;
      }
    }
  }

  /** The state as written to disk: long reports clipped and snapshot file lists reduced to counts, both kept in side files. */
  private persistedView(): Persisted {
    const dir = this.sideDir;
    if (!dir) return this.state;
    const agents = this.state.agents.map((a) => {
      let out: AgentRecord = a;
      if (a.report && a.report.length > REPORT_STORE_CHARS && this.writeSide(join(dir, `report-${safeName(a.id)}.txt`), a.report)) {
        out = { ...out, report: a.report.slice(0, REPORT_STORE_CHARS) + REPORT_MARK };
      }
      if (a.snapshots?.some((sn) => sn.files.length)) {
        const snaps = a.snapshots.map((sn) => {
          if (!sn.files.length) return sn;
          const ok = this.writeSide(join(dir, `snap-${safeName(a.id)}-${sn.revision}.json`), JSON.stringify(sn.files));
          return ok ? { ...sn, files: [], fileCount: sn.files.length } : sn;
        });
        out = { ...out, snapshots: snaps };
      }
      return out;
    });
    return { ...this.state, agents };
  }

  private writeSide(path: string, content: string): boolean {
    if (this.sideWritten.get(path) === content.length) return true;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      this.sideWritten.set(path, content.length);
      return true;
    } catch { return false; } // the full text then stays inline in state.json
  }

  private dirty(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 150);
    this.timer.unref?.();
  }

  /**
   * Writes state atomically (temp + rename) after rotating a backup copy. Never throws: a failed write is retried, then
   * recorded in `lastFlushError` (state stays in memory and a later flush retries).
   */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.file) return;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.persistedView()));
        this.rotateBackup();
        renameSync(tmp, this.file);
        this.flushError = undefined;
        return;
      } catch (e) {
        lastError = e;
        sleepSync(40 * (attempt + 1)); // Windows: antivirus or an indexer can briefly hold the file
      }
    }
    this.flushError = { time: this.now(), message: lastError instanceof Error ? lastError.message : String(lastError) };
    try { this.onFlushError?.(this.flushError); } catch { /* observer must not break the store */ }
    // Try again later instead of giving up until the next change.
    if (!this.timer) { this.timer = setTimeout(() => this.flush(), 5000); this.timer.unref?.(); }
  }

  /** Copies the current good state.json to state.json.bak, at most once per interval. A failed copy never blocks the write. */
  private rotateBackup(): void {
    if (!this.file || !existsSync(this.file)) return;
    const t = this.now();
    if (this.lastBak && t - this.lastBak < this.bakIntervalMs) return;
    try { copyFileSync(this.file, `${this.file}.bak`); this.lastBak = t; } catch { /* best effort */ }
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
    for (const c of convIds) this.unindexConversation(c);
    this.state.agents = this.state.agents.filter((a) => a.projectId !== id);
    this.state.locks = this.state.locks.filter((l) => l.projectId !== id);
    if (this.state.toolRules?.[id]) { const { [id]: _gone, ...rest } = this.state.toolRules; this.state.toolRules = rest; }
    if (this.state.checksApproved?.[id]) { const { [id]: _gone, ...rest } = this.state.checksApproved; this.state.checksApproved = rest; }
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
    this.unindexConversation(id);
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
  /**
   * A conversation's messages by time. With `limit` only the newest `limit` are returned (ascending); `before` (a message id or an
   * epoch-ms time) pages backwards from there. Without options the whole conversation is returned, as before.
   */
  listMessages(conversationId: Id, opts?: { before?: Id | number; limit?: number }): Message[] {
    const all = [...(this.byConversation.get(conversationId) ?? [])].sort((a, b) => a.time - b.time);
    if (!opts || (opts.before === undefined && opts.limit === undefined)) return all;
    let end = all.length;
    if (opts.before !== undefined) {
      const at = typeof opts.before === 'number' ? opts.before : this.messageById.get(opts.before)?.time;
      if (at !== undefined) {
        const idx = typeof opts.before === 'number' ? all.findIndex((m) => m.time >= at) : all.findIndex((m) => m.id === opts.before);
        end = idx < 0 ? (typeof opts.before === 'number' ? all.length : end) : idx;
      }
    }
    const limit = opts.limit === undefined ? end : Math.max(1, Math.floor(opts.limit));
    return all.slice(Math.max(0, end - limit), end);
  }
  countMessages(conversationId: Id): number { return this.byConversation.get(conversationId)?.length ?? 0; }
  getMessage(id: Id): Message | undefined { return this.messageById.get(id); }
  addMessage(m: Message): Message { this.state.messages.push(m); this.indexMessage(m); this.touchConversation(m.conversationId); this.dirty(); return m; }
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
   * to a weaker status for the same result. Only the agent's current result is marked: a late mark for an older revision or
   * an earlier incarnation (`gen`, a resumed helper that ended the same way) must neither replace its mark nor look like one.
   */
  markReports(marks: ReportMark[], status: ReportDelivery['status']): void {
    const time = Date.now();
    for (const m of marks) {
      const a = this.getAgent(m.id);
      if (!a || !sameResult({ v: 1, ...currentResult(a), status, time }, m)) continue;
      const cur = a.reportDelivery;
      if (sameResult(cur, m) && DELIVERY_RANK[cur!.status] >= DELIVERY_RANK[status]) continue;
      a.reportDelivery = { v: 1, revision: m.revision, gen: m.gen ?? 0, state: m.state, status, time };
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
  /**
   * A stopped agent resumed in place keeps its revision: its old mark must not hide the outcome of the resumed run, and a
   * turn still carrying the old result must not mark the new one. A new delivery generation separates the two.
   */
  clearReportDelivery(id: Id): void {
    const a = this.getAgent(id);
    if (!a) return;
    delete a.reportDelivery;
    a.reportGen = (a.reportGen ?? 0) + 1;
    this.dirty();
  }

  // ---- sessions (native CLI session ids)
  /**
   * One link per (key, CLI): a fallback to another CLI must not destroy the session the first CLI can still resume. Without `cli`
   * the most recently updated link of the key is returned (what older callers, and files with one link per key, mean).
   */
  getSession(agentId: Id, cli?: CliId): SessionLink | undefined {
    const all = this.state.sessions.filter((s) => s.agentId === agentId && (cli === undefined || s.cli === cli));
    return all.reduce<SessionLink | undefined>((best, s) => (!best || s.updated >= best.updated ? s : best), undefined);
  }
  setSession(link: SessionLink): void {
    const i = this.state.sessions.findIndex((s) => s.agentId === link.agentId && s.cli === link.cli);
    if (i >= 0) this.state.sessions[i] = link; else this.state.sessions.push(link);
    this.dirty();
  }
  /** Models of the saved native sessions of one CLI: a resumed session must keep its model even when a model list drops it. */
  sessionModels(cli: CliId): string[] { return [...new Set(this.state.sessions.filter((s) => s.cli === cli && s.model).map((s) => s.model!))]; }
  clearSession(agentId: Id): void { this.state.sessions = this.state.sessions.filter((s) => s.agentId !== agentId); this.dirty(); }

  // ---- usage
  addUsage(u: UsageEvent): void {
    this.state.usage.push(u);
    if (this.state.usage.length > USAGE_PRUNE_AT) this.pruneUsage();
    this.dirty();
  }
  /**
   * Folds usage events older than `USAGE_KEEP_MS` into `usageArchive` (totals per project) so state.json stays small. Every
   * windowed question the ledger asks (5 h / 7 d, cooldowns, reported limits) is answered by newer events; lifetime
   * cost figures should add `usageArchive()`.
   */
  pruneUsage(): void {
    const cutoff = this.now() - USAGE_KEEP_MS;
    if (!this.state.usage.some((u) => u.time < cutoff)) return;
    const archive: UsageArchive = this.state.usageArchive ?? { total: emptyTotals(), byProject: {} };
    const keep: UsageEvent[] = [];
    for (const u of this.state.usage) {
      if (u.time >= cutoff) { keep.push(u); continue; }
      for (const t of [archive.total, (archive.byProject[u.projectId] ??= emptyTotals())]) {
        t.runs += 1; t.inputTokens += u.inputTokens ?? 0; t.outputTokens += u.outputTokens ?? 0; t.costUsd += u.costUsd ?? 0;
      }
    }
    this.state.usage = keep;
    this.state.usageArchive = archive;
  }
  /** Totals of pruned usage events, for one project or overall. */
  usageArchive(projectId?: Id): UsageTotals {
    const a = this.state.usageArchive;
    return { ...(projectId ? a?.byProject[projectId] : a?.total) ?? emptyTotals() };
  }
  /** Agents currently working, per CLI (cheap scan of the agent list, no process inspection). */
  runningByCli(): Record<CliId, number> {
    const out: Record<CliId, number> = {};
    for (const a of this.state.agents) if (a.state === 'working' && a.cli) out[a.cli] = (out[a.cli] ?? 0) + 1;
    return out;
  }
  listUsage(): UsageEvent[] { return this.state.usage; }

  /** Cost figures learned from measured runs (calibration.ts); absent until the first run, and in files written before Phase 3. */
  getCalibration(): Calibration | undefined {
    const c = this.state.calibration;
    return c && c.version === 1 && typeof c.throughTime === 'number' && c.pctPerKTok && c.tokensK && c.minutes ? c : undefined;
  }
  setCalibration(c: Calibration): void { this.state.calibration = c; this.dirty(); }
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

  // ---- approval of a project's checks file (by content hash)
  getChecksApproval(projectId: Id): string | undefined { return this.state.checksApproved?.[projectId]; }
  setChecksApproval(projectId: Id, hash: string): void {
    this.state.checksApproved = { ...(this.state.checksApproved ?? {}), [projectId]: hash };
    this.flush(); // an approval must survive a crash right after it
  }

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
/** Fan-out brake per lead turn (see leadTurn): helpers beyond these wait for the lead's confirmation. */
export const DEFAULT_HELPERS_PER_TURN = 4;
export const DEFAULT_PLANNERS_PER_TURN = 1;
export const HELPERS_PER_TURN_RANGE = [1, 12] as const;
export const PLANNERS_PER_TURN_RANGE = [1, 4] as const;
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
  if ('editor' in patch && patch.editor !== undefined && !isEditorId(patch.editor)) throw new Error('editor must be one of code, code-insiders, cursor, windsurf.');
  if (patch.maxHelpersPerTurn !== undefined) out.maxHelpersPerTurn = clampInt(patch.maxHelpersPerTurn, HELPERS_PER_TURN_RANGE, 'maxHelpersPerTurn');
  if (patch.maxPlannersPerTurn !== undefined) out.maxPlannersPerTurn = clampInt(patch.maxPlannersPerTurn, PLANNERS_PER_TURN_RANGE, 'maxPlannersPerTurn');
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
  /** Undefined = headroom routing (see RoutingPolicy.lowAllowance). */
  lowAllowancePolicy?: LowAllowancePolicy;
  subscriptionReserve: number;
}

export function effectiveSettings(s: Settings, projectId?: Id): EffectiveSettings {
  const p: ProjectSettings = (projectId && s.projectOverrides?.[projectId]) || {};
  return {
    concurrencyLimit: p.concurrencyLimit ?? s.concurrencyLimit,
    allowedModels: { ...(s.allowedModels ?? {}), ...(p.allowedModels ?? {}) },
    rolePreferences: { ...(s.rolePreferences ?? {}), ...(p.rolePreferences ?? {}) },
    effortPolicy: p.effortPolicy ?? s.effortPolicy ?? 'adaptive',
    // Left unset on purpose: absent means headroom routing in the router (an explicit 'reduceEffort' keeps the old stay-put meaning).
    lowAllowancePolicy: p.lowAllowancePolicy ?? s.lowAllowancePolicy,
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

/** Agent ids become file names; anything unusual is replaced so an id can never escape the side folder. */
const safeName = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);

export function normPath(p: string): string {
  return p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}
