import { closeSync, lstatSync, openSync, readSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

/** Shared, defensive helpers for the chat importers: capped reads, tolerant JSON lines, skip counts. */

export const CHAT_LIMITS = {
  /** A transcript larger than this is read up to here and the rest is reported as skipped. */
  maxFileBytes: 64 * 1024 * 1024,
  /** A single JSON line longer than this is skipped unread (a pasted file, a base64 image). */
  maxLineBytes: 8 * 1024 * 1024,
  maxMessages: 5000,
  maxMessageChars: 100_000,
  /** Account exports: conversations.json may be large; past this it is refused rather than parsed. */
  maxExportBytes: 256 * 1024 * 1024,
  maxListed: 2000
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export { isObj };

/** Counts of what an importer left out, as readable phrases ("12 tool calls", "1 unreadable line"). */
export class Skips {
  private counts = new Map<string, number>();
  add(what: string, n = 1): void { this.counts.set(what, (this.counts.get(what) ?? 0) + n); }
  list(): string[] { return [...this.counts].map(([w, n]) => `${n} ${n === 1 ? w : plural(w)}`); }
}
/** "tool call" -> "tool calls", "line with bad bytes" -> "lines with bad bytes": the noun before a qualifier (or the last word) takes the plural. */
function plural(phrase: string): string {
  const m = / (?:on|from|past|with|in|at|of|by|to|that) |\s\(/.exec(phrase);
  const head = m ? phrase.slice(0, m.index) : phrase, tail = m ? phrase.slice(m.index) : '';
  const word = /(\S+)$/.exec(head)?.[1] ?? head;
  const pl = word.endsWith('s') ? word : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`;
  return `${head.slice(0, head.length - word.length)}${pl}${tail}`;
}

/** The first `max` bytes of a regular file (never a link) and whether it was longer. */
export function readCapped(path: string, max: number): { buf: Buffer; size: number; truncated: boolean } {
  const st = lstatSync(path);
  if (!st.isFile()) throw new Error('not a regular file');
  const size = Math.min(st.size, max);
  const buf = Buffer.alloc(size);
  const fd = openSync(path, 'r');
  try {
    let off = 0;
    while (off < size) { const n = readSync(fd, buf, off, size - off, off); if (n <= 0) break; off += n; }
    return { buf: off === size ? buf : buf.subarray(0, off), size: st.size, truncated: st.size > max };
  } finally { closeSync(fd); }
}

const strict = new TextDecoder('utf-8', { fatal: true });
const loose = new TextDecoder('utf-8');

/** UTF-8 text (BOM dropped); invalid bytes are replaced and reported instead of failing the whole file. */
export function decodeUtf8(buf: Buffer, skips?: Skips, what = 'line with invalid UTF-8 (shown with replacement characters)'): string {
  try { return strict.decode(buf).replace(/^﻿/, ''); } catch { skips?.add(what); return loose.decode(buf).replace(/^﻿/, ''); }
}

/**
 * Each JSON line of a .jsonl buffer as a value. Bad JSON, over-long lines and a cut-off last line are counted in `skips`, never
 * thrown. Deep nesting that overflows the parser counts as an unreadable line.
 */
export function* jsonLines(buf: Buffer, skips: Skips, truncated: boolean): Generator<unknown> {
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    const last = end < 0;
    if (last) end = buf.length;
    const len = end - start;
    if (len > CHAT_LIMITS.maxLineBytes) skips.add('over-long line');
    else if (len > 0) {
      const text = decodeUtf8(buf.subarray(start, end), skips).trim();
      if (text) {
        let v: unknown;
        try { v = JSON.parse(text); } catch { skips.add(last && truncated ? 'cut-off line at the end (the file was larger than Harbor reads)' : last ? 'cut-off line at the end (truncated file)' : 'unreadable line'); v = undefined; }
        if (v !== undefined) yield v;
      }
    }
    start = end + 1;
  }
}

/** Epoch ms from an ISO string, epoch seconds or epoch ms; undefined when it is not a plausible time. */
export function parseTime(v: unknown): number | undefined {
  let t: number | undefined;
  if (typeof v === 'number' && Number.isFinite(v)) t = v < 1e11 ? v * 1000 : v;
  else if (typeof v === 'string' && v.length <= 40) { const p = Date.parse(v); t = Number.isFinite(p) ? p : undefined; }
  return t !== undefined && t > 0 && t < 4102444800000 ? Math.round(t) : undefined;
}

/** A message text kept within the cap; the cut is reported. */
export function clipMessage(text: string, skips: Skips): string {
  if (text.length <= CHAT_LIMITS.maxMessageChars) return text;
  skips.add('message cut to the length limit');
  return `${text.slice(0, CHAT_LIMITS.maxMessageChars)}\n[… shortened by Harbor on import]`;
}

/** A short title from the first words of a text. */
export function titleFrom(text: string | undefined, fallback: string): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return fallback;
  return t.length > 70 ? `${t.slice(0, 69)}…` : t;
}

/** Directory entries that are plain folders or files (links, junctions and special files are never followed or read). */
export function plainEntries(dir: string): Dirent[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter((e) => !e.isSymbolicLink() && (e.isDirectory() || e.isFile())); } catch { return []; }
}

export function statOf(path: string): { size: number; mtime: number } | undefined {
  try { const s = lstatSync(path); return s.isFile() ? { size: s.size, mtime: s.mtimeMs } : undefined; } catch { return undefined; }
}

export const joinPath = join;

/** `home` replaced by ~ for display. */
export function tildify(p: string, home?: string): string {
  if (!home || home.length < 4) return p;
  return p.toLowerCase().startsWith(home.toLowerCase()) ? `~${p.slice(home.length)}` : p;
}
