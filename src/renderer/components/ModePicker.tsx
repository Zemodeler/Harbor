import { useEffect, useRef, useState } from 'react';
import type { Conversation, ConversationMode } from '../../shared/api';
import s from '../Harbor.module.css';
import { InlineConfirm } from './ui/InlineConfirm';

export const modes: { id: ConversationMode; label: string; hint: string }[] = [
  { id: 'default', label: 'Default', hint: 'Normal behaviour: Harbor asks before risky actions.' },
  { id: 'auto', label: 'Auto', hint: 'No permission prompts. Agents act without asking.' },
  { id: 'plan', label: 'Plan', hint: 'Read-only. Harbor plans first and changes nothing.' },
  { id: 'goal', label: 'Goal', hint: 'Keep working until the goal you set is reached.' }
];

// Module-level so the ref callback runs on mount only.
const focusSafe = (el: HTMLElement | null) => { el?.querySelector('button')?.focus(); };

export function ModePicker({ conversation, disabled, setMode }: { conversation: Conversation; disabled?: boolean; setMode: (mode: ConversationMode, goal?: string) => Promise<unknown> }) {
  const mode = conversation.mode ?? 'default';
  const [goalOpen, setGoalOpen] = useState(false);
  const [goal, setGoal] = useState(conversation.goal ?? '');
  const [pending, setPending] = useState(false);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const group = useRef<HTMLDivElement>(null);
  // Cancelling the confirmation returns focus to the Auto option, never to <body>.
  const cancelAuto = () => { setConfirmAuto(false); group.current?.querySelector<HTMLElement>('[data-mode=auto]')?.focus(); };
  useEffect(() => { setConfirmAuto(false); setGoalOpen(false); setGoal(conversation.goal ?? ''); }, [conversation.id, conversation.goal]);
  async function choose(next: ConversationMode) {
    if (next === 'goal') { setConfirmAuto(false); setGoalOpen(true); return; }
    setGoalOpen(false);
    // Auto removes permission prompts, so it is never one click away.
    if (next === 'auto' && mode !== 'auto') { setConfirmAuto(true); return; }
    setConfirmAuto(false);
    if (next !== mode) { setPending(true); try { await setMode(next); } finally { setPending(false); } }
  }
  async function enableAuto() {
    setPending(true);
    try { await setMode('auto'); setConfirmAuto(false); } finally { setPending(false); }
  }
  async function saveGoal() {
    if (!goal.trim()) return;
    setPending(true);
    try { await setMode('goal', goal.trim()); setGoalOpen(false); } finally { setPending(false); }
  }
  const active = goalOpen ? 'goal' : mode;
  // Auto removes the permission prompts, so the confirm is red and Cancel (the safe choice) has focus.
  const autoConfirm = confirmAuto ? <div ref={focusSafe} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); cancelAuto(); } }}>
    <InlineConfirm label="Confirm Auto mode" confirmLabel="Enable Auto mode" pending={pending} onConfirm={() => void enableAuto()} onCancel={cancelAuto}><strong>Turn on Auto mode?</strong> Permission prompts are off for the lead and for edit helpers, so they can run tools and change files without asking you. Reviewers stay read-only.</InlineConfirm>
  </div> : null;
  return <div className={s.modePicker}>
    <div ref={group} role="radiogroup" aria-label="Conversation mode" className={s.modeGroup}>
      {modes.map(m => <button key={m.id} type="button" role="radio" aria-checked={active === m.id} data-mode={m.id} className={s.modeOption} title={m.hint} disabled={disabled || pending} onClick={() => void choose(m.id)}>{m.label}</button>)}
    </div>
    {autoConfirm}
    {goalOpen ? <form className={s.goalForm} onSubmit={e => { e.preventDefault(); void saveGoal(); }}>
      <label>Goal<input autoFocus value={goal} maxLength={500} placeholder="What should be true when this is done?" onChange={e => setGoal(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setGoalOpen(false); }}/></label>
      <button className={s.primary} disabled={!goal.trim() || pending}>Set goal</button>
      <button type="button" onClick={() => setGoalOpen(false)}>Cancel</button>
    </form> : mode === 'goal' && conversation.goal ? <p className={s.goalText}>Goal: {conversation.goal}</p> : null}
  </div>;
}
