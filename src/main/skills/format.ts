/**
 * The Agent Skills layout (plan section 3.1): a folder holding SKILL.md, whose YAML frontmatter has `name` and `description`
 * and whose body is the instructions, plus optional resources such as `scripts/`.
 *
 * Verified against the real files on the build machine (2026-10-14): 69 SKILL.md files under ~/.claude/skills,
 * ~/.codex/skills and ~/.claude/plugins all start with a `---` frontmatter block holding `name:` and `description:` as plain or
 * double-quoted scalars, sometimes with `license`, `version`, `metadata:` (a nested map), `allowed-tools`, `argument-hint` and
 * `user-invocable`. Block scalars (`>`/`|`) and single quotes were not seen there; they are parsed because YAML allows them.
 * NOT verified: the open specification's exact limits; the ones used here (name of at most 64 lowercase letters, digits and
 * dashes, description of at most 1024 characters) are what the published Agent Skills docs state, and are only warnings.
 *
 * Only the keys Harbor needs are read and no YAML library is used: a skill is text from a stranger, and a small line parser
 * cannot be made to construct objects, follow anchors or load files. Everything is pure.
 */

export const SKILL_FILE = 'SKILL.md';
/** A SKILL.md larger than this is refused: progressive disclosure keeps skills small, and the file may be inlined in a prompt. */
export const MAX_SKILL_MD_BYTES = 256 * 1024;
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 1024;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ParsedSkill {
  /** Display name: the frontmatter name, or the folder name when it has none (with a warning). Never empty when usable. */
  name: string;
  description: string;
  body: string;
  /** Other top-level scalar keys, as text (license, version, ...). */
  meta: Record<string, string>;
  /** Reasons the skill cannot be used: it is listed but never given to an agent. */
  problems: string[];
  warnings: string[];
}

/** One line of text for a prompt or a list: control characters and line breaks become spaces, then clipped. */
export function oneLine(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Frontmatter lines between the opening and closing `---`, or undefined when the file has none. */
function splitFrontmatter(text: string): { lines: string[]; body: string } | undefined {
  const t = text.replace(/^﻿/, '');
  const lines = t.split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0] ?? '')) return undefined;
  for (let i = 1; i < lines.length && i < 400; i++) {
    if (/^(---|\.\.\.)\s*$/.test(lines[i]!)) return { lines: lines.slice(1, i), body: lines.slice(i + 1).join('\n') };
  }
  return undefined;
}

const indentOf = (l: string) => /^[ \t]*/.exec(l)![0].length;

