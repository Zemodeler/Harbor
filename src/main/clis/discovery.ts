import { existsSync, statSync } from 'node:fs';
import { delimiter, join, posix, win32 } from 'node:path';
import type { CliId, CliStatus } from '../../shared/api';
import { quoteWinArg, runProcess, type Runner } from '../proc';
import { CLI_DEFINITIONS, type AuthState, type CliDefinition } from './registry';

/** `blocked`: why routing must not use this CLI although it is installed (a custom CLI whose file changed since the user approved it). */
export interface ResolvedCli extends CliStatus { path?: string; authState: AuthState; blocked?: string }

export interface DiscoveryDeps {
  run: Runner;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  isFile: (p: string) => boolean;
  definitions: CliDefinition[];
  /** Settings.cliPaths: executables the user chose in Settings (never read from a project folder). */
  cliPaths?: Record<CliId, string>;
}

export const isFilePath = (p: string): boolean => { try { return existsSync(p) && statSync(p).isFile(); } catch { return false; } };

export const defaultDiscoveryDeps = (cliPaths?: Record<CliId, string>): DiscoveryDeps => ({
  run: runProcess, env: process.env, platform: process.platform, definitions: CLI_DEFINITIONS, isFile: isFilePath, ...(cliPaths ? { cliPaths } : {})
});

/**
 * Why a Settings executable path is unacceptable as text (existence is checked separately). Quotes, `%` and line breaks would be
 * rejected by the .cmd launch quoting in proc.ts anyway; refusing them here gives a readable message at save time instead.
 */
export function cliPathProblem(p: unknown): string | undefined {
  if (typeof p !== 'string') return 'must be text';
  if (p.length > 1024) return 'is too long';
  if (/[\0\r\n"%]/.test(p)) return 'contains a quote, % or a line break';
  if (!win32.isAbsolute(p) && !posix.isAbsolute(p)) return 'must be an absolute path';
  return undefined;
}

/** Find an executable: the Settings path, the env override, PATH, then extra known dirs. Windows prefers .exe over .cmd. */
export function findExecutable(def: CliDefinition, d: Pick<DiscoveryDeps, 'env' | 'platform' | 'isFile' | 'cliPaths'>): string | undefined {
  // A custom CLI runs exactly the file the user approved: no Settings path, env var or PATH search can swap it.
  if (def.exe !== undefined) return d.isFile(def.exe) ? def.exe : undefined;
  const chosen = d.cliPaths?.[def.id];
  if (chosen && d.isFile(chosen)) return chosen;
  const override = d.env[def.envVar];
  if (override && d.isFile(override)) return override;
  const exts = d.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = [...(d.env['PATH'] ?? d.env['Path'] ?? '').split(delimiter).filter(Boolean), ...def.extraDirs()];
  for (const dir of dirs) for (const n of def.exeNames) for (const ext of exts) {
    const p = join(dir, n + ext);
    if (d.isFile(p)) return p;
  }
  return undefined;
}

export async function resolveCli(def: CliDefinition, deps: DiscoveryDeps = defaultDiscoveryDeps()): Promise<ResolvedCli> {
  const r = await resolveFound(def, deps);
  // A path chosen in Settings that is gone (an update moved the CLI) must not silently look like "not installed" or like the setting won.
  const chosen = def.exe === undefined ? deps.cliPaths?.[def.id] : undefined;
  if (!chosen || deps.isFile(chosen)) return r;
  const missing = `The path set in Settings is not an existing file: ${chosen}.`;
  return { ...r, note: r.installed ? `${missing} Using ${r.path} instead.${r.note ? ` ${r.note}` : ''}` : `${missing} ${r.note ?? ''}`.trim() };
}

async function resolveFound(def: CliDefinition, deps: DiscoveryDeps): Promise<ResolvedCli> {
  const base = { id: def.id, name: def.name, models: def.models, ...(def.features ? { features: def.features } : {}), ...(def.custom ? { custom: true } : {}) };
  const path = findExecutable(def, deps);
  if (!path && def.exe !== undefined) return { ...base, installed: false, signedIn: false, authState: 'unknown', note: `Not found: ${def.exe} is not an existing file. Edit this CLI in Settings.` };
  if (!path) return { ...base, installed: false, signedIn: false, authState: 'unknown', note: `Not installed. Looked on PATH and in: ${def.extraDirs().slice(0, 6).join('; ') || '(no known folders)'}` };

  const v = await deps.run(path, def.versionArgs, { timeoutMs: 15000, ...(def.env ? { env: def.env } : {}) });
  if (v.error || v.code !== 0) {
    return { ...base, path, installed: true, signedIn: false, authState: 'unknown', note: `Found at ${path} but it failed to run: ${v.error ?? (v.stderr.trim() || `exit ${v.code}`)}` };
  }
  const version = (v.stdout.match(/\d+\.\d+\.\d+[\w.\-]*/) ?? [])[0];

  let authState: AuthState = 'unknown';
  let note: string | undefined = def.noStatusNote;
  if (def.statusArgs && def.parseStatus) {
    const s = await deps.run(path, def.statusArgs, { timeoutMs: 20000, ...(def.env ? { env: def.env } : {}) });
    authState = s.error || s.timedOut ? 'unknown' : def.parseStatus(s);
    if (authState === 'unknown') note = 'Sign-in status could not be determined. Retry the check or open the CLI.';
    if (authState === 'signedOut') note = 'Installed, login required.';
  }
  return { ...base, path, installed: true, version, signedIn: authState === 'signedIn', authState, note };
}

export async function discoverClis(deps: DiscoveryDeps = defaultDiscoveryDeps()): Promise<ResolvedCli[]> {
  return Promise.all(deps.definitions.map((d) => resolveCli(d, deps)));
}

/** Strip main-process-only fields before sending to the renderer. */
export function toStatus(r: ResolvedCli): CliStatus {
  return { id: r.id, name: r.name, installed: r.installed, version: r.version, signedIn: r.signedIn, models: r.models, note: r.note, authState: r.authState,
    ...(r.features ? { features: r.features } : {}), ...(r.custom ? { custom: true } : {}) };
}

/** Open the CLI's own login flow in a visible terminal window. Never reads credentials. */
export function loginCommand(def: CliDefinition, path: string): string {
  // Custom CLIs bring their own login arguments: anything beyond plain words is quoted (and quotes or % refused) for cmd.exe.
  const args = def.loginArgs.length ? ' ' + def.loginArgs.map((a) => (/^[\w.:/=-]+$/.test(a) ? a : quoteWinArg(a))).join(' ') : '';
  return `start "Harbor: sign in to ${def.name}" cmd /k "${path}"${args}`;
}

