import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocumentKind, DocumentRefusalReason, DocumentResult, DocumentView, Id } from '../shared/api';
import { looksLikeImage, MAX_SHOWN_IMAGE_BYTES, real, within } from './images';
import { reviewable } from './review';
import { normPath } from './store';

/**
 * The document viewer's main-process half (plan section 4b): which files may be shown, and what the renderer gets for each.
 * Pure functions over the file system so the path guard and every format are testable without Electron.
 *
 * Safety model, in order: (1) a path must resolve, after links and junctions, inside a root Harbor allows (the project, its
 * helpers' worktrees, the project's conversation attachments, Harbor's skills library, or a file the user picked in a dialog);
 * a symlink as the file itself is refused; credential files are never read. (2) Content goes to the renderer as data only:
 * text, a data: URL for images (SVG included: always shown as an <img>, never inlined), and for HTML a sanitised copy that the
 * renderer puts in an iframe with `sandbox=""` (no scripts, forms, popups or same-origin) under a `default-src 'none'` CSP.
 * The sanitiser below is defence in depth; the sandbox and CSP are what hold.
 *
 * Verified on Electron 44.7 with Harbor's CSP and window policy (a throwaway Electron script, sandboxed preload, the same
 * will-frame-navigate rule as windowSecurity.ts): a `sandbox=""` srcdoc iframe renders, its scripts are blocked, remote images
 * are blocked by both CSPs, and webUtils.getPathForFile is available in the sandboxed preload. PDF does NOT work inside Harbor:
 * the CSP blocks frames (no frame-src, so default-src 'self') and objects (object-src 'none'), and even with those relaxed and
 * `plugins: true`, Harbor's navigation guard denies the data:/blob: subframe the PDF viewer needs. Loosening all three is not
 * worth it for a preview, so PDFs get "open in the default app".
 */

/** Text-like files above this are not read; the viewer offers the default app (when safe) or Explorer instead. */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
/** Images are sent as data: URLs; same cap as images an agent shows in the chat. */
export const MAX_IMAGE_BYTES = MAX_SHOWN_IMAGE_BYTES;
const SNIFF_BYTES = 8192;

export interface DocumentRoot {
  kind: DocumentView['root'];
  path: string;
  agentId?: Id;
  /** A single file the user picked (only that exact file is allowed), not a folder. */
  file?: boolean;
}

export type ResolvedDocument =
  | { ok: true; path: string; root: DocumentRoot; relPath: string; size: number; modified: number }
  | { ok: false; reason: DocumentRefusalReason; message: string };

const refuse = (reason: DocumentRefusalReason, message: string): { ok: false; reason: DocumentRefusalReason; message: string } => ({ ok: false, reason, message });

