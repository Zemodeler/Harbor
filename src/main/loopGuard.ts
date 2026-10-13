/**
 * Loop guard: notices a helper that keeps producing output while going in circles (the same command again and again, a short cycle
 * of the same steps, polling "waiting for the run" with nothing changing, or a long stretch of activity that changes nothing).
 * PURE: no timers, no I/O, no clock reads. The orchestrator feeds it every chunk of a run (`observe`) and, for edit helpers with a
 * worktree, a periodic worktree fingerprint (`probe`, see progressProbe.ts).
 *
 * Without it only the 70-minute hard limit stopped such a run (softCap.ts): real runs spent up to an hour of quota that way.
 *
 * FALSE POSITIVES ARE WORSE THAN A MISSED LOOP: every limit is conservative, and progress is judged two ways:
 * - files (edit helpers with a probe): an event counts against the helper only once a LATER probe confirmed the fingerprint had not
 *   changed since before it. Events after the last probe are unknown, so they never count. A failed probe is no information.
 * - novelty (read-only helpers, or an edit helper without a probe): a new distinct command or new assistant text is progress. For an
 *   edit helper without a probe every edit counts as progress (the tool line only names the file, not what changed).
 * Verdicts come only from `observe` (an event): a helper running one long silent command produces no events and is never flagged;
 * silence is the stall/soft-cap logic's job.
 * Cost: O(REPEAT_WINDOW) per event, a bounded set of seen keys, a bounded list of recent texts.
 */

/** The same normalized command this many times in the recent window, with no progress in between, is a loop. */
export const REPEAT_COMMAND_LIMIT = 6;
/** Cheap read-only commands (git status, ls, Read, Grep...) are often repeated for good reasons: they need this many. */
export const CHEAP_REPEAT_LIMIT = 12;
/** How many recent events the repeat and cycle signals look at. */
export const REPEAT_WINDOW = 30;
/** The repeats must span at least this long: a burst of duplicates in a few seconds is not yet a loop worth a stop. */
export const REPEAT_MIN_SPAN_MS = 2 * 60_000;
/** A cycle of 2-4 steps (A,B,A,B / A,B,C,A,B,C) repeated this many times in a row with no progress is a loop. */
export const CYCLE_REPEATS = 4;
/** A cycle made only of cheap read-only commands needs this many repeats. */
export const CHEAP_CYCLE_REPEATS = 8;
export const MIN_CYCLE = 2;
export const MAX_CYCLE = 4;
/** Edit helper: worktree fingerprint unchanged (confirmed by probes) this long while output continues. */
export const NO_PROGRESS_MS = 15 * 60_000;
/** Read-only helper (planner/reviewer/other): no new distinct command and no new assistant text for this long while output continues. */
export const NO_PROGRESS_READONLY_MS = 12 * 60_000;
/** "Output continues": at least this many tool calls inside the no-progress span (a long single command is not activity). */
export const NO_PROGRESS_MIN_EVENTS = 8;
/** Edit helper: an unchanged worktree is still investigation, not a loop, while it keeps doing new things (more than this many). */
export const NO_PROGRESS_MAX_NOVEL = 2;
/** This many "waiting for ... / still running" notes with no progress in between are a waiting loop... */
export const WAIT_NOTE_LIMIT = 6;
/** ...when they span at least this long (a test suite polled a few times while it runs is normal). */
export const WAIT_MIN_SPAN_MS = 15 * 60_000;
/** Assistant texts this similar (token-set Jaccard) to a recent one are not new. */
export const TEXT_SIMILARITY = 0.6;
/** Recent texts compared for similarity. */
export const TEXT_MEMORY = 20;
/** Bound on remembered distinct command keys (novelty); oldest are forgotten. */
export const KEY_MEMORY = 2000;

