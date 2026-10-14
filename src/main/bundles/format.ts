import type { BundleItem, ConversationMode, ImportedInfo, ProjectSettings } from '../../shared/api';
import { looksLikeImage } from '../images';
import { normalizeSettingsPatch, toolRuleFor } from '../store';
import { ZipRefused, readZip, writeZip, type ZipFile } from '../skills/zip';

/**
 * The Harbor bundle (`.harbor.zip`, plan section 6.1): a versioned zip Harbor writes and reads itself.
 *
 *   harbor-bundle.json          { format: "harbor-bundle", version, createdAt, appVersion?, project: { name } }
 *   project.json                routing preferences, tool rules, skill choices, the checks file reference (all optional)
 *   conversations/<n>.json      title, mode, goal, messages (role, text, time, image names), decisions; no logs, no routing details
 *   images/<n>/<k>.<ext>        image files of those messages, only when the user ticked them
 *   skills/<folder>/...         skill folders, imported through the same checks as a skill .zip
 *
 * Never in a bundle (the export builds from an allowlist, so nothing else can slip in): credentials and secret values, CLI paths and
 * custom CLI descriptors, MCP or environment values, absolute machine paths (rewritten, see paths.ts), run logs, helper reports,
 * check output, the journal, session ids. Reading is as strict as skill import: the zip safeguards of skills/zip.ts, caps on files and
 * sizes, and every path inside is matched against the fixed layout above, so no path from a bundle is ever used on disk.
 */

export const BUNDLE_FORMAT = 'harbor-bundle';
export const BUNDLE_VERSION = 1;
export const MANIFEST = 'harbor-bundle.json';
export const BUNDLE_LIMITS = {
  maxArchiveBytes: 64 * 1024 * 1024, maxEntries: 3000, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024,
  maxConversations: 200, maxMessages: 5000, maxMessageChars: 100_000, maxDecisions: 200, maxImages: 600, maxImageBytes: 10 * 1024 * 1024
};
/** What the export dialog lists as never included. */
export const ALWAYS_EXCLUDED = [
  'Credentials, sign-ins and tokens',
  'Secret values of MCP servers and environment variables',
  'CLI paths and custom CLI descriptors',
  'Absolute paths of this machine (rewritten to project-relative paths)',
  'Run logs, helper reports, check output and the journal',
  'Native CLI session ids (a bundle conversation cannot be resumed, only continued)'
];

export interface BundleMessage { role: 'user' | 'assistant' | 'system'; text: string; time: number; images?: Array<{ name: string; mime: string; file?: string }> }
export interface BundleConversation { title: string; updated: number; mode?: ConversationMode; goal?: string; imported?: Pick<ImportedInfo, 'source' | 'label' | 'started' | 'ended'>; messages: BundleMessage[]; decisions: Array<{ text: string; time?: number }> }
export interface BundleProject { settings?: ProjectSettings; toolRules?: Array<{ tool: string; prefix?: string }>; skillChoices?: Record<string, boolean>; checksFile?: string }
export interface BundleManifest { format: typeof BUNDLE_FORMAT; version: number; createdAt: number; appVersion?: string; project: { name: string } }

export interface BundleContent {
  manifest: BundleManifest;
  project: BundleProject;
  conversations: Array<{ key: string; conversation: BundleConversation }>;
  images: Map<string, Buffer>;
  skills: Array<{ folder: string; files: Array<{ path: string; data: Buffer }> }>;
}

const json = (v: unknown) => Buffer.from(JSON.stringify(v, null, 1), 'utf8');
const EXT = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp']]);
export const imageExt = (mime: string): string | undefined => EXT.get(mime);

/** The zip bytes of a bundle, plus the item list the export dialog shows. */
export function writeBundle(c: BundleContent): { data: Buffer; items: BundleItem[] } {
  const files: Array<{ path: string; data: Buffer }> = [{ path: MANIFEST, data: json(c.manifest) }];
  if (Object.keys(c.project).length) files.push({ path: 'project.json', data: json(c.project) });
  for (const { key, conversation } of c.conversations) files.push({ path: `conversations/${key}.json`, data: json(conversation) });
  for (const [path, data] of c.images) files.push({ path: `images/${path}`, data });
  for (const s of c.skills) for (const f of s.files) files.push({ path: `skills/${s.folder}/${f.path}`, data: f.data });
  return { data: writeZip(files), items: bundleItems(c) };
}

