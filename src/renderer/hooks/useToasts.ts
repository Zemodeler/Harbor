import { useCallback, useEffect, useRef, useState } from 'react';
import type { Conversation, HarborEvent, SessionActivity } from '../../shared/api';
import type { HarborState } from './useHarbor';
import { activityToast, addToast, FINISHED_TOAST_MS, questionToast, remainingMs, TOAST_LEAVE_MS, type Toast } from '../toasts';
import { getNotificationPrefs } from '../notificationPrefs';

const focused = () => typeof document.hasFocus !== 'function' || document.hasFocus();

/**
 * Toasts for "needs your answer", "finished" and "failed". It keeps its own event subscription because useHarbor only
 * keeps the open project's conversations, and a session in another project finishing is exactly what a toast is for.
 * Nothing is shown for the conversation on screen while the window has focus: the user sees it already.
 */
export function useToasts(state: HarborState) {
  const { api } = state;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const states = useRef(new Map<string, SessionActivity['state'] | undefined>());
  const known = useRef(new Map<string, Conversation>());
  const names = useRef(new Map<string, string>());
  const openId = useRef('');
  const [leaving, setLeaving] = useState<string[]>([]);
  const timers = useRef(new Map<string, { h?: ReturnType<typeof setTimeout>; total: number; at: number }>());
  const exits = useRef(new Set<ReturnType<typeof setTimeout>>());
  openId.current = state.conversation?.id || '';
  // Main already notifies when Settings.desktopNotifications is on: never send a second Windows notification.
  const basicOn = useRef(false); basicOn.current = state.settings?.desktopNotifications === true;
  state.projects.forEach(p => names.current.set(p.id, p.name));
  // Conversations loaded by useHarbor give each one a starting state, so the first event after a start is compared
  // with what was on screen rather than treated as news.
  useEffect(() => {
    for (const c of state.conversations) {
      known.current.set(c.id, c);
      if (!states.current.has(c.id)) states.current.set(c.id, c.activity?.state);
    }
  }, [state.conversations]);
  const remove = useCallback((id: string) => {
    setToasts(ts => ts.filter(t => t.id !== id)); setLeaving(l => l.filter(x => x !== id));
  }, []);
  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id); if (timer?.h) clearTimeout(timer.h); timers.current.delete(id);
    // jsdom (and old engines) have no Web Animations; reduced motion wants no exit either: remove at once.
    const animates = typeof document.body.getAnimations === 'function' && !(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    if (!animates) { remove(id); return; }
    setLeaving(l => l.includes(id) ? l : [...l, id]);
    const h = setTimeout(() => { exits.current.delete(h); remove(id); }, TOAST_LEAVE_MS);
    exits.current.add(h);
  }, [remove]);
  const arm = useCallback((id: string, ms: number) => {
    timers.current.set(id, { h: setTimeout(() => dismiss(id), ms), total: ms, at: Date.now() });
  }, [dismiss]);
  /** Hover or keyboard focus on a toast stops its auto-dismiss clock so it can be read and clicked. */
  const pause = useCallback((id: string) => {
    const t = timers.current.get(id); if (!t) return;
    if (!t.h) return; clearTimeout(t.h); timers.current.set(id, { ...t, h: undefined, total: remainingMs(t.total, t.at, Date.now()) });
  }, []);
  const resume = useCallback((id: string) => {
    const t = timers.current.get(id); if (t && !t.h) arm(id, t.total);
  }, [arm]);
  const openRef = useRef(state.openConversation); openRef.current = state.openConversation;
  /** Opens the toast's conversation, looking it up across projects when this window never loaded it. */
  const open = useCallback(async (t: Toast) => {
    dismiss(t.id);
    if (!t.conversationId) return;
    let c = known.current.get(t.conversationId);
    if (!c) {
      for (const pid of names.current.keys()) {
        try { c = (await api.listConversations(pid)).find(x => x.id === t.conversationId); } catch { /* try the next project */ }
        if (c) break;
      }
    }
    if (c) await openRef.current(c);
  }, [api, dismiss]);
  const show = useCallback((t: Toast) => {
    const prefs = getNotificationPrefs();
    if (prefs.inApp) {
      setToasts(ts => addToast(ts, t));
      if (t.kind === 'finished') arm(t.id, FINISHED_TOAST_MS);
    }
    // A Windows notification only when the window is in the background (otherwise the toast is enough).
    if (prefs.system && !basicOn.current && !focused() && typeof Notification === 'function' && Notification.permission === 'granted') {
      try {
        const n = new Notification(`Harbor: ${t.title}`, { body: t.body, tag: t.id, silent: t.kind === 'finished' });
        n.onclick = () => { window.focus(); n.close(); void open(t); };
      } catch { /* Notifications unavailable: the in-app toast still shows. */ }
    }
  }, [arm, open]);
  useEffect(() => api.onEvent((e: HarborEvent) => {
    if (e.type === 'conversation') {
      const c = e.conversation;
      const previous = states.current.get(c.id);
      states.current.set(c.id, c.activity?.state);
      known.current.set(c.id, c);
      if (c.id === openId.current && focused()) return;
      const t = activityToast(previous, c, names.current.get(c.projectId) || '');
      if (t) show(t);
    }
    if (e.type === 'question') {
      if (e.conversationId === openId.current && focused()) return;
      show(questionToast(e, known.current.get(e.conversationId)?.title));
    }
  }), [api, show]);
  // A question that was answered (or dropped as moot) no longer needs its toast.
  const questionIds = state.questions.map(q => q.requestId).join('\n');
  useEffect(() => {
    const live = new Set(questionIds.split('\n'));
    setToasts(ts => ts.some(t => t.kind === 'question' && !live.has(t.id.slice(9))) ? ts.filter(t => t.kind !== 'question' || live.has(t.id.slice(9))) : ts);
  }, [questionIds]);
  useEffect(() => () => { timers.current.forEach(t => { if (t.h) clearTimeout(t.h); }); exits.current.forEach(clearTimeout); }, []);
  return { toasts, leaving, dismiss, open, pause, resume };
}
export type ToastState = ReturnType<typeof useToasts>;
