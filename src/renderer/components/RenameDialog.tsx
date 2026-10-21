import { useEffect, useRef, useState } from 'react';
import { Modal } from './ui/Modal';
import s from '../Harbor.module.css';
import n from './Navigation.module.css';

export const NAME_LIMIT = 160;
const WARN_AT = 140;

/** Rename a conversation. Opens with the current name selected so typing replaces it; Enter saves, Esc cancels. */
export function RenameDialog({ title, pending = false, error, onSave, onCancel }: { title: string; pending?: boolean; error?: string; onSave: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.select(); }, []);
  const blank = !name.trim();
  const formId = 'rename-dialog-form';
  return <Modal title="Rename conversation" close={onCancel} size="sm" footer={<><button type="button" onClick={onCancel}>Cancel</button><button form={formId} className={s.primary} disabled={pending || blank}>Save name</button></>}>
    <form id={formId} onSubmit={e => { e.preventDefault(); if (!blank && !pending) onSave(name); }}>
      <label className={s.field}>Conversation name<input ref={input} autoFocus value={name} maxLength={NAME_LIMIT} aria-describedby="rename-count" onChange={e => setName(e.target.value)}/></label>
      <p id="rename-count" className={n.nameCount} data-warn={name.length >= WARN_AT || undefined} aria-live="polite">{name.length >= WARN_AT ? `${name.length} of ${NAME_LIMIT} characters` : ''}</p>
      {error ? <p className={s.error} role="alert">{error}</p> : null}
    </form>
  </Modal>;
}
