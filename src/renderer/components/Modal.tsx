import { useEffect, useRef, useId, type ReactNode } from 'react';
import { CloseIcon } from './Icons';
import s from '../Harbor.module.css';

export function Modal({ title, children, close, dismissible = true }: { title: string; children: ReactNode; close: () => void; dismissible?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!; dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  return <dialog className={s.modal} ref={ref} aria-labelledby={titleId} onKeyDown={e => {
    if (e.key !== 'Tab') return;
    const controls = Array.from(ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [href], [tabindex]:not([tabindex="-1"])')).filter(el => el.getClientRects().length > 0);
    const first = controls[0], last = controls.at(-1);
    if (!first) { e.preventDefault(); ref.current?.focus(); return; }
    if ((!e.shiftKey && document.activeElement === last) || (e.shiftKey && document.activeElement === first)) { e.preventDefault(); (e.shiftKey ? last : first)?.focus(); }
  }} onCancel={e => { e.preventDefault(); if (dismissible) close(); }}>
    <div className={s.modalHeader}><h2 id={titleId}>{title}</h2>{dismissible ? <button className={s.iconButton} onClick={close} aria-label="Close dialog"><CloseIcon size={18} aria-hidden="true"/></button> : null}</div>{children}
  </dialog>;
}
