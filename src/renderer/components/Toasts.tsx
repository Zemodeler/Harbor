import { Tooltip } from './ui/Tooltip';
import { OVERLAY_OPENED } from './ui/overlayEvents';
import { useEffect, useRef } from 'react';
import type { ToastState } from '../hooks/useToasts';
import { visibleToasts, toastLive, toastRole, type ToastKind } from '../toasts';
import { CloseIcon, DoneIcon, QuestionIcon, WarningIcon } from './Icons';
import n from './Navigation.module.css';

const ICONS: Record<ToastKind, typeof DoneIcon> = { finished: DoneIcon, question: QuestionIcon, failed: WarningIcon };

/**
 * Notifications never take focus; their buttons are reachable with Tab and named after the toast. The region is a manual
 * popover so it lives in the top layer and stays above an open modal dialog. Failures are role=alert, questions an assertive
 * status, finished toasts a polite status; the region itself is not a live region so nothing is announced twice.
 */
export function Toasts({ toasts }: { toasts: ToastState }) {
  const ref = useRef<HTMLElement>(null);
  const { shown, hidden } = visibleToasts(toasts.toasts);
  const any = shown.length > 0;
  useEffect(() => {
    const el = ref.current;
    // jsdom and old engines have no Popover API: the fixed-position fallback in CSS still shows the toasts.
    if (!el || typeof el.showPopover !== 'function') return;
    try { if (any) el.showPopover(); else el.hidePopover(); } catch { /* already in that state */ }
  }, [any]);
  // The top layer stacks in the order things were shown, so a dialog opened later would cover the toasts: re-show on every dialog open.
  useEffect(() => {
    const raise = () => {
      const el = ref.current;
      if (!el || typeof el.showPopover !== 'function' || !el.matches(':popover-open')) return;
      try { el.hidePopover(); el.showPopover(); } catch { /* not showing */ }
    };
    document.addEventListener(OVERLAY_OPENED, raise);
    return () => document.removeEventListener(OVERLAY_OPENED, raise);
  }, []);
  return <section ref={ref} className={n.toastRegion} aria-label="Notifications" popover="manual" data-empty={any ? undefined : ''}>
    {shown.map(t => {
      const Icon = ICONS[t.kind];
      const leave = toasts.leaving.includes(t.id);
      return <div key={t.id} className={n.toast} data-kind={t.kind} data-leaving={leave ? '' : undefined} role={toastRole(t.kind)} aria-live={toastLive(t.kind)}
        onPointerEnter={() => toasts.pause(t.id)} onPointerLeave={() => toasts.resume(t.id)}
        onFocus={() => toasts.pause(t.id)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) toasts.resume(t.id); }}>
        <span className={n.toastIcon} aria-hidden="true"><Icon size={18} weight="fill" /></span>
        <div className={n.toastText}><strong>{t.title}</strong><p>{t.body}</p>
          {t.conversationId ? <div className={n.toastActions}>
            <button onClick={() => void toasts.open(t)} aria-label={`${t.kind === 'question' ? 'Answer' : 'Open conversation'}: ${t.body}`}>{t.kind === 'question' ? 'Answer' : 'Open conversation'}</button>
          </div> : null}
        </div>
        <Tooltip text="Dismiss" side="bottom"><button className={n.toastClose} onClick={() => toasts.dismiss(t.id)} aria-label={`Dismiss notification: ${t.title}`}><CloseIcon size={14} aria-hidden="true" /></button></Tooltip>
      </div>;
    })}
    {hidden > 0 ? <p className={n.toastMore}>+{hidden} more</p> : null}
  </section>;
}