// Maps, not objects: an extension such as ".constructor" must never match an inherited property.
const MARKDOWN = new Set(['.md', '.markdown', '.mdx', '.mkd']);
const TEXT = new Set(['.txt', '.text', '.log', '.ini', '.cfg', '.conf', '.properties', '.gitignore', '.gitattributes', '.editorconfig', '.jsonl', '.ndjson', '.lock']);
const JSON_EXT = new Set(['.json', '.jsonc', '.json5', '.webmanifest']);
const CSV = new Set(['.csv', '.tsv']);
const HTML = new Set(['.html', '.htm', '.xhtml']);
const OFFICE = new Set(['.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.odt', '.ods', '.odp', '.rtf']);
const IMAGES = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'], ['.webp', 'image/webp']]);
/** Extension -> highlighter language (the renderer knows keywords for the common ones and shows the rest plain). */
const CODE = new Map<string, string>([
  ['.ts', 'ts'], ['.tsx', 'ts'], ['.mts', 'ts'], ['.cts', 'ts'], ['.js', 'js'], ['.jsx', 'js'], ['.mjs', 'js'], ['.cjs', 'js'],
  ['.py', 'py'], ['.pyi', 'py'], ['.rb', 'rb'], ['.rs', 'rs'], ['.go', 'go'], ['.java', 'java'], ['.kt', 'kt'], ['.kts', 'kt'], ['.scala', 'scala'],
  ['.cs', 'cs'], ['.fs', 'fs'], ['.vb', 'vb'], ['.c', 'c'], ['.h', 'c'], ['.cc', 'cpp'], ['.cpp', 'cpp'], ['.cxx', 'cpp'], ['.hpp', 'cpp'], ['.hh', 'cpp'],
  ['.swift', 'swift'], ['.m', 'c'], ['.php', 'php'], ['.lua', 'lua'], ['.pl', 'pl'], ['.r', 'r'], ['.dart', 'dart'], ['.ex', 'ex'], ['.exs', 'ex'],
  ['.sh', 'sh'], ['.bash', 'sh'], ['.zsh', 'sh'], ['.ps1', 'ps1'], ['.psm1', 'ps1'], ['.bat', 'bat'], ['.cmd', 'bat'], ['.sql', 'sql'],
  ['.css', 'css'], ['.scss', 'css'], ['.sass', 'css'], ['.less', 'css'], ['.vue', 'html'], ['.svelte', 'html'], ['.xml', 'xml'], ['.xsd', 'xml'], ['.csproj', 'xml'],
  ['.yaml', 'yaml'], ['.yml', 'yaml'], ['.toml', 'toml'], ['.graphql', 'graphql'], ['.gql', 'graphql'], ['.proto', 'proto'], ['.gradle', 'kt'], ['.tf', 'hcl'], ['.hcl', 'hcl']
]);
const CODE_NAMES = new Map<string, string>([['dockerfile', 'sh'], ['makefile', 'sh'], ['jenkinsfile', 'kt'], ['procfile', 'sh']]);
/**
 * What the default app may be asked to open: documents and images only. Never programs or anything Windows runs (.js, .vbs,
 * .bat, .ps1, .lnk, .hta, ...), and not HTML or SVG either (a browser would run their scripts; the viewer shows them without).
 */
const EXTERNAL_OK = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.odt', '.ods', '.odp', '.rtf',
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export function canOpenExternally(path: string): boolean { return EXTERNAL_OK.has(extname(path).toLowerCase()); }

const slash = (p: string): string => p.replace(/\\/g, '/');

/**
 * Checks a path an agent wrote, the user clicked or dropped, against the allowed roots. Relative paths resolve against `cwd`.
 * A trailing `:line` or `:line:col` (as agents write file references) is dropped when the path itself does not exist.
 * Messages name no path outside the roots: the input may be anything.
 */
