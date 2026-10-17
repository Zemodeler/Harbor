import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { Attachment, BundleExportPreview, BundleExportResult, BundleImportOptions, BundleImportResult, BundlePreview, BundleSelection, ChatImportPreview, ChatImportResult, ChatImportSourceId, ChatImportSourceInfo, DocumentResult, Message, ScreenshotSource, CliId, CustomCliDescriptor, Conversation, ConversationMode, EditorId, GitCommit, HarborApi, HarborEvent, Id, PendingPermission, Project, ProjectNote, RemoteScope, RemoteTokenInfo, SpendStatus } from '../shared/api';
import { ClaudeAdapter } from './adapters/claude';
import { CodexAdapter } from './adapters/codex';
import type { CliAdapter } from './adapters/types';
import { cliPathProblem, defaultDiscoveryDeps, discoverClis, findExecutable, isFilePath, loginCommand, resolveCli, toStatus, type ResolvedCli } from './clis/discovery';
import { loadCatalogWithWarnings, parseCatalog, type CatalogEntry } from './clis/capabilities';
import { mergeCodexModels, type CodexModel } from './clis/codexModels';
import { CLI_DEFINITIONS } from './clis/registry';
import { EventBus } from './events';
import { Git } from './git';
import { GitView } from './gitView';
import { isEditorId } from './launcher';
import { Orchestrator, toAgent, type OrchestratorDeps } from './orchestrator';
import { runProcess, type ProcessKiller, type Runner } from './proc';
import { newId, normPath, Store } from './store';
import { GenericAdapter } from './adapters/generic';
import { CLI_TEMPLATES, CUSTOM_CLIS_FILE, MAX_CUSTOM_CLIS, catalogEntriesOf, definitionOf, fileStamp, hashFile, hasReadOnlyMode, loadCustomClis, saveCustomClis, validateDescriptor } from './clis/custom';
import { dryRunCli } from './clis/dryRun';
import { skillsSection } from './prompts';
import { SkillManager, type SkillHomes } from './skills/library';
import type { SkillAccess } from './skills/delivery';
import type { FetchLike } from './skills/github';
import { effectiveSettings, mergeSettings, USAGE_KEEP_MS } from './store';
import { aggregateRatings, isRatingValue, MAX_RATING_NOTE, ratingTarget } from './ratings';
import { recordedDecisions, replayDecisions, type ReplayScenario } from './routingReplay';
import { buildTaskReport } from './taskReport';
import { Journal } from './journal';
import { buildDiagnostics, startupNotices } from './diagnostics';
import { readLogTail } from './logger';
import { projectPathRefusal } from './projectPath';
import { reviewDirectory } from './review';
import { previewRollback } from './rollback';
import type { RepoMapCache } from './repoMap';
import { RemoteTokens } from './remote/tokens';
import { FreeResetCoordinator, UsageLedger, type LedgerOptions } from './usage';
import { attachmentDir, attachmentUrl, copyShownImage, real, savePng, urlForStoredPath } from './images';
import { ScreenshotBroker, type Capturer } from './screenshots';
import { canOpenExternally, openDocumentAt, resolveDocumentPath, type DocumentRoot } from './documents';
import { Transfer } from './bundles/transfer';
import { MCP_SERVERS_FILE, McpRegistry, validateMcpServer } from './mcp/registry';
import { planMcpRun, type McpTarget } from './mcp/materialize';
import { probeMcpServer, type McpFetch } from './mcp/probe';
import { discoverCliMcpServers } from './mcp/discover';

type Extras = 'getTaskReport' | 'rateResult' | 'listRatings' | 'getRatingSummary' | 'replayRouting';
export type HarborService = Omit<HarborApi, 'onEvent' | 'exportDiagnostics' | 'getGitLogPage' | 'openWorkspace' | 'setConversationDeadline' | Extras | 'previewScreenshot' | 'answerScreenshot' | 'openDocument' | 'pickDocument' | 'documentAction' | 'pathForFile' | 'previewBundleExport' | 'exportBundle' | 'browseImportFile' | 'previewBundle' | 'importBundle' | 'listImportSources' | 'previewImport' | 'importConversation' | 'continueImported' | 'getSpendStatus' | 'listProjectNotes' | 'removeProjectNote' | 'createRemoteToken' | 'listRemoteTokens' | 'revokeRemoteToken'> & Required<Pick<HarborApi, Extras>> & {
  createRemoteToken(name: string, scope: RemoteScope): Promise<{ token: string; info: RemoteTokenInfo }>;
  listRemoteTokens(): Promise<RemoteTokenInfo[]>;
  revokeRemoteToken(id: Id): Promise<void>;
  listProjectNotes(projectId: Id): Promise<ProjectNote[]>;
  removeProjectNote(projectId: Id, noteId: Id): Promise<ProjectNote[]>;
  getSpendStatus(projectId?: Id, conversationId?: Id): Promise<SpendStatus>;
  previewBundleExport(projectId: Id, selection: BundleSelection): Promise<BundleExportPreview>;
  exportBundle(token: string, opts?: { keepSecrets?: boolean; redactSecrets?: boolean }): Promise<BundleExportResult | null>;
  browseImportFile(kind: 'bundle' | 'chatExport'): Promise<string | null>;
  previewBundle(path: string): Promise<BundlePreview>;
  importBundle(token: string, opts: BundleImportOptions): Promise<BundleImportResult>;
  listImportSources(): Promise<ChatImportSourceInfo[]>;
  previewImport(source: ChatImportSourceId, opts?: { path?: string }): Promise<ChatImportPreview>;
  importConversation(projectId: Id, token: string, entryIds: string[]): Promise<ChatImportResult>;
  continueImported(conversationId: Id, opts: { cli: CliId }): Promise<Conversation>;
  openDocument(projectId: Id, path: string, opts?: { agentId?: Id; since?: number }): Promise<DocumentResult>;
  pickDocument(projectId: Id): Promise<DocumentResult | null>;
  documentAction(projectId: Id, path: string, action: 'openExternal' | 'reveal', opts?: { agentId?: Id }): Promise<void>;
  previewScreenshot(requestId: Id, opts?: { sourceId?: string }): Promise<ScreenshotSource[]>;
  answerScreenshot(requestId: Id, answer: { allow: boolean; sourceId?: string; forConversation?: boolean }): Promise<void>;
  setConversationDeadline(conversationId: Id, deadline: number | null): Promise<Conversation>;
  openWorkspace(projectId: Id, action: 'terminal' | 'editor' | 'folder', opts?: { agentId?: Id; file?: string }): Promise<void>;
  exportDiagnostics(): Promise<string>;
  getGitLogPage(projectId: Id, opts?: { branch?: string; limit?: number; skip?: number }): Promise<{ commits: GitCommit[]; hasMore: boolean; note?: string }>;
  onEvent(cb: (e: HarborEvent) => void): () => void;
  /** Main-process extras (not part of the renderer contract). */
  readonly orchestrator: Orchestrator;
  readonly store: Store;
  /** Hashed remote-API tokens (remote/server.ts verifies against them). */
  readonly remoteTokens: RemoteTokens;
  whenIdle(timeoutMs?: number): Promise<void>;
  /**
   * Quitting: aborts every run, ends the CLI processes Harbor started (through the injected killer) and persists. The abort and
   * the flush happen before the first await, so a caller that does not wait still gets state on disk.
   */
  shutdown(): Promise<void>;
  /** Agent runs and lead turns in flight: what quitting would interrupt. */
  activeRuns(): number;
  /** The machine woke from sleep: re-arms the permission request timers against their wall-clock deadlines. */
  onResume(): void;
};