/** What a bundle holds, item by item (the same list on export and on import). */
export function bundleItems(c: BundleContent): BundleItem[] {
  const items: BundleItem[] = [];
  const p = c.project;
  if (p.settings && Object.keys(p.settings).length) items.push({ kind: 'settings', key: 'settings', label: 'Routing preferences', detail: Object.keys(p.settings).join(', ') });
  if (p.toolRules?.length) items.push({ kind: 'toolRules', key: 'toolRules', label: `${p.toolRules.length} tool rule${p.toolRules.length === 1 ? '' : 's'}`, detail: p.toolRules.map((r) => (r.prefix ? `${r.tool}(${r.prefix} ...)` : r.tool)).join(', ') });
  if (p.skillChoices && Object.keys(p.skillChoices).length) items.push({ kind: 'skillChoices', key: 'skillChoices', label: 'Skill choices for this project', detail: Object.entries(p.skillChoices).map(([k, v]) => `${k} ${v ? 'on' : 'off'}`).join(', ') });
  if (p.checksFile) items.push({ kind: 'checksFile', key: 'checksFile', label: 'Checks file reference', detail: `${p.checksFile} (the commands stay in the repository and need approval on the other machine)` });
  for (const { key, conversation: cv } of c.conversations) {
    items.push({ kind: 'conversation', key, label: cv.title, detail: `${cv.messages.length} message${cv.messages.length === 1 ? '' : 's'}, ${cv.decisions.length} decision${cv.decisions.length === 1 ? '' : 's'}${cv.imported ? `, imported earlier from ${cv.imported.label}` : ''}`, bytes: json(cv).length });
  }
  for (const [path, data] of c.images) items.push({ kind: 'image', key: path, label: `Image ${path}`, bytes: data.length });
  for (const s of c.skills) items.push({ kind: 'skill', key: s.folder, label: s.folder, detail: `${s.files.length} file${s.files.length === 1 ? '' : 's'}`, bytes: s.files.reduce((n, f) => n + f.data.length, 0) });
  return items;
}

// ---------------------------------------------------------------- reading (untrusted input)

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e14 ? v : undefined);
const CONV_FILE = /^conversations\/([a-z0-9-]{1,40})\.json$/;
const IMAGE_FILE = /^images\/([a-z0-9-]{1,40})\/([a-z0-9-]{1,40}\.(?:png|jpg|gif|webp))$/;
const SKILL_FILE = /^skills\/([A-Za-z0-9._-]{1,64})\/(.+)$/;
const MODES: ConversationMode[] = ['default', 'auto', 'plan', 'goal'];

export interface ReadBundle { content?: BundleContent; version: number; problems: string[]; warnings: string[] }

/** Parses JSON that may be hostile: errors (including a stack overflow from deep nesting) become a problem, never a crash. */
function parseJson(data: Buffer, what: string, problems: string[]): unknown {
  try { return JSON.parse(data.toString('utf8').replace(/^﻿/, '')); } catch (e) {
    problems.push(e instanceof RangeError ? `${what} is nested too deeply to read.` : `${what} is not valid JSON.`);
    return undefined;
  }
}

