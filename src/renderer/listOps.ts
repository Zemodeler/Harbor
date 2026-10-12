// Pure list helpers for event-driven state. Updates keep an item where it is, so the UI does not jump or reorder.

/** Replace the item with the same id in place; otherwise append (for lists with no natural order). */
export function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex(x => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice(); next[i] = item; return next;
}

/** Replace in place; otherwise insert by time, after the last item that is not newer. */
export function upsertByTime<T extends { id: string; time: number }>(list: T[], item: T): T[] {
  const i = list.findIndex(x => x.id === item.id);
  if (i >= 0) { const next = list.slice(); next[i] = item; return next; }
  let j = list.length;
  while (j > 0 && list[j - 1].time > item.time) j--;
  return [...list.slice(0, j), item, ...list.slice(j)];
}

/** A fetched list plus entries that arrived by event while the fetch ran: events are newer, so they win. */
export function mergeFetched<T extends { id: string }>(fetched: T[], live: T[]): T[] {
  if (!live.length) return fetched;
  const byId = new Map(live.map(x => [x.id, x]));
  const merged = fetched.map(x => byId.get(x.id) ?? x);
  const known = new Set(fetched.map(x => x.id));
  return [...merged, ...live.filter(x => !known.has(x.id))];
}

/**
 * Fetched messages combined with cached ones (events seen while loading). The fetched record wins unless the
 * cached text is strictly longer (a streamed delta the fetch did not see yet).
 */
export function mergeMessages<T extends { id: string; text: string; time: number }>(fetched: T[], cached: T[]): T[] {
  const byId = new Map(fetched.map(m => [m.id, m]));
  for (const c of cached) {
    const f = byId.get(c.id);
    if (!f || c.text.length > f.text.length) byId.set(c.id, c);
  }
  // Array.prototype.sort is stable, so equal times keep their fetched order.
  return [...byId.values()].sort((a, b) => a.time - b.time);
}