export interface ServiceOptions {
  /** Where state.json and worktrees live. Undefined => in-memory store (tests). */
  dataDir?: string;
  /** Folder picker for addProject(); injected so this module never imports electron. */
  pickFolder?: () => Promise<string | undefined>;
  openFolder?: (path: string) => Promise<void>;
  /** Opens a terminal or the editor on a folder (and optionally one file inside it); injected so this module never imports electron. */
  launch?: (kind: 'terminal' | 'editor', target: { dir: string; file?: string }, editor?: EditorId) => Promise<void>;
  /** Executable picker for browseCliPath(); injected so this module never imports electron. */
  pickFile?: () => Promise<string | undefined>;
  /** Replace discovery (tests). */
  discover?: () => Promise<ResolvedCli[]>;
  /** Process runner and file check for CLI checks that bypass `discover` (testCliPath; tests inject fakes). */
  cliRunner?: Runner;
  isFile?: (path: string) => boolean;
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
  /** Tool permission timeout and timer (tests); defaults in orchestrator.ts. */
  toolPermissionTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Stall watchdog and per-run time limits (tests); defaults in orchestrator.ts. */
  stall?: OrchestratorDeps['stall'];
  /** How long a helper's question to the user waits before Harbor answers with the safe default (tests); default in askRouting.ts. */
  questionTimeoutMs?: number;
  /** Tests only: approve a project's checks file without asking the user. */
  autoApproveChecks?: boolean;
  /** Cap on automatic lead turns after one user message (default 12; tests lower it). */
  maxAutoTurns?: number;
  /** Lead wake-up debounce and clock (tests); defaults in orchestrator.ts. */
  reportDebounce?: OrchestratorDeps['reportDebounce'];
  now?: () => number;
  /** Replace the capability catalog (tests); default: the built-in one with the data folder's capabilities.json on top. */
  catalog?: CatalogEntry[];
  /**
   * Codex's live model list (index.ts reads ~/.codex/models_cache.json; tests inject a fixture). Undefined result or option:
   * the catalog's Codex priors are used as they are. See clis/codexModels.ts.
   */
  codexModels?: () => CodexModel[] | undefined;
  /** Shown by exportDiagnostics (index.ts passes app.getVersion(); this module never imports electron). */
  appVersion?: string;
  /** The CLIs' own folders whose skills are listed read-only (index.ts passes ~/.claude and CODEX_HOME). Absent = none (tests). */
  skillHomes?: SkillHomes;
  /** Network access for GitHub skill imports (index.ts passes fetch). Absent = GitHub import unavailable; tests inject a fake. */
  fetch?: FetchLike;
  /** Folder or .zip picker for browseSkillSource(); injected so this module never imports electron. */
  pickSkillSource?: (kind: 'folder' | 'zip') => Promise<string | undefined>;
  /** Window and screen capture for HARBOR_SCREENSHOT (index.ts wraps Electron's desktopCapturer; tests inject a fake). Absent = refused. */
  capturer?: Capturer;
  /** Whether Harbor's window is visible: a window allowed for a conversation is never captured while Harbor is in the background. */
  foreground?: () => boolean;
  /** How long a screenshot request waits for the user (tests); default 5 minutes (screenshots.ts). */
  screenshotTimeoutMs?: number;
  /** File picker for pickDocument(): any file the user chooses may then be viewed this session. Injected so this module never imports electron. */
  pickDocument?: () => Promise<string | undefined>;
  /** Selects a file in Explorer (documentAction 'reveal'); index.ts passes shell.showItemInFolder. */
  revealPath?: (path: string) => void | Promise<void>;
  /** Folders of the chat importers: ~/.claude, CODEX_HOME, and the home folder (shown as ~). Absent = folder sources unavailable (tests). */
  chatHomes?: { claude?: string; codex?: string; home?: string };
  /** Save dialog for exportBundle; injected so this module never imports electron. */
  pickBundleSave?: (defaultName: string) => Promise<string | undefined>;
  /** Open dialog for a bundle or an account export (browseImportFile). */
  pickImportFile?: (kind: 'bundle' | 'chatExport') => Promise<string | undefined>;
  /** Network access for testing an http/sse MCP server (index.ts passes fetch). Absent = such tests report that they need the app. */
  mcpFetch?: McpFetch;
  /** How long testMcpServer waits for a server (tests shorten it); default 20 s (mcp/probe.ts). */
  mcpTestTimeoutMs?: number;
  /** How often runs in flight are measured against the spend ceilings, and its timer (tests); defaults in spend.ts. */
  spendCheckMs?: number;
  spendTimer?: (fn: () => void, ms: number) => () => void;
  /** Replace the repo map cache of helper prompts (tests). */
  repoMaps?: RepoMapCache;
}

/** Journal project id for entries that belong to Harbor itself (startup notices, failed saves), not to a project. */
const HARBOR_JOURNAL = '__harbor__';
const CONVERSATION_MODES: ConversationMode[] = ['default', 'auto', 'plan', 'goal'];
// A Map, not an object: a mime such as "constructor" or "__proto__" must never match an inherited property.
const IMAGE_EXT = new Map<string, string>([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp']]);

/** Canonical base64 only: right alphabet and padding, and decoding then re-encoding gives the input back (no stray bits). */
export function decodeStrictBase64(s: string): Buffer | undefined {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return undefined;
  const data = Buffer.from(s, 'base64');
  return data.toString('base64') === s ? data : undefined;
}

// `<data>/attachments/<conversationId>` with its traversal guard lives in images.ts (the harbor-file protocol uses it too).
export { attachmentDir };
export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** A file name that is safe to put on disk: no folders, no characters Windows refuses, never a device name. */
function safeFileName(raw: unknown): string {
  const name = basename(String(raw ?? '').replace(/[\\]/g, '/')).replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 120);
  return !name || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name) ? `file${name ? `-${name}` : ''}` : name;
}

/**
 * Validate every attachment first, then write them under `dir`. Nothing is written when any one is rejected.
 * PNG, JPEG, GIF and WebP are images (validated, stored as `<id>.<ext>`, shown in the conversation). Anything else is a plain
 * file, stored as `<id>-<name>` with its own name and extension so the agent can open it with its tools.
 */
export function saveAttachments(dir: string, input: { name: string; mime: string; dataBase64: string }[]): Attachment[] {
  if (input.length > MAX_FILES) throw new Error(`Attach at most ${MAX_FILES} files per message.`);
  const decoded = input.map((a) => {
    const ext = typeof a.mime === 'string' && IMAGE_EXT.has(a.mime) ? IMAGE_EXT.get(a.mime) : undefined;
    const name = safeFileName(a.name);
    const limit = ext ? MAX_ATTACHMENT_BYTES : MAX_FILE_BYTES;
    // Check the encoded length before decoding so an oversized payload is never allocated.
    if (typeof a.dataBase64 !== 'string' || a.dataBase64.length > Math.ceil(limit / 3) * 4 + 4) throw new Error(`"${name}" is larger than ${limit / 1024 / 1024} MB.`);
    const data = decodeStrictBase64(a.dataBase64);
    if (!data) throw new Error(`"${name}" is not valid ${ext ? 'image ' : 'file '}data.`);
    if (!data.length) throw new Error(`"${name}" is empty.`);
    if (data.length > limit) throw new Error(`"${name}" is larger than ${limit / 1024 / 1024} MB.`);
    return { name: name === 'file' && ext ? 'image' : name, mime: ext ? a.mime : 'application/octet-stream', ext, data };
  });
  if (decoded.filter((d) => d.ext).length > MAX_ATTACHMENTS) throw new Error(`Attach at most ${MAX_ATTACHMENTS} images per message.`);
  if (decoded.length) mkdirSync(dir, { recursive: true });
  return decoded.map((d) => {
    const path = join(dir, d.ext ? `${newId()}.${d.ext}` : `${newId()}-${d.name}`);
    writeFileSync(path, d.data);
    return { name: d.name, mime: d.mime, path, ...(d.ext ? { url: attachmentUrl(dir, path) } : {}), origin: 'user' as const };
  });
}

/** CLIs whose headless flow has been verified against a real install in this repo's history (codex: 0.160.0, see adapters/codex.ts). */
const VERIFIED = new Set<CliId>(['claude', 'codex']);

/** Login failures from either CLI. Claude reports them in its result text; codex uses the same wording as discovery (clis/registry.ts). */
export const SIGNED_OUT_RE = /not logged in|logged out|not signed in|please run \/login/i;

