import { useSyncExternalStore } from 'react';

/**
 * Renderer-side notification preferences, kept on this device. `inApp` = toasts inside the window; `system` = a
 * Windows notification from this window (Notification API) whose click opens the conversation. The main process has
 * its own basic notification (Settings.desktopNotifications); the UI keeps the two from both being on.
 */
export interface NotificationPrefs { inApp: boolean; system: boolean }
const key = 'harbor.notifications.v1';
const defaults: NotificationPrefs = { inApp: true, system: false };
const listeners = new Set<() => void>();
let cached: NotificationPrefs | undefined;

function read(): NotificationPrefs {
  if (cached) return cached;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) || 'null');
    const r = raw && typeof raw === 'object' ? raw as Partial<NotificationPrefs> : {};
    cached = { inApp: r.inApp !== false, system: r.system === true };
  } catch { cached = defaults; }
  return cached;
}
export function getNotificationPrefs() { return read(); }
export function setNotificationPrefs(patch: Partial<NotificationPrefs>) {
  cached = { ...read(), ...patch };
  try { localStorage.setItem(key, JSON.stringify(cached)); } catch { /* Applies for this session only. */ }
  listeners.forEach(l => l());
}
/** Tests start from a clean store. */
export function resetNotificationPrefs() { cached = undefined; }
export function useNotificationPrefs() {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb); }, read, () => defaults);
}
