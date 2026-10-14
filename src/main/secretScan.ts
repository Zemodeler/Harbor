import { createHash } from 'node:crypto';

/**
 * Secret scanning of helper work (PURE): keys, tokens, private keys and .env-like content in the lines a diff adds and in the names
 * of files it adds. A finding is a type, a file and a line: the matched value is never returned, so nothing downstream (messages,
 * the journal, prompts, reports) can print it. Best effort by pattern; false positives are handled by a per-project allowlist of
 * paths and by a `harbor:allow-secret` marker on the line itself.
 */

export type SecretType =
  | 'private-key' | 'aws-access-key' | 'aws-secret-key' | 'github-token' | 'gitlab-token' | 'slack-token' | 'slack-webhook'
  | 'stripe-key' | 'google-api-key' | 'openai-key' | 'anthropic-key' | 'npm-token' | 'jwt' | 'password-in-url' | 'secret-assignment'
  | 'env-file' | 'credential-file';

export interface SecretFinding { type: SecretType; file: string; line: number }

/** A line carrying this text is never reported (an intentional fixture, a documented example). */
export const ALLOW_MARKER = 'harbor:allow-secret';
/** Tool name of the permission request that overrides a blocked integration (a `permission` event of kind 'tool'). */
export const SECRET_TOOL = 'Harbor secret scan';
/** Lines longer than this are scanned only up to it (minified bundles). */
const MAX_LINE = 4000;
/** At most this many findings are kept per scan; the total is still counted. */
export const MAX_FINDINGS = 200;