export function resolveDocumentPath(raw: unknown, cwd: string, roots: DocumentRoot[]): ResolvedDocument {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024 || /[\0\r\n]/.test(raw)) return refuse('invalid', 'The path is empty or not a plain path.');
  let p = raw.trim();
  if (/^file:/i.test(p)) {
    try { const u = new URL(p); if (u.host) return refuse('invalid', 'Network paths cannot be opened.'); p = fileURLToPath(u); } catch { return refuse('invalid', 'That file address could not be read.'); }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return refuse('invalid', 'Only files can be opened here, not web addresses.');
  if (p.startsWith('\\\\') || p.startsWith('//')) return refuse('invalid', 'Network paths cannot be opened.');
  let abs = resolve(cwd, p);
  if (!existsSync(abs)) {
    const m = /^(.*?):\d+(?::\d+)?$/.exec(p);
    if (m && m[1] && !/^[a-z]$/i.test(m[1])) abs = resolve(cwd, m[1]);
  }
  const ok = roots.filter((r) => {
    if (!r.path) return false;
    if (r.file ? normPath(resolve(r.path)) === normPath(abs) : within(r.path, abs)) return true;
    // The same place under another spelling (a junction, an 8.3 short name such as RUNNER~1): Harbor itself emits canonical paths for
    // documents a lead opens, so they must reopen under a project whose own path is not canonical. The canonical checks below still decide.
    const rr = real(resolve(r.path)), rt = real(abs);
    return !!rr && !!rt && (r.file ? normPath(rr) === normPath(rt) : within(rr, rt));
  });
  if (!ok.length) return refuse('outside', 'Harbor only opens files inside the project, its helpers\' worktrees and Harbor\'s own folders. Use "Open file…" to choose another file.');
  let st;
  try { st = lstatSync(abs); } catch { return refuse('notFound', 'That file does not exist (it may have been moved or deleted).'); }
  if (st.isSymbolicLink()) return refuse('link', 'That file is a link; Harbor does not follow links to files.');
  if (!st.isFile()) return refuse('notFile', 'That is a folder, not a file.');
  const target = real(abs);
  const root = target ? roots.find((r) => {
    if (!r.path) return false;
    const rr = real(resolve(r.path));
    return !!rr && (r.file ? normPath(rr) === normPath(target) : within(rr, target));
  }) : undefined;
  if (!target || !root) return refuse('link', 'That file resolves (through a link or junction) to a place outside the project and Harbor\'s folders.');
  const relPath = root.file ? basename(target) : slash(relative(real(resolve(root.path)) ?? root.path, target));
  if (!reviewable(relPath) || !reviewable(basename(target))) return refuse('credential', 'Harbor never shows credential files (.env, keys, tokens).');
  let full;
  try { full = statSync(target); } catch { return refuse('notFound', 'That file could not be read.'); }
  return { ok: true, path: target, root, relPath: relPath || basename(target), size: full.size, modified: Math.round(full.mtimeMs) };
}

/** UTF-8 (with or without a BOM) or UTF-16 with a BOM; undefined for anything that looks binary. */
export function decodeText(buf: Buffer): string | undefined {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const b = Buffer.from(buf.subarray(2));
    return b.length % 2 ? undefined : b.swap16().toString('utf16le');
  }
  const body = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  if (body.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return undefined; }
}

function head(path: string, n: number): Buffer {
  const fd = openSync(path, 'r');
  try { const b = Buffer.alloc(n); const read = readSync(fd, b, 0, n, 0); return b.subarray(0, read); } finally { closeSync(fd); }
}

/** The kind a file's name suggests, before its bytes are looked at. */
export function kindByName(path: string): { kind: DocumentKind | 'unknown'; language?: string; mime?: string } {
  const name = basename(path).toLowerCase();
  const ext = extname(name);
  if (MARKDOWN.has(ext)) return { kind: 'markdown' };
  if (JSON_EXT.has(ext)) return { kind: 'json', language: 'json' };
  if (CSV.has(ext)) return { kind: 'csv' };
  if (HTML.has(ext)) return { kind: 'html', language: 'html' };
  if (ext === '.svg') return { kind: 'svg', mime: 'image/svg+xml' };
  if (ext === '.pdf') return { kind: 'pdf', mime: 'application/pdf' };
  if (OFFICE.has(ext)) return { kind: 'office' };
  const image = IMAGES.get(ext);
  if (image) return { kind: 'image', mime: image };
  const lang = CODE.get(ext) ?? (ext ? undefined : CODE_NAMES.get(name));
  if (lang) return { kind: 'code', language: lang };
  if (TEXT.has(ext) || name.startsWith('.')) return { kind: 'text' };
  return { kind: 'unknown' };
}

