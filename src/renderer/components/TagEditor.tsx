import { useState } from 'react';
import type { Conversation } from '../../shared/api';
import { MAX_TAGS, parseTags } from '../conversationMeta';
import { Modal } from './Modal';
import s from '../Harbor.module.css';
import n from './Navigation.module.css';

/** Tags are kept on this device only (the contract has no tags yet); the dialog says so. */
export function TagEditor({ conversation, tags, known, save, close }: { conversation: Conversation; tags: string[]; known: string[]; save: (tags: string[]) => void; close: () => void }) {
  const [text, setText] = useState(tags.join(', '));
  const current = parseTags(text);
  const suggestions = known.filter(t => !current.includes(t)).slice(0, 12);
  return <Modal title="Edit tags" close={close}>
    <form onSubmit={e => { e.preventDefault(); save(current); close(); }}>
      <p>Tags for “{conversation.title}”. Find them with <kbd>#</kbd> in Ctrl+K or filter the conversation list.</p>
      <label className={s.field}>Tags, separated by commas or spaces<input autoFocus value={text} onChange={e => setText(e.target.value)} placeholder="bug, release, ui" aria-describedby="tag-help"/></label>
      <p id="tag-help" className={s.muted}>Up to {MAX_TAGS} tags. Saved on this device only; they do not sync to other computers.</p>
      {suggestions.length ? <div className={n.tagFilter} role="group" aria-label="Tags in use">{suggestions.map(t => <button type="button" key={t} aria-label={`Add tag ${t}`} onClick={() => setText(v => `${v.trim() ? `${v.replace(/[,\s]+$/, '')}, ` : ''}${t}`)}>#{t}</button>)}</div> : null}
      <div className={s.actions}><button type="button" onClick={close}>Cancel</button><button className={s.primary}>Save tags</button></div>
    </form>
  </Modal>;
}
