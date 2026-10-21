import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PushSecretFinding, TemplateDraft, TemplatePreview, UserTemplate } from '../shared/api';
import { CHECKS_FILE } from './checks';
import { isInside, type Git } from './git';
import { reviewable } from './review';
import { applyAllowlist, scanPath, scanText, type SecretFinding } from './secretScan';
import { decodeText } from './documents';

/**
 * User templates: a project's tracked files copied into `<data folder>\templates\<id>\files`, described by `template.json`.
 * Nothing here runs a command. A template's default checks are only ever written to a new project's `.harbor/checks.json`, where the
 * existing approval flow (a permission request on the first run, by content hash) still applies.
 */

export const MAX_TEMPLATE_FILES = 2000;
export const MAX_TEMPLATE_FILE_BYTES = 1_000_000;
export const MAX_TEMPLATE_BYTES = 20_000_000;
const MAX_CHECKS = 10;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Checks as typed: trimmed, 1-500 characters, one line, at most ten. Throws with a sentence the owner can act on. */
export function cleanChecks(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('Checks must be a list of commands.');
  const out = raw.map((c) => (typeof c === 'string' ? c.trim() : '')).filter(Boolean);
  if (out.length > MAX_CHECKS) throw new Error(`A template can hold at most ${MAX_CHECKS} default checks.`);
  for (const c of out) if (c.length > 500 || /[\r\n\0]/.test(c)) throw new Error('A check is one command of at most 500 characters.');
  return [...new Set(out)];
}

function cleanName(raw: unknown): string {
  const n = typeof raw === 'string' ? raw.trim() : '';
  if (!n || n.length > 60 || /[\r\n\0]/.test(n)) throw new Error('A template name needs 1 to 60 characters.');
  return n;
}
function cleanDescription(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || raw.length > 300 || /\0/.test(raw)) throw new Error('A template description is at most 300 characters.');
  return raw.trim() || undefined;
}

export interface CollectedFile { path: string; abs: string; bytes: number }
export interface Collected { files: CollectedFile[]; bytes: number; excluded: Array<{ path: string; reason: string }>; findings: PushSecretFinding[]; findingsTotal: number; tooMany: boolean; tooLarge: boolean }