export interface LoopLimits {
  repeatLimit: number; cheapRepeatLimit: number; window: number; repeatMinSpanMs: number;
  cycleRepeats: number; cheapCycleRepeats: number;
  noProgressMs: number; noProgressReadonlyMs: number; noProgressMinEvents: number; noProgressMaxNovel: number;
  waitNoteLimit: number; waitMinSpanMs: number;
}

export const DEFAULT_LOOP_LIMITS: LoopLimits = {
  repeatLimit: REPEAT_COMMAND_LIMIT, cheapRepeatLimit: CHEAP_REPEAT_LIMIT, window: REPEAT_WINDOW, repeatMinSpanMs: REPEAT_MIN_SPAN_MS,
  cycleRepeats: CYCLE_REPEATS, cheapCycleRepeats: CHEAP_CYCLE_REPEATS,
  noProgressMs: NO_PROGRESS_MS, noProgressReadonlyMs: NO_PROGRESS_READONLY_MS, noProgressMinEvents: NO_PROGRESS_MIN_EVENTS, noProgressMaxNovel: NO_PROGRESS_MAX_NOVEL,
  waitNoteLimit: WAIT_NOTE_LIMIT, waitMinSpanMs: WAIT_MIN_SPAN_MS
};

export type LoopKind = 'repeat' | 'cycle' | 'no-progress' | 'waiting';

export interface LoopEvidence {
  kind: LoopKind;
  /** What repeated: the command, the cycle ("A -> B"), or a short note. Normalized, clipped. */
  what: string;
  /** How many times (repeats, cycle rounds, waiting notes, or events without progress). */
  count: number;
  /** From the first counted event to the verdict. */
  spanMs: number;
  /** How long ago the last progress was (file change or new step), when known. */
  sinceProgressMs?: number;
  /** How progress was judged: by the worktree's files, or by new commands/text. */
  basis: 'files' | 'novelty';
}

export type LoopVerdict = { loop: false } | { loop: true; kind: LoopKind; evidence: LoopEvidence };

/** The chunk shapes the guard reads (a subset of adapters' Chunk, so it stays free of adapter imports). */
export type LoopEvent = { kind: 'tool'; text: string } | { kind: 'text'; text: string } | { kind: string };

// ---------------------------------------------------------------- normalizing

const SHELL_WRAPPER = /^(?:"[^"]*"|\S*?)(?:bash|sh|zsh|pwsh|powershell|cmd)(?:\.exe)?"?\s+(?:-lc|-c|-command|\/c|-noprofile\s+-command)\s+/i;

/**
 * The comparable form of a tool line. Volatile parts are replaced so a retried command matches itself: temp paths (<tmp>), ISO
 * timestamps and clock times (<time>), hex ids of 7+ characters such as commits and uuids (<id>), and standalone numbers (#, so
 * `sleep 30` = `sleep 60`). Digits inside names stay (`migration_001.sql`, `v2.ts`): reading numbered files is not a repeat.
 * Shell wrappers (`bash -lc '...'`) and quotes are dropped, whitespace collapsed, lower-cased, clipped to 200 characters.
 */
export function normalizeCommand(s: string): string {
  let t = s.trim().replace(/\s+/g, ' ');
  t = t.replace(SHELL_WRAPPER, '');
  t = t.replace(/["'`]/g, '');
  t = t.replace(/(?:[a-z]:)?[\\/][^\s]*?\b(?:temp|tmp)[\\/][^\s]*/gi, '<tmp>');
  t = t.replace(/\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?z?)?/gi, '<time>');
  t = t.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '<time>');
  t = t.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>');
  t = t.replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, '<id>');
  t = t.replace(/\b\d+(?:\.\d+)?\b/g, '#');
  return t.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 200);
}

/** Claude tool names and shell commands that only look: repeating them is cheap and often legitimate. */
const CHEAP_TOOLS = new Set(['read', 'glob', 'grep', 'ls', 'notebookread', 'todowrite', 'todoread']);
const CHEAP_SHELL = /^(?:git (?:status|log|diff|show|branch|rev-parse)|ls|dir|pwd|cat|head|tail|type|wc|rg|grep|find|echo|get-childitem|get-content|select-string|test-path|where|which)\b/;
const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'file']); // codex reports edits as "file change"

