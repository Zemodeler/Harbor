import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { Attachment, CliId, ConversationMode, HarborApi, HarborEvent, Id, Project } from '../shared/api';
import { ClaudeAdapter } from './adapters/claude';
import { CodexAdapter } from './adapters/codex';
import type { CliAdapter } from './adapters/types';
import { discoverClis, loginCommand, toStatus, type ResolvedCli } from './clis/discovery';
import { loadCatalog } from './clis/capabilities';
import { CLI_DEFINITIONS } from './clis/registry';
import { EventBus } from './events';
import { Git } from './git';
import { GitView } from './gitView';
import { Orchestrator, toAgent } from './orchestrator';
import type { ProcessKiller } from './proc';
import { newId, Store } from './store';
import { Journal } from './journal';
import { reviewDirectory } from './review';
import { previewRollback } from './rollback';
import { FreeResetCoordinator, UsageLedger, type LedgerOptions } from './usage';

export type HarborService = Omit<HarborApi, 'onEvent'> & {
  onEvent(cb: (e: HarborEvent) => void): () => void;
  /** Main-process extras (not part of the renderer contract). */
  readonly orchestrator: Orchestrator;
  readonly store: Store;
  whenIdle(timeoutMs?: number): Promise<void>;
  shutdown(): void;
};

export interface ServiceOptions {
  /** Where state.json and worktrees live. Undefined => in-memory store (tests). */
  dataDir?: string;
  /** Folder picker for addProject(); injected so this module never imports electron. */
  pickFolder?: () => Promise<string | undefined>;
  openFolder?: (path: string) => Promise<void>;
  /** Replace discovery (tests). */
  discover?: () => Promise<ResolvedCli[]>;
  /** Replace adapter construction (tests). */
  adapterFor?: (cli: CliId, resolved: ResolvedCli | undefined) => CliAdapter | undefined;
  ledger?: LedgerOptions;
  git?: Git;
  maxActivePerProject?: number;
  /** Delays for automatic re-checks after a previously seen CLI goes missing (tests shorten these). */
  recheckDelaysMs?: number[];
  /** Override where worktrees are created (tests). */
  worktreesRoot?: string;
  /** Replace the startup orphan-process killer (tests). */
  killer?: ProcessKiller;
  /** Where rollback evidence patches are written (default: <dataDir>/patches; none for an in-memory store). */
  patchesRoot?: string;
}

