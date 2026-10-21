import type { ReactNode } from 'react';
import { Modal } from './Modal';
import u from './ui.module.css';

/**
 * One shape for "are you sure?": the safe choice has focus, a destructive confirm is red, and a failure shows in place.
 * While `pending` the dialog cannot be dismissed so a half-finished action is never hidden.
 */
export function ConfirmDialog({ title, children, confirmLabel, pendingLabel, cancelLabel = 'Cancel', tone = 'default', pending = false, disabled = false, error, onConfirm, onCancel }: {
  title: string; children: ReactNode; confirmLabel: string; pendingLabel?: string; cancelLabel?: string; tone?: 'default' | 'danger'; pending?: boolean; disabled?: boolean; error?: string; onConfirm: () => void; onCancel: () => void;
}) {
  return <Modal title={title} size="sm" role="alertdialog" close={onCancel} dismissible={!pending} footer={<>
    <button data-autofocus={tone === 'danger' ? '' : undefined} disabled={pending} onClick={onCancel}>{cancelLabel}</button>
    <button className={tone === 'danger' ? u.dangerSolid : u.primary} data-autofocus={tone !== 'danger' ? '' : undefined} disabled={pending || disabled} onClick={onConfirm}>{pending ? pendingLabel ?? confirmLabel : confirmLabel}</button>
  </>}>
    <div className={u.confirmBody}>{children}</div>
    {error ? <p className={u.error} role="alert">{error}</p> : null}
  </Modal>;
}
