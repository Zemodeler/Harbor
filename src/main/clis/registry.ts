import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CliId } from '../../shared/api';

export type AuthState = 'signedIn' | 'signedOut' | 'unknown';

export interface CliDefinition {
  id: CliId;
  name: string;
  /** Executable base names to look for on PATH (PATHEXT is applied on Windows). */
  exeNames: string[];
  /** Env var that overrides the executable path (also used by tests and the smoke script). */
  envVar: string;
  /** Extra directories to search beyond PATH. */
  extraDirs: () => string[];
  versionArgs: string[];
  /** Non-interactive auth check. Absent means no supported way to check. */
  statusArgs?: string[];
  parseStatus?: (r: { code: number | null; stdout: string; stderr: string }) => AuthState;
  loginArgs: string[];
  models: string[];
  noStatusNote?: string;
}

const home = () => process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
const appData = () => process.env['APPDATA'] ?? '';

/** Claude desktop bundles claude.exe under %APPDATA%\Claude\claude-code\<ver>\<hash>\ (newest first). */
function bundledClaudeDirs(): string[] {
  const root = join(appData(), 'Claude', 'claude-code');
  try {
    return readdirSync(root).sort().reverse().flatMap((v) => {
      const vdir = join(root, v);
      try { return readdirSync(vdir).map((h) => join(vdir, h)); } catch { return []; }
    }).filter((d) => existsSync(d));
  } catch { return []; }
}

const text = (r: { stdout: string; stderr: string }) => `${r.stdout}\n${r.stderr}`.toLowerCase();

export const CLI_DEFINITIONS: CliDefinition[] = [
  {
    id: 'claude', name: 'Claude Code', exeNames: ['claude'], envVar: 'HARBOR_CLAUDE_PATH',
    extraDirs: () => [join(home(), '.local', 'bin'), join(home(), '.claude', 'local'), join(appData(), 'npm'), ...bundledClaudeDirs()],
    versionArgs: ['--version'],
    statusArgs: ['auth', 'status', '--json'],
    parseStatus: (r) => {
      try {
        const j = JSON.parse(r.stdout) as { loggedIn?: boolean };
        if (typeof j.loggedIn === 'boolean') return j.loggedIn ? 'signedIn' : 'signedOut';
      } catch { /* fall through */ }
      return 'unknown';
    },
    loginArgs: ['auth', 'login'],
    models: ['sonnet', 'opus', 'haiku']
  },
  {
    id: 'codex', name: 'Codex', exeNames: ['codex'], envVar: 'HARBOR_CODEX_PATH',
    extraDirs: () => [join(appData(), 'npm'), join(home(), '.local', 'bin')],
    versionArgs: ['--version'],
    statusArgs: ['login', 'status'],
    parseStatus: (r) => {
      const t = text(r);
      if (/not logged in|logged out|not signed in/.test(t)) return 'signedOut';
      if (r.code === 0 && /logged in|signed in/.test(t)) return 'signedIn';
      return 'unknown';
    },
    loginArgs: ['login'],
    // Codex picks its own default model; Harbor passes --model only when a name other than 'default' is chosen.
    models: ['default']
  },
  {
    id: 'gemini', name: 'Gemini CLI', exeNames: ['gemini'], envVar: 'HARBOR_GEMINI_PATH',
    extraDirs: () => [join(appData(), 'npm')],
    versionArgs: ['--version'],
    loginArgs: [],
    models: ['default'],
    noStatusNote: 'Gemini CLI has no non-interactive sign-in check; status is unknown. Terminal adapter only.'
  }
];
