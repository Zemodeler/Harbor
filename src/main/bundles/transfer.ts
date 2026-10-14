import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Attachment, BundleExportPreview, BundleExportResult, BundleImportOptions, BundleImportResult, BundlePreview, BundleSelection, ChatImportPreview, ChatImportResult, ChatImportSourceId, ChatImportSourceInfo, CliId, Conversation, HarborEvent, Id, ImportedInfo, Message, Project, SecretFinding } from '../../shared/api';
import { buildHandoff } from '../handoff';
import { attachmentDir, attachmentUrl, looksLikeImage, urlForStoredPath } from '../images';
import { IMPORT_SOURCES, importSource, type ImportEnv, type ImportSource, type SourceEntry } from '../importers';
import type { SkillManager } from '../skills/library';
import { safeFolderName } from '../skills/format';
import { newId, type Store } from '../store';
import { ALWAYS_EXCLUDED, BUNDLE_FORMAT, BUNDLE_LIMITS, BUNDLE_VERSION, acceptableToolRule, bundleItems, imageExt, readBundle, writeBundle, type BundleContent, type BundleConversation, type BundleMessage, type BundleProject } from './format';
import { rewritePaths, type PathRoots } from './paths';
import { redactBundleText, scanSecrets } from './secrets';

/**
 * Import and export (plan section 6): Harbor bundles and chat importers, over the Store and the skills library. Every write here is
 * Harbor's own (new ids, the data folder, the skills library through its import checks, a file the user chose in a save dialog).
 * Imported text is data: it is shown, summarised into a handoff as quoted history, and never becomes an instruction.
 */

export interface TransferDeps {
  store: Store;
  skills: SkillManager;
  /** Where attachments live (`<data>\attachments`). */
  dataRoot: string;
  /** The real data folder, for path rewriting (undefined in tests). */
  dataDir?: string;
  worktreesRoot: string;
  /** Folders of the chat sources (index.ts passes ~/.claude and CODEX_HOME). */
  env: ImportEnv;
  appVersion?: string;
  /** The project's lead agent id (created when missing). */
  mainAgentId: (projectId: Id) => Id;
  /** A new, ordinary conversation of the project (orchestrator.newConversation). */
  newConversation: (projectId: Id) => Conversation;
  emit: (e: HarborEvent) => void;
  journal?: (projectId: Id, text: string) => void;
  /** Save dialog for exportBundle; undefined result = cancelled. */
  pickSave?: (defaultName: string) => Promise<string | undefined>;
  /** Whether Harbor can run this CLI now (undefined) or why not. */
  cliProblem: (cli: CliId) => string | undefined;
  cliName: (cli: CliId) => string;
}

interface ExportStage { kind: 'export'; at: number; projectId: Id; content: BundleContent; secrets: SecretFinding[]; fileName: string }
interface BundleStage { kind: 'bundle'; at: number; content: BundleContent; skillToken?: string; skillNames: string[] }
interface ChatStage { kind: 'chat'; at: number; source: ImportSource; entries: Map<string, SourceEntry>; done: Set<string> }
type Stage = ExportStage | BundleStage | ChatStage;

const STAGE_TTL_MS = 30 * 60_000;
const MAX_STAGES = 8;
const MAX_EXPORT_IMAGES_BYTES = 50 * 1024 * 1024;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const dateOf = (t: number) => new Date(t).toISOString().slice(0, 10);

export class Transfer {
  private stages = new Map<string, Stage>();
  constructor(private d: TransferDeps) {}

