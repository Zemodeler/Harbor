import type { SecretFinding } from '../../shared/api';
import { SECRET_PATTERNS } from '../logger';

/**
 * Secret scan for Harbor bundles (plan section 6.1): the patterns diagnostics redacts with (logger.ts) plus `.env`-style lines and a
 * few more token shapes. Best effort, like diagnostics: it warns, it cannot prove a bundle is clean. Findings carry a masked excerpt
 * only, so the warning itself never repeats a secret.
 */

const EXTRA: Array<{ kind: string; re: RegExp }> = [
  { kind: '.env line', re: /^[ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|AUTH)[A-Za-z0-9_]*[ \t]*=[ \t]*["']?[^\s"'#]{6,}/gim },
  { kind: 'API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'token', re: /\b(?:glpat|npm|pypi)[-_][A-Za-z0-9_-]{20,}/g },
  { kind: 'API key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'webhook URL', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g },
  { kind: 'password in a URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'<>]+:[^\s@/"'<>]{3,}@/gi }
];
const KIND_OF: string[] = ['private key', 'API key', 'GitHub token', 'Slack token', 'AWS key', 'bearer token', 'JWT', 'secret-looking value'];
const PATTERNS: Array<{ kind: string; re: RegExp; to?: string }> = [
  ...SECRET_PATTERNS.map(([re, to], i) => ({ kind: KIND_OF[i] ?? 'secret-looking value', re, to })),
  ...EXTRA
];
const MAX_FINDINGS = 50;

/** First four characters and the length: enough to find it, never enough to use it. */
export const maskSecret = (s: string): string => `${s.replace(/\s+/g, ' ').trim().slice(0, 4)}… (${s.length} characters)`;

/** Findings in one text; `where` names the item ("conversation \"Fix login\"", "skill pdf-tools: scripts/x.py"). */
export function scanSecrets(text: string, where: string, limit = MAX_FINDINGS): SecretFinding[] {
  const out: SecretFinding[] = [];
  if (!text) return out;
  // Patterns overlap (a .env line is also key=value): one finding per stretch of text.
  const taken: Array<[number, number]> = [];
  for (const p of PATTERNS) {
    for (const m of text.matchAll(new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`))) {
      const start = m.index ?? 0, end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      taken.push([start, end]);
      out.push({ where, kind: p.kind, excerpt: maskSecret(m[0]) });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** The text with every finding replaced by "[redacted]" (the user chose "remove them" in the export dialog). */
export function redactBundleText(text: string): { text: string; count: number } {
  let count = 0, out = text;
  for (const p of PATTERNS) {
    out = out.replace(new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`), (m, ...groups) => {
      count++;
      // logger's key=value pattern keeps the key name ($1) and drops only the value.
      if (p.to?.startsWith('$1') && typeof groups[0] === 'string') return `${groups[0]}[redacted]`;
      return '[redacted]';
    });
  }
  return { text: out, count };
}
