import { useState } from 'react';
import type { Conversation } from '../../shared/api';
import { MAX_TAGS, parseTags } from '../conversationMeta';
import { CloseIcon } from './Icons';
import { Modal } from './ui/Modal';
import s from '../Harbor.module.css';
import n from './Navigation.module.css';

/** Tags are kept on this device only (the contract has no tags yet); the dialog says so. */
export function TagEditor({ conversation, tags, known, save, close }: { conversation: Conversation; tags: string[]; known: string[]; save: (tags: string[]) => void; close: () => void }) {
  const [chips, setChips] = useState(() => parseTags(tags.join(' ')));
  const [draft, setDraft] = useState('');
  // Whatever is still typed counts as a tag when saving, so nobody loses the last word by skipping Enter.
  const current = parseTags([...chips, draft].join(' '));
  const full = chips.length >= MAX_TAGS;
  const suggestions = known.filter(t => !current.includes(t)).slice(0, 12);
  const commit = (text: string) => { setChips(parseTags([...chips, text].join(' '))); setDraft(''); };
  const onChange = (value: string) => {
    // A comma or space ends a tag; the text after the last separator stays in the box.
    const parts = value.split(/[,\s]+/);
    if (parts.length > 1) { setChips(parseTags([...chips, ...parts.slice(0, -1)].join(' '))); setDraft(parts.at(-1) ?? ''); } else setDraft(value);
  };
  const formId = 'tag-editor-form';
  return <Modal title="Edit tags" close={close} size="sm" footer={<><button type="button" onClick={close}>Cancel</button><button form={formId} className={s.primary}>Save tags</button></>}>
    <form id={formId} onSubmit={e => { e.preventDefault(); save(current); close(); }}>
      <p>Tags for “{conversation.title}”. Find them with <kbd>#</kbd> in Ctrl+K or filter the conversation list.</p>
      <div className={n.tagBox}>
        {chips.length ? <ul className={n.tagChips} aria-label="Current tags">{chips.map(t => <li key={t} className={n.tagChip}>#{t}
          <button type="button" aria-label={`Remove tag ${t}`} onClick={() => setChips(chips.filter(x => x !== t))}><CloseIcon size={12} aria-hidden="true"/></button></li>)}</ul> : null}
        <input autoFocus value={draft} aria-label="Tags, separated by commas or spaces" aria-describedby="tag-help" placeholder={chips.length ? '' : 'bug, release, ui'}
          onChange={e => onChange(e.target.value)} onBlur={() => { if (draft.trim()) commit(draft); }}
          onKeyDown={e => {
            if (e.key === 'Enter' && draft.trim()) { e.preventDefault(); commit(draft); }
            else if (e.key === 'Backspace' && !draft && chips.length) setChips(chips.slice(0, -1));
          }}/>
      </div>
      <p id="tag-help" className={s.muted}>Type a tag and press Enter or comma. Backspace removes the last one. Up to {MAX_TAGS} tags, saved on this device only; they do not sync to other computers.</p>
      {suggestions.length ? <div className={n.tagFilter} role="group" aria-label="Tags in use">{suggestions.map(t => <button type="button" key={t} aria-label={`Add tag ${t}`} disabled={full} onClick={() => setChips(parseTags([...chips, t].join(' ')))}>#{t}</button>)}</div> : null}
    </form>
  </Modal>;
}
