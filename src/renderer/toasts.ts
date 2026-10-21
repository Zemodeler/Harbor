// Which Harbor events become a toast. Pure: the hook (hooks/useToasts.ts) feeds it events and remembered states.
import type { Conversation, SessionActivity } from '../shared/api';

export type ToastKind = 'question' | 'finished' | 'failed';
export interface Toast { id: string; kind: ToastKind; title: string; body: string; conversationId?: string; projectId?: string; time: number }
export const MAX_TOASTS = 4;
/** Finished toasts go away by themselves; failures and questions stay until handled or dismissed. */
export const FINISHED_TOAST_MS = 10000;

const RUNNING: Array<SessionActivity['state']> = ['queued', 'working', 'waiting'];

/**
 * A toast for a conversation update, or null. Only a change seen in this window counts (`previous` known): a
 * conversation that was already done or failed when Harbor started is not news.
 */
export function activityToast(previous: SessionActivity['state'] | undefined, c: Conversation, projectName: string, now = Date.now()): Toast | null {
  const next = c.activity?.state;
  if (!previous || !next || previous === next) return null;
  const where = projectName ? `${projectName} · ${c.title}` : c.title;
  if (next === 'done' && RUNNING.includes(previous)) return { id: `finished:${c.id}:${now}`, kind: 'finished', title: 'Finished', body: where, conversationId: c.id, projectId: c.projectId, time: now };
  if (next === 'failed') return { id: `failed:${c.id}:${now}`, kind: 'failed', title: 'Failed', body: c.activity?.detail ? `${where}: ${c.activity.detail}` : where, conversationId: c.id, projectId: c.projectId, time: now };
  return null;
}
export function questionToast(e: { requestId: string; conversationId: string; prompt: string }, title: string | undefined, now = Date.now()): Toast {
  return { id: `question:${e.requestId}`, kind: 'question', title: 'Needs your answer', body: title ? `${title}: ${e.prompt}` : e.prompt, conversationId: e.conversationId, time: now };
}
/** Newest last, one toast per conversation and kind (a newer one replaces the older), at most MAX_TOASTS. */
export function addToast(list: Toast[], t: Toast): Toast[] {
  const rest = list.filter(x => !(x.kind === t.kind && x.conversationId && x.conversationId === t.conversationId) && x.id !== t.id);
  return [...rest, t].slice(-MAX_TOASTS);
}

/** At most this many toasts are drawn; the rest are summarised as "+N more". */
export const MAX_VISIBLE_TOASTS = 3;
/** Exit animation length; the toast is removed after it. */
export const TOAST_LEAVE_MS = 160;
/** Questions and failures need the user, so they win a visible slot over a finished toast. Original order is kept. */
export function visibleToasts(list: Toast[], max = MAX_VISIBLE_TOASTS): { shown: Toast[]; hidden: number } {
  if (list.length <= max) return { shown: list, hidden: 0 };
  const ranked = list.map((t, i) => ({ t, i })).sort((a, b) => (a.t.kind === 'finished' ? 1 : 0) - (b.t.kind === 'finished' ? 1 : 0) || b.i - a.i).slice(0, max);
  const keep = new Set(ranked.map(r => r.t.id));
  return { shown: list.filter(t => keep.has(t.id)), hidden: list.length - max };
}
/**
 * A failure is an alert. A question toast is a status with an assertive live region: the question card in the
 * conversation is already role=alert (tests and screen readers expect one alert per question), so no second one.
 */
export function toastRole(kind: ToastKind): 'alert' | 'status' { return kind === 'failed' ? 'alert' : 'status'; }
export function toastLive(kind: ToastKind): 'assertive' | 'polite' | undefined { return kind === 'question' ? 'assertive' : kind === 'finished' ? 'polite' : undefined; }
/** Time left on an auto-dismiss timer after it ran since `startedAt`; never below a short grace so a resume is not instant. */
export function remainingMs(total: number, startedAt: number, now: number, floor = 1500): number { return Math.max(floor, total - (now - startedAt)); }