/** Reads a checked file into what the viewer shows. `since` = the `modified` the viewer already has: unchanged files send no content. */
export function readDocument(doc: Extract<ResolvedDocument, { ok: true }>, opts: { since?: number } = {}): DocumentView {
  const base: DocumentView = { path: doc.path, name: basename(doc.path), kind: 'binary', size: doc.size, modified: doc.modified, root: doc.root.kind, relPath: doc.relPath,
    ...(doc.root.agentId ? { agentId: doc.root.agentId } : {}), canOpenExternally: canOpenExternally(doc.path) };
  if (opts.since !== undefined && opts.since === doc.modified) return { ...base, kind: kindOf(doc.path), unchanged: true };
  const byName = kindByName(doc.path);
  if (byName.kind === 'office') return { ...base, kind: 'office', note: 'Office files cannot be previewed in Harbor yet. Open it in its default app.' };
  if (byName.kind === 'pdf') {
    if (doc.size < 5 || !head(doc.path, 5).toString('latin1').startsWith('%PDF-')) return { ...base, note: 'This file is not the PDF its name says.' };
    return { ...base, kind: 'pdf', mime: 'application/pdf', note: 'PDFs cannot be previewed inside Harbor (its security settings block the PDF viewer). Open it in its default app.' };
  }
  if (byName.kind === 'image') {
    if (doc.size > MAX_IMAGE_BYTES) return { ...base, kind: 'tooLarge', note: `This image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.` };
    const data = readFileSync(doc.path);
    if (!looksLikeImage(data, byName.mime!)) return { ...base, note: 'This file is not the image its name says.' };
    return { ...base, kind: 'image', mime: byName.mime, dataUrl: `data:${byName.mime};base64,${data.toString('base64')}` };
  }
  if (doc.size > MAX_TEXT_BYTES) {
    // Too big to read whole; a short look still tells a binary file from a large text file.
    const text = byName.kind !== 'unknown' || decodeText(head(doc.path, SNIFF_BYTES)) !== undefined;
    return text ? { ...base, kind: 'tooLarge', note: `This file is larger than ${MAX_TEXT_BYTES / 1024 / 1024} MB, too large to preview.` } : { ...base, note: 'This is a binary file; Harbor cannot preview it.' };
  }
  const text = decodeText(readFileSync(doc.path));
  if (text === undefined) return { ...base, note: 'This is a binary file (or not UTF-8 text); Harbor cannot preview it.' };
  if (byName.kind === 'svg') {
    if (!/<svg[\s>]/i.test(text)) return { ...base, note: 'This file is not the SVG image its name says.' };
    // As an <img> only: Chromium runs no script and loads nothing external for SVG images, and the CSP allows only data: images.
    return { ...base, kind: 'svg', mime: 'image/svg+xml', dataUrl: `data:image/svg+xml;base64,${Buffer.from(text, 'utf8').toString('base64')}` };
  }
  if (byName.kind === 'html') return { ...base, kind: 'html', language: 'html', text, html: sanitizeHtml(text) };
  if (byName.kind === 'unknown') return { ...base, kind: 'text', text };
  return { ...base, kind: byName.kind, ...(byName.language ? { language: byName.language } : {}), text };
}

/** The kind by name alone (for an unchanged answer, which reads no bytes). */
function kindOf(path: string): DocumentKind {
  const k = kindByName(path).kind;
  return k === 'unknown' ? 'text' : k;
}

/** One call for the service: check, then read. */
export function openDocumentAt(raw: unknown, cwd: string, roots: DocumentRoot[], opts: { since?: number } = {}): DocumentResult {
  const r = resolveDocumentPath(raw, cwd, roots);
  if (!r.ok) return r;
  try { return { ok: true, document: readDocument(r, opts) }; } catch { return refuse('notFound', 'That file could not be read.'); }
}

// ---------------------------------------------------------------- HTML sanitiser (defence in depth; see the header)

