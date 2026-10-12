import { memo, useState } from 'react';
import type { Message } from '../../shared/api';
import { Clipped } from './Clipped';
import { ChevronIcon, ToolIcon } from './Icons';
import s from '../Harbor.module.css';

export function toolLabel(text: string): string {
  const first = text.split(/\r?\n/)[0];
  const match = /^(Read|Edit|Write|Bash|Shell|Glob|Grep|Search|command_execution|file_change)\s*(.*)$/i.exec(first);
  if (!match) return first.slice(0, 90) || 'Tool activity';
  const labels: Record<string, string> = { read: 'Read', edit: 'Updated', write: 'Created', bash: 'Ran a command', shell: 'Ran a command', glob: 'Found files', grep: 'Searched files', search: 'Searched', command_execution: 'Ran a command', file_change: 'Updated files' };
  const verb = match[1].toLowerCase();
  return ['read', 'edit', 'write'].includes(verb) ? `${labels[verb]} ${match[2].split(/[\\/]/).at(-1) || 'a file'}` : labels[verb];
}
export function groupMessages(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  for (const message of messages) {
    const previous = groups.at(-1);
    if (message.role === 'tool' && previous?.[0].role === 'tool' && previous[0].agentId === message.agentId) previous.push(message);
    else groups.push([message]);
  }
  return groups;
}
// Bodies are only rendered while their <details> is open: a long session has thousands of tool lines nobody expands.
function ToolItem({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  return <details className={s.toolItem} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary><span className={s.timelineDot}/><span title={message.text.split('\n')[0]}>{toolLabel(message.text)}</span><time dateTime={new Date(message.time).toISOString()}>{new Date(message.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time><ChevronIcon className={s.disclosureChevron} size={12} aria-hidden="true"/></summary>
    {open ? <Clipped text={message.text}>{lines => <pre>{lines.join('\n')}</pre>}</Clipped> : null}
  </details>;
}
export const ToolActivity = memo(function ToolActivity({ messages }: { messages: Message[] }) {
  const [open, setOpen] = useState(false);
  const last = messages.at(-1)!;
  return <details className={s.toolGroup} onToggle={e => { if (e.target === e.currentTarget) setOpen(e.currentTarget.open); }}>
    <summary><ToolIcon size={16} aria-hidden="true"/><strong>{messages.length === 1 ? 'Used a tool' : `Used ${messages.length} tools`}</strong><span>{toolLabel(last.text)}</span><ChevronIcon className={s.disclosureChevron} size={14} aria-hidden="true"/></summary>
    {open ? <div className={s.toolTimeline}>{messages.map(message => <ToolItem key={message.id} message={message}/>)}</div> : null}
  </details>;
}, (a, b) => a.messages.length === b.messages.length && a.messages.every((m, i) => m === b.messages[i]));
