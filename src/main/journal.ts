import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Id } from '../shared/api';

/**
 * What went wrong in Harbor's own runs, so recurring problems become backlog items instead of anecdotes.
 * Append-only JSONL beside state.json; kept out of state.json so it never slows down the main store.
 */
export type JournalKind = 'protocol' | 'helper-failed' | 'lead-failed' | 'fallback' | 'checks-failed' | 'outside-claim' | 'triage' | 'permission' | 'rollback';

export interface JournalEntry { time: number; kind: JournalKind; projectId: Id; conversationId?: Id; agentId?: Id; text: string }

const KEEP = 1000;
/** When the file grows past this, it moves to `<file>.1` (replacing the previous rotation) and a new file starts. */
export const JOURNAL_MAX_BYTES = 512 * 1024;
const TEXT_MAX = 500;

/** A line from disk is trusted only if it has the fields list() and the digest read; anything else is skipped. */
function parseEntry(line: string): JournalEntry | undefined {
  try {
    const v = JSON.parse(line) as Partial<JournalEntry> | null;
    if (!v || typeof v !== 'object') return undefined;
    if (typeof v.time !== 'number' || typeof v.kind !== 'string' || typeof v.projectId !== 'string' || typeof v.text !== 'string') return undefined;
    return v as JournalEntry;
  } catch { return undefined; }
}

export class Journal {
  private entries: JournalEntry[] = [];
  /** A torn write from a crash leaves a partial last line; start the next entry on a fresh line so it is not lost with it. */
  private needsNewline = false;

  /** file undefined => in memory only (tests). */
  constructor(private file?: string, private maxBytes = JOURNAL_MAX_BYTES) {
    if (!file || !existsSync(file)) return;
    try {
      const raw = readFileSync(file, 'utf8');
      this.needsNewline = raw.length > 0 && !raw.endsWith('\n');
      this.entries = raw.split(/\r?\n/).filter(Boolean).slice(-KEEP).flatMap((l) => {
        const e = parseEntry(l);
        return e ? [e] : [];
      });
    } catch { /* unreadable journal: start fresh in memory, keep the file */ }
  }

  add(e: Omit<JournalEntry, 'time'>): void {
    const entry: JournalEntry = { time: Date.now(), ...e, text: e.text.slice(0, TEXT_MAX) };
    this.entries.push(entry);
    if (this.entries.length > KEEP) this.entries.splice(0, this.entries.length - KEEP);
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      // renameSync replaces an existing `<file>.1` on Windows, so one rotation is kept.
      if (existsSync(this.file) && statSync(this.file).size > this.maxBytes) renameSync(this.file, `${this.file}.1`);
      appendFileSync(this.file, (this.needsNewline ? '\n' : '') + JSON.stringify(entry) + '\n');
      this.needsNewline = false;
    } catch { /* journaling must never break a run */ }
  }

  list(projectId: Id): JournalEntry[] { return this.entries.filter((e) => e.projectId === projectId); }
}

/** Plain-text digest for the chat and for a lead review turn. */
export function journalDigest(entries: JournalEntry[], recent = 25): string {
  if (!entries.length) return 'The run journal for this project is empty.';
  const counts = new Map<JournalKind, number>();
  for (const e of entries) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const since = new Date(entries[0]!.time).toISOString().slice(0, 16).replace('T', ' ');
  const lines = [
    `Run journal: ${entries.length} entries since ${since}.`,
    `By kind: ${[...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}.`,
    `Most recent:`,
    ...entries.slice(-recent).map((e) => `- ${new Date(e.time).toISOString().slice(0, 16).replace('T', ' ')} [${e.kind}] ${e.text}`)
  ];
  return lines.join('\n');
}
