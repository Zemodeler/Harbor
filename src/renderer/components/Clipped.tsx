import { useMemo, useState, type ReactNode } from 'react';
import s from '../Harbor.module.css';

/** Diffs and tool output can be enormous; past this many lines (or characters in one line) the rest waits behind "Show all". */
export const CLIP_LINES = 400, CLIP_LINE_CHARS = 2000;

export function clipLines(text: string, max = CLIP_LINES): { lines: string[]; total: number; clipped: boolean } {
  const all = text.split('\n');
  const tooLong = all.length > max, longLine = all.some(l => l.length > CLIP_LINE_CHARS);
  if (!tooLong && !longLine) return { lines: all, total: all.length, clipped: false };
  const lines = (tooLong ? all.slice(0, max) : all).map(l => l.length > CLIP_LINE_CHARS ? `${l.slice(0, CLIP_LINE_CHARS)}…` : l);
  return { lines, total: all.length, clipped: true };
}

/** Renders `children(lines)` for the first lines only, with a button that reveals everything. */
export function Clipped({ text, max = CLIP_LINES, children }: { text: string; max?: number; children: (lines: string[]) => ReactNode }) {
  const [all, setAll] = useState(false);
  const clip = useMemo(() => clipLines(text, max), [text, max]);
  const lines = useMemo(() => all ? text.split('\n') : clip.lines, [all, clip, text]);
  return <>{children(lines)}{clip.clipped && !all ? <button type="button" className={s.hqShowAll} onClick={() => setAll(true)}>Show all {clip.total} lines</button> : null}</>;
}