/** Codex models the user's settings (global and per project) or a saved session name: they stay in the catalog even when Codex stops listing them. */
function namedCodexModels(store: Store): string[] {
  const s = store.getSettings();
  const scopes = [s, ...Object.values(s.projectOverrides ?? {})];
  const out = new Set<string>(store.sessionModels('codex'));
  for (const x of scopes) {
    for (const m of x.allowedModels?.['codex'] ?? []) out.add(m);
    for (const p of Object.values(x.rolePreferences ?? {})) if (p?.cli === 'codex' && p.model) out.add(p.model);
  }
  return [...out];
}

export function createHarborService(opts: ServiceOptions = {}): HarborService {
  const store = new Store(opts.dataDir);
  const bus = new EventBus();
  const clock = opts.now ?? Date.now;
  // Capability knowledge is data: an optional capabilities.json in the data folder overrides the built-in catalog. What it dropped is
  // reported (log, journal, diagnostics) instead of silently routing on a catalog the owner did not intend.
  const loadedCatalog = loadCatalogWithWarnings(opts.dataDir ? join(opts.dataDir, 'capabilities.json') : undefined);
  // Codex's own model list corrects the catalog: models it stopped listing drop out, new ones join with middle priors.
  // A fresh array that the ledger and orchestrator share: custom CLIs' entries are added and removed in place (syncCustomCatalog).
  const catalog = mergeCodexModels(opts.catalog ?? loadedCatalog.catalog, opts.codexModels?.(), namedCodexModels(store));
  const isFile = opts.isFile ?? isFilePath;
  const isDirectory = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
  // Custom CLIs come only from the data folder (never from a project); without one (tests) they live in memory.
  const customFile = opts.dataDir ? join(opts.dataDir, CUSTOM_CLIS_FILE) : undefined;
  const loadedCustom = loadCustomClis(customFile, { isFile });
  let customs: CustomCliDescriptor[] = loadedCustom.clis;
  const customOf = (id: CliId) => customs.find((c) => c.id === id);
  const customEntries = new Set<CatalogEntry>();
  const syncCustomCatalog = () => {
    for (let i = catalog.length - 1; i >= 0; i--) if (customEntries.has(catalog[i]!)) catalog.splice(i, 1);
    customEntries.clear();
    // capabilities.json entries for the same cli/model win over the descriptor's.
    for (const d of customs) for (const e of catalogEntriesOf(d)) if (!catalog.some((x) => x.cli === e.cli && x.model === e.model)) { catalog.push(e); customEntries.add(e); }
  };
  syncCustomCatalog();
  const ledger = new UsageLedger(store, { measurable: (id) => !!adapterFor(id), catalog, ...opts.ledger });
  const git = opts.git ?? new Git();
  const dataRoot = opts.dataDir ?? join(process.env['TEMP'] ?? '.', 'harbor-test');
  const worktreesRoot = opts.worktreesRoot ?? join(dataRoot, 'worktrees');
  let clis: ResolvedCli[] = [];
  const discoveryDeps = (cliPaths?: Record<CliId, string>) => ({ ...defaultDiscoveryDeps(cliPaths), isFile, ...(opts.cliRunner ? { run: opts.cliRunner } : {}) });
  /** Plan 2.4: running a custom executable needs the user's explicit OK naming that exact path (the renderer repeats it). */
  const confirmRun = (exe: string, o: unknown) => {
    const c = o && typeof o === 'object' ? (o as { confirmExe?: unknown }).confirmExe : undefined;
    if (typeof c !== 'string' || normPath(c.trim()) !== normPath(exe)) throw new Error(`Confirm that Harbor may run ${exe} first.`);
  };
  /** A Settings executable path as given, refused with a readable message unless it is an absolute path to an existing file. */
  const checkedCliPath = (cli: CliId, path: unknown): string => {
    const p = typeof path === 'string' ? path.trim() : path;
    const problem = cliPathProblem(p);
    if (problem) throw new Error(`The path for ${cli} ${problem}.`);
    if (!isFile(p as string)) throw new Error(`${p as string} is not an existing file. Choose the CLI's executable (.exe, .cmd or .bat).`);
    return p as string;
  };

  // ---- custom CLI approval: Harbor runs a custom executable only while its file is the one the user approved (sha256 on save).
  // The size+mtime stamp of the last verified hash avoids re-hashing an unchanged binary on every routing decision.
  const verifiedStamp = new Map<CliId, string>();
  let staleCheck: Promise<unknown> | undefined;
  const approvalOf = async (d: CustomCliDescriptor): Promise<{ ok: true } | { ok: false; why: string }> => {
    if (!isFile(d.exe)) return { ok: true }; // discovery reports "not found"; nothing would run
    const stamp = fileStamp(d.exe);
    if (stamp && verifiedStamp.get(d.id) === stamp) return { ok: true };
    const hash = await hashFile(d.exe).catch(() => undefined);
    if (d.approvedHash && hash === d.approvedHash) { if (stamp) verifiedStamp.set(d.id, stamp); return { ok: true }; }
    verifiedStamp.delete(d.id);
    return { ok: false, why: d.approvedHash ? 'its file changed since you approved it' : 'it has not been approved yet' };
  };
  const blockedCli = (d: CustomCliDescriptor, why: string): ResolvedCli => {
    const def = definitionOf(d);
    return { id: d.id, name: d.name, models: def.models, features: def.features, custom: true, path: d.exe, installed: true, signedIn: false, authState: 'unknown',
      blocked: `${why} (review it in Settings and approve it again)`, note: `Harbor will not run ${d.exe}: ${why}. Open it in Settings, check it and approve it again.` };
  };
  // Not an async wrapper around opts.discover: startup recovery is ordered after the first discovery, and tests rely on its timing.
  const discoverAll = (): Promise<ResolvedCli[]> => (opts.discover ? opts.discover() : discoverWithCustoms());
  const discoverWithCustoms = async (): Promise<ResolvedCli[]> => {
    // The approval is checked before discovery runs anything: a changed binary is not even asked for its version.
    const approved: CustomCliDescriptor[] = [], blocked: ResolvedCli[] = [];
    for (const d of customs) { const a = await approvalOf(d); if (a.ok) approved.push(d); else blocked.push(blockedCli(d, a.why)); }
    const found = await discoverClis({ ...discoveryDeps(store.getSettings().cliPaths), definitions: [...CLI_DEFINITIONS, ...approved.map(definitionOf)] });
    return [...found, ...blocked];
  };

  const defaultAdapter = (id: CliId, r?: ResolvedCli): CliAdapter | undefined => {
    if (!r?.installed || !r.path || r.blocked) return undefined;
    const custom = customOf(id);
    if (custom) {
      // The file changed after discovery approved it: no adapter until a refresh has re-checked it.
      if (fileStamp(custom.exe) !== verifiedStamp.get(id)) { staleCheck ??= refresh().catch(() => []).finally(() => { staleCheck = undefined; }); return undefined; }
      return new GenericAdapter(custom);
    }
    // A self-update (Claude desktop, Codex desktop) can swap the versioned folder after discovery: spawning the remembered path
    // would fail with ENOENT, so look again right now and refresh the cached status in the background.
    let path = r.path;
    if (!isFile(path)) {
      const def = CLI_DEFINITIONS.find((x) => x.id === id);
      const now = def && findExecutable(def, discoveryDeps(store.getSettings().cliPaths));
      staleCheck ??= refresh().catch(() => []).finally(() => { staleCheck = undefined; });
      if (!now) return undefined;
      path = now;
    }
    if (id === 'claude') return new ClaudeAdapter(path);
    if (id === 'codex') return new CodexAdapter(path);
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
  const pending = new Map<Id, { resolve: (allow: boolean) => void; event: PendingPermission }>();
  const ask = (kind: 'freeReset' | 'tool' | 'conflict', prompt: string, agentId?: Id, signal?: AbortSignal) =>
    new Promise<boolean>((resolve) => {
      const requestId = newId();
      const event: PendingPermission = { type: 'permission', requestId, kind, prompt, agentId };
      pending.set(requestId, { resolve, event });
      signal?.addEventListener('abort', () => { if (pending.delete(requestId)) resolve(false); }, { once: true });
      bus.emit(event);
    });

  /** Conflict asks raised for a helper of this conversation (free-reset asks belong to no conversation and never block one). */
  const pendingFor = (conversationId: Id): boolean =>
    [...pending.values()].some(({ event }) => event.conversationId === conversationId || (!!event.agentId && store.getAgent(event.agentId)?.parentConversationId === conversationId));

  const freeReset = new FreeResetCoordinator({
    ledger, store,
    backlog: () => store.allAgentRecords().filter((a) => a.role !== 'main' && a.state === 'queued').length,
    ask: (p) => ask('freeReset', p),
    allow: () => store.getSettings().allowFreeReset
  });

  // Beside state.json; without a data folder (tests) the journal stays in memory, like the Store.
  // Hashes only (see remote/tokens.ts); in memory without a data folder, like the Store.
  const remoteTokens = new RemoteTokens(opts.dataDir ? join(opts.dataDir, 'remote-tokens.json') : undefined);
  const journal = new Journal(opts.dataDir ? join(opts.dataDir, 'journal.jsonl') : undefined);

  // ---- skills (plan section 3): the library lives in the data folder; without one (tests) nothing can be imported.
  const skills = new SkillManager({ libraryDir: opts.dataDir ? join(opts.dataDir, 'skills') : undefined, homes: opts.skillHomes, state: store, fetch: opts.fetch, now: opts.now });
  /** How a run on this CLI can reach a skill folder outside its working folder (skills/delivery.ts). */
  const skillAccess = (cli: CliId): SkillAccess => (cli === 'claude' ? 'readDirs' : cli === 'codex' ? 'readable' : customOf(cli)?.run.readDir ? 'readDirs' : 'inline');
  const nativeSkills = (cli: CliId): boolean => (clis.find((c) => c.id === cli)?.features ?? CLI_DEFINITIONS.find((d) => d.id === cli)?.features)?.nativeSkills === true;
  // ---- MCP servers (plan section 5): one registry in the data folder, written out per CLI for each run (mcp/materialize.ts).
  const mcp = new McpRegistry(opts.dataDir ? join(opts.dataDir, MCP_SERVERS_FILE) : undefined, opts.now);
  const mcpTarget = (cli: CliId): McpTarget => {
    const features = clis.find((c) => c.id === cli)?.features ?? CLI_DEFINITIONS.find((d) => d.id === cli)?.features;
    if (features?.mcp === false) return 'none';
    return cli === 'claude' ? 'claude' : cli === 'codex' ? 'codex' : customOf(cli)?.run.mcp ? 'custom' : 'none';
  };
  /** Running a stdio server's command for a test needs the user's explicit OK naming exactly that command (like a custom CLI). */
  const confirmCommand = (command: string, o: unknown) => {
    const c = o && typeof o === 'object' ? (o as { confirmCommand?: unknown }).confirmCommand : undefined;
    const same = typeof c === 'string' && (c.trim() === command || (isAbsolute(command) && normPath(c.trim()) === normPath(command)));
    if (!same) throw new Error(`Confirm that Harbor may run ${command} first.`);
  };
  /** A bare command is looked up on PATH (with PATHEXT, so npx finds npx.cmd); an absolute one must be an existing file. */
  const resolveMcpCommand = (command: string): string | undefined => {
    if (isAbsolute(command)) return isFile(command) ? command : undefined;
    return findExecutable({ id: 'mcp-server', name: command, exeNames: [command], envVar: '', extraDirs: () => [], versionArgs: [], loginArgs: [], models: [] }, { env: process.env, platform: process.platform, isFile });
  };
  const projectRef = (id: Id | undefined) => { if (id === undefined || id === null) return undefined; const p = needProject(id); return { id: p.id, path: p.path }; };
  // ---- screenshots and shown images (plan section 4): both land in the conversation's attachments folder, never anywhere else.
  const screenshots = new ScreenshotBroker({
    capturer: opts.capturer,
    save: (conversationId, png, name) => savePng(attachmentDir(dataRoot, conversationId), png, name, 'screenshot'),
    emit: (e) => bus.emit(e),
    // One line per request and per capture; never image bytes, never the window title.
    journal: (e) => journal.add({ kind: 'screenshot', ...e }),
    foreground: opts.foreground, setTimer: opts.setTimer, timeoutMs: opts.screenshotTimeoutMs
  });
  const orchestrator = new Orchestrator({
    store, bus, ledger, git, worktreesRoot, ask, freeReset, journal, screenshots, ...(opts.repoMaps ? { repoMaps: opts.repoMaps } : {}),
    attachImage: (conversationId, image) => copyShownImage(attachmentDir(dataRoot, conversationId), image),
    getClis: () => clis,
    adapterFor,
    enabled: (c) => store.getSettings().cliOverrides[c]?.enabled !== false,
    verified: (c) => VERIFIED.has(c),
    // Plan 2.4: a custom CLI with no read-only mode gets no read-only work unless the user accepted that risk for it.
    readOnlySafe: (c) => { const d = customOf(c); return !d || hasReadOnlyMode(d) || d.acceptReadOnlyRisk === true; },
    skillsFor: (projectId, cli, cwd) => {
      const p = store.getProject(projectId);
      const r = p && skills.forRun({ id: p.id, path: p.path }, cli, cwd, skillAccess(cli), nativeSkills(cli));
      return r ? { system: skillsSection(r.delivery), readableDirs: r.delivery.readDirs } : undefined;
    },
    mcpFor: (projectId, cli, run) => {
      const plan = planMcpRun({
        servers: mcp.enabledFor(projectId), cliName: clis.find((c) => c.id === cli)?.name ?? cli, target: mcpTarget(cli), permission: run.permission,
        // Only Claude answers tool permission prompts through Harbor (adapters/types.ts onToolPermission), and only in edit runs.
        hostAsks: cli === 'claude' && run.permission === 'edit' && run.asks, claudeOwnMcp: store.getSettings().claudeOwnMcp === true
      });
      return { ...(plan.run ? { mcp: plan.run } : {}), notes: plan.notes };
    },
    catalog,
    neutralDir: opts.dataDir ? join(opts.dataDir, 'neutral') : undefined,
    now: opts.now,
    reportDebounce: opts.reportDebounce,
    maxActivePerProject: opts.maxActivePerProject,
    killer: opts.killer,
    patchesRoot: opts.patchesRoot ?? (opts.dataDir ? join(opts.dataDir, 'patches') : undefined),
    toolPermissionTimeoutMs: opts.toolPermissionTimeoutMs,
    setTimer: opts.setTimer,
    stall: opts.stall,
    questionTimeoutMs: opts.questionTimeoutMs,
    maxAutoTurns: opts.maxAutoTurns,
    autoApproveChecks: opts.autoApproveChecks,
    spendCheckMs: opts.spendCheckMs,
    spendTimer: opts.spendTimer
  });

  // A state file that was restored from backup or set aside, and a write that keeps failing, are visible in the journal and the
  // running conversations instead of only in a log nobody reads. Journal entries use a project-less id (diagnostics lists them).
  for (const n of store.startupNotices) journal.add({ kind: 'triage', projectId: HARBOR_JOURNAL, text: n });
  for (const w of [...loadedCatalog.warnings, ...loadedCustom.warnings, ...mcp.warnings]) { console.warn(`[harbor] ${w}`); journal.add({ kind: 'triage', projectId: HARBOR_JOURNAL, text: w }); }
  store.onFlushError = (e) => {
    journal.add({ kind: 'triage', projectId: HARBOR_JOURNAL, text: `Harbor could not save its state (${e.message}). It keeps trying; recent changes exist only in memory until then.` });
    for (const p of store.listProjects()) for (const c of store.listConversations(p.id)) {
      if (c.activity?.state === 'working') bus.emit({ type: 'message', message: store.addMessage({ id: newId(), conversationId: c.id, role: 'system', text: 'Warning: Harbor could not save its state to disk. Work continues, and it keeps retrying; do not quit until this clears.', time: Date.now() }) });
    }
  };

  // A CLI that was installed earlier and is now missing is usually a self-update swapping its folder (the Claude
  // desktop app does this), so re-check a few times instead of leaving it "Not installed" until a manual refresh.
  const seenInstalled = new Set<CliId>();
  const recheckDelays = opts.recheckDelaysMs ?? [3_000, 10_000, 30_000, 60_000, 120_000];
  let recheckTimer: ReturnType<typeof setTimeout> | undefined;
  // The very first check has no "seen" history, so a swap in progress at launch would otherwise stick: during the
  // startup chain any missing CLI is re-checked, including ones that are genuinely absent (they just stay missing).
  const refresh = async (attempt = 0, startup = false): Promise<ResolvedCli[]> => {
    if (recheckTimer) { clearTimeout(recheckTimer); recheckTimer = undefined; }
    clis = await discoverAll();
    for (const c of clis) { if (c.installed) seenInstalled.add(c.id); bus.emit({ type: 'cli', cli: toStatus(c) }); }
    const lost = clis.some((c) => !c.installed && (startup || seenInstalled.has(c.id)));
    if (lost && attempt < recheckDelays.length) {
      recheckTimer = setTimeout(() => { void refresh(attempt + 1, startup).catch(() => {}); }, recheckDelays[attempt]);
      recheckTimer.unref?.();
    }
    return clis;
  };
  const ready = refresh(0, true).then(() => orchestrator.recover(), () => orchestrator.recover());

  /** Attachments stored before harbor-file URLs existed get theirs on the way out (only files under the attachments folder). */
  const withImageUrls = (m: Message): Message => {
    if (!m.attachments?.some((a) => !a.url && a.path)) return m;
    return { ...m, attachments: m.attachments.map((a) => { if (a.url) return a; const url = urlForStoredPath(dataRoot, a.path); return url ? { ...a, url } : a; }) };
  };
  const needProject = (id: Id): Project => {
    const p = store.getProject(id);
    if (!p) throw new Error(`Unknown project ${id}`);
    return p;
  };
  // ---- document viewer (plan section 4b): files the user picked in the dialog this session (exact files, never their folders).
  const pickedDocuments = new Set<string>();
  /** Where a document of this project may come from, and the folder relative paths resolve against (the helper's worktree, else the project). */
  const documentScope = (projectId: Id, agentId: Id | undefined): { cwd: string; roots: DocumentRoot[] } => {
    const project = needProject(projectId);
    let cwd = project.path;
    if (agentId !== undefined) {
      const a = store.getAgent(agentId);
      if (!a || a.projectId !== projectId) throw new Error('That agent does not belong to this project.');
      if (a.worktree && existsSync(a.worktree)) cwd = a.worktree;
    }
    const roots: DocumentRoot[] = [{ kind: 'project', path: project.path }];
    for (const a of store.listAgentRecords(projectId)) if (a.worktree) roots.push({ kind: 'worktree', path: a.worktree, agentId: a.id });
    for (const c of store.listConversations(projectId)) { try { roots.push({ kind: 'attachments', path: attachmentDir(dataRoot, c.id) }); } catch { /* not a plain id: no folder */ } }
    if (opts.dataDir) roots.push({ kind: 'skills', path: join(opts.dataDir, 'skills') });
    for (const p of pickedDocuments) roots.push({ kind: 'picked', path: p, file: true });
    return { cwd, roots };
  };
  const gitViewOf = async (projectId: Id): Promise<GitView> => {
    const view = await GitView.open(needProject(projectId).path);
    if (!view) throw new Error('This project folder is not a Git repository.');
    return view;
  };
  // ---- import and export (plan section 6): bundles and chat importers; imported chats are read-only history.
  const transfer = new Transfer({
    store, skills, dataRoot, dataDir: opts.dataDir, worktreesRoot, appVersion: opts.appVersion,
    env: { claudeHome: opts.chatHomes?.claude, codexHome: opts.chatHomes?.codex, home: opts.chatHomes?.home, now: opts.now ?? Date.now },
    mainAgentId: (projectId) => orchestrator.ensureProject(needProject(projectId)).main.id,
    newConversation: (projectId) => orchestrator.newConversation(projectId),
    emit: (e) => bus.emit(e),
    journal: (projectId, text) => journal.add({ kind: 'import', projectId, text }),
    pickSave: opts.pickBundleSave,
    cliProblem: (cli) => {
      const c = clis.find((x) => x.id === cli);
      if (!c?.installed) return `${cli} is not installed.`;
      if (c.blocked) return `Harbor will not run ${c.name}: ${c.blocked}.`;
      if (store.getSettings().cliOverrides[cli]?.enabled === false) return `${c.name} is turned off in Settings.`;
      if (c.authState === 'signedOut') return `${c.name} needs a sign-in first.`;
      if (!adapterFor(cli)) return `Harbor cannot run ${c.name} yet.`;
      return undefined;
    },
    cliName: (cli) => clis.find((x) => x.id === cli)?.name ?? cli
  });
  const readOnlyImported = (c: Conversation | undefined) => {
    if (c?.imported) throw new Error('This is imported history and is read-only. Use "Continue with…" to keep working on it.');
  };

  return {
    orchestrator, store, remoteTokens,
    whenIdle: async (t) => { await ready; await orchestrator.whenIdle(t); },
    shutdown: async () => {
      if (recheckTimer) { clearTimeout(recheckTimer); recheckTimer = undefined; }
      await orchestrator.shutdown(); // aborts and flushes before its first await
      store.flush();
      remoteTokens.flush();
    },
    activeRuns: () => orchestrator.activeRunCount(),
    onResume: () => orchestrator.rearmTimers(),

    async listClis() { await ready; return clis.map(toStatus); },
    async refreshClis() { return (await refresh()).map(toStatus); },
    async openLogin(cliId) {
      const custom = customOf(cliId);
      const def = custom ? definitionOf(custom) : CLI_DEFINITIONS.find((d) => d.id === cliId);
      const r = clis.find((c) => c.id === cliId);
      if (!def || !r?.path) throw new Error(`${cliId} is not installed`);
      if (r.blocked) throw new Error(`Harbor will not run ${r.path}: ${r.blocked}.`);
      if (process.platform !== 'win32') throw new Error('Opening a login terminal is only implemented on Windows');
      // Visible terminal; Harbor never reads or stores credentials.
      spawn('cmd.exe', ['/d', '/c', loginCommand(def, r.path)], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    },
    async testCliPath(cliId, path) {
      const def = CLI_DEFINITIONS.find((d) => d.id === cliId);
      if (!def) throw new Error(`Unknown CLI ${String(cliId)}.`);
      // Runs only the CLI's own version and status commands, the same ones discovery runs; nothing is saved.
      return toStatus(await resolveCli(def, discoveryDeps({ [cliId]: checkedCliPath(cliId, path) })));
    },
    async browseCliPath() {
      if (!opts.pickFile) throw new Error('Choosing a file is available in the desktop app.');
      return (await opts.pickFile()) ?? null;
    },
    async listCustomClis() { return structuredClone(customs); },
    async listCliTemplates() { return structuredClone(CLI_TEMPLATES); },
    async dryRunCustomCli(descriptor, o) {
      // Editing an existing CLI may keep its id, so duplicates are not a dry-run problem; saving checks them.
      const v = validateDescriptor(descriptor, { otherIds: [], isFile, isDirectory });
      if (!v.descriptor) return { ok: false, problems: v.problems, steps: [] };
      confirmRun(v.descriptor.exe, o);
      return dryRunCli(v.descriptor, { run: opts.cliRunner ?? runProcess });
    },
    async saveCustomCli(descriptor, o) {
      const replace = o?.replace === true;
      const id = descriptor && typeof descriptor === 'object' ? (descriptor as { id?: unknown }).id : undefined;
      if (replace && !customs.some((c) => c.id === id)) throw new Error('There is no custom CLI with that id to replace.');
      const v = validateDescriptor(descriptor, { otherIds: customs.filter((c) => !(replace && c.id === id)).map((c) => c.id), isFile, isDirectory });
      if (!v.descriptor) throw new Error(`This CLI cannot be saved:\n- ${v.problems.join('\n- ')}`);
      confirmRun(v.descriptor.exe, o);
      if (!replace && customs.length >= MAX_CUSTOM_CLIS) throw new Error(`At most ${MAX_CUSTOM_CLIS} custom CLIs can be added.`);
      // The approval: the hash of exactly the file the user named. A later change blocks the CLI until it is saved (approved) again.
      const saved: CustomCliDescriptor = { ...v.descriptor, approvedHash: await hashFile(v.descriptor.exe), approvedAt: Date.now() };
      const next = replace ? customs.map((c) => (c.id === saved.id ? saved : c)) : [...customs, saved];
      if (customFile) saveCustomClis(customFile, next);
      customs = next;
      verifiedStamp.delete(saved.id);
      syncCustomCatalog();
      await refresh();
      return structuredClone(customs);
    },
    async removeCustomCli(id) {
      if (!customOf(id)) return structuredClone(customs);
      const next = customs.filter((c) => c.id !== id);
      if (customFile) saveCustomClis(customFile, next);
      customs = next;
      verifiedStamp.delete(id);
      syncCustomCatalog();
      await refresh();
      return structuredClone(customs);
    },

    // Skills: listing and reading only read files; nothing in a skill is ever run.
    async listSkills(projectId) { return skills.list(projectRef(projectId)); },
    async readSkill(skillId, projectId) { return skills.read(skillId, projectRef(projectId)); },
    async setSkillEnabled(skillId, enabled, projectId) { return skills.setEnabled(skillId, enabled, projectRef(projectId)); },
    async previewSkillImport(source, o) {
      const confirm = o && typeof o === 'object' ? o.confirmDownload : undefined;
      if (confirm !== undefined && typeof confirm !== 'string') throw new Error('confirmDownload must be the token of a GitHub listing.');
      return skills.preview(source, confirm !== undefined ? { confirmDownload: confirm } : {});
    },
    async importSkills(token, o) { return skills.importStaged(token, o?.names); },
    async removeSkill(skillId) { return skills.remove(skillId); },
    async browseSkillSource(kind) {
      if (kind !== 'folder' && kind !== 'zip') throw new Error('Choose a folder or a .zip file.');
      if (!opts.pickSkillSource) throw new Error('Choosing a file is available in the desktop app.');
      return (await opts.pickSkillSource(kind)) ?? null;
    },

    // MCP servers: the registry is plain text in the data folder; values never reach logs, diagnostics, bundles or run details.
    async listMcpServers(projectId) { return mcp.list(projectRef(projectId)?.id); },
    async saveMcpServer(server, o) {
      const previous = o && typeof o === 'object' && typeof o.previousName === 'string' ? o.previousName : undefined;
      const projectId = o && typeof o === 'object' ? projectRef(o.projectId)?.id : undefined;
      mcp.save(server, previous);
      return mcp.list(projectId);
    },
    async removeMcpServer(name, o) {
      const projectId = o && typeof o === 'object' ? projectRef(o.projectId)?.id : undefined;
      mcp.remove(name);
      return mcp.list(projectId);
    },
    async setMcpServerEnabled(name, enabled, projectId) {
      const id = projectRef(projectId)?.id;
      mcp.setEnabled(name, enabled, id);
      return mcp.list(id);
    },
    async testMcpServer(server, o) {
      const v = validateMcpServer(server);
      if (!v.server) throw new Error(`This MCP server cannot be tested:\n- ${v.problems.join('\n- ')}`);
      const s = v.server;
      if (s.transport === 'stdio') confirmCommand(s.command!, o);
      // A fresh empty folder outside every project, removed afterwards.
      const cwd = mkdtempSync(join(tmpdir(), 'harbor-mcp-test-'));
      try {
        return await probeMcpServer(s, { cwd, resolveCommand: resolveMcpCommand, fetch: opts.mcpFetch, timeoutMs: opts.mcpTestTimeoutMs, clientVersion: opts.appVersion });
      } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* a server that is still exiting may hold it */ } }
    },
    async listCliMcpServers(projectId) {
      const p = projectRef(projectId);
      return discoverCliMcpServers({ home: opts.chatHomes?.home, codexHome: opts.chatHomes?.codex }, p?.path);
    },

    async listProjects() { return store.listProjects(); },
    async addProject(path) {
      const chosen = path ?? (await opts.pickFolder?.());
      if (!chosen) return null;
      const refusal = projectPathRefusal(chosen);
      if (refusal) throw new Error(refusal);
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
    async renameProject(id, name) {
      const p = needProject(id);
      const next = String(name).trim();
      if (!next || next.length > 120) throw new Error('A project name needs 1 to 120 characters.');
      return store.upsertProject({ ...p, name: next });
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
      if (patch.archived && (c.activity && ['queued', 'working', 'waiting'].includes(c.activity.state) || pendingFor(id) || store.listAgentRecords(c.projectId).some(a => a.parentConversationId === id && ['queued', 'working', 'waiting'].includes(a.state)))) throw new Error('Finish or stop the session and answer pending requests before archiving.');
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
    async openWorkspace(projectId, action, o) {
      const project = needProject(projectId);
      if (action !== 'terminal' && action !== 'editor' && action !== 'folder') throw new Error('Unknown workspace action.');
      let dir = project.path;
      if (o?.agentId) {
        const a = store.getAgent(o.agentId);
        if (!a || a.projectId !== projectId) throw new Error('That helper does not belong to this project.');
        if (!a.worktree) throw new Error('That helper has no worktree of its own.');
        dir = a.worktree;
      }
      if (!existsSync(dir)) throw new Error('That folder no longer exists.');
      let file: string | undefined;
      if (o?.file !== undefined && o.file !== '') {
        if (action === 'terminal') throw new Error('A terminal opens on a folder, not a file.');
        if (typeof o.file !== 'string' || /[\0\r\n]/.test(o.file) || isAbsolute(o.file)) throw new Error('The file must be a path inside the folder.');
        const rel = relative(dir, resolve(dir, o.file));
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('The file must be a path inside the folder.');
        if (!existsSync(join(dir, rel))) throw new Error('That file does not exist.');
        file = rel;
      }
      if (action === 'folder') {
        if (!opts.openFolder) throw new Error('Opening folders is available in the desktop app.');
        await opts.openFolder(file ? join(dir, file) : dir);
        return;
      }
      if (!opts.launch) throw new Error('Opening a terminal or editor is available in the desktop app.');
      const configured = store.getSettings().editor;
      await opts.launch(action, { dir, file }, isEditorId(configured) ? configured : undefined);
    },
    async getGitOverview(projectId) {
      const view = await GitView.open(needProject(projectId).path);
      if (!view) return { projectId, branches: [], worktrees: [], notes: ['This project folder is not a Git repository.'] };
      return view.overview(projectId, store.listAgentRecords(projectId));
    },
    async getGitLog(projectId, opts) { return (await gitViewOf(projectId)).log(opts); },
    async getGitLogPage(projectId, opts) { return (await gitViewOf(projectId)).logPage(opts); },
    async getGitChanges(projectId, target) { return (await gitViewOf(projectId)).changes(target); },
    async getGitDiff(projectId, path, target) { return (await gitViewOf(projectId)).diff(path, target); },
    async newConversation(projectId) { needProject(projectId); return orchestrator.newConversation(projectId); },
    async listMessages(conversationId, opts) {
      if (opts !== undefined && (typeof opts !== 'object' || opts === null || (opts.limit !== undefined && (typeof opts.limit !== 'number' || !Number.isFinite(opts.limit))))) throw new Error('Invalid paging options.');
      return store.listMessages(conversationId, opts).map(withImageUrls);
    },
    async deleteConversation(id) {
      const c = store.getConversation(id);
      if (!c) return;
      if (c.activity && ['working', 'queued', 'waiting'].includes(c.activity.state) || pendingFor(id) || store.listAgentRecords(c.projectId).some(a => a.parentConversationId === id && ['working', 'queued', 'waiting'].includes(a.state))) throw new Error('Stop the running session and answer pending requests before deleting this conversation.');
      store.removeConversation(id);
      try { rmSync(attachmentDir(dataRoot, id),{ recursive: true, force: true }); } catch { /* best effort: only Harbor's own copies */ }
      for (const k of [`lead:${id}`, `concierge:${id}`]) store.clearSession(k);
    },
    async send(conversationId, text, attachments, opts) {
      await ready;
      if (!text.trim() && !attachments?.length) return;
      if (!store.getConversation(conversationId)) throw new Error('This conversation is no longer available.');
      readOnlyImported(store.getConversation(conversationId));
      const saved = attachments?.length ? saveAttachments(attachmentDir(dataRoot, conversationId), attachments) : [];
      await orchestrator.userMessage(conversationId, text.trim() ? text : 'See the attached file(s).', saved, { steer: opts?.steer === true });
    },
    async setConversationMode(conversationId, mode, goal) {
      const c = store.getConversation(conversationId);
      if (!c) throw new Error('This conversation is no longer available.');
      readOnlyImported(c);
      if (!CONVERSATION_MODES.includes(mode)) throw new Error('Unknown conversation mode.');
      const text = goal?.trim();
      if (mode === 'goal' && !text) throw new Error('Goal mode needs a goal: say what should be true when the lead is done.');
      const previous = c.mode ?? 'default';
      store.patchConversation(conversationId, { mode, goal: mode === 'goal' ? text!.slice(0, 2000) : undefined });
      orchestrator.modeChanged(conversationId, previous, mode);
      bus.emit({ type: 'conversation', conversation: { ...c } });
      return { ...c };
    },
    async setConversationDeadline(conversationId, deadline) {
      const c = store.getConversation(conversationId);
      if (!c) throw new Error('This conversation is no longer available.');
      if (deadline !== null && !(typeof deadline === 'number' && Number.isFinite(deadline) && deadline > 0)) throw new Error('The deadline must be a time (epoch milliseconds), or null to clear it.');
      // Routing reads it on the next decision (urgency from the deadline and the unfinished work's estimated minutes).
      if (deadline === null) delete c.deadline;
      store.patchConversation(conversationId, deadline === null ? {} : { deadline: Math.round(deadline) });
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
    async stopAgent(agentId, conversationId) {
      if (conversationId !== undefined && conversationId !== null && (typeof conversationId !== 'string' || !conversationId || conversationId.length > 200)) throw new Error('Invalid conversation id.');
      orchestrator.stop(agentId, conversationId ?? undefined);
    },
    async setAgentPriority(agentId, priority) { orchestrator.setPriority(agentId, priority); },
    async pauseAgent(agentId) { orchestrator.pause(agentId); },
    async resumeAgent(agentId) { orchestrator.resume(agentId); },
    async resumeAgentSession(agentId) { orchestrator.resumeAgent(agentId); },
    async integrateBranches(projectId, agentIds, target) { await ready; return toAgent(await orchestrator.integrateBranches(needProject(projectId).id, agentIds, target)); },
    async applyIntegration(agentId) { return toAgent(await orchestrator.applyIntegration(agentId)); },
    async mergeSession(conversationId) { await ready; return orchestrator.mergeSession(conversationId); },
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
    async rollbackTask(agentId, target) { await ready; return toAgent(orchestrator.rollbackTask(agentId, target)); },

    async getUsage() { await ready; return ledger.windows(clis.filter((c) => c.installed).map((c) => c.id)); },
    async getSettings() { return store.getSettings(); },
    async setSettings(s) {
      // An executable path must exist when it is saved; the shape (absolute, no quotes) is checked by the store.
      const paths = s && typeof s === 'object' && s.cliPaths && typeof s.cliPaths === 'object' ? Object.entries(s.cliPaths) : [];
      for (const [cli, p] of paths) {
        // A custom CLI runs only its approved file; changing that file goes through saveCustomCli (and a new approval).
        if (customOf(cli) && typeof p === 'string' && p.trim()) throw new Error(`${cli} is a custom CLI: change its executable in its own settings.`);
        if (typeof p === 'string' && p.trim()) checkedCliPath(cli, p);
      }
      const next = store.setSettings(s);
      // A raised concurrency limit should start waiting work now, not at the next unrelated event.
      for (const p of store.listProjects()) orchestrator.pump(p.id);
      // A new executable path takes effect now (cli events follow), not at the next manual refresh.
      if (s && typeof s === 'object' && 'cliPaths' in s) await refresh();
      return next;
    },
    async answerPermission(requestId, allow, o) {
      // A screenshot is never allowed by a bare yes: the user must pick (and see) what is captured, through answerScreenshot.
      if (screenshots.has(requestId)) {
        if (allow === true) throw new Error('Choose the window or screen to capture in the screenshot card (answerScreenshot).');
        await screenshots.answer(requestId, { allow: false });
        return;
      }
      // Tool requests live in the orchestrator (they time out and end with their run); the rest are plain yes/no asks.
      if (orchestrator.answerToolPermission(requestId, allow === true, o?.always === true)) return;
      const r = pending.get(requestId);
      if (!r) return;
      pending.delete(requestId);
      r.resolve(allow);
    },
    async exportDiagnostics() {
      await ready;
      const projects = store.listProjects();
      const agents = store.allAgentRecords();
      const byState: Record<string, number> = {};
      for (const a of agents) byState[a.state] = (byState[a.state] ?? 0) + 1;
      return buildDiagnostics({
        appVersion: opts.appVersion, clis: clis.map(toStatus),
        counts: { projects: projects.length, conversations: projects.reduce((n, p) => n + store.listConversations(p.id).length, 0), agents: agents.length, agentsByState: byState },
        journal: [...projects.flatMap((p) => journal.list(p.id)), ...journal.list(HARBOR_JOURNAL)].sort((a, b) => a.time - b.time).slice(-40),
        logTail: opts.dataDir ? readLogTail(join(opts.dataDir, 'logs'), 100) : '',
        notices: [...startupNotices(opts.dataDir), ...store.startupNotices.filter((n) => !startupNotices(opts.dataDir).includes(n)), ...loadedCatalog.warnings, ...loadedCustom.warnings, ...mcp.warnings,
          ...(store.lastFlushError ? [`Saving state is failing: ${store.lastFlushError.message} (since ${new Date(store.lastFlushError.time).toISOString()})`] : [])]
      });
    },
    async getTaskReport(conversationId) {
      const c = store.getConversation(conversationId);
      if (!c) throw new Error('This conversation is no longer available.');
      const agents = store.listAgentRecords(c.projectId);
      const helperConvs = agents.filter((a) => a.role !== 'main' && a.parentConversationId === c.id).flatMap((a) => { const hc = store.findConversationByAgent(a.id); return hc && hc.id !== c.id ? [hc.id] : []; });
      const messages = [c.id, ...helperConvs].flatMap((id) => store.listMessages(id));
      return buildTaskReport({ conversation: c, agents, usage: store.listUsage(), messages, catalog, calibration: store.getCalibration(), now: clock(), keepMs: USAGE_KEEP_MS });
    },
    async rateResult(targetId, rating, note) {
      if (typeof targetId !== 'string' || !targetId) throw new Error('Name the agent or message to rate.');
      if (!isRatingValue(rating)) throw new Error('A rating is up, down or redo-stronger.');
      if (note !== undefined && note !== null && typeof note !== 'string') throw new Error('The note must be text.');
      const agent = store.getAgent(targetId);
      const target = ratingTarget({ targetId, agent, message: agent ? undefined : store.getMessage(targetId), agentOf: (id) => store.getAgent(id), conversationOf: (id) => store.findConversationByAgent(id)?.id });
      const text = typeof note === 'string' ? note.trim().slice(0, MAX_RATING_NOTE) : '';
      return store.addRating({ id: newId(), time: clock(), rating, ...(text ? { note: text } : {}), ...target });
    },
    async listRatings(o) {
      if (o?.projectId !== undefined) needProject(o.projectId);
      return [...store.listRatings(o?.projectId)].reverse();
    },
    async getRatingSummary(o) {
      if (o?.projectId !== undefined) needProject(o.projectId);
      const by = o?.by ?? 'model';
      if (by !== 'cli' && by !== 'model' && by !== 'need') throw new Error('Summarize ratings by cli, model or need.');
      return aggregateRatings(store.listRatings(o?.projectId), by);
    },
    async replayRouting(o = {}) {
      if (o.projectId !== undefined) needProject(o.projectId);
      const limit = Math.min(2000, Math.max(1, Math.round(typeof o.limit === 'number' && Number.isFinite(o.limit) ? o.limit : 200)));
      let convIds: Id[];
      if (o.conversationId !== undefined) {
        const c = store.getConversation(o.conversationId);
        if (!c) throw new Error('This conversation is no longer available.');
        if (o.projectId !== undefined && c.projectId !== o.projectId) throw new Error('That conversation belongs to another project.');
        convIds = [c.id, ...store.listAgentRecords(c.projectId).filter((a) => a.role !== 'main' && a.parentConversationId === c.id).flatMap((a) => store.findConversationByAgent(a.id)?.id ?? [])];
      } else {
        convIds = (o.projectId !== undefined ? [needProject(o.projectId)] : store.listProjects()).flatMap((p) => store.listConversations(p.id).map((c) => c.id));
      }
      const messages = [...new Set(convIds)].flatMap((id) => store.listMessages(id));
      const decisions = recordedDecisions(messages, (id) => store.getAgent(id)).slice(-limit);
      const notes: string[] = [];
      let altCatalog: CatalogEntry[] = catalog;
      if (o.catalog !== undefined) {
        if (!Array.isArray(o.catalog)) throw new Error('The what-if catalog must be a list of capabilities.json entries.');
        const parsed = parseCatalog(o.catalog);
        if (parsed.warnings.some((w) => /no usable entry|must be a list/.test(w))) throw new Error('The what-if catalog has no usable entry.');
        altCatalog = parsed.catalog;
        notes.push(...parsed.warnings.map((w) => w.replace(/^capabilities\.json/, 'what-if catalog')));
      }
      const cur = store.getSettings();
      const altSettings = o.settings !== undefined ? mergeSettings(cur, o.settings) : cur;
      const scenario = (cat: readonly CatalogEntry[], s: typeof cur): ReplayScenario => ({
        catalog: cat, enabled: (c) => s.cliOverrides[c]?.enabled !== false, ...(store.getCalibration() ? { calibration: store.getCalibration() } : {}),
        policyFor: (d) => {
          const eff = effectiveSettings(s, d.projectId);
          return { allowedModels: eff.allowedModels, effortPolicy: eff.effortPolicy, lowAllowance: eff.lowAllowancePolicy, reserve: eff.subscriptionReserve, preference: d.role === 'main' ? undefined : eff.rolePreferences[d.role] };
        }
      });
      const out = replayDecisions(decisions, { base: scenario(catalog, cur), alt: scenario(altCatalog, altSettings), now: clock() });
      return { ...out, notes: [...out.notes, ...notes] };
    },
    async previewScreenshot(requestId, o) {
      const sourceId = o && typeof o === 'object' ? o.sourceId : undefined;
      return screenshots.preview(requestId, sourceId);
    },
    async answerScreenshot(requestId, answer) {
      if (!answer || typeof answer !== 'object' || typeof answer.allow !== 'boolean') throw new Error('Answer with allow true or false.');
      if (answer.sourceId !== undefined && typeof answer.sourceId !== 'string') throw new Error('Choose a window or screen from the preview.');
      await screenshots.answer(requestId, { allow: answer.allow, ...(answer.sourceId !== undefined ? { sourceId: answer.sourceId } : {}), forConversation: answer.forConversation === true });
    },
    async openDocument(projectId, path, o) {
      const agentId = o && typeof o === 'object' ? o.agentId : undefined;
      const since = o && typeof o === 'object' && typeof o.since === 'number' && Number.isFinite(o.since) ? o.since : undefined;
      const { cwd, roots } = documentScope(projectId, agentId);
      return openDocumentAt(path, cwd, roots, since !== undefined ? { since } : {});
    },
    async pickDocument(projectId) {
      const project = needProject(projectId);
      if (!opts.pickDocument) throw new Error('Choosing a file is available in the desktop app.');
      const chosen = await opts.pickDocument();
      if (!chosen) return null;
      // The user's own choice in a native dialog: that one file (never its folder) may be viewed, refreshed and acted on this session.
      pickedDocuments.add(resolve(chosen));
      const target = real(resolve(chosen));
      if (target) pickedDocuments.add(target); // the viewer refreshes by the real path
      const { roots } = documentScope(projectId, undefined);
      return openDocumentAt(resolve(chosen), project.path, roots);
    },
    async documentAction(projectId, path, action, o) {
      if (action !== 'openExternal' && action !== 'reveal') throw new Error('Unknown document action.');
      const { cwd, roots } = documentScope(projectId, o && typeof o === 'object' ? o.agentId : undefined);
      const r = resolveDocumentPath(path, cwd, roots);
      if (!r.ok) throw new Error(r.message);
      if (action === 'reveal') {
        if (!opts.revealPath) throw new Error('Showing files in Explorer is available in the desktop app.');
        await opts.revealPath(r.path);
        return;
      }
      // The default app of a script or program would run it: only documents and images are handed over.
      if (!canOpenExternally(r.path)) throw new Error('Harbor opens only documents and images in their default app. Use "Show in Explorer" for this file.');
      if (!opts.openFolder) throw new Error('Opening files is available in the desktop app.');
      await opts.openFolder(r.path);
    },
    // Import and export (plan section 6). Nothing here runs a CLI; imported text never becomes an instruction.
    async previewBundleExport(projectId, selection) { return transfer.previewExport(projectId, selection); },
    async exportBundle(token, o) { return transfer.exportBundle(token, o && typeof o === 'object' ? { keepSecrets: o.keepSecrets === true, redactSecrets: o.redactSecrets === true } : {}); },
    async browseImportFile(kind) {
      if (kind !== 'bundle' && kind !== 'chatExport') throw new Error('Choose a bundle or an export file.');
      if (!opts.pickImportFile) throw new Error('Choosing a file is available in the desktop app.');
      return (await opts.pickImportFile(kind)) ?? null;
    },
    async previewBundle(path) { return transfer.previewBundle(path); },
    async importBundle(token, o) { return transfer.importBundle(token, o); },
    async listImportSources() { return transfer.listSources(); },
    async previewImport(source, o) { return transfer.previewImport(source, o && typeof o === 'object' ? o : {}); },
    async importConversation(projectId, token, entryIds) { return transfer.importConversations(projectId, token, entryIds); },
    async continueImported(conversationId, o) { await ready; return transfer.continueImported(conversationId, o); },
    async getSpendStatus(projectId, conversationId) {
      if (projectId) needProject(projectId);
      return orchestrator.spendStatus(projectId ?? undefined, conversationId ?? undefined);
    },
    async listPendingPermissions() { return [...orchestrator.pendingToolEvents(), ...screenshots.pending(), ...[...pending.values()].map((p) => p.event)]; },
    async answerQuestion(requestId, answer) { await ready; await orchestrator.answerQuestion(requestId, answer); },
    async listToolRules(projectId) { return store.listToolRules(needProject(projectId).id); },
    async removeToolRule(projectId, ruleId) {
      needProject(projectId);
      store.removeToolRule(projectId, ruleId);
      return store.listToolRules(projectId);
    },
    async listProjectNotes(projectId) { return store.listProjectNotes(needProject(projectId).id); },
    async removeProjectNote(projectId, noteId) {
      needProject(projectId);
      store.removeProjectNote(projectId, noteId);
      return store.listProjectNotes(projectId);
    },
    async createRemoteToken(name, scope) {
      if (scope === 'full' && store.getSettings().remote?.allowFullScope !== true) throw new Error('Full remote access is off. Turn on remote.allowFullScope in settings first, or create a read-only or answer-permissions token.');
      return remoteTokens.create(name, scope);
    },
    async listRemoteTokens() { return remoteTokens.list(); },
    async revokeRemoteToken(id) { remoteTokens.revoke(id); },
    onEvent: (cb) => bus.on(cb)
  };
}
