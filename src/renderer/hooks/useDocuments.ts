import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Conversation, DocumentResult, HarborApi, HarborEvent } from '../../shared/api';

/** The viewer re-checks the shown file this often (a cheap stat in main; content only moves when the file changed). */
export const DOCUMENT_POLL_MS = 2000;
export const MAX_DOCUMENT_TABS = 12;

export interface DocTab {
  key: string;
  /** What was asked for (a refusal keeps it so "Try again" can repeat it). */
  request: { path: string; agentId?: string };
  title?: string;
  result?: DocumentResult;
  loading: boolean;
  /** The call itself failed (not a refusal): a message for the tab. */
  error?: string;
  /** The file disappeared or became unreadable after it was shown. */
  gone?: string;
}

const message = (e: unknown, fallback: string) => e instanceof Error && e.message ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback;

/**
 * Tabs of the document viewer for the open project. Opens on clicks (paths in messages, changed files, the Git panel), drops,
 * Ctrl+K and an agent's `document` event for the conversation on screen. The active tab follows file changes by polling with
 * `since`, only while the window is visible.
 */
export function useDocuments(api: HarborApi, projectId: string, conversation: Conversation | undefined, agents: Agent[], request?: { seq: number; event: Extract<HarborEvent, { type: 'document' }> }) {
  const [tabs, setTabs] = useState<DocTab[]>([]);
  const [active, setActive] = useState<string>();
  const [hidden, setHidden] = useState(false);
  const live = useRef({ projectId, conversationId: conversation?.id, agents });
  live.current = { projectId, conversationId: conversation?.id, agents };
  const supported = !!api.openDocument;

  // Tabs belong to one project.
  useEffect(() => { setTabs([]); setActive(undefined); setHidden(false); }, [projectId]);

  const put = useCallback((tab: DocTab, focus: boolean, replaceKey?: string) => {
    setTabs(ts => {
      const rest = ts.filter(t => t.key !== tab.key && t.key !== replaceKey);
      const at = ts.findIndex(t => t.key === tab.key || t.key === replaceKey);
      const next = at >= 0 ? [...rest.slice(0, at), tab, ...rest.slice(at)] : [...rest, tab];
      return next.slice(-MAX_DOCUMENT_TABS);
    });
    if (focus) { setActive(tab.key); setHidden(false); }
  }, []);

  const show = useCallback(async (request: { path: string; agentId?: string }, opts: { title?: string; focus?: boolean } = {}) => {
    const focus = opts.focus !== false;
    const pid = live.current.projectId;
    if (!pid) return;
    const pendingKey = `pending:${request.path}`;
    if (!api.openDocument) { put({ key: pendingKey, request, title: opts.title, loading: false, error: 'The document viewer is available in the desktop app.' }, focus); return; }
    put({ key: pendingKey, request, title: opts.title, loading: true }, focus);
    try {
      const result = await api.openDocument(pid, request.path, request.agentId ? { agentId: request.agentId } : undefined);
      if (live.current.projectId !== pid) return;
      // One tab per real file, however it was reached (relative path, absolute path, a click in another message).
      const key = result.ok ? `doc:${result.document.path.toLowerCase()}` : `refused:${request.path}`;
      put({ key, request: result.ok ? { path: result.document.path, ...(request.agentId ? { agentId: request.agentId } : {}) } : request, title: opts.title, result, loading: false }, focus, pendingKey);
    } catch (e) {
      if (live.current.projectId !== pid) return;
      put({ key: pendingKey, request, title: opts.title, loading: false, error: message(e, 'The file could not be opened.') }, focus);
    }
  }, [api, put]);

  const open = useCallback((path: string, opts: { agentId?: string; title?: string } = {}) => {
    void show({ path, ...(opts.agentId ? { agentId: opts.agentId } : {}) }, { title: opts.title });
  }, [show]);

  const pick = useCallback(async () => {
    const pid = live.current.projectId;
    if (!pid) return;
    if (!api.pickDocument) { put({ key: 'pending:pick', request: { path: '' }, loading: false, error: 'Choosing a file is available in the desktop app.' }, true); return; }
    try {
      const result = await api.pickDocument(pid);
      if (!result || live.current.projectId !== pid) return;
      const key = result.ok ? `doc:${result.document.path.toLowerCase()}` : 'refused:picked';
      put({ key, request: { path: result.ok ? result.document.path : '' }, result, loading: false }, true);
    } catch (e) { put({ key: 'pending:pick', request: { path: '' }, loading: false, error: message(e, 'The file could not be opened.') }, true); }
  }, [api, put]);

  /** A tab that only explains why nothing could be opened (for example a dropped file that has no local path). */
  const report = useCallback((name: string, error: string) => {
    put({ key: `pending:${name}`, request: { path: '' }, title: name, loading: false, error }, true);
  }, [put]);

  const close = useCallback((key: string) => {
    setTabs(ts => {
      const i = ts.findIndex(t => t.key === key);
      const next = ts.filter(t => t.key !== key);
      setActive(a => a === key ? next[Math.min(i, next.length - 1)]?.key : a);
      return next;
    });
  }, []);

  const reload = useCallback((key: string) => {
    const tab = tabs.find(t => t.key === key);
    if (tab && tab.request.path) void show(tab.request, { title: tab.title });
  }, [tabs, show]);

  // An agent's HARBOR_OPEN_DOCUMENT: opened when it belongs to the conversation on screen (its lead or one of its helpers).
  // useHarbor holds the one event subscription and hands the latest request over (seq changes for every event).
  const seen = useRef(request?.seq ?? 0);
  useEffect(() => {
    if (!request || request.seq === seen.current) return;
    seen.current = request.seq;
    const e = request.event;
    const { projectId: pid, conversationId: cid, agents: list } = live.current;
    if (e.projectId !== pid || !cid) return;
    const helper = e.agentId ? list.find(a => a.id === e.agentId) : undefined;
    if (e.conversationId !== cid && helper?.conversationId !== cid) return;
    void show({ path: e.path, ...(e.agentId ? { agentId: e.agentId } : {}) }, { title: e.title });
  }, [request, show]);

  // Refresh on change: the visible tab only, only while Harbor is visible; `since` makes an unchanged file cost one stat.
  const current = tabs.find(t => t.key === active);
  const watched = current?.result?.ok && !hidden ? current : undefined;
  const watchKey = watched?.result?.ok ? `${watched.key}|${watched.result.document.modified}` : undefined;
  useEffect(() => {
    if (!watched || !api.openDocument || !watched.result?.ok) return;
    const pid = projectId, doc = watched.result.document, key = watched.key;
    let stopped = false;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void api.openDocument!(pid, doc.path, { ...(watched.request.agentId ? { agentId: watched.request.agentId } : {}), since: doc.modified }).then(r => {
        if (stopped) return;
        if (r.ok && r.document.unchanged) return;
        setTabs(ts => ts.map(t => t.key !== key ? t : r.ok ? { ...t, result: r, gone: undefined } : { ...t, gone: r.message }));
      }).catch(() => { /* a failed check is retried on the next tick */ });
    }, DOCUMENT_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [watchKey, api, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => ({ supported, tabs, active: current, activeKey: active, setActive, open, pick, report, close, reload, hidden, hide: () => setHidden(true), unhide: () => setHidden(false) }),
    [supported, tabs, current, active, open, pick, report, close, reload, hidden]);
}
export type DocumentsState = ReturnType<typeof useDocuments>;
