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
  useEffect(() => {
    const save = () => { try { localStorage.setItem(key, JSON.stringify(current.current)); setSaveError(false); } catch { setSaveError(true); } };
    const timer = setTimeout(save, 120);
    window.addEventListener('pagehide', save);
    return () => { clearTimeout(timer); window.removeEventListener('pagehide', save); try { localStorage.setItem(key, JSON.stringify(current.current)); } catch { /* The next save reports the failure. */ } };
  }, [preferences]);
  useEffect(() => { document.documentElement.dataset.textSize = preferences.textSize; document.documentElement.dataset.density = preferences.density; }, [preferences.textSize, preferences.density]);
  const setDraft = (id: string, text: string | ((current: string) => string)) => setPreferences(p => ({ ...p, drafts: { ...p.drafts, [id]: typeof text === 'function' ? text(p.drafts[id] || '') : text } }));
  const setQueue = (id: string, items: QueuedPrompt[] | ((current: QueuedPrompt[]) => QueuedPrompt[])) => setPreferences(p => ({ ...p, queue: { ...p.queue, [id]: typeof items === 'function' ? items(p.queue[id] || []) : items } }));
  return { preferences, setPreferences, setDraft, setQueue, saveError };
}
export type WorkspaceState = ReturnType<typeof useWorkspace>;
