import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import t from './tooltip.module.css';

const HOVER_DELAY_MS = 450;
type Placement = { left: number; top: number; side: 'top' | 'bottom' | 'right' };

/**
 * Replaces the browser's `title` bubble on icon buttons: it appears on hover (after a short delay) and at once on keyboard
 * focus, closes on Esc, and is styled like the rest of the app. It wraps with `display: contents`, so it never changes
 * layout. The child keeps its own accessible name
 * (aria-label); the tooltip is a visual aid and is not announced a second time.
 */
export function Tooltip({ text, side = 'top', disabled = false, children }: { text: string; side?: 'top' | 'bottom' | 'right'; disabled?: boolean; children: ReactNode }) {
  const id = useId();
  const [at, setAt] = useState<Placement>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hide = () => { clearTimeout(timer.current); setAt(undefined); };
  const show = (target: EventTarget, delay: number) => {
    const el = (target as HTMLElement).closest?.('button, a, [tabindex]') as HTMLElement | null;
    if (disabled || !el || (el as HTMLButtonElement).disabled) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = el.getBoundingClientRect();
      setAt(side === 'right' ? { left: r.right + 8, top: r.top + r.height / 2, side } : { left: r.left + r.width / 2, top: side === 'top' ? r.top - 8 : r.bottom + 8, side });
    }, delay);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!at) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    document.addEventListener('keydown', key); window.addEventListener('scroll', hide, true);
    return () => { document.removeEventListener('keydown', key); window.removeEventListener('scroll', hide, true); };
  }, [at]);
  return <span className={t.wrap}
    onMouseOver={e => show(e.target, HOVER_DELAY_MS)} onMouseOut={hide}
    onFocus={e => { if ((e.target as HTMLElement).matches?.(':focus-visible')) show(e.target, 0); }} onBlur={hide} onClick={hide}>
    {children}
    {at ? <span id={id} role="tooltip" className={t.tip} data-side={at.side} style={{ left: at.left, top: at.top }}>{text}</span> : null}
  </span>;
}
