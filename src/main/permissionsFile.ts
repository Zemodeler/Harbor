import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { neverAlwaysAllow } from './store';

/**
 * `.harbor/permissions.json`: {"allow": ["npm run lint"], "deny": ["git push"]}. Command prefixes for Bash, like the allow and deny lists
 * of Claude Code's settings.json. Read from the main checkout, never a helper's worktree, so an agent cannot widen its own rights.
 * `deny` only ever narrows, so it applies at once. `allow` widens: it is honoured only for the exact content the user approved
 * (`hash`), and never for a command a stored "always allow" rule could not cover either (shell chaining, deletes, network, publishing).
 */
export const PERMISSIONS_FILE = join('.harbor', 'permissions.json');
const MAX_ENTRIES = 50;
const MAX_LEN = 200;

export interface ProjectPermissions { allow: string[]; deny: string[]; hash: string }

const clean = (v: unknown): string[] => (Array.isArray(v) ? v : [])
  .filter((c): c is string => typeof c === 'string')
  .map((c) => c.trim())
  .filter((c) => c && c.length <= MAX_LEN && !/[\r\n\0]/.test(c))
  .slice(0, MAX_ENTRIES);

export function loadProjectPermissions(projectPath: string): ProjectPermissions {
  const none: ProjectPermissions = { allow: [], deny: [], hash: '' };
  const file = join(projectPath, PERMISSIONS_FILE);
  if (!existsSync(file)) return none;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { allow?: unknown; deny?: unknown };
    const deny = clean(j.deny);
    const allow = clean(j.allow).filter((c) => !/[;&|<>`$()]/.test(c) && !neverAlwaysAllow('Bash', { command: c }));
    return { allow, deny, hash: createHash('sha256').update(JSON.stringify({ allow, deny })).digest('hex') };
  } catch { return none; }
}

/** The deny entry that covers this Bash command, if any: the command (or a chained part of it) is the entry or starts with it plus a space. */
export function denyingEntry(deny: readonly string[], tool: string, input: unknown): string | undefined {
  const cmd = (input as { command?: unknown } | null)?.command;
  if (tool !== 'Bash' || typeof cmd !== 'string') return undefined;
  const parts = cmd.split(/&&|\|\||;|\|/).map((p) => p.trim().replace(/\s+/g, ' '));
  return deny.find((d) => parts.some((p) => p === d || p.startsWith(`${d} `)));
}
