import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Id } from '../shared/api';

/**
 * What went wrong in Harbor's own runs, so recurring problems become backlog items instead of anecdotes.
 * Append-only JSONL beside state.json; kept out of state.json so it never slows down the main store.
 */
export type JournalKind = 'protocol' | 'helper-failed' | 'lead-failed' | 'fallback' | 'checks-failed' | 'outside-claim' | 'triage';

export interface JournalEntry { time: number; kind: JournalKind; projectId: Id; conversationId?: Id; agentId?: Id; text: string }

const KEEP = 1000;

export class Journal {
  private entries: JournalEntry[] = [];

  /** file undefined => in memory only (tests). */
  constructor(private file?: string) {
    if (!file || !existsSync(file)) return;
    try {
      this.entries = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-KEEP).flatMap((l) => {
        try { return [JSON.parse(l) as JournalEntry]; } catch { return []; }
      });
    } catch { /* unreadable journal: start fresh in memory, keep the file */ }
  }

  add(e: Omit<JournalEntry, 'time'>): void {
    const entry: JournalEntry = { time: Date.now(), ...e, text: e.text.slice(0, 500) };
    this.entries.push(entry);
    if (this.entries.length > KEEP) this.entries.splice(0, this.entries.length - KEEP);
    if (!this.file) return;
    try { mkdirSync(dirname(this.file), { recursive: true }); appendFileSync(this.file, JSON.stringify(entry) + '\n'); } catch { /* journaling must never break a run */ }
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
