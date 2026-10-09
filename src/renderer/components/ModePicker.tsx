import { useEffect, useState } from 'react';
import type { Conversation, ConversationMode } from '../../shared/api';
import s from '../Harbor.module.css';

export const modes: { id: ConversationMode; label: string; hint: string }[] = [
  { id: 'default', label: 'Default', hint: 'Normal behaviour: Harbor asks before risky actions.' },
  { id: 'auto', label: 'Auto', hint: 'No permission prompts. Agents act without asking.' },
  { id: 'plan', label: 'Plan', hint: 'Read-only. Harbor plans first and changes nothing.' },
  { id: 'goal', label: 'Goal', hint: 'Keep working until the goal you set is reached.' }
];

export function ModePicker({ conversation, disabled, setMode }: { conversation: Conversation; disabled?: boolean; setMode: (mode: ConversationMode, goal?: string) => Promise<unknown> }) {
  const mode = conversation.mode ?? 'default';
  const [goalOpen, setGoalOpen] = useState(false);
  const [goal, setGoal] = useState(conversation.goal ?? '');
  const [pending, setPending] = useState(false);
  useEffect(() => { setGoalOpen(false); setGoal(conversation.goal ?? ''); }, [conversation.id, conversation.goal]);
  async function choose(next: ConversationMode) {
    if (next === 'goal') { setGoalOpen(true); return; }
    setGoalOpen(false);
    if (next !== mode) { setPending(true); try { await setMode(next); } finally { setPending(false); } }
  }
  async function saveGoal() {
    if (!goal.trim()) return;
    setPending(true);
    try { await setMode('goal', goal.trim()); setGoalOpen(false); } finally { setPending(false); }
  }
  const active = goalOpen ? 'goal' : mode;
  return <div className={s.modePicker}>
    <div role="radiogroup" aria-label="Conversation mode" className={s.modeGroup}>
      {modes.map(m => <button key={m.id} type="button" role="radio" aria-checked={active === m.id} data-mode={m.id} className={s.modeOption} title={m.hint} disabled={disabled || pending} onClick={() => void choose(m.id)}>{m.label}</button>)}
    </div>
    {goalOpen ? <form className={s.goalForm} onSubmit={e => { e.preventDefault(); void saveGoal(); }}>
      <label>Goal<input autoFocus value={goal} maxLength={500} placeholder="What should be true when this is done?" onChange={e => setGoal(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setGoalOpen(false); }}/></label>
      <button className={s.primary} disabled={!goal.trim() || pending}>Set goal</button>
      <button type="button" onClick={() => setGoalOpen(false)}>Cancel</button>
    </form> : mode === 'goal' && conversation.goal ? <p className={s.goalText}>Goal: {conversation.goal}</p> : null}
  </div>;
}
