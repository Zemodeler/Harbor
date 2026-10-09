// Continuity handoff: a short, structured briefing for a session that cannot resume its native CLI session
// (new conversation, session lost, or routing moved to another CLI). Pure: the orchestrator gathers the facts.
// The key rule is honesty about verification: evidence covers the exact commit it was gathered on, never later edits.

export interface HandoffWork { title: string; role: string; state: string; branch?: string; note?: string }

export interface HandoffEvidence {
  title: string; branch?: string;
  /** Latest verdict of a reviewer of this branch, or the helper's own result, with the commit it examined. */
  verdict?: 'approve' | 'changes'; checks?: Array<{ cmd: string; ok: boolean }>;
  tested?: string; head?: string;
}

export interface HandoffInput {
  mode?: string; goal?: string;
  /** Oldest first; the newest are kept when the budget is tight. */
  decisions: string[];
  work: HandoffWork[];
  evidence: HandoffEvidence[];
  applied: string[];
}

const MAX_CHARS = 3500;
const MAX_DECISIONS = 10;
const short = (c?: string) => (c ? c.slice(0, 7) : 'unknown');
const line = (s: string, n = 220) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** What a piece of verification still proves: only the commit it ran on. */
export function evidenceLine(e: HandoffEvidence): string {
  const bits: string[] = [];
  if (e.verdict) bits.push(`review: ${e.verdict === 'approve' ? 'approved' : 'changes requested'}`);
  if (e.checks?.length) {
    const bad = e.checks.filter((c) => !c.ok);
    bits.push(bad.length ? `checks failed (${bad.map((c) => c.cmd).join(', ')})` : `checks passed (${e.checks.length})`);
  }
  if (!bits.length) bits.push('no review or checks recorded');
  const covers = e.tested ? ` on ${short(e.tested)}` : '';
  const stale = e.tested && e.head && e.tested !== e.head;
  const state = !e.tested ? '' : stale
    ? ` — STALE: the branch is now at ${short(e.head)}, so this does not cover the current code; verify again`
    : ' — current';
  return `${e.title}${e.branch ? ` (${e.branch})` : ''}: ${bits.join(', ')}${covers}${state}`;
}

export function buildHandoff(i: HandoffInput): string {
  const parts: string[] = [];
  if (i.goal) parts.push(`Goal: ${line(i.goal, 300)}`);
  if (i.mode && i.mode !== 'default') parts.push(`Conversation mode: ${i.mode}`);
  const decisions = i.decisions.slice(-MAX_DECISIONS);
  if (decisions.length) parts.push(`Decisions and constraints already settled (do not ask the user again):\n${decisions.map((d) => `- ${line(d)}`).join('\n')}`);
  const open = i.work.filter((w) => !['done'].includes(w.state));
  if (open.length) parts.push(`Outstanding work:\n${open.map((w) => `- ${w.title} [${w.role}, ${w.state}]${w.branch ? ` on ${w.branch}` : ''}${w.note ? `: ${line(w.note, 160)}` : ''}`).join('\n')}`);
  if (i.evidence.length) parts.push(`Verification evidence (valid only for the commit shown; anything committed since is unverified):\n${i.evidence.map((e) => `- ${evidenceLine(e)}`).join('\n')}`);
  if (i.applied.length) parts.push(`Already applied to the user's branch:\n${i.applied.map((a) => `- ${line(a)}`).join('\n')}`);
  if (!parts.length) return '';
  let text = `Project handoff (Harbor's record; your earlier native session is not available — rely on this and on the repository, and check git before trusting it):\n\n${parts.join('\n\n')}`;
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS - 40).trimEnd()}\n… [handoff truncated]`;
  return text;
}
