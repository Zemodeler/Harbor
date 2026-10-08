import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { CliStatus } from '../../shared/api';
import { runProcess, type Runner } from '../proc';
import { CLI_DEFINITIONS, type AuthState, type CliDefinition } from './registry';

export interface ResolvedCli extends CliStatus { path?: string; authState: AuthState }

export interface DiscoveryDeps {
  run: Runner;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  isFile: (p: string) => boolean;
  definitions: CliDefinition[];
}

const defaultDeps = (): DiscoveryDeps => ({
  run: runProcess, env: process.env, platform: process.platform, definitions: CLI_DEFINITIONS,
  isFile: (p) => { try { return existsSync(p) && statSync(p).isFile(); } catch { return false; } }
});

/** Find an executable by env override, PATH, then extra known dirs. Windows prefers .exe over .cmd. */
export function findExecutable(def: CliDefinition, d: Pick<DiscoveryDeps, 'env' | 'platform' | 'isFile'>): string | undefined {
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

export async function resolveCli(def: CliDefinition, deps: DiscoveryDeps = defaultDeps()): Promise<ResolvedCli> {
  const base = { id: def.id, name: def.name, models: def.models };
  const path = findExecutable(def, deps);
  if (!path) return { ...base, installed: false, signedIn: false, authState: 'unknown', note: `Not installed. Looked on PATH and in: ${def.extraDirs().slice(0, 6).join('; ') || '(no known folders)'}` };

  const v = await deps.run(path, def.versionArgs, { timeoutMs: 15000 });
  if (v.error || v.code !== 0) {
    return { ...base, path, installed: true, signedIn: false, authState: 'unknown', note: `Found at ${path} but it failed to run: ${v.error ?? (v.stderr.trim() || `exit ${v.code}`)}` };
  }
  const version = (v.stdout.match(/\d+\.\d+\.\d+[\w.\-]*/) ?? [])[0];

  let authState: AuthState = 'unknown';
  let note: string | undefined = def.noStatusNote;
  if (def.statusArgs && def.parseStatus) {
    const s = await deps.run(path, def.statusArgs, { timeoutMs: 20000 });
    authState = s.error || s.timedOut ? 'unknown' : def.parseStatus(s);
    if (authState === 'unknown') note = 'Sign-in status could not be determined. Retry the check or open the CLI.';
    if (authState === 'signedOut') note = 'Installed, login required.';
  }
  return { ...base, path, installed: true, version, signedIn: authState === 'signedIn', authState, note };
}

export async function discoverClis(deps: DiscoveryDeps = defaultDeps()): Promise<ResolvedCli[]> {
  return Promise.all(deps.definitions.map((d) => resolveCli(d, deps)));
}

/** Strip main-process-only fields before sending to the renderer. */
export function toStatus(r: ResolvedCli): CliStatus {
  return { id: r.id, name: r.name, installed: r.installed, version: r.version, signedIn: r.signedIn, models: r.models, note: r.note, authState: r.authState };
}

/** Open the CLI's own login flow in a visible terminal window. Never reads credentials. */
export function loginCommand(def: CliDefinition, path: string): string {
  const args = def.loginArgs.length ? ' ' + def.loginArgs.join(' ') : '';
  return `start "Harbor: sign in to ${def.name}" cmd /k "${path}"${args}`;
}