  private now(): number { return this.d.env.now(); }
  private stage(s: Stage): string {
    const t = this.now();
    for (const [k, v] of this.stages) if (t - v.at > STAGE_TTL_MS) this.stages.delete(k);
    while (this.stages.size >= MAX_STAGES) this.stages.delete(this.stages.keys().next().value!);
    const token = randomUUID();
    this.stages.set(token, s);
    return token;
  }
  private take<K extends Stage['kind']>(token: unknown, kind: K, what: string): Extract<Stage, { kind: K }> {
    const s = typeof token === 'string' ? this.stages.get(token) : undefined;
    if (!s || s.kind !== kind || this.now() - s.at > STAGE_TTL_MS) throw new Error(`That ${what} has expired. Check it again.`);
    return s as Extract<Stage, { kind: K }>;
  }
  private project(id: unknown): Project {
    const p = typeof id === 'string' ? this.d.store.getProject(id) : undefined;
    if (!p) throw new Error('Choose an existing project.');
    return p;
  }
  private roots(p: Project): PathRoots {
    return { project: p.path, worktrees: this.d.worktreesRoot, ...(this.d.dataDir ? { data: this.d.dataDir } : {}), ...(this.d.env.home ? { home: this.d.env.home } : {}) };
  }

  // ------------------------------------------------------------------ export