function unquoteDouble(raw: string): string {
  try { return JSON.parse(raw) as string; } catch { /* YAML escapes JSON does not know: keep the text between the quotes */ }
  return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/** Top-level `key: value` pairs. Nested maps and lists are skipped; scalars may continue on more-indented lines. */
export function parseFrontmatter(lines: string[]): { values: Map<string, string>; duplicates: string[] } {
  const values = new Map<string, string>();
  const duplicates: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || /^\s*#/.test(line) || indentOf(line) > 0) continue;
    const m = /^([A-Za-z0-9_-]+)\s*:(?:\s+(.*)|\s*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    let raw = (m[2] ?? '').trim();
    // The value's continuation: following lines that are indented (or blank between indented ones).
    const more: string[] = [];
    while (i + 1 < lines.length && (indentOf(lines[i + 1]!) > 0 || (!lines[i + 1]!.trim() && i + 2 < lines.length && indentOf(lines[i + 2]!) > 0))) more.push(lines[++i]!);
    let value: string | undefined;
    const block = /^([|>])[+-]?\d*\s*(?:#.*)?$/.exec(raw);
    if (block) {
      const pad = Math.min(...more.filter((l) => l.trim()).map(indentOf));
      const body = more.map((l) => (l.trim() ? l.slice(Number.isFinite(pad) ? pad : 0) : ''));
      value = block[1] === '|' ? body.join('\n').trim() : body.join('\n').split(/\n{2,}/).map((p) => p.replace(/\n/g, ' ')).join('\n').trim();
    } else if (raw.startsWith('"')) {
      // A double-quoted scalar may run over several lines; YAML folds them with single spaces.
      const joined = [raw, ...more.map((l) => l.trim())].join(' ');
      let end = -1;
      for (let j = 1; j < joined.length; j++) { if (joined[j] === '\\') j++; else if (joined[j] === '"') { end = j; break; } }
      value = unquoteDouble(end > 0 ? joined.slice(0, end + 1) : `${joined}"`);
    } else if (raw.startsWith("'")) {
      const joined = [raw, ...more.map((l) => l.trim())].join(' ');
      const close = joined.lastIndexOf("'");
      value = (close > 0 ? joined.slice(1, close) : joined.slice(1)).replace(/''/g, "'");
    } else if (raw === '') {
      // A nested map or list (metadata:, allowed-tools:): not a scalar Harbor reads.
      const nested = more.some((l) => /^\s*-(\s|$)/.test(l) || /^\s*[\w"'-]+\s*:(\s|$)/.test(l));
      value = nested ? undefined : more.map((l) => l.trim()).join(' ').trim() || undefined;
    } else {
      raw = raw.replace(/\s+#.*$/, '');
      value = [raw, ...more.map((l) => l.trim())].join(' ').trim();
    }
    if (value === undefined) continue;
    if (values.has(key)) { duplicates.push(key); continue; }
    values.set(key, value);
  }
  return { values, duplicates };
}

/** Parses SKILL.md text. `folder` is the skill folder's own name, used when the frontmatter has no name. */
export function parseSkillMd(text: string, folder: string, byteLength = Buffer.byteLength(text, 'utf8')): ParsedSkill {
  const problems: string[] = [], warnings: string[] = [];
  const fallback = oneLine(folder, MAX_NAME) || 'skill';
  if (byteLength > MAX_SKILL_MD_BYTES) {
    return { name: fallback, description: '', body: '', meta: {}, problems: [`SKILL.md is larger than ${MAX_SKILL_MD_BYTES / 1024} KB.`], warnings };
  }
  if (text.includes('\0')) return { name: fallback, description: '', body: '', meta: {}, problems: ['SKILL.md is not a text file.'], warnings };
  const fm = splitFrontmatter(text);
  if (!fm) {
    return { name: fallback, description: '', body: text, meta: {}, problems: ['SKILL.md has no frontmatter: it must start with a --- block holding name and description.'], warnings };
  }
  const { values, duplicates } = parseFrontmatter(fm.lines);
  for (const d of duplicates) warnings.push(`The frontmatter repeats "${d}"; the first value is used.`);
  const rawName = values.get('name') ?? '';
  let name = oneLine(rawName, MAX_NAME + 1);
  if (!name) { warnings.push('The frontmatter has no name; the folder name is used.'); name = fallback; }
  else if (name.length > MAX_NAME || !NAME_RE.test(name)) warnings.push(`The name "${oneLine(rawName, 80)}" is not 1-${MAX_NAME} lowercase letters, digits and dashes.`);
  name = oneLine(name, MAX_NAME);
  const rawDesc = values.get('description') ?? '';
  const description = oneLine(rawDesc, MAX_DESCRIPTION);
  if (!description) problems.push('The frontmatter has no description, so an agent could not tell when to use it.');
  else if (oneLine(rawDesc, MAX_DESCRIPTION + 10).length > MAX_DESCRIPTION) warnings.push(`The description is longer than ${MAX_DESCRIPTION} characters and was shortened.`);
  const meta: Record<string, string> = {};
  for (const [k, v] of values) if (k !== 'name' && k !== 'description') meta[k] = oneLine(v, 300);
  return { name, description, body: fm.body, meta, problems, warnings };
}

/** Folder names Harbor creates in its library: lowercase letters, digits and dashes (never a path, never a device name). */
export function safeFolderName(name: string): string {
  const s = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_NAME).replace(/-+$/, '');
  return !s || /^(con|prn|aux|nul|com\d|lpt\d)$/.test(s) ? `skill${s ? `-${s}` : ''}` : s;
}

/** Files Harbor flags as "contains scripts": anything under scripts/ or with a program extension, or marked executable. */
const SCRIPT_EXT = /\.(sh|bash|zsh|ps1|psm1|psd1|bat|cmd|com|exe|dll|msi|scr|vbs|vbe|js|mjs|cjs|ts|py|pyw|rb|pl|php|jar|lua|wsf|hta|reg|lnk)$/i;
export const isScriptPath = (rel: string, executable = false): boolean => executable || SCRIPT_EXT.test(rel) || /(^|\/)scripts\//i.test(rel);