/** Reads a bundle. A newer version is refused with only the manifest read; any problem means nothing can be imported. */
export function readBundle(buf: Buffer): ReadBundle {
  const problems: string[] = [], warnings: string[] = [];
  let files: ZipFile[];
  try { files = readZip(buf, { maxEntries: BUNDLE_LIMITS.maxEntries, maxFileBytes: BUNDLE_LIMITS.maxFileBytes, maxTotalBytes: BUNDLE_LIMITS.maxTotalBytes, maxArchiveBytes: BUNDLE_LIMITS.maxArchiveBytes }); }
  catch (e) { if (e instanceof ZipRefused) return { version: 0, problems: [e.message], warnings }; throw e; }
  const byPath = new Map(files.map((f) => [f.path, f]));
  const mf = byPath.get(MANIFEST);
  if (!mf) return { version: 0, problems: ['This is not a Harbor bundle (no harbor-bundle.json inside).'], warnings };
  const m = parseJson(mf.data, 'harbor-bundle.json', problems);
  if (!isObj(m) || m['format'] !== BUNDLE_FORMAT) return { version: 0, problems: problems.length ? problems : ['This is not a Harbor bundle (unknown format).'], warnings };
  const version = typeof m['version'] === 'number' && Number.isInteger(m['version']) ? m['version'] : 0;
  if (version > BUNDLE_VERSION) return { version, problems: [`This bundle was made by a newer Harbor (bundle version ${version}; this Harbor reads up to version ${BUNDLE_VERSION}). Update Harbor, then import it again. Nothing was read beyond its version.`], warnings };
  if (version < 1) return { version, problems: ['This bundle has no valid version number.'], warnings };
  const manifest: BundleManifest = { format: BUNDLE_FORMAT, version, createdAt: num(m['createdAt']) ?? 0, ...(str(m['appVersion'], 40) ? { appVersion: str(m['appVersion'], 40) } : {}), project: { name: (isObj(m['project']) ? str(m['project']['name'], 120) : undefined) || 'Unnamed project' } };

  const project = readProject(byPath.get('project.json'), problems, warnings);
  const conversations: BundleContent['conversations'] = [];
  const images = new Map<string, Buffer>();
  const skills = new Map<string, Array<{ path: string; data: Buffer }>>();
  let ignored = 0;
  for (const f of files) {
    if (f.path === MANIFEST || f.path === 'project.json') continue;
    let mm: RegExpExecArray | null;
    if ((mm = CONV_FILE.exec(f.path))) {
      if (conversations.length >= BUNDLE_LIMITS.maxConversations) { problems.push(`The bundle holds more than ${BUNDLE_LIMITS.maxConversations} conversations.`); break; }
      const cv = readConversation(f.data, mm[1]!, problems, warnings);
      if (cv) conversations.push({ key: mm[1]!, conversation: cv });
    } else if ((mm = IMAGE_FILE.exec(f.path))) {
      const mime = mm[2]!.endsWith('.png') ? 'image/png' : mm[2]!.endsWith('.jpg') ? 'image/jpeg' : mm[2]!.endsWith('.gif') ? 'image/gif' : 'image/webp';
      if (f.data.length > BUNDLE_LIMITS.maxImageBytes || !looksLikeImage(f.data, mime)) { warnings.push(`${f.path} is not a valid image and is left out.`); continue; }
      if (images.size >= BUNDLE_LIMITS.maxImages) { warnings.push(`More than ${BUNDLE_LIMITS.maxImages} images: the rest are left out.`); continue; }
      images.set(`${mm[1]}/${mm[2]}`, f.data);
    } else if ((mm = SKILL_FILE.exec(f.path))) {
      const list = skills.get(mm[1]!) ?? [];
      list.push({ path: mm[2]!, data: f.data });
      skills.set(mm[1]!, list);
    } else ignored++;
  }
  if (ignored) warnings.push(`${ignored} file${ignored === 1 ? '' : 's'} in the bundle ${ignored === 1 ? 'is' : 'are'} not part of the bundle layout and ${ignored === 1 ? 'is' : 'are'} ignored.`);
  conversations.sort((a, b) => a.key.localeCompare(b.key));
  return { version, problems, warnings, content: { manifest, project, conversations, images, skills: [...skills].map(([folder, list]) => ({ folder, files: list })) } };
}

function readProject(f: ZipFile | undefined, problems: string[], warnings: string[]): BundleProject {
  if (!f) return {};
  const raw = parseJson(f.data, 'project.json', problems);
  if (!isObj(raw)) { if (raw !== undefined) problems.push('project.json is not an object.'); return {}; }
  const out: BundleProject = {};
  if (raw['settings'] !== undefined) {
    // The same validation as setSettings: a malformed or out-of-range value is dropped with a warning, never stored as is.
    try {
      const s = normalizeSettingsPatch({ projectOverrides: { bundle: raw['settings'] as ProjectSettings } }).projectOverrides?.['bundle'];
      if (s && Object.keys(s).length) out.settings = s;
    } catch (e) { warnings.push(`The routing preferences in the bundle are not valid and are left out (${e instanceof Error ? e.message : 'invalid'}).`); }
  }
  if (Array.isArray(raw['toolRules'])) {
    out.toolRules = raw['toolRules'].slice(0, 100).flatMap((r) => {
      if (!isObj(r) || typeof r['tool'] !== 'string' || r['tool'].length > 100) return [];
      const prefix = typeof r['prefix'] === 'string' && r['prefix'].length <= 200 ? r['prefix'] : undefined;
      return [{ tool: r['tool'], ...(prefix ? { prefix } : {}) }];
    });
  }
  if (isObj(raw['skillChoices'])) {
    const sc: Record<string, boolean> = {};
    // project:<folder> = a skill in the repository; bundle:<folder> = a skill carried in this bundle (skills/<folder>).
    for (const [k, v] of Object.entries(raw['skillChoices']).slice(0, 300)) if (typeof v === 'boolean' && /^(project:[^\0\r\n]{1,300}|bundle:[A-Za-z0-9._-]{1,64})$/.test(k)) sc[k] = v;
    if (Object.keys(sc).length) out.skillChoices = sc;
  }
  if (typeof raw['checksFile'] === 'string' && raw['checksFile'] === '.harbor/checks.json') out.checksFile = raw['checksFile'];
  return out;
}

