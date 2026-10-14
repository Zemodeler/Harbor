// Command palette ranking: pure so it can be tested without rendering. Entries carry data only; the component maps
// an entry id to what it does.

export type PaletteKind = 'action' | 'project' | 'conversation' | 'prompt';
export interface PaletteEntry {
  id: string;
  kind: PaletteKind;
  title: string;
  detail?: string;
  keywords?: string[];
  shortcut?: string;
  disabled?: boolean;
  excerpt?: string;
}
/** `>` limits to commands, `@` to projects, `#` to conversations with that tag; anything else searches everything. */
export type PaletteScope = 'all' | 'actions' | 'projects' | 'tag';
export interface PaletteQuery { scope: PaletteScope; text: string }

export function parseQuery(raw: string): PaletteQuery {
  const q = raw.trimStart();
  if (q.startsWith('>')) return { scope: 'actions', text: q.slice(1).trim() };
  if (q.startsWith('@')) return { scope: 'projects', text: q.slice(1).trim() };
  if (q.startsWith('#')) return { scope: 'tag', text: q.slice(1).trim() };
  return { scope: 'all', text: q.trim() };
}

const fold = (s: string) => s.toLocaleLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const boundary = (t: string, i: number) => i === 0 || !/[\p{L}\p{N}]/u.test(t[i - 1]);

/**
 * How well `query` matches `text` (higher is better), or null for no match. Order: exact, prefix, start of a word,
 * anywhere, every word somewhere, then letters in order (so "nc" finds "New conversation").
 */
export function matchScore(query: string, text: string): number | null {
  const q = fold(query.trim()), t = fold(text);
  if (!q) return 0;
  if (!t) return null;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900 - Math.min(t.length - q.length, 100);
  const at = t.indexOf(q);
  if (at > 0) {
    let i = at;
    while (i >= 0) { if (boundary(t, i)) return 700 - Math.min(i, 100); i = t.indexOf(q, i + 1); }
    return 500 - Math.min(at, 100);
  }
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every(w => t.includes(w))) return 400 - Math.min(t.length, 100);
  if (q.length < 2) return null;
  // Letters in order: reward word starts and runs, punish gaps.
  let score = 200, ti = 0, last = -1;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    if (boundary(t, found)) score += 12;
    if (found === last + 1) score += 6; else score -= Math.min(found - last, 20);
    last = found; ti = found + 1;
  }
  return Math.max(score, 1);
}

/** Best score of an entry: the title counts fully, keywords a little less, the detail line least. */
export function entryScore(entry: PaletteEntry, query: string): number | null {
  const scores = [matchScore(query, entry.title), ...(entry.keywords || []).map(k => matchScore(query, k)).map(s => s === null ? null : s * .7), entry.detail ? (s => s === null ? null : s * .5)(matchScore(query, entry.detail)) : null];
  const best = scores.reduce<number | null>((m, s) => s === null ? m : m === null ? s : Math.max(m, s), null);
  return best;
}

/**
 * Filters and orders entries for a query. Recently used entries get a small boost (and lead when the query is empty);
 * disabled entries sink below enabled ones but stay visible so the user sees why a command is not offered.
 */
export function rankEntries<T extends PaletteEntry>(entries: T[], query: string, opts: { recent?: string[]; limit?: number } = {}): T[] {
  const recent = opts.recent || [];
  const ranked: Array<{ entry: T; score: number; index: number }> = [];
  entries.forEach((entry, index) => {
    const base = entryScore(entry, query);
    if (base === null) return;
    const r = recent.indexOf(entry.id);
    const boost = r < 0 ? 0 : Math.max(60 - r * 8, 10);
    ranked.push({ entry, index, score: base + boost - (entry.disabled ? 2000 : 0) });
  });
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.slice(0, opts.limit ?? ranked.length).map(r => r.entry);
}

/** Most recent first, no duplicates, bounded. */
export function pushRecent(list: string[], id: string, max = 8): string[] {
  return [id, ...list.filter(x => x !== id)].slice(0, max);
}

/** Splits text around case-insensitive matches of `query` for highlighting (first `max` matches). */
export function highlight(text: string, query: string, max = 3): Array<{ text: string; match: boolean }> {
  const q = query.trim();
  if (!q) return [{ text, match: false }];
  const lower = text.toLocaleLowerCase(), needle = q.toLocaleLowerCase();
  const parts: Array<{ text: string; match: boolean }> = [];
  let from = 0, count = 0;
  while (count < max) {
    const at = lower.indexOf(needle, from);
    if (at < 0) break;
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + q.length), match: true });
    from = at + q.length; count++;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts;
}
