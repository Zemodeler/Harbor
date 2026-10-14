import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CliFeatures, CliId } from '../../shared/api';

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
  /** Custom CLIs: the one approved executable. Set = no Settings path, env var or PATH search (exeNames/envVar are unused). */
  exe?: string;
  /** What Harbor can use on this CLI (shown in Settings; a missing feature changes what Harbor does, it never blocks routing). */
  features?: CliFeatures;
  custom?: boolean;
  /** Environment for the version and status checks (custom CLIs: the allowlist plus the user's own values); absent = Harbor's. */
  env?: NodeJS.ProcessEnv;
}

const NO_FEATURES: CliFeatures = { images: false, resume: false, structuredOutput: false, permissionModes: false, readOnly: false, mcp: false, nativeSkills: false, usageReadings: false };

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

/** Codex desktop bundles codex.exe under %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\. */
function bundledCodexDirs(): string[] {
  const root = join(process.env['LOCALAPPDATA'] ?? '', 'OpenAI', 'Codex', 'bin');
  try { return readdirSync(root).map((h) => join(root, h)).filter((d) => existsSync(d)); } catch { return []; }
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
    models: ['sonnet', 'opus', 'haiku'],
    // Images are passed but a real vision run is unverified (docs/limitations.md); MCP is the CLI's own. Native skills: ~/.claude/skills
    // and <cwd>/.claude/skills, which Harbor then does not list again (skills/library.ts).
    features: { images: true, resume: true, structuredOutput: true, permissionModes: true, readOnly: true, mcp: true, nativeSkills: true, usageReadings: true }
  },
  {
    id: 'codex', name: 'Codex', exeNames: ['codex'], envVar: 'HARBOR_CODEX_PATH',
    extraDirs: () => [join(appData(), 'npm'), join(home(), '.local', 'bin'), ...bundledCodexDirs()],
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
    models: ['default'],
    // --image is unverified (adapters/codex.ts). Native skills: $CODEX_HOME/skills (default ~/.codex/skills), seen in codex-cli
    // 0.162.0-alpha.17.2's own strings and as a real folder of SKILL.md skills (skills/library.ts); Harbor then does not list those
    // skills to Codex again. Not verified by a model run. Limits come from its logs.
    features: { images: true, resume: true, structuredOutput: true, permissionModes: true, readOnly: true, mcp: true, nativeSkills: true, usageReadings: true }
  },
  {
    id: 'gemini', name: 'Gemini CLI', exeNames: ['gemini'], envVar: 'HARBOR_GEMINI_PATH',
    extraDirs: () => [join(appData(), 'npm')],
    versionArgs: ['--version'],
    loginArgs: [],
    models: ['default'],
    features: NO_FEATURES,
    noStatusNote: 'Gemini CLI has no non-interactive sign-in check; status is unknown. Terminal adapter only.'
  }
];
