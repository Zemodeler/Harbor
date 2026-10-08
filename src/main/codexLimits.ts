import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** One provider-reported limit window (e.g. Codex's 5h and weekly windows). */
export interface ReportedLimit { period: 'session' | 'weekly'; usedPct: number; resetsAt: number; asOf: number }

const TAIL_BYTES = 512 * 1024;

/**
 * Codex writes the account's real rate-limit state into every session log (`rate_limits` on token_count events:
 * `primary` = 5h window, `secondary` = weekly, with `used_percent` and `resets_at` in epoch seconds).
 * Pure: returns the limits from the LAST such event in `text`. Windows whose reset time has already
 * passed are dropped, because their percentage is stale (the window has rolled over).
 */
export function parseCodexRateLimits(text: string, now: number): ReportedLimit[] {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let j: any;
    try { j = JSON.parse(lines[i]); } catch { continue; }
    const rl = j?.payload?.rate_limits ?? j?.rate_limits;
    if (!rl) continue;
    const asOf = Date.parse(j.timestamp ?? '') || now;
    const out: ReportedLimit[] = [];
    for (const [key, period] of [['primary', 'session'], ['secondary', 'weekly']] as const) {
      const w = rl[key];
      if (!w || typeof w.used_percent !== 'number' || typeof w.resets_at !== 'number') continue;
      const resetsAt = w.resets_at * 1000;
      if (resetsAt > now) out.push({ period, usedPct: w.used_percent, resetsAt, asOf });
    }
    return out;
  }
  return [];
}

const sortedDesc = (dir: string) => { try { return readdirSync(dir).sort().reverse(); } catch { return []; } };

/** Newest session log: sessions/YYYY/MM/DD/rollout-*.jsonl (names sort chronologically). */
function newestSessionFiles(root: string, max: number): string[] {
  const files: string[] = [];
  for (const y of sortedDesc(root)) for (const m of sortedDesc(join(root, y))) for (const d of sortedDesc(join(root, y, m))) {
    for (const f of sortedDesc(join(root, y, m, d))) {
      if (f.endsWith('.jsonl')) files.push(join(root, y, m, d, f));
      if (files.length >= max) return files;
    }
  }
  return files;
}

function readTail(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size, start = Math.max(0, size - TAIL_BYTES), buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally { closeSync(fd); }
}

/** Latest Codex-reported limits, read from ~/.codex/sessions. Never touches auth files. Empty if unavailable. */
export function readCodexLimits(now = Date.now(), codexHome = join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', '.codex')): ReportedLimit[] {
  try {
    for (const f of newestSessionFiles(join(codexHome, 'sessions'), 5)) {
      const limits = parseCodexRateLimits(readTail(f), now);
      if (limits.length) return limits;
    }
  } catch { /* unreadable logs: fall back to Harbor's own estimate */ }
  return [];
}
