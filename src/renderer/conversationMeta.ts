// Conversation tags and palette history are a renderer-side layer: the contract (src/shared/api.ts) has pinned and
// archived but no tags, so tags live in this device's local storage only (see BACKLOG.md "Core requests").

export const MAX_TAGS = 8;
export const TAG_LENGTH = 24;
export interface ConversationMeta { tags: Record<string, string[]>; recent: string[] }
export const emptyMeta: ConversationMeta = { tags: {}, recent: [] };

/** Lower case, no leading '#', spaces become '-', letters/digits/-/_ only. Empty when nothing usable is left. */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').toLocaleLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, TAG_LENGTH);
}
/** "#bug, ui  release" -> ['bug', 'ui', 'release']: commas or spaces separate tags; duplicates and blanks are dropped. */
export function parseTags(input: string): string[] {
  const out: string[] = [];
  for (const part of input.split(/[,\s]+/)) {
    const tag = normalizeTag(part);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}
export function parseMeta(value: string | null): ConversationMeta {
  try {
    const raw: unknown = value ? JSON.parse(value) : null;
    if (!raw || typeof raw !== 'object') return emptyMeta;
    const r = raw as Partial<ConversationMeta>;
    const tags: Record<string, string[]> = {};
    if (r.tags && typeof r.tags === 'object') for (const [id, list] of Object.entries(r.tags)) {
      if (!Array.isArray(list)) continue;
      const clean = parseTags(list.filter(t => typeof t === 'string').join(' '));
      if (clean.length) tags[id] = clean;
    }
    const recent = Array.isArray(r.recent) ? r.recent.filter((x): x is string => typeof x === 'string').slice(0, 8) : [];
    return { tags, recent };
  } catch { return emptyMeta; }
}
/** Tags in use, most used first (ties alphabetical); `ids` limits the count to those conversations. */
export function tagCounts(tags: Record<string, string[]>, ids?: Iterable<string>): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  const keys = ids ? [...ids] : Object.keys(tags);
  for (const id of keys) for (const t of tags[id] || []) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
