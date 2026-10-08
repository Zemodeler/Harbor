import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CliId, HarborApi, HarborEvent, Id, Project } from '../shared/api';
import { ClaudeAdapter } from './adapters/claude';
import { CodexAdapter } from './adapters/codex';
import type { CliAdapter } from './adapters/types';
import { discoverClis, loginCommand, toStatus, type ResolvedCli } from './clis/discovery';
import { CLI_DEFINITIONS } from './clis/registry';
import { EventBus } from './events';
import { Git } from './git';
import { Orchestrator, toAgent } from './orchestrator';
import { newId, Store } from './store';
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
}

/** CLIs whose headless flow has been verified against a real install in this repo's history. */
const VERIFIED = new Set<CliId>(['claude']);

export function createHarborService(opts: ServiceOptions = {}): HarborService {
  const store = new Store(opts.dataDir);
  const bus = new EventBus();
  const ledger = new UsageLedger(store, { measurable: (id) => !!adapterFor(id), ...opts.ledger });
  const git = opts.git ?? new Git();
  const worktreesRoot = opts.worktreesRoot ?? join(opts.dataDir ?? join(process.env['TEMP'] ?? '.', 'harbor-test'), 'worktrees');
  let clis: ResolvedCli[] = [];

  const defaultAdapter = (id: CliId, r?: ResolvedCli): CliAdapter | undefined => {
    if (!r?.installed || !r.path) return undefined;
    if (id === 'claude') return new ClaudeAdapter(r.path);
    if (id === 'codex') return new CodexAdapter(r.path);
    return undefined; // gemini and others: detected, but no headless adapter yet
  };
  const adapterFor = (id: CliId) => (opts.adapterFor ?? defaultAdapter)(id, clis.find((c) => c.id === id));

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

  const orchestrator = new Orchestrator({
    store, bus, ledger, git, worktreesRoot, ask, freeReset,
    getClis: () => clis,
    adapterFor,
    enabled: (c) => store.getSettings().cliOverrides[c]?.enabled !== false,
    verified: (c) => VERIFIED.has(c),
    maxActivePerProject: opts.maxActivePerProject
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
    async newConversation(projectId) { needProject(projectId); return orchestrator.newConversation(projectId); },
    async listMessages(conversationId) { return store.listMessages(conversationId); },
    async deleteConversation(id) {
      const c = store.getConversation(id);
      if (!c) return;
      if (store.getAgent(c.agentId)?.state === 'working') throw new Error('Stop the running agents before deleting this conversation.');
      store.removeConversation(id);
    },
    async send(conversationId, text) {
      await ready;
      if (!text.trim()) return;
      await orchestrator.userMessage(conversationId, text);
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

    async getUsage() { await ready; return ledger.windows(clis.filter((c) => c.installed).map((c) => c.id)); },
    async getSettings() { return store.getSettings(); },
    async setSettings(s) { return store.setSettings(s); },
    async answerPermission(requestId, allow) {
      const r = pending.get(requestId);
      if (!r) return;
      pending.delete(requestId);
      r(allow);
    },
    onEvent: (cb) => bus.on(cb)
  };
}
