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