/** Injected first in every HTML preview: nothing loads but inline styles and data: images and fonts. */
export const HTML_PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
/** Removed with everything inside them. */
const DROP_WITH_CONTENT = /<(script|iframe|object|applet|frameset|noframes|portal|template|noembed|xmp|math)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
/** Removed as a tag (void or harmless content). */
const DROP_TAG = new Set(['base', 'link', 'meta', 'embed', 'frame', 'param', 'source', 'track', 'audio', 'video', 'form', 'input', 'button', 'select', 'textarea', 'keygen', 'set', 'animate', 'animatemotion', 'animatetransform', 'foreignobject', 'use', 'image', 'feimage']);
const URL_ATTRS = new Set(['src', 'href', 'xlink:href', 'srcset', 'poster', 'background', 'action', 'formaction', 'data', 'codebase', 'cite', 'longdesc', 'manifest', 'ping', 'lowsrc', 'dynsrc', 'usemap', 'profile', 'archive', 'classid', 'itemtype', 'srcdoc']);
const SAFE_IMAGE_DATA = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

function cleanCss(css: string): string {
  // Any url() except an inline raster image, @import and old IE expression()/behaviour hooks go.
  return css.replace(/@import[^;]*;?/gi, '').replace(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, _q, u: string) => (SAFE_IMAGE_DATA.test(u.trim()) ? m : 'none'))
    .replace(/expression\s*\(/gi, 'invalid(').replace(/behavio(u)?r\s*:/gi, 'invalid:').replace(/-moz-binding\s*:/gi, 'invalid:');
}

const escapeAttr = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cleanAttrs(name: string, attrs: string): string {
  const out: string[] = [];
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const m of attrs.matchAll(re)) {
    const key = m[1]!.toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (key.startsWith('on') || key === 'is' || key === 'formtarget' || key === 'target' || key === 'http-equiv') continue;
    if (key === 'style') { out.push(`style="${escapeAttr(cleanCss(value))}"`); continue; }
    if (URL_ATTRS.has(key)) {
      const v = value.trim();
      // In-page anchors stay; images may carry inline raster data. Every other address is dropped (no network, no navigation).
      if (key === 'href' && name === 'a' && v.startsWith('#')) out.push(`href="${escapeAttr(v)}"`);
      else if (key === 'src' && name === 'img' && SAFE_IMAGE_DATA.test(v)) out.push(`src="${escapeAttr(v)}"`);
      else if (key === 'href' && name === 'a' && /^https?:\/\//i.test(v)) out.push(`title="${escapeAttr(v.slice(0, 300))}"`);
      continue;
    }
    if (!/^[a-z][a-z0-9_:.-]*$/.test(key)) continue;
    out.push(m[2] === undefined && m[3] === undefined && m[4] === undefined ? key : `${key}="${escapeAttr(value)}"`);
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

/**
 * A copy of an HTML page that loads nothing and runs nothing even outside a sandbox: scripts, frames, plugins, forms, media,
 * <base>/<link>/<meta>, event handlers, javascript:/remote URLs, CSS url()/@import are removed; a CSP meta is put first.
 */
export function sanitizeHtml(html: string): string {
  let s = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/<\?[\s\S]*?(?:\?>|$)/g, '').replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, '');
  s = s.replace(DROP_WITH_CONTENT, '');
  s = s.replace(/<style\b([^>]*)>([\s\S]*?)(?:<\/style\s*>|$)/gi, (_m, _a, css: string) => `<style>${cleanCss(css).replace(/<\//g, '<\\/')}</style>`);
  s = s.replace(/<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (_m, close: string, rawName: string, attrs: string) => {
    const name = rawName.toLowerCase();
    if (DROP_TAG.has(name)) return '';
    if (close) return `</${name}>`;
    const selfClose = /\/\s*$/.test(attrs) ? ' /' : '';
    return `<${name}${cleanAttrs(name, attrs.replace(/\/\s*$/, ''))}${selfClose}>`;
  });
  // A stray "<script" left by malformed markup (no closing ">") must not survive as the start of a tag.
  s = s.replace(/<(\/?)(script|iframe|object|embed|base|link|meta)\b/gi, '&lt;$1$2');
  return `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"><meta name="referrer" content="no-referrer">${s}`;
}
