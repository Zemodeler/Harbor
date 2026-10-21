import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import './ui.module.css';
import m from './menu.module.css';

export type MenuItem =
  | { separator: true; key: string }
  | { key: string; label: string; onSelect: () => void; danger?: boolean; icon?: ReactNode; disabled?: boolean; /** Shown under a disabled item and used as its tooltip. */ reason?: string; ariaLabel?: string; separator?: false };

const TYPEAHEAD_MS = 600;
const GAP = 4;

/**
 * Button that opens a floating menu (role="menu"). Arrow keys, Home/End and typeahead move between enabled items,
 * Esc closes and returns focus to the button, and a click elsewhere closes it. The popover is position: fixed from
 * the button's rectangle so no scrolling ancestor clips it and no list needs padding to make room.
 */
export function Menu({ label, title, trigger, items, className, triggerClassName }: { label: string; title?: string; trigger: ReactNode; items: MenuItem[]; className?: string; triggerClassName?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({ opacity: 0 });
  const wrap = useRef<HTMLSpanElement>(null), button = useRef<HTMLButtonElement>(null), popover = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const menuId = useId();

  const enabled = () => [...popover.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []];
  const close = useCallback((refocus: boolean) => { setOpen(false); if (refocus) button.current?.focus(); }, []);

  // Place the popover under the button, right-aligned; flip above it when it would run off the viewport bottom.
  useLayoutEffect(() => {
    if (!open || !button.current || !popover.current) return;
    const b = button.current.getBoundingClientRect(), h = popover.current.offsetHeight, w = popover.current.offsetWidth;
    const flip = b.bottom + GAP + h > window.innerHeight && b.top - GAP - h >= 0;
    const left = Math.max(8, Math.min(b.right - w, window.innerWidth - w - 8));
    setPos(flip ? { left, bottom: window.innerHeight - b.top + GAP } : { left, top: b.bottom + GAP });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    enabled()[0]?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(true); } };
    const down = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const away = () => setOpen(false);
    document.addEventListener('keydown', key); document.addEventListener('pointerdown', down);
    window.addEventListener('resize', away); window.addEventListener('scroll', away, true);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', down); window.removeEventListener('resize', away); window.removeEventListener('scroll', away, true); };
  }, [open, close]);

  const move = (to: (list: HTMLButtonElement[], at: number) => number) => {
    const list = enabled(); if (!list.length) return;
    list[to(list, list.indexOf(document.activeElement as HTMLButtonElement))]?.focus();
  };
  const onMenuKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move((l, at) => (at + 1) % l.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move((l, at) => (at <= 0 ? l.length - 1 : at - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); move(() => 0); }
    else if (e.key === 'End') { e.preventDefault(); move(l => l.length - 1); }
    else if (e.key === 'Tab') setOpen(false);
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
      const now = Date.now(), t = typed.current;
      t.text = now - t.at > TYPEAHEAD_MS ? e.key.toLowerCase() : t.text + e.key.toLowerCase(); t.at = now;
      const list = enabled(), start = Math.max(0, list.indexOf(document.activeElement as HTMLButtonElement));
      // A repeated single letter cycles; a longer prefix searches from the current item.
      const from = t.text.length === 1 ? start + 1 : start;
      const found = [...list.slice(from), ...list.slice(0, from)].find(b => (b.textContent ?? '').trim().toLowerCase().startsWith(t.text));
      if (found) { e.preventDefault(); found.focus(); }
    }
  };

  return <span ref={wrap} className={`${m.wrap} ${className ?? ''}`}>
    <button ref={button} type="button" className={`${m.trigger} ${triggerClassName ?? ''}`} aria-label={label} title={title} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => { if (open) close(false); else { setPos({ opacity: 0 }); setOpen(true); } }}
      onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setPos({ opacity: 0 }); setOpen(true); } }}>{trigger}</button>
    {open ? <div ref={popover} id={menuId} role="menu" aria-label={label} className={m.menu} style={pos} onKeyDown={onMenuKey}>
      {items.map(item => item.separator ? <div key={item.key} role="separator" className={m.separator}/>
        : <MenuRow key={item.key} item={item} select={() => { close(true); item.onSelect(); }}/>)}
    </div> : null}
  </span>;
}

function MenuRow({ item, select }: { item: Exclude<MenuItem, { separator: true }>; select: () => void }) {
  const reasonId = useId();
  const why = item.disabled ? item.reason : undefined;
  return <button type="button" role="menuitem" tabIndex={-1} className={`${m.item} ${item.danger ? m.danger : ''}`} disabled={item.disabled} aria-label={item.ariaLabel} aria-describedby={why ? reasonId : undefined} title={why} onClick={select}>
    <span className={m.label}>{item.icon}{item.label}</span>
    {why ? <span id={reasonId} className={m.reason}>{why}</span> : null}
  </button>;
}
