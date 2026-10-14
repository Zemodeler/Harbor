import type { AgentRole, CliId, EffortPolicy, Id, LowAllowancePolicy, ProjectSettings, RolePreference, Settings } from '../../shared/api';

/**
 * Port of `normalizeSettingsPatch` and the merge in `Store.setSettings` (src/main/store.ts), so the demo rejects
 * and clamps exactly what Harbor does. Keep the messages identical: the UI shows them as they are.
 */
const CONCURRENCY_RANGE = [1, 8] as const, RESERVE_RANGE = [0, 50] as const;
const HELPER_ROLES = ['planner', 'implementer', 'reviewer', 'other'] as const;
const EFFORT_POLICIES: readonly EffortPolicy[] = ['adaptive', 'conserve', 'quality'];
const LOW_ALLOWANCE_POLICIES: readonly LowAllowancePolicy[] = ['reduceEffort', 'switch'];
const SCOPED_KEYS = ['concurrencyLimit', 'allowedModels', 'rolePreferences', 'effortPolicy', 'lowAllowancePolicy', 'subscriptionReserve'] as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function clampInt(v: unknown, [lo, hi]: readonly [number, number], name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a number.`);
  return Math.min(hi, Math.max(lo, Math.round(v)));
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], name: string): T {
  if (!allowed.includes(v as T)) throw new Error(`${name} must be one of: ${allowed.join(', ')}.`);
  return v as T;
}
const cleanName = (v: unknown, name: string): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`${name} must be text.`);
  return v.trim() || undefined;
};
function allowedModels(v: unknown): Record<CliId, string[]> | undefined {
  if (!isObj(v)) throw new Error('allowedModels must map a CLI id to a list of model names.');
  const out: Record<CliId, string[]> = {};
  for (const [cli, list] of Object.entries(v)) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error(`allowedModels.${cli} must be a list of model names.`);
    const names = [...new Set(list.map(m => cleanName(m, `allowedModels.${cli}`)).filter((m): m is string => !!m))];
    if (names.length) out[cli] = names;
  }
  return Object.keys(out).length ? out : undefined;
}
function rolePreferences(v: unknown): Settings['rolePreferences'] {
  if (!isObj(v)) throw new Error('rolePreferences must map a role to { cli, model }.');
  const out: Partial<Record<Exclude<AgentRole, 'main'>, RolePreference>> = {};
  for (const role of HELPER_ROLES) {
    const p = v[role];
    if (p === undefined) continue;
    if (!isObj(p)) throw new Error(`rolePreferences.${role} must be { cli, model }.`);
    const cli = cleanName(p['cli'], `rolePreferences.${role}.cli`), model = cleanName(p['model'], `rolePreferences.${role}.model`);
    if (cli || model) out[role] = { ...(cli ? { cli } : {}), ...(model ? { model } : {}) };
  }
  return Object.keys(out).length ? out : undefined;
}
function scoped(v: Record<string, unknown>): ProjectSettings {
  const out: ProjectSettings = {};
  const has = (k: string) => k in v;
  if (has('concurrencyLimit')) out.concurrencyLimit = v['concurrencyLimit'] === undefined ? undefined : clampInt(v['concurrencyLimit'], CONCURRENCY_RANGE, 'concurrencyLimit');
  if (has('subscriptionReserve')) out.subscriptionReserve = v['subscriptionReserve'] === undefined ? undefined : clampInt(v['subscriptionReserve'], RESERVE_RANGE, 'subscriptionReserve');
  if (has('effortPolicy')) out.effortPolicy = v['effortPolicy'] === undefined ? undefined : oneOf(v['effortPolicy'], EFFORT_POLICIES, 'effortPolicy');
  if (has('lowAllowancePolicy')) out.lowAllowancePolicy = v['lowAllowancePolicy'] === undefined ? undefined : oneOf(v['lowAllowancePolicy'], LOW_ALLOWANCE_POLICIES, 'lowAllowancePolicy');
  if (has('allowedModels')) out.allowedModels = v['allowedModels'] === undefined ? undefined : allowedModels(v['allowedModels']);
  if (has('rolePreferences')) out.rolePreferences = v['rolePreferences'] === undefined ? undefined : rolePreferences(v['rolePreferences']);
  return out;
}

export function normalizeSettingsPatch(patch: Partial<Settings>): Partial<Settings> {
  if (!isObj(patch)) throw new Error('Settings must be an object.');
  const out: Partial<Settings> = { ...patch, ...scoped(patch as Record<string, unknown>) };
  if ('keepRunningInBackground' in patch && patch.keepRunningInBackground !== undefined && typeof patch.keepRunningInBackground !== 'boolean') throw new Error('keepRunningInBackground must be a boolean.');
  if ('claudeOwnMcp' in patch && patch.claudeOwnMcp !== undefined && typeof patch.claudeOwnMcp !== 'boolean') throw new Error('claudeOwnMcp must be a boolean.');
  if ('editor' in patch && patch.editor !== undefined && !['code', 'code-insiders', 'cursor', 'windsurf'].includes(patch.editor)) throw new Error('editor must be one of code, code-insiders, cursor, windsurf.');
  if ('cliPaths' in patch) {
    const cp: unknown = patch.cliPaths;
    if (cp !== undefined && !isObj(cp)) throw new Error('cliPaths must map a CLI id to an executable path.');
    const map: Record<CliId, string> = {};
    for (const [cli, v] of Object.entries(cp ?? {})) {
      const p = typeof v === 'string' ? v.trim() : v;
      if (p === undefined || p === '') { map[cli] = ''; continue; }
      const problem = typeof p !== 'string' ? 'must be text' : p.length > 1024 ? 'is too long' : /[\0\r\n"%]/.test(p) ? 'contains a quote, % or a line break' : !/^([a-zA-Z]:[\\/]|[\\/])/.test(p) ? 'must be an absolute path' : undefined;
      if (problem) throw new Error(`cliPaths.${cli} ${problem}.`);
      map[cli] = p as string;
    }
    out.cliPaths = map;
  }
  if ('projectOverrides' in patch) {
    const po: unknown = patch.projectOverrides;
    if (po === undefined) out.projectOverrides = undefined;
    else {
      if (!isObj(po)) throw new Error('projectOverrides must map a project id to its settings.');
      const map: Record<Id, ProjectSettings> = {};
      for (const [id, o] of Object.entries(po)) {
        if (o !== undefined && !isObj(o)) throw new Error(`projectOverrides.${id} must be an object.`);
        map[id] = o ? Object.fromEntries(Object.entries(scoped(o)).filter(([, x]) => x !== undefined)) : {};
      }
      out.projectOverrides = map;
    }
  }
  return out;
}

/** Validates, then merges like `Store.setSettings`: an entry replaces a project's overrides, empty ones are removed, `undefined` resets. */
export function applySettingsPatch(cur: Settings, patch: Partial<Settings>): Settings {
  const p = normalizeSettingsPatch(patch);
  const next: Settings = { ...cur, ...p, cliOverrides: { ...cur.cliOverrides, ...(p.cliOverrides ?? {}) } };
  if ('projectOverrides' in p && p.projectOverrides) {
    const merged: Record<Id, ProjectSettings> = { ...(cur.projectOverrides ?? {}) };
    for (const [id, o] of Object.entries(p.projectOverrides)) { if (o && Object.keys(o).length) merged[id] = o; else delete merged[id]; }
    next.projectOverrides = merged;
  }
  if ('cliPaths' in p) {
    const merged: Record<CliId, string> = { ...(cur.cliPaths ?? {}) };
    for (const [cli, path] of Object.entries(p.cliPaths ?? {})) { if (path) merged[cli] = path; else delete merged[cli]; }
    if (Object.keys(merged).length) next.cliPaths = merged; else delete next.cliPaths;
  }
  for (const k of [...SCOPED_KEYS, 'projectOverrides'] as const) {
    if (next[k] === undefined || (k === 'projectOverrides' && !Object.keys(next[k]!).length)) delete next[k];
  }
  return next;
}
