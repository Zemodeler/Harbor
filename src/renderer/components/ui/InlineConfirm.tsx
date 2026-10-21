import type { ReactNode } from 'react';
import u from './ui.module.css';

/** The in-place confirmation used inside lists and cards: same buttons and danger colour as ConfirmDialog, no overlay. */
export function InlineConfirm({ label, children, confirmLabel, cancelLabel = 'Cancel', tone = 'danger', pending = false, onConfirm, onCancel }: {
  label: string; children: ReactNode; confirmLabel: string; cancelLabel?: string; tone?: 'default' | 'danger'; pending?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return <div className={u.inlineConfirm} data-tone={tone} role="group" aria-label={label}>
    <p>{children}</p>
    <div className={u.inlineActions}>
      <button disabled={pending} onClick={onCancel}>{cancelLabel}</button>
      <button className={tone === 'danger' ? u.dangerSolid : u.primary} disabled={pending} onClick={onConfirm}>{confirmLabel}</button>
    </div>
  </div>;
}
