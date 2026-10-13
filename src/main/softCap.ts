/**
 * Time limits of one helper run. PURE (no timers, no clock reads): the orchestrator arms the timers and asks these functions what to do.
 *
 * A flat 45-minute kill threw away about two hours of a real run: four helpers were cut off mid-work and their work was redone as
 * "complete the preserved implementation" tasks. Now a run has two limits:
 * - SOFT (HELPER_SOFT_CAP_MS): a run that produced output or tool activity in the last ACTIVE_WINDOW_MS keeps going; an idle (or
 *   silently looping) run is stopped here. Past the soft limit the activity check repeats, so a run that goes quiet later stops then.
 * - HARD (HELPER_HARD_CAP_MS): stopped whatever it is doing.
 * A run Harbor stopped at a limit is resumed ONCE automatically from its saved session (or with Harbor's handoff when the session is
 * gone) with the instruction to finish and report (CAP_RESUME_PROMPT), before the lead is woken. A second cap stop wakes the lead.
 * The values are STARTING VALUES (Phase 5 tunes them).
 */

export const HELPER_SOFT_CAP_MS = 35 * 60_000;
export const HELPER_HARD_CAP_MS = 70 * 60_000;
/** Output or a tool call within this window counts as "still working" at the soft limit. */
export const ACTIVE_WINDOW_MS = 5 * 60_000;
/** Automatic resumes after a cap stop, per helper. */
export const MAX_CAP_RESUMES = 1;

export interface CapLimits { softMs: number; hardMs: number; activeWindowMs: number }

/**
 * Limits for helper runs from the injected watchdog settings. `helperCapMs` (the old single limit) is the HARD limit, so callers that
 * only knew one limit still get a run stopped at it; the soft limit never exceeds the hard one.
 */
export function capLimits(o: { helperCapMs?: number; helperSoftCapMs?: number; activeWindowMs?: number } = {}): CapLimits {
  const hardMs = o.helperCapMs ?? HELPER_HARD_CAP_MS;
  return { softMs: Math.min(o.helperSoftCapMs ?? HELPER_SOFT_CAP_MS, hardMs), hardMs, activeWindowMs: o.activeWindowMs ?? ACTIVE_WINDOW_MS };
}

export type SoftCheck = { stop: true } | { stop: false; recheckInMs: number };

/** At or past the soft limit: stop an idle run; an active one is checked again once its activity would have aged out of the window. */
export function softCheck(o: { idleMs: number; activeWindowMs: number }): SoftCheck {
  if (o.idleMs >= o.activeWindowMs) return { stop: true };
  return { stop: false, recheckInMs: Math.max(1_000, o.activeWindowMs - o.idleMs) };
}

/** Why the cap stopped a run, for the user and the lead. */
export type CapKind = 'idle' | 'hard';

export const capReason = (kind: CapKind, l: CapLimits): string => kind === 'hard'
  ? `it reached the hard limit of ${Math.round(l.hardMs / 60_000)} minutes`
  : `it passed the ${Math.round(l.softMs / 60_000)} minute limit with no output for ${Math.round(l.activeWindowMs / 60_000)} minutes`;

/** Whether Harbor may resume a capped helper by itself (once), or must hand the decision to the lead. */
export const capResumeAllowed = (a: { capResumes?: number }): boolean => (a.capResumes ?? 0) < MAX_CAP_RESUMES;

/** The follow-up of an automatic resume after a cap stop. */
export const CAP_RESUME_PROMPT = 'Harbor stopped your run at its time limit; your work so far is committed on your branch. Continue from where you stopped and FINISH: do only what is still missing for your assignment (no new scope, no full test suite unless your assignment asks for it), commit, then write your final report and the HARBOR_RESULT line. If the rest cannot be done in about 20 minutes, stop now and report exactly what is done and what is left (outcome "partial") so the lead can split it.';

/** The follow-up when Harbor resumes a stopped helper because new work depends on it. */
export const DEPENDENCY_RESUME_PROMPT = 'Harbor resumed your run because other work depends on it. Your earlier work is committed on your branch. Finish what is still missing for your assignment, commit, and write your final report and the HARBOR_RESULT line.';