const PATTERNS: Array<[SecretType, RegExp]> = [
  ['private-key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/],
  ['aws-access-key', /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/],
  ['aws-secret-key', /\baws_?secret_?(?:access_?)?key\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}\b/i],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ['slack-webhook', /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{8,}/],
  ['stripe-key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/]
];

/** Values that are obviously not secrets: placeholders, references to the environment, templates. */
const PLACEHOLDER = /^(?:x+|\*+|\.+|-+|_+|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%[A-Z_]+%|\$[A-Z_][A-Z0-9_]*|(?:your|my)[-_]?(?:api[-_]?)?(?:key|token|secret|password|pass)\w*|change[-_]?me|replace[-_]?me|placeholder|example\w*|sample\w*|dummy\w*|fake\w*|test\w*|todo|none|null|undefined|true|false|redacted|\[redacted\]|password|secret|token)$/i;
const ENV_REFERENCE = /process\.env|import\.meta\.env|os\.environ|getenv|env\[|\$env:|System\.getenv|Environment\.GetEnvironmentVariable/i;

/** `key = "value"` / `key: value` where the key names a secret. The value must look like one (long, not a placeholder or a reference). */
const ASSIGNMENT = /(?:^|[\s{,;(])["']?([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?key|credential)s?)["']?\s*(?::=|=>|[:=])\s*(["'`]?)([^\s"'`,;)}]+)\2/i;
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"]{1,64}:([^\s:/@'"]{3,128})@[^\s'"]+/i;

function looksSecret(value: string): boolean {
  if (value.length < 8 || PLACEHOLDER.test(value) || ENV_REFERENCE.test(value)) return false;
  // A real secret mixes characters; a word, a path or a number alone is a value, not a credential.
  if (/^[a-z]+$/i.test(value) || /^\d+$/.test(value) || /^[./\\~]/.test(value) || /^https?:/.test(value)) return false;
  return (/[A-Za-z]/.test(value) && /[0-9]/.test(value)) || value.length >= 20;
}

/** Findings of one line (each type once). Inline references to the environment and the allow marker are skipped. */
export function scanLine(text: string): SecretType[] {
  if (!text || text.includes(ALLOW_MARKER)) return [];
  const line = text.length > MAX_LINE ? text.slice(0, MAX_LINE) : text;
  const out = new Set<SecretType>();
  for (const [type, re] of PATTERNS) if (re.test(line)) out.add(type);
  const url = URL_PASSWORD.exec(line);
  if (url && !PLACEHOLDER.test(url[1]!) && !/^\$|^\{|^<|^%/.test(url[1]!)) out.add('password-in-url');
  if (!out.size) {
    const m = ASSIGNMENT.exec(line);
    if (m && looksSecret(m[3]!)) out.add('secret-assignment');
  }
  return [...out];
}

const ENV_NAME = /(^|\/)\.env(?:\.[^/]*)?$/i;
const ENV_TEMPLATE = /\.(?:example|sample|template|dist|defaults?)$/i;
const CREDENTIAL_NAME = /(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|\.npmrc|\.netrc|\.pypirc|\.git-credentials|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml)|service[-_]?account[^/]*\.json)$|\.(?:pem|key|p12|pfx|jks|keystore|kdbx|tfstate)$/i;

/** A file the diff adds whose name says it holds credentials (.env, keys, keystores, ...). Line 0: the file as a whole. */
export function scanPath(path: string): SecretType | undefined {
  const p = path.replace(/\\/g, '/');
  if (ENV_NAME.test(p)) return ENV_TEMPLATE.test(p) ? undefined : 'env-file';
  return CREDENTIAL_NAME.test(p) ? 'credential-file' : undefined;
}

/** Scan a whole file's text (a new file), lines numbered from `firstLine`. */
export function scanText(file: string, text: string, firstLine = 1): SecretFinding[] {
  const out: SecretFinding[] = [];
  text.split(/\r?\n/).forEach((l, i) => { for (const type of scanLine(l)) out.push({ type, file, line: firstLine + i }); });
  return out;
}

const unquote = (p: string): string => {
  const t = p.trim();
  if (!t.startsWith('"')) return t;
  // git quotes paths with special characters C-style; octal escapes are left as they are (only the name is reported).
  return t.slice(1, -1).replace(/\\(["\\])/g, '$1');
};

/**
 * Scan a unified diff (`git diff`, any context size): every added line, numbered in the new file, and every added file's name.
 * Deleted files and removed lines are not findings (removing a secret is the fix). Binary files are skipped.
 */
export function scanDiff(diff: string): { findings: SecretFinding[]; total: number } {
  const findings: SecretFinding[] = [];
  let total = 0;
  const add = (f: SecretFinding) => { total++; if (findings.length < MAX_FINDINGS) findings.push(f); };
  let file: string | undefined;
  let newFile = false;
  let line = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (l.startsWith('diff --git ')) { file = undefined; newFile = false; inHunk = false; continue; }
    if (!inHunk || l.startsWith('--- ') || l.startsWith('+++ ')) {
      if (l.startsWith('new file mode')) { newFile = true; continue; }
      if (l.startsWith('+++ ')) {
        const p = l.slice(4);
        file = p === '/dev/null' ? undefined : unquote(p).replace(/^b\//, '');
        if (file && newFile) { const t = scanPath(file); if (t) add({ type: t, file, line: 0 }); }
        continue;
      }
      if (l.startsWith('Binary files ')) { file = undefined; continue; }
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { line = Number(h[1]); inHunk = true; continue; }
    if (!inHunk || !file) continue;
    if (l.startsWith('+')) { for (const type of scanLine(l.slice(1))) add({ type, file, line }); line++; }
    else if (l.startsWith(' ')) line++;
    // '-' lines and "\ No newline at end of file" do not advance the new file's numbering.
  }
  return { findings, total };
}

/** `*` = within one path segment, `**` = any depth; a pattern without a slash matches the file name anywhere. Case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const body = g.split(/(\*\*\/?|\*|\?)/).map((part) => {
    if (part === '**/' || part === '**') return '(?:.*/)?' + (part === '**' ? '.*' : '');
    if (part === '*') return '[^/]*';
    if (part === '?') return '[^/]';
    return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return new RegExp(`${g.includes('/') ? '^' : '(?:^|/)'}${body}${g.endsWith('/') ? '' : '$'}`, 'i');
}

/**
 * Splits findings by the allowlist. An entry is a path glob (`tests/fixtures/**`, `*.snap`), or `type@glob` to allow one kind of
 * finding only (`jwt@docs/**`). Blank entries and comments (`#`) are ignored.
 */
export function applyAllowlist(findings: readonly SecretFinding[], allowlist: readonly string[] = []): { kept: SecretFinding[]; allowed: SecretFinding[] } {
  const rules = allowlist.map((e) => e.trim()).filter((e) => e && !e.startsWith('#')).map((e) => {
    const at = /^([a-z-]+)@(.+)$/.exec(e);
    return at ? { type: at[1], re: globToRegExp(at[2]!) } : { type: undefined, re: globToRegExp(e) };
  });
  const kept: SecretFinding[] = [], allowed: SecretFinding[] = [];
  for (const f of findings) (rules.some((r) => (!r.type || r.type === f.type) && r.re.test(f.file.replace(/\\/g, '/'))) ? allowed : kept).push(f);
  return { kept, allowed };
}

const where = (f: SecretFinding): string => (f.line > 0 ? `${f.file}:${f.line}` : f.file);

/** Type and location only (never the value), at most `max` entries. */
export function describeFindings(findings: readonly SecretFinding[], total = findings.length, max = 10): string {
  const shown = findings.slice(0, max).map((f) => `${f.type} at ${where(f)}`);
  const more = total - shown.length;
  return shown.join('; ') + (more > 0 ? `; and ${more} more` : '');
}

/** Stable identity of a set of findings on one commit: an override answers exactly these, nothing that appears later. */
export function findingsFingerprint(commit: string, findings: readonly SecretFinding[]): string {
  const lines = findings.map((f) => `${f.type}|${f.file}|${f.line}`).sort();
  return createHash('sha256').update(`${commit}\n${lines.join('\n')}`).digest('hex');
}
