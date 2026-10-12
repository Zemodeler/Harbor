import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { killTree } from './proc';
import type { CheckRun } from './types';

/** Runs one check command in a directory. Injected so tests never spawn real builds. */
export type CheckRunner = (cmd: string, cwd: string, signal?: AbortSignal) => Promise<Omit<CheckRun, 'cmd'>>;

export const CHECKS_FILE = join('.harbor', 'checks.json');
const TIMEOUT_MS = 15 * 60_000;
const OUTPUT_TAIL = 4000;

/**
 * The checks Harbor runs after an edit helper, from `.harbor/checks.json` ({"checks": ["npm test", ...]}).
 * Read from the main checkout, never the helper's worktree: a helper must not be able to weaken its own checks.
 */
export function loadChecks(projectPath: string): string[] {
  const file = join(projectPath, CHECKS_FILE);
  if (!existsSync(file)) return [];
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { checks?: unknown };
    return Array.isArray(j.checks) ? j.checks.filter((c): c is string => typeof c === 'string' && !!c.trim()).slice(0, 10) : [];
  } catch { return []; }
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  // key=value / key: value where the key names a secret; keeps the key so the output stays readable
  /\b((?:[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"',;]+)/gi
];

/** Replaces secret-looking strings so check output stored in state (and shown to agents) cannot leak them. Best effort. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (_m, keep) => (typeof keep === 'string' ? `${keep}[redacted]` : '[redacted]'));
  return out;
}

/** Variables a check needs to find tools and temp folders; everything else (API keys, tokens, Harbor's own settings) stays out. */
const ENV_KEEP = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'OS', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'LANG', 'LC_ALL', 'TERM', 'CI', 'NODE_ENV', 'FORCE_COLOR', 'NO_COLOR']);
/** npm/node settings are kept (registries, caches, node options) unless the name says it holds a credential. */
const ENV_KEEP_PREFIX = /^(npm_config_|node_|npm_)/i;
const ENV_SECRET_NAME = /token|auth|password|passwd|secret|key|credential|cookie|session/i;

/** The environment checks run with: not Harbor's full one. Names are matched case-insensitively (Windows spells `Path`). */
export function minimalEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (ENV_KEEP.has(k.toUpperCase()) || (ENV_KEEP_PREFIX.test(k) && !ENV_SECRET_NAME.test(k))) out[k] = v;
  }
  return out;
}

/** Commands come from the project's own config file, so they run through the shell like a developer would type them. */
export const runShellCheck: CheckRunner = (cmd, cwd, signal) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    let output = '', timedOut = false, settled = false;
    const child = spawn(cmd, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: minimalEnv() });
    const keep = (d: Buffer) => { output = (output + d.toString()).slice(-OUTPUT_TAIL); };
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ ok: exitCode === 0 && !timedOut, exitCode, timedOut: timedOut || undefined, durationMs: Date.now() - t0, output: redactSecrets(output.trim()) });
    };
    const onAbort = () => killTree(child);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort);
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (e) => { output += `\n${e.message}`; finish(null); });
    child.on('close', (code) => finish(code));
  });