/** Tracked files of a project that may go into a template, plus what was left out and why, and secret findings in what stays. Read-only. */
export async function collectTemplateFiles(projectPath: string, git: Git, allowlist: readonly string[] = []): Promise<Collected> {
  const r = await git.exec(projectPath, ['ls-files', '-z']);
  if (!r.ok) throw new Error(r.timedOut ? 'git timed out while listing the project files.' : 'This project is not a git repository with commits, so there is nothing tracked to copy.');
  const names = r.stdout.split('\0').filter(Boolean);
  const out: Collected = { files: [], bytes: 0, excluded: [], findings: [], findingsTotal: 0, tooMany: false, tooLarge: false };
  const found: SecretFinding[] = [];
  for (const rel of names) {
    const slash = rel.replace(/\\/g, '/');
    if (slash.startsWith('.git/') || slash.startsWith('.harbor/') || slash.split('/').includes('..') || /^[A-Za-z]:|^\//.test(slash)) { out.excluded.push({ path: slash, reason: 'Harbor\'s own files are not copied' }); continue; }
    const abs = join(projectPath, ...slash.split('/'));
    let st;
    try { st = lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink() || !st.isFile()) { out.excluded.push({ path: slash, reason: 'not a plain file' }); continue; }
    if (!reviewable(slash) || scanPath(slash)) { out.excluded.push({ path: slash, reason: 'looks like a credential file' }); continue; }
    if (st.size > MAX_TEMPLATE_FILE_BYTES) { out.excluded.push({ path: slash, reason: 'larger than 1 MB' }); continue; }
    if (out.files.length >= MAX_TEMPLATE_FILES) { out.tooMany = true; break; }
    out.files.push({ path: slash, abs, bytes: st.size });
    out.bytes += st.size;
    const text = decodeText(readFileSync(abs));
    if (text !== undefined) found.push(...scanText(slash, text));
  }
  if (out.bytes > MAX_TEMPLATE_BYTES) out.tooLarge = true;
  const split = applyAllowlist(found, allowlist);
  out.findingsTotal = split.kept.length;
  out.findings = split.kept.slice(0, 50).map((f) => ({ type: f.type, file: f.file, line: f.line }));
  return out;
}

/** The project's own `.harbor/checks.json` commands, as a suggestion for the template's defaults. */
export function suggestedChecks(projectPath: string): string[] {
  try {
    const j = JSON.parse(readFileSync(join(projectPath, CHECKS_FILE), 'utf8')) as { checks?: unknown };
    return Array.isArray(j.checks) ? j.checks.filter((c): c is string => typeof c === 'string' && !!c.trim() && c.length <= 500).slice(0, MAX_CHECKS) : [];
  } catch { return []; }
}

export function previewOf(projectId: string, c: Collected, suggested: string[]): TemplatePreview {
  return {
    projectId, files: c.files.length, bytes: c.bytes, sample: c.files.slice(0, 50).map((f) => f.path), excluded: c.excluded.slice(0, 100),
    findings: c.findings, findingsTotal: c.findingsTotal, suggestedChecks: suggested, blocked: c.findingsTotal > 0 || c.tooMany || c.tooLarge || c.files.length === 0
  };
}

/** Why a collection cannot be saved, or undefined. Findings are never described by value. */
export function blockReason(c: Collected): string | undefined {
  if (c.findingsTotal) return `The secret scan found ${c.findingsTotal} possible secret${c.findingsTotal === 1 ? '' : 's'} in the files to copy (${c.findings.slice(0, 3).map((f) => `${f.type} at ${f.file}${f.line > 0 ? `:${f.line}` : ''}`).join(', ')}). Remove or allowlist them, then save again.`;
  if (c.tooMany) return `A template holds at most ${MAX_TEMPLATE_FILES} files.`;
  if (c.tooLarge) return `A template holds at most ${Math.round(MAX_TEMPLATE_BYTES / 1_000_000)} MB.`;
  if (!c.files.length) return 'There are no tracked files to copy. Commit something first.';
  return undefined;
}

export interface TemplateFiles { path: string; read: () => Buffer }

/** The templates folder. Every id is validated before it becomes a path, and every path is checked to stay inside its template. */
export class TemplateLibrary {
  constructor(private root: string, private now: () => number = Date.now) {}

  private dir(id: string): string {
    if (!ID.test(id)) throw new Error('Unknown template.');
    return join(this.root, id);
  }

  list(): UserTemplate[] {
    if (!existsSync(this.root)) return [];
    const out: UserTemplate[] = [];
    for (const id of readdirSync(this.root)) {
      if (!ID.test(id)) continue;
      const t = this.read(id);
      if (t) out.push(t);
    }
    return out.sort((a, b) => b.created - a.created);
  }

  get(id: string): UserTemplate | undefined { return ID.test(id) ? this.read(id) : undefined; }

  private read(id: string): UserTemplate | undefined {
    try {
      const j = JSON.parse(readFileSync(join(this.dir(id), 'template.json'), 'utf8')) as Partial<UserTemplate>;
      if (j.id !== id || typeof j.name !== 'string' || typeof j.created !== 'number') return undefined;
      return { id, name: j.name, ...(typeof j.description === 'string' ? { description: j.description } : {}), created: j.created, files: Number(j.files) || 0, bytes: Number(j.bytes) || 0, checks: cleanChecks(j.checks ?? []), ...(typeof j.source === 'string' ? { source: j.source } : {}) };
    } catch { return undefined; }
  }

  /** Copies the collected files into a new template folder; a failure removes the half-made folder. */
  save(draft: TemplateDraft, files: readonly CollectedFile[], bytes: number, source: string): UserTemplate {
    const name = cleanName(draft?.name);
    const description = cleanDescription(draft?.description);
    const checks = cleanChecks(draft?.checks);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'template';
    let id = `${slug}-${randomBytes(3).toString('hex')}`;
    while (existsSync(join(this.root, id))) id = `${slug}-${randomBytes(3).toString('hex')}`;
    const dir = this.dir(id);
    const t: UserTemplate = { id, name, ...(description ? { description } : {}), created: this.now(), files: files.length, bytes, checks, source };
    try {
      mkdirSync(join(dir, 'files'), { recursive: true });
      for (const f of files) {
        const dest = join(dir, 'files', ...f.path.split('/'));
        if (!isInside(dest, join(dir, 'files'))) throw new Error('A file path left the template folder.');
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(f.abs));
      }
      writeFileSync(join(dir, 'template.json'), JSON.stringify(t, null, 2) + '\n', 'utf8');
    } catch (e) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      throw new Error(`The template was not saved: ${e instanceof Error ? e.message : String(e)}`);
    }
    return t;
  }

  update(id: string, patch: Partial<TemplateDraft>): UserTemplate {
    const t = this.get(id);
    if (!t) throw new Error('Unknown template.');
    if (!patch || typeof patch !== 'object') throw new Error('Choose what to change.');
    const next: UserTemplate = { ...t };
    if (patch.name !== undefined) next.name = cleanName(patch.name);
    if (patch.description !== undefined) { const d = cleanDescription(patch.description); if (d) next.description = d; else delete next.description; }
    if (patch.checks !== undefined) next.checks = cleanChecks(patch.checks);
    writeFileSync(join(this.dir(id), 'template.json'), JSON.stringify(next, null, 2) + '\n', 'utf8');
    return next;
  }

  /** Removes the template's own folder (never anything outside the templates folder). */
  remove(id: string): void {
    const dir = this.dir(id);
    if (!isInside(resolve(dir), resolve(this.root))) throw new Error('Unknown template.');
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }

  /** The files of a template, for copying into a new project. Paths are relative, forward slashes, and re-checked against the folder. */
  files(id: string): TemplateFiles[] {
    const base = join(this.dir(id), 'files');
    const out: TemplateFiles[] = [];
    const walk = (dir: string, rel: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), path);
        else if (e.isFile()) out.push({ path, read: () => readFileSync(join(dir, e.name)) });
      }
    };
    if (existsSync(base)) walk(base, '');
    return out;
  }
}