const CONVERSATION_MODES: ConversationMode[] = ['default', 'auto', 'plan', 'goal'];
// A Map, not an object: a mime such as "constructor" or "__proto__" must never match an inherited property.
const IMAGE_EXT = new Map<string, string>([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp']]);
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Canonical base64 only: right alphabet and padding, and decoding then re-encoding gives the input back (no stray bits). */
export function decodeStrictBase64(s: string): Buffer | undefined {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return undefined;
  const data = Buffer.from(s, 'base64');
  return data.toString('base64') === s ? data : undefined;
}

/** `<data>/attachments/<conversationId>`; refuses ids that are not plain tokens and paths that would leave the attachments folder. */
export function attachmentDir(dataRoot: string, conversationId: string): string {
  if (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId)) throw new Error('Invalid conversation id.');
  const root = resolve(dataRoot, 'attachments');
  const dir = resolve(root, conversationId);
  const rel = relative(root, dir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid conversation id.');
  return dir;
}
export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Validate every image first, then write them as `<dir>/<id>.<ext>`. Nothing is written when any one is rejected. */
export function saveAttachments(dir: string, input: { name: string; mime: string; dataBase64: string }[]): Attachment[] {
  if (input.length > MAX_ATTACHMENTS) throw new Error(`Attach at most ${MAX_ATTACHMENTS} images per message.`);
  const decoded = input.map((a) => {
    const ext = IMAGE_EXT.get(a.mime);
    const name = basename(String(a.name ?? '')).slice(0, 120) || 'image';
    if (!ext) throw new Error(`"${name}" is not a supported image type (use PNG, JPEG, GIF or WebP).`);
    // Check the encoded length before decoding so an oversized payload is never allocated.
    if (typeof a.dataBase64 !== 'string' || a.dataBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4) throw new Error(`"${name}" is larger than 10 MB.`);
    const data = decodeStrictBase64(a.dataBase64);
    if (!data) throw new Error(`"${name}" is not valid image data.`);
    if (!data.length) throw new Error(`"${name}" is empty.`);
    if (data.length > MAX_ATTACHMENT_BYTES) throw new Error(`"${name}" is larger than 10 MB.`);
    return { name, mime: a.mime, ext, data };
  });
  if (decoded.length) mkdirSync(dir, { recursive: true });
  return decoded.map((d) => {
    const path = join(dir, `${newId()}.${d.ext}`);
    writeFileSync(path, d.data);
    return { name: d.name, mime: d.mime, path };
  });
}

/** CLIs whose headless flow has been verified against a real install in this repo's history (codex: 0.160.0, see adapters/codex.ts). */
const VERIFIED = new Set<CliId>(['claude', 'codex']);

/** Login failures from either CLI. Claude reports them in its result text; codex uses the same wording as discovery (clis/registry.ts). */
export const SIGNED_OUT_RE = /not logged in|logged out|not signed in|please run \/login/i;

export function createHarborService(opts: ServiceOptions = {}): HarborService {
  const store = new Store(opts.dataDir);
  const bus = new EventBus();
  const ledger = new UsageLedger(store, { measurable: (id) => !!adapterFor(id), ...opts.ledger });
  const git = opts.git ?? new Git();
  const dataRoot = opts.dataDir ?? join(process.env['TEMP'] ?? '.', 'harbor-test');
  const worktreesRoot = opts.worktreesRoot ?? join(dataRoot, 'worktrees');
  let clis: ResolvedCli[] = [];

  const defaultAdapter = (id: CliId, r?: ResolvedCli): CliAdapter | undefined => {
    if (!r?.installed || !r.path) return undefined;
    if (id === 'claude') return new ClaudeAdapter(r.path);
    if (id === 'codex') return new CodexAdapter(r.path);
    return undefined; // gemini and others: detected, but no headless adapter yet
  };
  // A run that reports a login failure takes the CLI out of routing until the next refresh (discovery sets authState).
  const markSignedOut = (id: CliId) => {
    const c = clis.find((x) => x.id === id);
    if (!c || c.authState === 'signedOut') return;
    // Replace rather than mutate: discovery may hand back shared objects.
    const next: ResolvedCli = { ...c, authState: 'signedOut', signedIn: false, note: 'Installed, login required.' };
    clis = clis.map((x) => (x === c ? next : x));
    bus.emit({ type: 'cli', cli: toStatus(next) });
  };
  const watchAuth = (id: CliId, a: CliAdapter): CliAdapter => ({
    id: a.id,
    async *run(prompt, o) {
      for await (const c of a.run(prompt, o)) {
        if (c.kind === 'done' && !c.ok && SIGNED_OUT_RE.test(c.error ?? '')) markSignedOut(id);
        yield c;
      }
    }
  });
  const adapterFor = (id: CliId) => {
    const a = (opts.adapterFor ?? defaultAdapter)(id, clis.find((c) => c.id === id));
    return a && watchAuth(id, a);
  };

  // ---- permissions: every request is an event; nothing is granted without an explicit answer.
  const pending = new Map<Id, (allow: boolean) => void>();
  const ask = (kind: 'freeReset' | 'tool' | 'conflict', prompt: string, agentId?: Id) =>
    new Promise<boolean>((resolve) => {
      const requestId = newId();
      pending.set(requestId, resolve);
      bus.emit({ type: 'permission', requestId, kind, prompt, agentId });
    });

  const freeReset = new FreeResetCoordinator({
    ledger, store,
    backlog: () => store.allAgentRecords().filter((a) => a.role !== 'main' && a.state === 'queued').length,
    ask: (p) => ask('freeReset', p),
    allow: () => store.getSettings().allowFreeReset
  });

  // Beside state.json; without a data folder (tests) the journal stays in memory, like the Store.
  const journal = new Journal(opts.dataDir ? join(opts.dataDir, 'journal.jsonl') : undefined);
  const orchestrator = new Orchestrator({
    store, bus, ledger, git, worktreesRoot, ask, freeReset, journal,
    getClis: () => clis,
    adapterFor,
    enabled: (c) => store.getSettings().cliOverrides[c]?.enabled !== false,
    verified: (c) => VERIFIED.has(c),
    // Capability knowledge is data: an optional capabilities.json in the data folder overrides the built-in catalog.
    catalog: loadCatalog(opts.dataDir ? join(opts.dataDir, 'capabilities.json') : undefined),
    maxActivePerProject: opts.maxActivePerProject,
    killer: opts.killer,
    patchesRoot: opts.patchesRoot ?? (opts.dataDir ? join(opts.dataDir, 'patches') : undefined)
  });

  // A CLI that was installed earlier and is now missing is usually a self-update swapping its folder (the Claude
  // desktop app does this), so re-check a few times instead of leaving it "Not installed" until a manual refresh.
  const seenInstalled = new Set<CliId>();
  const recheckDelays = opts.recheckDelaysMs ?? [3_000, 10_000, 30_000, 60_000, 120_000];
  let recheckTimer: ReturnType<typeof setTimeout> | undefined;
  // The very first check has no "seen" history, so a swap in progress at launch would otherwise stick: during the
  // startup chain any missing CLI is re-checked, including ones that are genuinely absent (they just stay missing).
  const refresh = async (attempt = 0, startup = false): Promise<ResolvedCli[]> => {
    if (recheckTimer) { clearTimeout(recheckTimer); recheckTimer = undefined; }
    clis = await (opts.discover ?? discoverClis)();
    for (const c of clis) { if (c.installed) seenInstalled.add(c.id); bus.emit({ type: 'cli', cli: toStatus(c) }); }
    const lost = clis.some((c) => !c.installed && (startup || seenInstalled.has(c.id)));
    if (lost && attempt < recheckDelays.length) {
      recheckTimer = setTimeout(() => { void refresh(attempt + 1, startup).catch(() => {}); }, recheckDelays[attempt]);
      recheckTimer.unref?.();
    }
    return clis;
  };
  const ready = refresh(0, true).then(() => orchestrator.recover(), () => orchestrator.recover());

  const needProject = (id: Id): Project => {
    const p = store.getProject(id);
    if (!p) throw new Error(`Unknown project ${id}`);
    return p;
  };
  const gitViewOf = async (projectId: Id): Promise<GitView> => {
    const view = await GitView.open(needProject(projectId).path);
    if (!view) throw new Error('This project folder is not a Git repository.');
    return view;
  };

  return {
    orchestrator, store,
    whenIdle: async (t) => { await ready; await orchestrator.whenIdle(t); },
    shutdown: () => { if (recheckTimer) clearTimeout(recheckTimer); store.flush(); },

    async listClis() { await ready; return clis.map(toStatus); },
    async refreshClis() { return (await refresh()).map(toStatus); },
    async openLogin(cliId) {
      const def = CLI_DEFINITIONS.find((d) => d.id === cliId);
      const r = clis.find((c) => c.id === cliId);
      if (!def || !r?.path) throw new Error(`${cliId} is not installed`);
      if (process.platform !== 'win32') throw new Error('Opening a login terminal is only implemented on Windows');
      // Visible terminal; Harbor never reads or stores credentials.
      spawn('cmd.exe', ['/d', '/c', loginCommand(def, r.path)], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    },

    async listProjects() { return store.listProjects(); },
    async addProject(path) {
      const chosen = path ?? (await opts.pickFolder?.());
      if (!chosen) return null;
      if (!existsSync(chosen) || !statSync(chosen).isDirectory()) throw new Error(`Not a folder: ${chosen}`);
      const existing = store.findProjectByPath(chosen);
      const project = store.upsertProject(existing
        ? { ...existing, lastOpened: Date.now() }
        : { id: newId(), name: basename(chosen) || chosen, path: chosen, lastOpened: Date.now() });
      orchestrator.ensureProject(project);
      return project;
    },
    async setProjectImage(id, image) {
      const p = needProject(id);
      // Stored inline in state.json, so keep it small: the renderer downscales before sending.
      if (image !== null && (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(image) || image.length > 300_000)) throw new Error('Choose a PNG, JPEG, WebP or GIF image (it is resized to a small icon).');
      const { image: _old, ...rest } = p;
      return store.upsertProject(image === null ? rest : { ...rest, image });
    },
    async removeProject(id) {
      for (const a of store.listAgentRecords(id)) orchestrator.stop(a.id);
      store.removeProject(id); // Harbor records only; files and worktrees on disk are untouched.
    },

    async listConversations(projectId) {
      const main = store.mainAgent(needProject(projectId).id);
      return store.listConversations(projectId).filter((c) => c.agentId === main?.id);
    },
    async updateConversation(id, patch) {
      const c = store.getConversation(id);
      if (!c) throw new Error('This conversation is no longer available.');
      if (patch.archived && (c.activity && ['queued', 'working', 'waiting'].includes(c.activity.state) || pending.size || store.listAgentRecords(c.projectId).some(a => a.parentConversationId === id && ['queued', 'working', 'waiting'].includes(a.state)))) throw new Error('Finish or stop the session and answer pending requests before archiving.');
      if (patch.title !== undefined && (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.length > 160)) throw new Error('Use a conversation name between 1 and 160 characters.');
      const update: Partial<typeof c> = {};
      if (patch.title !== undefined) { update.title = patch.title.trim(); update.customTitle = true; }
      if (patch.pinned !== undefined) { if (typeof patch.pinned !== 'boolean') throw new Error('Invalid pin preference.'); update.pinned = patch.pinned; }
      if (patch.archived !== undefined) { if (typeof patch.archived !== 'boolean') throw new Error('Invalid archive preference.'); update.archived = patch.archived; }
      store.patchConversation(id, update);
      bus.emit({ type: 'conversation', conversation: { ...c } });
      return { ...c };
    },
    async searchConversations(query, projectId) {
      const term = query.trim().toLocaleLowerCase();
      if (!term) return [];
      const projects = projectId ? [needProject(projectId)] : store.listProjects();
      return projects.flatMap(p => store.listConversations(p.id).filter(c => c.agentId === store.mainAgent(p.id)?.id).flatMap(c => {
        const m = store.listMessages(c.id).find(m => m.text.toLocaleLowerCase().includes(term));
        if (!c.title.toLocaleLowerCase().includes(term) && !m) return [];
        const index = m?.text.toLocaleLowerCase().indexOf(term) ?? 0;
        return [{ conversation: { ...c }, projectName: p.name, excerpt: m?.text.slice(Math.max(0, index - 50), index + 150) }];
      })).sort((a, b) => b.conversation.updated - a.conversation.updated).slice(0, 100);
    },
    async stopConversation(id) { orchestrator.stopConversation(id); },
    async getReview(id) {
      const c = store.getConversation(id);
      if (!c) throw new Error('This conversation is no longer available.');
      const project = needProject(c.projectId);
      const roots = [{ directory: project.path, source: project.name, base: c.reviewBase }, ...store.listAgentRecords(project.id).filter(a => a.parentConversationId === id && a.worktree).map(a => ({ directory: a.worktree!, source: a.title, base: a.baseCommit }))];
      const files = [], notes = ['Current workspace changes may include edits made outside this session.', 'Verification has not been tied to this snapshot. Check the agent reports and rerun relevant checks before merging.', 'Credential file previews are excluded.'];
      for (const root of roots) {
        try { files.push(...await reviewDirectory(root.directory, root.source, root.base)); }
        catch (e) { notes.push(e instanceof Error ? e.message : 'A workspace could not be read.'); }
      }
      return { conversationId: id, capturedAt: Date.now(), files, notes };
    },
    async openProjectFolder(id) {
      const project = needProject(id);
      if (!opts.openFolder) throw new Error('Opening folders is available in the desktop app.');
      await opts.openFolder(project.path);
    },
    async getGitOverview(projectId) {
      const view = await GitView.open(needProject(projectId).path);
      if (!view) return { projectId, branches: [], worktrees: [], notes: ['This project folder is not a Git repository.'] };
      return view.overview(projectId, store.listAgentRecords(projectId));
    },
    async getGitLog(projectId, opts) { return (await gitViewOf(projectId)).log(opts); },
    async getGitChanges(projectId, target) { return (await gitViewOf(projectId)).changes(target); },
    async getGitDiff(projectId, path, target) { return (await gitViewOf(projectId)).diff(path, target); },
    async newConversation(projectId) { needProject(projectId); return orchestrator.newConversation(projectId); },
    async listMessages(conversationId) { return store.listMessages(conversationId); },
    async deleteConversation(id) {
      const c = store.getConversation(id);
      if (!c) return;
      if (c.activity && ['working', 'queued', 'waiting'].includes(c.activity.state) || pending.size || store.listAgentRecords(c.projectId).some(a => a.parentConversationId === id && ['working', 'queued', 'waiting'].includes(a.state))) throw new Error('Stop the running session and answer pending requests before deleting this conversation.');
      store.removeConversation(id);
      try { rmSync(attachmentDir(dataRoot, id),{ recursive: true, force: true }); } catch { /* best effort: only Harbor's own copies */ }
      for (const k of [`lead:${id}`, `concierge:${id}`]) store.clearSession(k);
    },
    async send(conversationId, text, attachments) {
      await ready;
      if (!text.trim() && !attachments?.length) return;
      if (!store.getConversation(conversationId)) throw new Error('This conversation is no longer available.');
      const saved = attachments?.length ? saveAttachments(attachmentDir(dataRoot, conversationId), attachments) : [];
      await orchestrator.userMessage(conversationId, text.trim() ? text : 'See the attached image(s).', saved);
    },
    async setConversationMode(conversationId, mode, goal) {
      const c = store.getConversation(conversationId);
      if (!c) throw new Error('This conversation is no longer available.');
      if (!CONVERSATION_MODES.includes(mode)) throw new Error('Unknown conversation mode.');
      const text = goal?.trim();
      if (mode === 'goal' && !text) throw new Error('Goal mode needs a goal: say what should be true when the lead is done.');
      const previous = c.mode ?? 'default';
      store.patchConversation(conversationId, { mode, goal: mode === 'goal' ? text!.slice(0, 2000) : undefined });
      orchestrator.modeChanged(conversationId, previous, mode);
      bus.emit({ type: 'conversation', conversation: { ...c } });
      return { ...c };
    },

    async listAgents(projectId) { return store.listAgentRecords(projectId).map(toAgent); },
    async openAgentConversation(agentId) {
      const a = store.getAgent(agentId);
      if (!a) throw new Error('Unknown agent');
      if (a.role === 'main') return store.listConversations(a.projectId).find((c) => c.agentId === a.id) ?? orchestrator.newConversation(a.projectId);
      const c = store.findConversationByAgent(agentId);
      if (c) return c;
      return store.addConversation({ id: newId(), projectId: a.projectId, title: `${a.role}: ${a.title}`, updated: Date.now(), agentId });
    },
    async stopAgent(agentId) { orchestrator.stop(agentId); },
    async setAgentPriority(agentId, priority) { orchestrator.setPriority(agentId, priority); },
    async pauseAgent(agentId) { orchestrator.pause(agentId); },
    async resumeAgent(agentId) { orchestrator.resume(agentId); },
    async resumeAgentSession(agentId) { orchestrator.resumeAgent(agentId); },
    async integrateBranches(projectId, agentIds, target) { await ready; return toAgent(orchestrator.integrateBranches(needProject(projectId).id, agentIds, target)); },
    async applyIntegration(agentId) { return toAgent(await orchestrator.applyIntegration(agentId)); },
    async getChanges(agentId) {
      const a = store.getAgent(agentId);
      if (!a) throw new Error('Unknown agent');
      const repo = needProject(a.projectId).path;
      // An integration spans base..head; a helper's branch spans its base commit to the branch's current head.
      const from = a.integration ? a.integration.base : a.baseCommit;
      const to = a.integration?.head ?? (a.branch ? await git.branchHead(repo, a.branch) : undefined);
      return from && to ? git.changes(repo, from, to) : [];
    },
    async previewRollback(agentId, target) {
      const a = store.getAgent(agentId);
      if (!a) throw new Error('Unknown agent');
      if (a.role === 'main') throw new Error('The lead agent has no task to roll back.');
      if (target !== undefined && typeof target !== 'string') throw new Error('Name an existing local branch, or leave the target out.');
      return previewRollback({ git, repo: needProject(a.projectId).path, agents: store.listAgentRecords(a.projectId) }, a, target);
    },

    async getUsage() { await ready; return ledger.windows(clis.filter((c) => c.installed).map((c) => c.id)); },
    async getSettings() { return store.getSettings(); },
    async setSettings(s) {
      const next = store.setSettings(s);
      // A raised concurrency limit should start waiting work now, not at the next unrelated event.
      for (const p of store.listProjects()) orchestrator.pump(p.id);
      return next;
    },
    async answerPermission(requestId, allow) {
      const r = pending.get(requestId);
      if (!r) return;
      pending.delete(requestId);
      r(allow);
    },
    async answerQuestion(requestId, answer) { await ready; await orchestrator.answerQuestion(requestId, answer); },
    onEvent: (cb) => bus.on(cb)
  };
}