const toolName = (key: string): string => key.split(' ', 1)[0] ?? '';
/** The command part of a tool line: Claude's "Bash <cmd>" / PowerShell, or Codex's bare command. */
const shellPart = (key: string): string => key.replace(/^(?:bash|powershell|shell)\s+/, '');

export const isCheapCommand = (key: string): boolean => CHEAP_TOOLS.has(toolName(key)) || CHEAP_SHELL.test(shellPart(key));
export const isEditCommand = (key: string): boolean => EDIT_TOOLS.has(toolName(key));
/** Commands that only wait or read a background task's output: polling, not new work. */
const POLL = /^(?:taskoutput|bashoutput|taskstop|killshell|monitor|sleep|start-sleep|timeout|wait)/;
export const isPollCommand = (key: string): boolean => POLL.test(toolName(key)) || POLL.test(shellPart(key));

const WAIT_RE = /\bwaiting (?:for|on|until)\b|\bstill (?:running|waiting|in progress|pending|going)\b|\bnot (?:finished|done|complete) yet\b|\bhas(?:n't| not) (?:finished|completed)\b/i;
export const isWaitNote = (text: string): boolean => WAIT_RE.test(text);

const tokens = (s: string): Set<string> => new Set(normalizeCommand(s).split(/[^a-z0-9<>#_]+/).filter((w) => w.length > 1));
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// ---------------------------------------------------------------- detector

interface Ev { seq: number; t: number; tool: boolean; key: string; cheap: boolean; novel: boolean; wait: boolean }

export interface LoopDetectorOptions {
  /** The helper may edit files (implementer, other without access: read). */
  canEdit: boolean;
  /** Fingerprints will be fed (an edit helper with a worktree). Without it progress is judged by novelty. */
  probed: boolean;
  limits?: Partial<LoopLimits>;
  /** Run start (ms). */
  startedAt: number;
}

export class LoopDetector {
  private readonly l: LoopLimits;
  private readonly events: Ev[] = [];
  private seq = 0;
  private readonly seenKeys = new Map<string, true>();
  private readonly recentTexts: Set<string>[] = [];
  private lastNovelSeq = 0;
  private lastNovelAt: number;
  private lastNovelToolSeq = 0;
  /** Last tool call that starts work (not a cheap look, not a poll): waiting notes count only after it. */
  private lastWorkSeq = 0;
  /** Probe state: last fingerprint, the event seq/time when it was first seen (a change), and the last confirming probe. */
  private fp?: string;
  private changeSeq = 0;
  private changeAt = 0;
  private probeSeq = 0;
  private probeAt = 0;
  /** Tool calls counted for "output continues" in the no-progress signal. Bounded by time pruning. */
  private readonly activity: Array<{ seq: number; t: number; novel: boolean }> = [];

  constructor(private readonly o: LoopDetectorOptions) {
    this.l = { ...DEFAULT_LOOP_LIMITS, ...o.limits };
    this.lastNovelAt = o.startedAt;
  }

  private get filesMode(): boolean { return this.o.canEdit && this.o.probed && this.fp !== undefined; }

  /** A worktree fingerprint at time `now`; undefined (a failed probe) is no information and changes nothing. */
  probe(fingerprint: string | undefined, now: number): void {
    if (fingerprint === undefined) return;
    if (this.fp === undefined || fingerprint !== this.fp) { this.fp = fingerprint; this.changeSeq = this.seq; this.changeAt = now; }
    this.probeSeq = this.seq;
    this.probeAt = now;
  }

  observe(c: LoopEvent, now: number): LoopVerdict {
    if (c.kind !== 'tool' && c.kind !== 'text') return { loop: false };
    const text = (c as { text: string }).text ?? '';
    const tool = c.kind === 'tool';
    const seq = ++this.seq;
    let key: string, novel: boolean;
    if (tool) {
      key = normalizeCommand(text);
      novel = !this.seenKeys.has(key);
      if (novel) { this.seenKeys.set(key, true); if (this.seenKeys.size > KEY_MEMORY) this.seenKeys.delete(this.seenKeys.keys().next().value as string); }
      // Without a probe an edit's effect is unknown: count it as progress rather than risk stopping productive edit/test work.
      if (this.o.canEdit && !this.filesMode && isEditCommand(key)) novel = true;
    } else {
      const toks = tokens(text);
      key = `text:${[...toks].sort().join(' ').slice(0, 200)}`;
      novel = !this.recentTexts.some((r) => jaccard(r, toks) >= TEXT_SIMILARITY);
      this.recentTexts.push(toks);
      if (this.recentTexts.length > TEXT_MEMORY) this.recentTexts.shift();
    }
    const ev: Ev = { seq, t: now, tool, key, cheap: tool && isCheapCommand(key), novel, wait: !tool && isWaitNote(text) };
    if (novel) { this.lastNovelSeq = seq; this.lastNovelAt = now; if (tool) this.lastNovelToolSeq = seq; }
    if (tool && !ev.cheap && !isPollCommand(key)) this.lastWorkSeq = seq;
    this.events.push(ev);
    if (this.events.length > this.l.window) this.events.shift();
    // Only tool calls count as activity: narration and "still running" notes are not work (waiting has its own signal).
    if (tool) this.activity.push({ seq, t: now, novel });
    const keep = Math.max(this.l.noProgressMs, this.l.noProgressReadonlyMs, this.l.waitMinSpanMs) * 2;
    while (this.activity.length && now - this.activity[0]!.t > keep) this.activity.shift();
    return this.check(now);
  }

  /** Events whose lack of progress is established: confirmed by a later unchanged probe (files), or since the last new command (novelty). */
  private eligible(): Ev[] {
    if (this.filesMode) return this.events.filter((e) => e.seq > this.changeSeq && e.seq <= this.probeSeq);
    // Since the last NEW command: narration around a retried command varies ("let me try again") without being progress.
    return this.events.filter((e) => e.seq >= this.lastNovelToolSeq);
  }

  private sinceProgress(now: number): number { return now - (this.filesMode ? this.changeAt : this.lastNovelAt); }

  private evidence(kind: LoopKind, what: string, count: number, first: number, now: number): LoopVerdict {
    return { loop: true, kind, evidence: { kind, what, count, spanMs: now - first, sinceProgressMs: this.sinceProgress(now), basis: this.filesMode ? 'files' : 'novelty' } };
  }

  private check(now: number): LoopVerdict {
    const el = this.eligible();
    const tools = el.filter((e) => e.tool);
    // a. the same command again and again
    const byKey = new Map<string, Ev[]>();
    for (const e of tools) { const a = byKey.get(e.key) ?? []; a.push(e); byKey.set(e.key, a); }
    for (const [key, evs] of byKey) {
      const limit = evs[0]!.cheap ? this.l.cheapRepeatLimit : this.l.repeatLimit;
      if (evs.length >= limit && evs[evs.length - 1]!.t - evs[0]!.t >= this.l.repeatMinSpanMs) return this.evidence('repeat', key, evs.length, evs[0]!.t, now);
    }
    // b. a short cycle at the end of the eligible tool sequence
    for (let len = MIN_CYCLE; len <= MAX_CYCLE; len++) {
      const unit = tools.slice(-len);
      if (unit.length < len || new Set(unit.map((e) => e.key)).size < 2) continue;
      const need = unit.every((e) => e.cheap) ? this.l.cheapCycleRepeats : this.l.cycleRepeats;
      if (tools.length < len * need) continue;
      let rounds = 1;
      for (let r = 1; (r + 1) * len <= tools.length; r++) {
        const at = tools.length - (r + 1) * len;
        if (unit.every((u, i) => tools[at + i]!.key === u.key)) rounds++; else break;
      }
      const first = tools[tools.length - rounds * len]!;
      if (rounds >= need && now - first.t >= this.l.repeatMinSpanMs) return this.evidence('cycle', unit.map((e) => e.key).join(' -> '), rounds, first.t, now);
    }
    // d. waiting notes with nothing changing (files mode: confirmed span; novelty mode: since the last new command)
    // A new command started since (the next build, the next suite) is the next step, not the same wait.
    const waits = (this.filesMode ? el : this.events.filter((e) => e.seq > this.lastNovelToolSeq)).filter((e) => e.wait && e.seq > this.lastWorkSeq);
    if (waits.length >= this.l.waitNoteLimit && waits[waits.length - 1]!.t - waits[0]!.t >= this.l.waitMinSpanMs) {
      return this.evidence('waiting', 'waiting notes ("waiting for ..." / "still running")', waits.length, waits[0]!.t, now);
    }
    // c. activity without progress
    if (this.filesMode) {
      if (this.probeAt - this.changeAt >= this.l.noProgressMs) {
        const span = this.activity.filter((a) => a.seq > this.changeSeq && a.seq <= this.probeSeq);
        const novelCount = span.filter((a) => a.novel).length;
        if (span.length >= this.l.noProgressMinEvents && novelCount <= this.l.noProgressMaxNovel) return this.evidence('no-progress', 'activity without any file change', span.length, this.changeAt, now);
      }
    } else if (!this.o.canEdit && now - this.lastNovelAt >= this.l.noProgressReadonlyMs) {
      const span = this.activity.filter((a) => a.seq > this.lastNovelSeq);
      if (span.length >= this.l.noProgressMinEvents) return this.evidence('no-progress', 'activity without any new command or finding', span.length, this.lastNovelAt, now);
    }
    return { loop: false };
  }
}

// ---------------------------------------------------------------- words

const mins = (ms: number): string => { const m = Math.round(ms / 60_000); return m < 1 ? 'under a minute' : `${m} minute${m === 1 ? '' : 's'}`; };

/** Plain words for the user, the lead and the resume instruction. */
export function describeLoop(e: LoopEvidence): string {
  const nothing = e.basis === 'files' ? 'without changing any files' : 'without doing anything new';
  const since = e.sinceProgressMs !== undefined ? ` (last progress ${mins(e.sinceProgressMs)} ago)` : '';
  switch (e.kind) {
    case 'repeat': return `it ran \`${e.what}\` ${e.count} times in ${mins(e.spanMs)} ${nothing}${since}`;
    case 'cycle': return `it repeated the same steps (${e.what}) ${e.count} times in ${mins(e.spanMs)} ${nothing}${since}`;
    case 'waiting': return `it wrote ${e.count} "waiting"/"still running" notes over ${mins(e.spanMs)} ${nothing}${since}`;
    case 'no-progress': return `it kept working for ${mins(e.spanMs)} (${e.count} steps) ${nothing}`;
  }
}

/** Automatic resumes after a loop stop, per helper (separate from the cap's MAX_CAP_RESUMES). */
export const MAX_LOOP_RESUMES = 1;
export const loopResumeAllowed = (a: { loopResumes?: number }): boolean => (a.loopResumes ?? 0) < MAX_LOOP_RESUMES;

/** The follow-up of the one automatic resume after a loop stop. */
export function loopResumePrompt(e: LoopEvidence, where: string): string {
  return `Harbor stopped your run because it was going in circles: ${describeLoop(e)}. Do not repeat it; take a different approach, narrow the problem, or stop and report exactly what blocks you (what you tried and what happened) with outcome "blocked" or "partial". ${where}`.trim();
}