  /** Builds the bundle in memory from an allowlist of fields; paths rewritten, secrets scanned. Writes nothing. */
  previewExport(projectId: Id, selection: BundleSelection): BundleExportPreview {
    const p = this.project(projectId);
    if (!isObj(selection)) throw new Error('Choose what to export.');
    const { store } = this.d;
    const roots = this.roots(p);
    const rw = (t: string) => rewritePaths(t, roots);
    const notes: string[] = [];
    const project: BundleProject = {};
    if (selection.settings === true) {
      const s = store.getSettings().projectOverrides?.[p.id];
      if (s && Object.keys(s).length) project.settings = structuredClone(s);
      else notes.push('This project has no routing preferences of its own; the bundle carries none.');
      if (existsSync(join(p.path, '.harbor', 'checks.json'))) project.checksFile = '.harbor/checks.json';
    }
    if (selection.toolRules === true) {
      const rules = store.listToolRules(p.id).map((r) => ({ tool: r.tool, ...(r.prefix ? { prefix: r.prefix } : {}) }));
      // A rule naming a path of this machine would not mean the same elsewhere: left out rather than rewritten into something else.
      const kept = rules.filter((r) => !r.prefix || rw(r.prefix) === r.prefix);
      if (kept.length < rules.length) notes.push(`${rules.length - kept.length} tool rule(s) name a folder of this machine and are left out.`);
      if (kept.length) project.toolRules = kept;
    }
    // Skills first: their bundle folder names are what skill choices refer to.
    const skills: BundleContent['skills'] = [];
    const folderOf = new Map<string, string>();
    for (const id of Array.isArray(selection.skills) ? selection.skills.slice(0, 50) : []) {
      if (typeof id !== 'string') continue;
      const x = this.d.skills.exportFiles(id, { id: p.id, path: p.path });
      let folder = x.folder;
      for (let i = 2; skills.some((s) => s.folder.toLowerCase() === folder.toLowerCase()); i++) folder = `${x.folder.slice(0, 60)}-${i}`;
      skills.push({ folder, files: x.files });
      folderOf.set(id, folder);
    }
    if (selection.skillChoices === true) {
      const prefs = store.skillPrefs().projects[p.id] ?? {};
      const sc: Record<string, boolean> = {};
      let dropped = 0;
      for (const [id, on] of Object.entries(prefs)) {
        if (folderOf.has(id)) sc[`bundle:${folderOf.get(id)}`] = on;
        else if (id.startsWith('project:')) sc[id] = on;
        else dropped++;
      }
      if (dropped) notes.push(`${dropped} skill choice(s) refer to skills that are neither in the project nor in this bundle and are left out.`);
      if (Object.keys(sc).length) project.skillChoices = sc;
    }
    const mainId = store.mainAgent(p.id)?.id;
    const conversations: BundleContent['conversations'] = [];
    const images = new Map<string, Buffer>();
    let imageBytes = 0, imagesSkipped = 0;
    const ids = Array.isArray(selection.conversations) ? [...new Set(selection.conversations)].slice(0, BUNDLE_LIMITS.maxConversations) : [];
    for (const id of ids) {
      const c = typeof id === 'string' ? store.getConversation(id) : undefined;
      if (!c || c.projectId !== p.id || c.agentId !== mainId) throw new Error('A chosen conversation is not a conversation of this project.');
      const key = `c${conversations.length + 1}`;
      let n = 0;
      const messages: BundleMessage[] = store.listMessages(c.id)
        .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system') // tool activity is a run log: never exported
        .slice(-BUNDLE_LIMITS.maxMessages)
        .map((m) => {
          const imgs = (m.attachments ?? []).slice(0, 6).map((a) => {
            const out: { name: string; mime: string; file?: string } = { name: clip(rw(a.name), 120), mime: a.mime };
            if (selection.images !== true || !imageExt(a.mime)) return out;
            const data = this.storedImage(a);
            if (!data || imageBytes + data.length > MAX_EXPORT_IMAGES_BYTES) { if (data) imagesSkipped++; return out; }
            const file = `${key}/i${++n}.${imageExt(a.mime)}`;
            images.set(file, data); imageBytes += data.length;
            return { ...out, file };
          });
          return { role: m.role as BundleMessage['role'], text: rw(m.text).slice(0, BUNDLE_LIMITS.maxMessageChars), time: m.time, ...(imgs.length ? { images: imgs } : {}) };
        });
      const decisions = [
        ...store.listCoordination(p.id).filter((e) => e.kind === 'decision' && e.conversationId === c.id).map((e) => ({ text: rw(e.text), time: e.time })),
        ...store.importedDecisions(c.id).map((e) => ({ text: rw(e.text), ...(e.time ? { time: e.time } : {}) }))
      ].slice(-BUNDLE_LIMITS.maxDecisions);
      const cv: BundleConversation = {
        title: clip(rw(c.title), 160), updated: c.updated, ...(c.mode && c.mode !== 'default' ? { mode: c.mode } : {}), ...(c.goal ? { goal: rw(c.goal) } : {}),
        ...(c.imported ? { imported: { source: c.imported.source, label: c.imported.label, ...(c.imported.started ? { started: c.imported.started } : {}), ...(c.imported.ended ? { ended: c.imported.ended } : {}) } } : {}),
        messages, decisions
      };
      conversations.push({ key, conversation: cv });
    }
    if (imagesSkipped) notes.push(`${imagesSkipped} image(s) are left out: the images of one bundle are capped at ${MAX_EXPORT_IMAGES_BYTES / 1024 / 1024} MB.`);
    if (selection.images !== true && conversations.some((c) => c.conversation.messages.some((m) => m.images?.length))) notes.push('Images are listed by name only. Tick "Include images" to put the image files in the bundle.');
    const content: BundleContent = { manifest: { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, createdAt: this.now(), ...(this.d.appVersion ? { appVersion: this.d.appVersion } : {}), project: { name: clip(p.name, 120) } }, project, conversations, images, skills };
    if (!Object.keys(project).length && !conversations.length && !skills.length) throw new Error('Choose at least one thing to export.');
    const secrets = scanContent(content);
    const { data, items } = writeBundle(content);
    const fileName = `${safeFolderName(p.name) || 'project'}-${dateOf(this.now())}.harbor.zip`;
    const token = this.stage({ kind: 'export', at: this.now(), projectId: p.id, content, secrets, fileName });
    return { token, fileName, items, excluded: [...ALWAYS_EXCLUDED, ...(selection.images === true ? [] : ['Image files (only their names), unless you tick "Include images"'])], secrets, bytes: data.length, ...(notes.length ? { notes } : {}) };
  }

  /** An image Harbor stored for a message, read only when it is one of Harbor's own attachment files and really an image. */
  private storedImage(a: Attachment): Buffer | undefined {
    if (!a.path || !urlForStoredPath(this.d.dataRoot, a.path)) return undefined;
    try {
      const st = lstatSync(a.path);
      if (!st.isFile() || st.size > BUNDLE_LIMITS.maxImageBytes) return undefined;
      const data = readFileSync(a.path);
      return looksLikeImage(data, a.mime) ? data : undefined;
    } catch { return undefined; }
  }

