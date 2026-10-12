import { useEffect, useRef, useState } from 'react';

export interface QueuedPrompt { id: string; text: string; paused?: boolean }
export interface PromptTemplate { id: string; title: string; text: string }
export interface WorkspacePreferences {
  drafts: Record<string, string>;
  queue: Record<string, QueuedPrompt[]>;
  templates: PromptTemplate[];
  textSize: 'standard' | 'large';
  density: 'comfortable' | 'compact';
}
const key = 'harbor.workspace.v1';
const empty: WorkspacePreferences = { drafts: {}, queue: {}, templates: [], textSize: 'standard', density: 'comfortable' };
function load(): WorkspacePreferences {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) || 'null');
    if (!parsed || typeof parsed !== 'object') return empty;
    const raw = parsed as Partial<WorkspacePreferences>;
    const drafts = Object.fromEntries(Object.entries(raw.drafts || {}).filter(([, v]) => typeof v === 'string'));
    const queue = Object.fromEntries(Object.entries(raw.queue || {}).filter(([, v]) => Array.isArray(v)).map(([id, items]) => [id, items.filter(i => i && typeof i.id === 'string' && typeof i.text === 'string').map(i => ({ ...i, paused: true }))]));
    const templates = Array.isArray(raw.templates) ? raw.templates.filter(t => t && typeof t.id === 'string' && typeof t.title === 'string' && typeof t.text === 'string') : [];
    return { drafts, queue, templates, textSize: raw.textSize === 'large' ? 'large' : 'standard', density: raw.density === 'compact' ? 'compact' : 'comfortable' };
  } catch { return empty; }
}
export function useWorkspace() {
  const [preferences, setPreferences] = useState(load);
  const [saveError, setSaveError] = useState(false);
  const current = useRef(preferences);
  current.current = preferences;
  // Saving is debounced (drafts change often) and writes after typing pauses; the final state is always written on
  // pagehide and on unmount, so nothing is lost and not every change stringifies all drafts.
  useEffect(() => {
    const timer = setTimeout(() => { try { localStorage.setItem(key, JSON.stringify(current.current)); setSaveError(false); } catch { setSaveError(true); } }, 300);
    return () => clearTimeout(timer);
  }, [preferences]);
  useEffect(() => {
    const flush = () => { try { localStorage.setItem(key, JSON.stringify(current.current)); } catch { /* The next save reports the failure. */ } };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, []);
  useEffect(() => { document.documentElement.dataset.textSize = preferences.textSize; document.documentElement.dataset.density = preferences.density; }, [preferences.textSize, preferences.density]);
  const setDraft = (id: string, text: string | ((current: string) => string)) => setPreferences(p => ({ ...p, drafts: { ...p.drafts, [id]: typeof text === 'function' ? text(p.drafts[id] || '') : text } }));
  const setQueue = (id: string, items: QueuedPrompt[] | ((current: QueuedPrompt[]) => QueuedPrompt[])) => setPreferences(p => ({ ...p, queue: { ...p.queue, [id]: typeof items === 'function' ? items(p.queue[id] || []) : items } }));
  /** Prune what was stored for a deleted conversation. */
  const forgetConversation = (id: string) => setPreferences(p => id in p.drafts || id in p.queue
    ? { ...p, drafts: Object.fromEntries(Object.entries(p.drafts).filter(([k]) => k !== id)), queue: Object.fromEntries(Object.entries(p.queue).filter(([k]) => k !== id)) } : p);
  return { preferences, setPreferences, setDraft, setQueue, forgetConversation, saveError };
}
export type WorkspaceState = ReturnType<typeof useWorkspace>;
