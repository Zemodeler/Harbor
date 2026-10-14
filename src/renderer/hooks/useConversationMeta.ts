import { useCallback, useEffect, useRef, useState } from 'react';
import { parseMeta, parseTags, type ConversationMeta } from '../conversationMeta';
import { pushRecent } from '../palette';

const key = 'harbor.conversationMeta.v1';

/** Tags per conversation and recently used palette entries, kept on this device (not in Harbor's store). */
export function useConversationMeta() {
  const [meta, setMeta] = useState<ConversationMeta>(() => { try { return parseMeta(localStorage.getItem(key)); } catch { return parseMeta(null); } });
  const [saveError, setSaveError] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    try { localStorage.setItem(key, JSON.stringify(meta)); setSaveError(false); } catch { setSaveError(true); }
  }, [meta]);
  const setTags = useCallback((conversationId: string, tags: string[] | string) => setMeta(m => {
    const clean = parseTags(Array.isArray(tags) ? tags.join(' ') : tags);
    const { [conversationId]: _, ...rest } = m.tags;
    return { ...m, tags: clean.length ? { ...rest, [conversationId]: clean } : rest };
  }), []);
  const forget = useCallback((conversationId: string) => setMeta(m => conversationId in m.tags ? { ...m, tags: Object.fromEntries(Object.entries(m.tags).filter(([k]) => k !== conversationId)) } : m), []);
  const used = useCallback((entryId: string) => setMeta(m => ({ ...m, recent: pushRecent(m.recent, entryId) })), []);
  return { tags: meta.tags, recent: meta.recent, setTags, forget, used, saveError };
}
export type ConversationMetaState = ReturnType<typeof useConversationMeta>;