  async exportBundle(token: string, opts: { keepSecrets?: boolean; redactSecrets?: boolean } = {}): Promise<BundleExportResult | null> {
    const st = this.take(token, 'export', 'export preview');
    if (!this.d.pickSave) throw new Error('Saving a bundle is available in the desktop app.');
    let content = st.content, redacted = 0;
    if (st.secrets.length && opts.redactSecrets !== true && opts.keepSecrets !== true) throw new Error(`The secret scan found ${st.secrets.length} possible secret${st.secrets.length === 1 ? '' : 's'}. Choose to remove ${st.secrets.length === 1 ? 'it' : 'them'} or to keep ${st.secrets.length === 1 ? 'it' : 'them'}, then export again.`);
    if (st.secrets.length && opts.redactSecrets === true) ({ content, count: redacted } = redactContent(content));
    const chosen = await this.d.pickSave(st.fileName);
    if (!chosen) return null;
    if (typeof chosen !== 'string' || !isAbsolute(chosen)) throw new Error('Choose where to save the bundle.');
    const path = /\.zip$/i.test(chosen) ? resolve(chosen) : `${resolve(chosen)}.harbor.zip`;
    const { data, items } = writeBundle(content);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
    try { writeFileSync(tmp, data, { flag: 'wx' }); renameSync(tmp, path); } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* best effort */ } throw e; }
    this.stages.delete(token);
    this.d.journal?.(st.projectId, `Exported a Harbor bundle (${items.length} items${redacted ? `, ${redacted} secret-looking strings removed` : ''}).`);
    return { path, bytes: data.length, items: items.length, ...(redacted ? { redacted } : {}) };
  }

  // ------------------------------------------------------------------ bundle import

  previewBundle(path: unknown): BundlePreview {
    if (typeof path !== 'string' || !path.trim() || /[\0\r\n]/.test(path) || !isAbsolute(path.trim())) throw new Error('Choose the bundle by its full path.');
    const file = resolve(path.trim());
    let st;
    try { st = lstatSync(file); } catch { throw new Error('That bundle file does not exist.'); }
    const empty = (problems: string[], version = 0): BundlePreview => ({ version, supported: false, items: [], conversations: [], secrets: [], problems });
    if (st.isSymbolicLink()) return empty(['That file is a link; choose the file it points to.']);
    if (!st.isFile()) return empty(['That is not a file.']);
    if (st.size > BUNDLE_LIMITS.maxArchiveBytes) return empty([`The bundle is larger than ${BUNDLE_LIMITS.maxArchiveBytes / 1024 / 1024} MB.`]);
    const r = readBundle(readFileSync(file));
    if (!r.content || r.problems.length) return { ...empty(r.problems, r.version), supported: r.version >= 1 && r.version <= BUNDLE_VERSION, ...(r.warnings.length ? { warnings: r.warnings } : {}) };
    const c = r.content;
    let skills: BundlePreview['skills'];
    let skillToken: string | undefined, skillNames: string[] = [];
    if (c.skills.length) {
      skills = this.d.skills.previewFiles(`bundle "${c.manifest.project.name}"`, c.skills.flatMap((s) => s.files.map((f) => ({ path: `${s.folder}/${f.path}`, data: f.data }))));
      skillToken = skills.token;
      skillNames = skills.skills.filter((s) => !s.problems?.length).map((s) => s.name);
      // The import token of the skills stays here: importBundle uses it, the renderer never needs it.
      const { token: _t, ...rest } = skills;
      skills = rest;
    }
    const token = this.stage({ kind: 'bundle', at: this.now(), content: c, skillToken, skillNames });
    const p = c.project;
    return {
      token, version: r.version, supported: true, createdAt: c.manifest.createdAt, ...(c.manifest.appVersion ? { appVersion: c.manifest.appVersion } : {}), projectName: c.manifest.project.name,
      items: bundleItems(c),
      conversations: c.conversations.map(({ key, conversation: cv }) => ({ key, title: cv.title, messages: cv.messages.length, decisions: cv.decisions.length, images: cv.messages.reduce((n, m) => n + (m.images?.filter((i) => i.file && c.images.has(i.file)).length ?? 0), 0) })),
      ...(p.settings ? { settings: p.settings } : {}),
      ...(p.toolRules?.length ? { toolRules: p.toolRules.map((t) => ({ ...t, allowed: acceptableToolRule(t) })) } : {}),
      ...(p.skillChoices ? { skillChoices: p.skillChoices } : {}),
      ...(p.checksFile ? { checksFile: p.checksFile } : {}),
      ...(skills ? { skills } : {}),
      secrets: scanContent(c),
      ...(r.warnings.length ? { warnings: r.warnings } : {})
    };
  }

  importBundle(token: string, opts: BundleImportOptions): BundleImportResult {
    const st = this.take(token, 'bundle', 'bundle preview');
    if (!isObj(opts)) throw new Error('Choose what to import.');
    const p = this.project(opts.projectId);
    const { store } = this.d;
    const c = st.content;
    const applied: string[] = [], skipped: string[] = [];
    const keys = Array.isArray(opts.conversations) ? opts.conversations.filter((k): k is string => typeof k === 'string') : [];
    const chosenConvs = keys.map((k) => { const x = c.conversations.find((cv) => cv.key === k); if (!x) throw new Error(`The bundle has no conversation ${clip(k, 40)}.`); return x; });
    const skillNames = Array.isArray(opts.skills) ? opts.skills.filter((n): n is string => typeof n === 'string' && st.skillNames.includes(n)) : [];
    // Checked before anything is written: an existing choice is never replaced without the user saying so.
    const existing = store.getSettings().projectOverrides?.[p.id];
    if (opts.settings === true && c.project.settings && existing && Object.keys(existing).length && opts.replaceSettings !== true) {
      throw new Error(`${p.name} already has its own routing preferences. Tick "Replace them" to use the bundle's, or leave routing preferences out.`);
    }
    if (skillNames.length && !st.skillToken) throw new Error('The skills in this bundle cannot be imported.');

    if (opts.settings === true && c.project.settings) {
      store.setSettings({ projectOverrides: { [p.id]: c.project.settings } });
      applied.push(existing && Object.keys(existing).length ? 'Routing preferences (replaced the project\'s own)' : 'Routing preferences');
    }
    if (opts.toolRules === true) {
      let n = 0;
      for (const r of c.project.toolRules ?? []) {
        if (!acceptableToolRule(r)) { skipped.push(`Tool rule ${r.prefix ? `${r.tool}(${r.prefix} ...)` : r.tool}: Harbor never always-allows it.`); continue; }
        const before = store.listToolRules(p.id).length;
        store.addToolRule(p.id, r);
        if (store.listToolRules(p.id).length > before) n++;
      }
      if (n) applied.push(`${n} tool rule${n === 1 ? '' : 's'}`);
    }
    let byDir: Record<string, string> = {};
    const importedSkills = [];
    if (skillNames.length) {
      const r = this.d.skills.importStagedDetailed(st.skillToken!, skillNames);
      byDir = r.byDir; importedSkills.push(...r.skills);
      st.skillToken = undefined; st.skillNames = [];
      applied.push(`${r.skills.length} skill${r.skills.length === 1 ? '' : 's'} into the library`);
    }
    if (opts.skillChoices === true) {
      const mine = store.skillPrefs().projects[p.id] ?? {};
      let n = 0;
      for (const [id, on] of Object.entries(c.project.skillChoices ?? {})) {
        const target = id.startsWith('bundle:') ? byDir[id.slice('bundle:'.length)] : id;
        if (!target) { skipped.push(`Skill choice for ${id.slice('bundle:'.length)}: that skill was not imported.`); continue; }
        if (mine[target] !== undefined && mine[target] !== on) { skipped.push(`Skill choice for ${target}: kept the project's own choice.`); continue; }
        store.setSkillPref(target, on, p.id); n++;
      }
      if (n) applied.push(`${n} skill choice${n === 1 ? '' : 's'}`);
    }
    if (c.project.checksFile) skipped.push(`The bundle's project used ${c.project.checksFile}; its commands stay in the repository and run only after you approve them here.`);
    const conversations: Conversation[] = [];
    for (const { conversation: cv } of chosenConvs) {
      const label = `Harbor bundle from ${c.manifest.project.name}${cv.imported ? ` (originally ${cv.imported.label})` : ''}`;
      const conv = this.addImported(p.id, {
        title: cv.title,
        imported: { source: 'bundle', label: clip(label, 160), importedAt: this.now(), ...(cv.imported?.started ? { started: cv.imported.started } : {}), messages: 0 },
        messages: cv.messages.map((m) => ({ role: m.role, text: m.text, time: m.time || undefined, images: (m.images ?? []).map((i) => ({ name: i.name, mime: i.mime, data: i.file ? c.images.get(i.file) : undefined })) }))
      });
      if (cv.decisions.length) store.setImportedDecisions(conv.id, cv.decisions);
      conversations.push(conv);
    }
    if (conversations.length) applied.push(`${conversations.length} conversation${conversations.length === 1 ? '' : 's'} as read-only history`);
    this.stages.delete(token);
    this.d.journal?.(p.id, `Imported from a Harbor bundle: ${applied.join(', ') || 'nothing'}.`);
    return { conversations, skills: importedSkills, applied, skipped };
  }

  // ------------------------------------------------------------------ chat importers

  listSources(): ChatImportSourceInfo[] {
    return IMPORT_SOURCES.map((s) => ({ id: s.id, name: s.name, kind: s.kind, verified: s.verified, ...(s.note ? { note: s.note } : {}), ...s.detect(this.d.env) }));
  }

  previewImport(sourceId: ChatImportSourceId, opts: { path?: string } = {}): ChatImportPreview {
    const src = importSource(sourceId);
    if (!src) throw new Error('Unknown import source.');
    if (src.kind === 'file' && (typeof opts?.path !== 'string' || !opts.path.trim())) throw new Error('Choose the export file first.');
    const l = src.preview(this.d.env, src.kind === 'file' ? { path: opts.path } : {});
    const ok = !l.problems.length && l.entries.length > 0;
    const token = ok ? this.stage({ kind: 'chat', at: this.now(), source: src, entries: new Map(l.entries.map((e) => [e.id, e])), done: new Set() }) : undefined;
    return {
      ...(token ? { token } : {}), source: src.id, label: l.label,
      entries: l.entries.map(({ ref: _r, ...e }) => e),
      ...(l.problems.length ? { problems: l.problems } : !l.entries.length ? { problems: ['No chats were found.'] } : {}),
      ...(l.skipped.length ? { skipped: l.skipped } : {}), ...(l.truncated ? { truncated: true } : {})
    };
  }

  importConversations(projectId: Id, token: string, entryIds: string[]): ChatImportResult {
    const st = this.take(token, 'chat', 'chat listing');
    const p = this.project(projectId);
    if (!Array.isArray(entryIds) || !entryIds.length || entryIds.length > 200) throw new Error('Choose between 1 and 200 chats to import.');
    const conversations: Conversation[] = [], skipped: string[] = [];
    for (const id of entryIds) {
      const entry = typeof id === 'string' ? st.entries.get(id) : undefined;
      if (!entry) { skipped.push(`${clip(String(id), 60)}: not in this listing.`); continue; }
      if (st.done.has(entry.id)) { skipped.push(`${entry.title}: already imported from this listing.`); continue; }
      let chat;
      try { chat = st.source.read(this.d.env, entry); } catch (e) { skipped.push(`${entry.title}: could not be read (${e instanceof Error ? clip(e.message, 120) : 'unknown error'}).`); continue; }
      if (!chat.messages.length) { skipped.push(`${chat.title || entry.title}: no messages Harbor could read${chat.skipped.length ? ` (left out: ${chat.skipped.join(', ')})` : ''}.`); continue; }
      st.done.add(entry.id);
      const conv = this.addImported(p.id, {
        title: chat.title || entry.title,
        imported: { source: st.source.id, label: st.source.name, importedAt: this.now(), ...(chat.started ? { started: chat.started } : {}), ...(chat.ended ? { ended: chat.ended } : {}), messages: 0, ...(chat.skipped.length ? { skipped: chat.skipped } : {}) },
        messages: chat.messages
      });
      conversations.push(conv);
      if (chat.skipped.length) skipped.push(`${conv.title}: left out ${chat.skipped.join(', ')}.`);
    }
    if (conversations.length) this.d.journal?.(p.id, `Imported ${conversations.length} chat(s) from ${st.source.name}.`);
    return { conversations, skipped };
  }

  // ------------------------------------------------------------------ shared: imported conversations, continuing them

  /** A read-only conversation of the project's lead, tagged imported, with new ids for everything. */
  private addImported(projectId: Id, x: { title: string; imported: ImportedInfo; messages: Array<{ role: Message['role']; text: string; time?: number; images?: Array<{ name: string; mime: string; data?: Buffer }> }> }): Conversation {
    const { store } = this.d;
    const id = newId();
    const msgs = x.messages.slice(0, BUNDLE_LIMITS.maxMessages);
    const imported: ImportedInfo = { ...x.imported, messages: msgs.length };
    const conv = store.addConversation({ id, projectId, title: clip(x.title.replace(/\s+/g, ' ').trim() || 'Imported chat', 160), updated: this.now(), agentId: this.d.mainAgentId(projectId), customTitle: true, imported });
    const firstTime = msgs.find((m) => m.time)?.time ?? this.now();
    let t = firstTime - 1;
    const when = imported.started ? ` The original ${imported.started && imported.ended && dateOf(imported.started) !== dateOf(imported.ended) ? `ran from ${dateOf(imported.started)} to ${dateOf(imported.ended)}` : `is from ${dateOf(imported.started)}`}.` : '';
    store.addMessage({ id: newId(), conversationId: id, role: 'system', time: t, text: `Imported from ${imported.label} on ${dateOf(this.now())}: read-only history (${msgs.length} message${msgs.length === 1 ? '' : 's'}).${when} It was written outside Harbor; agents see it only as quoted history. Use "Continue with…" to keep working on it.${imported.skipped?.length ? ` Left out on import: ${imported.skipped.join(', ')}.` : ''}` });
    for (const m of msgs) {
      t = Math.max(t + 1, m.time ?? 0);
      const attachments = (m.images ?? []).map((img) => this.saveImage(id, img)).filter((a): a is Attachment => !!a);
      store.addMessage({ id: newId(), conversationId: id, role: m.role, text: m.text, time: t, ...(attachments.length ? { attachments } : {}) });
    }
    store.patchConversation(id, { updated: this.now() });
    this.d.emit({ type: 'conversation', conversation: { ...conv } });
    return { ...conv };
  }

  /** An image from a bundle, written under the conversation's attachments folder with a new name; a file that is no image becomes a name only. */
  private saveImage(conversationId: Id, img: { name: string; mime: string; data?: Buffer }): Attachment | undefined {
    const ext = imageExt(img.mime);
    if (!ext) return undefined;
    if (!img.data || !looksLikeImage(img.data, img.mime)) return { name: clip(img.name, 120), mime: img.mime };
    const dir = attachmentDir(this.d.dataRoot, conversationId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${newId()}.${ext}`);
    writeFileSync(path, img.data, { flag: 'wx' });
    return { name: clip(img.name, 120), mime: img.mime, path, url: attachmentUrl(dir, path), origin: 'user' };
  }

  /** The Harbor-written handoff of an imported conversation (quoted history, see handoff.ts). */
  handoffOf(c: Conversation): string {
    const msgs = this.d.store.listMessages(c.id).filter((m) => m.role === 'user' || m.role === 'assistant');
    return buildHandoff({
      decisions: [], work: [], evidence: [], applied: [],
      imported: {
        source: c.imported!.label, title: c.title, ...(c.imported!.started ? { started: c.imported!.started } : {}), ...(c.imported!.ended ? { ended: c.imported!.ended } : {}),
        messages: msgs.map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text })),
        decisions: this.d.store.importedDecisions(c.id).map((d) => d.text),
        ...(c.imported!.skipped?.length ? { skipped: c.imported!.skipped } : {})
      }
    });
  }

  continueImported(conversationId: Id, opts: { cli: CliId }): Conversation {
    const { store } = this.d;
    const c = typeof conversationId === 'string' ? store.getConversation(conversationId) : undefined;
    if (!c) throw new Error('This conversation is no longer available.');
    if (!c.imported) throw new Error('Only an imported conversation can be continued this way. Send a message to continue this one.');
    const cli = isObj(opts) && typeof opts.cli === 'string' ? opts.cli : '';
    const problem = cli ? this.d.cliProblem(cli) : 'Choose the CLI that should continue it.';
    if (problem) throw new Error(problem);
    const text = this.handoffOf(c);
    const conv = this.d.newConversation(c.projectId);
    store.patchConversation(conv.id, { title: clip(`${c.title} (continued)`, 160), customTitle: true, continuedFrom: c.id });
    store.setContinuation(conv.id, { text, cli, from: c.id });
    const name = this.d.cliName(cli);
    store.addMessage({ id: newId(), conversationId: conv.id, role: 'system', time: this.now(), text: `Continues "${clip(c.title, 80)}" (imported from ${c.imported.label}). On its first turn the lead gets Harbor's summary of that chat as quoted history (not a replay; the other tool's own session is never resumed), and Harbor prefers ${name} for it. Write what you want done next.` });
    const out = store.getConversation(conv.id)!;
    this.d.emit({ type: 'conversation', conversation: { ...out } });
    return { ...out };
  }
}

/** Secret findings over everything text-like in a bundle. */
function scanContent(c: BundleContent): SecretFinding[] {
  const out: SecretFinding[] = [];
  const add = (t: string | undefined, where: string) => { if (t && out.length < 100) out.push(...scanSecrets(t, where, 100 - out.length)); };
  for (const r of c.project.toolRules ?? []) add(r.prefix, 'tool rules');
  for (const { conversation: cv } of c.conversations) {
    const where = `conversation "${clip(cv.title, 60)}"`;
    add(cv.title, where); add(cv.goal, where);
    for (const m of cv.messages) add(m.text, where);
    for (const d of cv.decisions) add(d.text, `${where} (decisions)`);
  }
  for (const s of c.skills) for (const f of s.files) if (!f.data.includes(0)) add(f.data.toString('utf8'), `skill ${s.folder}: ${f.path}`);
  return out;
}

/** The same content with every secret-looking string replaced by [redacted]. */
function redactContent(c: BundleContent): { content: BundleContent; count: number } {
  let count = 0;
  const r = (t: string) => { const x = redactBundleText(t); count += x.count; return x.text; };
  const project: BundleProject = { ...c.project, ...(c.project.toolRules ? { toolRules: c.project.toolRules.map((t) => ({ ...t, ...(t.prefix ? { prefix: r(t.prefix) } : {}) })) } : {}) };
  const conversations = c.conversations.map(({ key, conversation: cv }) => ({ key, conversation: { ...cv, title: r(cv.title), ...(cv.goal ? { goal: r(cv.goal) } : {}), messages: cv.messages.map((m) => ({ ...m, text: r(m.text) })), decisions: cv.decisions.map((d) => ({ ...d, text: r(d.text) })) } }));
  const skills = c.skills.map((s) => ({ ...s, files: s.files.map((f) => (f.data.includes(0) ? f : { ...f, data: Buffer.from(r(f.data.toString('utf8')), 'utf8') })) }));
  return { content: { ...c, project, conversations, skills }, count };
}
