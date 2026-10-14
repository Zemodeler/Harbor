import { copyFileSync, lstatSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Attachment } from '../shared/api';
import { newId, normPath } from './store';
import type { AppDocument } from './windowSecurity';

/**
 * Images Harbor keeps for a conversation (plan section 4.3): the attachments folder, the `harbor-file://` URLs the renderer shows
 * them with, and the checks for an image an agent asks to show (HARBOR_SHOW_IMAGE). Pure functions over the file system so the
 * path guards are testable without Electron; index.ts registers the protocol and only calls resolveHarborFile.
 */

export const HARBOR_FILE_SCHEME = 'harbor-file';
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Names Harbor itself writes into the attachments folder: `<id>.<ext>`. Anything else there is never served. */
const STORED_NAME = /^[A-Za-z0-9_-]{1,80}\.(png|jpg|jpeg|gif|webp)$/i;
// A Map, not an object: an extension such as ".constructor" must never match an inherited property.
const MIME_BY_EXT = new Map<string, string>([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'], ['.webp', 'image/webp']]);
/** An image an agent shows is copied into Harbor's folder; past this it is refused rather than copied. */
export const MAX_SHOWN_IMAGE_BYTES = 10 * 1024 * 1024;

/** `<data>/attachments/<conversationId>`; refuses ids that are not plain tokens and paths that would leave the attachments folder. */
export function attachmentDir(dataRoot: string, conversationId: string): string {
  if (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId)) throw new Error('Invalid conversation id.');
  const root = resolve(dataRoot, 'attachments');
  const dir = resolve(root, conversationId);
  const rel = relative(root, dir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid conversation id.');
  return dir;
}

/** The URL the renderer shows a stored image with; the folder's own name is the conversation id. */
export function attachmentUrl(dir: string, file: string): string {
  return `${HARBOR_FILE_SCHEME}://attachments/${encodeURIComponent(basename(dir))}/${encodeURIComponent(basename(file))}`;
}

/** The URL of a stored attachment path, when it is a file Harbor wrote under `<data>/attachments/<conversation>/`; otherwise undefined. */
export function urlForStoredPath(dataRoot: string, path: string | undefined): string | undefined {
  if (!path) return undefined;
  const rel = relative(resolve(dataRoot, 'attachments'), resolve(path));
  const parts = rel.split(/[\\/]/);
  if (parts.length !== 2 || rel.startsWith('..') || isAbsolute(rel) || !CONVERSATION_ID.test(parts[0]!) || !STORED_NAME.test(parts[1]!)) return undefined;
  return `${HARBOR_FILE_SCHEME}://attachments/${parts[0]}/${parts[1]}`;
}

export function imageMime(path: string): string | undefined { return MIME_BY_EXT.get(extname(path).toLowerCase()); }

/** The file starts like the image type its extension claims (a renamed script or HTML page is not shown as an image). */
export function looksLikeImage(data: Buffer, mime: string): boolean {
  if (mime === 'image/png') return data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/jpeg') return data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mime === 'image/gif') return data.length > 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString('latin1'));
  if (mime === 'image/webp') return data.length > 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

/** True when `child` is `root` itself or inside it (Windows paths compared case-insensitively). */
export function within(root: string, child: string): boolean {
  const r = normPath(resolve(root)), c = normPath(resolve(child));
  return c === r || c.startsWith(`${r}/`);
}

/** The real path (after links and junctions), or undefined when it cannot be resolved. */
export function real(p: string): string | undefined { try { return realpathSync.native(p); } catch { return undefined; } }

/**
 * The file a `harbor-file://attachments/<conversationId>/<name>` URL names, or undefined. Only files Harbor wrote under its own
 * attachments folder are served: one conversation folder, one stored name, no encoded separators or dots, and the real path
 * (after links and junctions) must still be inside the real attachments folder.
 */
export function resolveHarborFile(dataRoot: string, url: string): { path: string; mime: string } | undefined {
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  if (u.protocol !== `${HARBOR_FILE_SCHEME}:` || u.hostname !== 'attachments' || u.username || u.password || u.port || u.search || u.hash) return undefined;
  // Raw pathname: an encoded character (%2e, %2f, %5c) is refused outright instead of being decoded into something else.
  if (/[%\\]/.test(u.pathname)) return undefined;
  const parts = u.pathname.split('/');
  if (parts.length !== 3 || parts[0] !== '') return undefined;
  const [, conversationId, name] = parts as [string, string, string];
  if (!STORED_NAME.test(name)) return undefined;
  let dir: string;
  try { dir = attachmentDir(dataRoot, conversationId); } catch { return undefined; }
  const file = join(dir, name);
  const root = real(resolve(dataRoot, 'attachments'));
  const target = real(file);
  if (!root || !target || !within(root, target)) return undefined;
  try { if (!statSync(target).isFile()) return undefined; } catch { return undefined; }
  const mime = imageMime(name);
  return mime ? { path: target, mime } : undefined;
}

/**
 * Whether a harbor-file request may be answered: requests the browser starts itself carry no initiator; web content must be
 * Harbor's own document (the packaged file:// page reports "file://" or an opaque "null" origin, the dev server its own origin).
 */
export function harborFileRequestAllowed(initiatorOrigin: string | undefined, doc: AppDocument): boolean {
  if (initiatorOrigin === undefined || initiatorOrigin === '') return true;
  if (doc.kind === 'dev') return initiatorOrigin === doc.origin;
  return initiatorOrigin === 'file://' || initiatorOrigin === 'null';
}

/** A PNG Harbor captured, written as `<dir>/<id>.png`. The bytes are checked to be a PNG first. */
export function savePng(dir: string, data: Buffer, name: string, origin: Attachment['origin']): Attachment {
  if (!looksLikeImage(data, 'image/png')) throw new Error('The capture is not a PNG image.');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${newId()}.png`);
  writeFileSync(path, data);
  return { name, mime: 'image/png', path, url: attachmentUrl(dir, path), origin };
}

export type ShownImage = { path: string; mime: string; bytes: number } | { error: string };

/**
 * The image an agent's HARBOR_SHOW_IMAGE line names, checked: relative paths resolve against the agent's working folder; the file
 * (and, after links and junctions, its real path) must be inside one of `roots` (the project folder, the agent's worktree); it must
 * be a PNG, JPEG, GIF or WebP whose bytes match, and at most 10 MB. Errors are short and name no outside path.
 */
export function resolveShownImage(raw: string, cwd: string, roots: string[], read: (p: string) => Buffer): ShownImage {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024 || /[\0\r\n]/.test(raw)) return { error: 'the path is empty or not a plain path' };
  const trimmed = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('\\\\') || trimmed.startsWith('//')) return { error: 'only files inside the project can be shown (no URLs or network paths)' };
  const abs = resolve(cwd, trimmed);
  const okRoots = roots.filter(Boolean);
  if (!okRoots.some((r) => within(resolve(r), abs))) return { error: 'the file is outside the project and the agent\'s worktree' };
  const mime = imageMime(abs);
  if (!mime) return { error: 'only PNG, JPEG, GIF and WebP images can be shown' };
  let st;
  try { st = lstatSync(abs); } catch { return { error: 'the file does not exist' }; }
  if (st.isSymbolicLink()) return { error: 'the file is a link' };
  if (!st.isFile()) return { error: 'it is not a file' };
  const target = real(abs);
  if (!target || !okRoots.some((r) => { const rr = real(resolve(r)); return !!rr && within(rr, target); })) return { error: 'the file resolves outside the project and the agent\'s worktree' };
  if (st.size > MAX_SHOWN_IMAGE_BYTES) return { error: 'the image is larger than 10 MB' };
  if (st.size === 0) return { error: 'the file is empty' };
  let head: Buffer;
  try { head = read(target); } catch { return { error: 'the file could not be read' }; }
  if (!looksLikeImage(head, mime)) return { error: 'the file is not the image its name says' };
  return { path: target, mime, bytes: st.size };
}

/** Copies a checked image into the conversation's attachments folder (the original in the project is never touched again). */
export function copyShownImage(dir: string, src: { path: string; mime: string }, origin: Attachment['origin'] = 'agent'): Attachment {
  const ext = src.mime === 'image/jpeg' ? 'jpg' : src.mime.slice('image/'.length);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${newId()}.${ext}`);
  copyFileSync(src.path, path);
  return { name: basename(src.path).slice(0, 120), mime: src.mime, path, url: attachmentUrl(dir, path), origin };
}
