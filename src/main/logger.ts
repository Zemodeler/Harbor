import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Main-process log with size rotation (main.log, main.log.1, main.log.2). Takes a directory so it stays
 * Electron-free and testable. Logging must never break the app: every file operation is swallowed.
 */
export type LogLevel = 'info' | 'warn' | 'error';

export const LOG_MAX_BYTES = 1024 * 1024;
export const LOG_FILES = 3;
const LINE_MAX = 4000;

/** Also the base of the bundle secret scan (bundles/secrets.ts). */
export const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted key]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, '[redacted]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted jwt]'],
  // key=value / "key": "value" for secret-looking names
  [/((?:api[_-]?key|token|secret|password|passwd|authorization|credential)s?["']?\s*[:=]\s*["']?)[^\s"',;}]{4,}/gi, '$1[redacted]']
];

/** Best-effort: removes strings that look like keys, tokens or passwords. It cannot catch everything. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

function describe(v: unknown): string {
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}

export interface Logger {
  readonly file: string;
  log(level: LogLevel, message: string, ...extra: unknown[]): void;
  info(message: string, ...extra: unknown[]): void;
  warn(message: string, ...extra: unknown[]): void;
  error(message: string, ...extra: unknown[]): void;
}

export function createLogger(dir: string, opts: { maxBytes?: number; files?: number; now?: () => number } = {}): Logger {
  const maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
  const files = Math.max(1, opts.files ?? LOG_FILES);
  const now = opts.now ?? Date.now;
  const file = join(dir, 'main.log');

  const rotate = (): void => {
    rmSync(`${file}.${files - 1}`, { force: true });
    for (let i = files - 2; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    renameSync(file, files > 1 ? `${file}.1` : `${file}.old`);
    if (files === 1) rmSync(`${file}.old`, { force: true });
  };

  const log = (level: LogLevel, message: string, ...extra: unknown[]): void => {
    try {
      const text = redactSecrets([message, ...extra.map(describe)].join(' ')).replace(/\r?\n/g, '\n    ').slice(0, LINE_MAX);
      mkdirSync(dir, { recursive: true });
      if (existsSync(file) && statSync(file).size > maxBytes) rotate();
      appendFileSync(file, `${new Date(now()).toISOString()} ${level.toUpperCase()} ${text}\n`);
    } catch { /* logging must never break the app */ }
  };
  return { file, log, info: (m, ...e) => log('info', m, ...e), warn: (m, ...e) => log('warn', m, ...e), error: (m, ...e) => log('error', m, ...e) };
}

/** The last `lines` lines of the current log (already redacted when written; redacted again for safety). */
export function readLogTail(dir: string, lines = 200): string {
  try {
    const raw = readFileSync(join(dir, 'main.log'), 'utf8');
    return redactSecrets(raw.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n'));
  } catch { return ''; }
}
