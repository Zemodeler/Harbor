import { useCallback, useEffect, useRef, useId, type ReactNode } from 'react';
import { CloseIcon } from '../Icons';
import u from './ui.module.css';

export type ModalSize = 'sm' | 'md' | 'lg' | 'full';
const CLOSE_MS = 140;
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [href], [tabindex]:not([tabindex="-1"])';

/** Only animate where the browser can report it; jsdom and reduced-motion users close synchronously. */
const animates = (el: HTMLElement) => typeof el.getAnimations === 'function' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Pinned action row. Pass it as `footer` so it stays in view while the body scrolls. */
export function ModalFooter({ children }: { children: ReactNode }) { return <div className={u.footer}>{children}</div>; }

/**
 * Native <dialog> with a header, a scrolling body and an optional pinned footer. Esc, the close button and a click on
 * the backdrop all go through `close` (unless not `dismissible`); focus is trapped and returned to the opener.
 * `role="alertdialog"` is for confirmations that interrupt the user.
 */
export function Modal({ title, children, close, dismissible = true, size = 'md', footer, description, role }: {
  title: string; children: ReactNode; close: () => void; dismissible?: boolean; size?: ModalSize; footer?: ReactNode; description?: string; role?: 'dialog' | 'alertdialog';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId(), descId = useId();
  const pressedBackdrop = useRef(false);
  const closing = useRef(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!; dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  const request = useCallback(() => {
    const dialog = ref.current;
    if (closing.current) return;
    if (!dialog || !animates(dialog)) { close(); return; }
    closing.current = true; dialog.dataset.closing = '';
    setTimeout(() => { closing.current = false; close(); }, CLOSE_MS);
  }, [close]);
  return <dialog className={u.dialog} data-size={size} ref={ref} role={role} aria-labelledby={titleId} aria-describedby={description ? descId : undefined}
    onMouseDown={e => { pressedBackdrop.current = e.target === ref.current; }}
    onClick={e => { if (dismissible && pressedBackdrop.current && e.target === ref.current) request(); pressedBackdrop.current = false; }}
    onKeyDown={e => {
      if (e.key !== 'Tab') return;
      const controls = Array.from(ref.current!.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (!first) { e.preventDefault(); ref.current?.focus(); return; }
      if ((!e.shiftKey && document.activeElement === last) || (e.shiftKey && document.activeElement === first)) { e.preventDefault(); (e.shiftKey ? last : first)?.focus(); }
    }}
    onCancel={e => { e.preventDefault(); if (dismissible) request(); }}>
    <div className={u.header}><h2 id={titleId}>{title}</h2>{dismissible ? <button className={u.close} onClick={request} aria-label="Close dialog"><CloseIcon size={18} aria-hidden="true"/></button> : null}</div>
    <div className={u.body}>{description ? <p id={descId} className={u.description}>{description}</p> : null}{children}</div>
    {footer ? <ModalFooter>{footer}</ModalFooter> : null}
  </dialog>;
}
