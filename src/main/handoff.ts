// Continuity handoff: a short, structured briefing for a session that cannot resume its native CLI session
// (new conversation, session lost, or routing moved to another CLI). Pure: the orchestrator gathers the facts.
// The key rule is honesty about verification: evidence covers the exact commit it was gathered on, never later edits.

export interface HandoffWork { title: string; role: string; state: string; branch?: string; note?: string; /** Epoch ms of the last change; failed or stopped work older than a day is dropped from the open list. */ updated?: number }

/** A decision, optionally tied to the conversation it was made in (project-wide when it has no conversation). */
export interface HandoffDecision { text: string; conversationId?: string; /** Epoch ms the lead noted it (shown as provenance). */ time?: number }

export interface HandoffEvidence {
  title: string; branch?: string;
  /** Latest verdict of a reviewer of this branch, or the helper's own result, with the commit it examined. */
  verdict?: 'approve' | 'changes'; checks?: Array<{ cmd: string; ok: boolean }>;
  tested?: string; head?: string;
}

export interface HandoffInput {
  mode?: string; goal?: string;
  /** Oldest first; the newest are kept when the budget is tight. */
  decisions: Array<string | HandoffDecision>;
  /** With `conversationId`, decisions tied to another conversation are left out. */
  conversationId?: string;
  /** Clock for the age cut-off of failed work (default Date.now()). */
  now?: number;
  work: HandoffWork[];
  evidence: HandoffEvidence[];
  applied: string[];
}

/** Character budget per section: a long decision list can never push verification evidence or "already applied" out of the text. */
const BUDGET = { decisions: 1100, work: 900, evidence: 1400, applied: 700 };
const MAX_DECISIONS = 10;
const OLD_FAILED_MS = 24 * 3600_000;

/** Lines that fit in `budget` chars (header excluded), in order; the rest is summarised in one closing line. */
function fit(lines: string[], budget: number, what: string): string[] {
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > budget && out.length) break;
    out.push(l); used += l.length + 1;
  }
  return lines.length > out.length ? [...out, `- … ${lines.length - out.length} more ${what} not shown`] : out;
}
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
  const scoped = i.decisions
    .map((d) => (typeof d === 'string' ? { text: d } : d))
    .filter((d) => !i.conversationId || !d.conversationId || d.conversationId === i.conversationId)
    .slice(-MAX_DECISIONS);
  // Oldest first in the input; when the budget is tight the newest decisions are the ones kept.
  const when = (d: HandoffDecision) => (d.time ? ` (noted ${new Date(d.time).toISOString().slice(0, 10)})` : '');
  const decisionLines = scoped.map((d) => `- ${line(d.text)}${when(d)}`);
  let kept = decisionLines, used = 0;
  for (let n = decisionLines.length - 1; n >= 0; n--) {
    used += decisionLines[n]!.length + 1;
    if (used > BUDGET.decisions && n < decisionLines.length - 1) { kept = decisionLines.slice(n + 1); break; }
  }
  if (kept.length) {
    const dropped = decisionLines.length - kept.length;
    // Provenance, not authority: these are the lead's own notes of what the user said, so the user's current message wins over them.
    parts.push(`Decisions the lead noted earlier (the lead's notes of what the user said, not the user's own words; the user's current message wins if it differs; do not ask again what is settled here):\n${kept.join('\n')}${dropped ? `\n- … ${dropped} older decisions not shown` : ''}`);
  }
  const now = i.now ?? Date.now();
  const open = i.work.filter((w) => w.state !== 'done' && !((w.state === 'failed' || w.state === 'stopped') && w.updated !== undefined && now - w.updated > OLD_FAILED_MS));
  if (open.length) {
    const lines = open.map((w) => `- ${w.title} [${w.role}, ${w.state}]${w.branch ? ` on ${w.branch}` : ''}${w.note ? `: ${line(w.note, 160)}` : ''}`);
    parts.push(`Outstanding work:\n${fit(lines, BUDGET.work, 'items').join('\n')}`);
  }
  if (i.evidence.length) {
    // Stale evidence is the dangerous kind (it looks like proof): it is listed first and is the last to be dropped.
    const stale = (e: HandoffEvidence) => !!e.tested && !!e.head && e.tested !== e.head;
    const ordered = [...i.evidence.filter(stale), ...i.evidence.filter((e) => !stale(e))];
    const lines = ordered.map((e) => `- ${evidenceLine(e)}`);
    parts.push(`Verification evidence (valid only for the commit shown; anything committed since is unverified; the full test suite and any database setup run once, in one validation step, not per helper):\n${fit(lines, BUDGET.evidence, 'entries').join('\n')}`);
  }
  if (i.applied.length) parts.push(`Already applied to the user's branch:\n${fit(i.applied.map((a) => `- ${line(a)}`), BUDGET.applied, 'entries').join('\n')}`);
  if (!parts.length) return '';
  return `Project handoff (Harbor's record; your earlier native session is not available — rely on this and on the repository, and check git before trusting it):\n\n${parts.join('\n\n')}`;
}