function readConversation(data: Buffer, key: string, problems: string[], warnings: string[]): BundleConversation | undefined {
  const raw = parseJson(data, `conversations/${key}.json`, problems);
  if (!isObj(raw)) { if (raw !== undefined) problems.push(`conversations/${key}.json is not an object.`); return undefined; }
  const list = Array.isArray(raw['messages']) ? raw['messages'] : [];
  if (list.length > BUNDLE_LIMITS.maxMessages) warnings.push(`"${str(raw['title'], 80) ?? key}" has more than ${BUNDLE_LIMITS.maxMessages} messages; only the first ${BUNDLE_LIMITS.maxMessages} are imported.`);
  let clipped = 0;
  const messages: BundleMessage[] = list.slice(0, BUNDLE_LIMITS.maxMessages).flatMap((m): BundleMessage[] => {
    if (!isObj(m) || (m['role'] !== 'user' && m['role'] !== 'assistant' && m['role'] !== 'system') || typeof m['text'] !== 'string') return [];
    if (m['text'].length > BUNDLE_LIMITS.maxMessageChars) clipped++;
    const images = Array.isArray(m['images']) ? m['images'].slice(0, 6).flatMap((a) => {
      if (!isObj(a) || typeof a['name'] !== 'string' || !imageExt(String(a['mime']))) return [];
      const file = typeof a['file'] === 'string' && /^[a-z0-9-]{1,40}\/[a-z0-9-]{1,40}\.(?:png|jpg|gif|webp)$/.test(a['file']) ? a['file'] : undefined;
      return [{ name: a['name'].slice(0, 120), mime: String(a['mime']), ...(file ? { file } : {}) }];
    }) : [];
    return [{ role: m['role'], text: m['text'].slice(0, BUNDLE_LIMITS.maxMessageChars), time: num(m['time']) ?? 0, ...(images.length ? { images } : {}) }];
  });
  if (clipped) warnings.push(`${clipped} long message${clipped === 1 ? ' was' : 's were'} shortened to ${BUNDLE_LIMITS.maxMessageChars} characters.`);
  const decisions = (Array.isArray(raw['decisions']) ? raw['decisions'] : []).slice(0, BUNDLE_LIMITS.maxDecisions)
    .flatMap((d) => (isObj(d) && typeof d['text'] === 'string' && d['text'].trim() ? [{ text: d['text'].slice(0, 2000), ...(num(d['time']) ? { time: num(d['time']) } : {}) }] : []));
  const imp = isObj(raw['imported']) ? raw['imported'] : undefined;
  const source = imp && ['claude-code', 'codex', 'claude-export', 'chatgpt-export', 'bundle'].includes(String(imp['source'])) ? imp['source'] as ImportedInfo['source'] : undefined;
  return {
    title: (str(raw['title'], 160) ?? '').trim() || `Conversation ${key}`,
    updated: num(raw['updated']) ?? 0,
    ...(MODES.includes(raw['mode'] as ConversationMode) ? { mode: raw['mode'] as ConversationMode } : {}),
    ...(str(raw['goal'], 2000) ? { goal: str(raw['goal'], 2000) } : {}),
    ...(source ? { imported: { source, label: str(imp!['label'], 120) ?? source, ...(num(imp!['started']) ? { started: num(imp!['started']) } : {}), ...(num(imp!['ended']) ? { ended: num(imp!['ended']) } : {}) } } : {}),
    messages, decisions
  };
}

/** Whether Harbor would store this rule (the never-always checks of store.ts run on it, as for an "always allow" answer). */
export function acceptableToolRule(r: { tool: string; prefix?: string }): boolean {
  const draft = toolRuleFor(r.tool, r.tool === 'Bash' ? { command: r.prefix ?? '' } : {});
  return !!draft && draft.tool === r.tool && (draft.prefix ?? undefined) === (r.prefix ?? undefined);
}
