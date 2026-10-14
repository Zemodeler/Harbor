import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CliArg, CliFeatures, CliTemplate, CustomCliDescriptor } from '../../shared/api';
import { NEEDS, TIERS, type CatalogEntry, type Need, type Tier } from './capabilities';
import { cliPathProblem } from './discovery';
import type { AuthState, CliDefinition } from './registry';

/**
 * Custom CLIs: a CLI described as data (plan section 2.2). Everything here is pure except the file helpers at the end, so the
 * descriptor rules can be tested without processes. A descriptor is only ever read from Harbor's data folder (custom-clis.json),
 * written from Settings; a project's .harbor folder can never add or change one.
 */

export const CUSTOM_CLIS_FILE = 'custom-clis.json';
/** Ids a custom CLI may not take: the built-in CLIs, Harbor's own runner and the test adapter. */
export const RESERVED_IDS = ['claude', 'codex', 'gemini', 'harbor', 'fake', 'auto'];
export const MAX_CUSTOM_CLIS = 20;

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Variables a descriptor (or an MCP server, mcp/registry.ts) may not set: they decide which programs run and how the shell resolves them. */
export const ENV_LOCKED =new Set(['path', 'pathext', 'comspec', 'systemroot', 'windir', 'node_options']);
const UNSAFE_TEXT = /[\0\r\n]/;
const PLACEHOLDER_RE = /\{([A-Za-z]+)\}/g;
/** Placeholders replaced inside an argument. */
const INLINE = ['model', 'effort', 'cwd', 'promptFile'] as const;
/** Placeholders that stand for a whole list of arguments and must be a whole argument on their own. */
export const SLOTS = ['resumeArgs', 'effortArgs', 'permissionArgs', 'imageArgs', 'readDirArgs', 'mcpArgs'] as const;
type Slot = typeof SLOTS[number];

/** Variables of the user's environment a custom CLI gets: what Windows programs and Node shims need to start, nothing that holds secrets. */
export const ENV_ALLOWLIST = ['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'OS', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'LANG', 'LC_ALL', 'TERM', 'NO_COLOR'];

/** The environment for a custom CLI: the allowlist (matched case-insensitively, as Windows does) plus what the user typed. */
export function customEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const allowed = new Set(ENV_ALLOWLIST.map((k) => k.toLowerCase()));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && allowed.has(k.toLowerCase())) out[k] = v;
  for (const [k, v] of Object.entries(extra ?? {})) if (!ENV_LOCKED.has(k.toLowerCase())) out[k] = v;
  return out;
}

// ---------------------------------------------------------------- JSON paths ($.a.b[0].c), no code and no eval

export type PathSeg = string | number;

export function parseJsonPath(p: string): PathSeg[] | undefined {
  if (typeof p !== 'string' || !p.startsWith('$') || p.length > 200) return undefined;
  const segs: PathSeg[] = [];
  const re = /\.([A-Za-z0-9_-]+)|\[(\d{1,6})\]/y;
  re.lastIndex = 1;
  while (re.lastIndex < p.length) {
    const m = re.exec(p);
    if (!m) return undefined;
    segs.push(m[1] !== undefined ? m[1] : Number(m[2]));
  }
  return segs;
}

export function readJsonPath(v: unknown, segs: PathSeg[]): unknown {
  let cur = v;
  for (const s of segs) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (typeof s === 'number') { if (!Array.isArray(cur)) return undefined; cur = cur[s]; }
    // Own properties only: a path must never reach the prototype chain.
    else { if (Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, s)) return undefined; cur = (cur as Record<string, unknown>)[s]; }
  }
  return cur;
}

/** `$.path` (truthy) or `$.path==literal` (a JSON literal, or plain text). */
export interface DoneTest { path: PathSeg[]; equals?: unknown }

export function parseDoneTest(expr: string): DoneTest | undefined {
  const i = expr.indexOf('==');
  const path = parseJsonPath((i < 0 ? expr : expr.slice(0, i)).trim());
  if (!path) return undefined;
  if (i < 0) return { path };
  const raw = expr.slice(i + 2).trim();
  if (!raw) return undefined;
  let equals: unknown = raw;
  try { equals = JSON.parse(raw); } catch { /* plain text literal */ }
  return { path, equals };
}

export function matchesDone(event: unknown, t: DoneTest): boolean {
  const v = readJsonPath(event, t.path);
  return 'equals' in t ? v === t.equals : !!v;
}

// ---------------------------------------------------------------- argument templates

export interface ArgVars { model: string; effort: string; cwd: string; promptFile?: string; sessionId?: string }
export type SlotValues = Partial<Record<Slot, string[]>>;

const fill = (s: string, vars: Record<string, string | undefined>): { text: string; empty: boolean } => {
  let empty = false;
  const text = s.replace(PLACEHOLDER_RE, (whole, name: string) => {
    if (!(name in vars)) return whole;
    const v = vars[name] ?? '';
    if (!v) empty = true;
    return v;
  });
  return { text, empty };
};

/**
 * Expands a descriptor's arguments. Each value lands inside ONE argv element (never split or re-parsed by Harbor), so a model
 * name or folder with spaces or quotes cannot add arguments. A group (string[]) is dropped whole when any placeholder in it is
 * empty; a lone argument whose placeholder is empty is dropped too. Slots expand to their list in place; slots the template does
 * not mention are appended at the end in SLOTS order.
 */
export function expandArgs(args: readonly CliArg[], vars: ArgVars, slots: SlotValues = {}): string[] {
  const out: string[] = [];
  const used = new Set<Slot>();
  const v: Record<string, string | undefined> = { model: vars.model, effort: vars.effort, cwd: vars.cwd, promptFile: vars.promptFile, sessionId: vars.sessionId };
  for (const a of args) {
    if (typeof a === 'string') {
      const slot = slotOf(a);
      if (slot) { used.add(slot); out.push(...(slots[slot] ?? [])); continue; }
      const f = fill(a, v);
      if (!f.empty || !hasPlaceholder(a)) out.push(f.text);
      continue;
    }
    const filled = a.map((x) => fill(x, v));
    if (filled.every((f) => !f.empty)) out.push(...filled.map((f) => f.text));
  }
  for (const s of SLOTS) if (!used.has(s)) out.push(...(slots[s] ?? []));
  return out;
}

const slotOf = (a: string): Slot | undefined => { const m = /^\{([A-Za-z]+)\}$/.exec(a); return m && (SLOTS as readonly string[]).includes(m[1]!) ? m[1] as Slot : undefined; };
const hasPlaceholder = (a: string) => /\{(model|effort|cwd|promptFile|sessionId)\}/.test(a);

// ---------------------------------------------------------------- validation

export interface ValidationContext {
  /** Ids already used by other custom CLIs (the one being edited excluded). */
  otherIds: readonly string[];
  isFile: (p: string) => boolean;
  isDirectory?: (p: string) => boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Checks a descriptor and returns a clean copy (unknown fields dropped), or every problem found. Pure apart from the injected file checks. */
export function validateDescriptor(raw: unknown, ctx: ValidationContext): { descriptor?: CustomCliDescriptor; problems: string[] } {
  const problems: string[] = [];
  const p = (s: string) => { problems.push(s); };
  if (!isObj(raw)) return { problems: ['The descriptor must be an object.'] };
  const id = raw['id'], name = raw['name'], exe = raw['exe'];
  if (typeof id !== 'string' || !ID_RE.test(id)) p('id must be 2-32 lowercase letters, digits or dashes, starting with a letter.');
  else if (RESERVED_IDS.includes(id)) p(`id "${id}" is taken by a built-in CLI.`);
  else if (ctx.otherIds.includes(id)) p(`id "${id}" is already used by another custom CLI.`);
  if (typeof name !== 'string' || !name.trim() || name.length > 60 || UNSAFE_TEXT.test(name)) p('name must be 1-60 characters on one line.');
  const exeProblem = cliPathProblem(exe);
  if (exeProblem) p(`exe ${exeProblem}.`);
  else if (ctx.isDirectory?.(exe as string)) p('exe is a folder; choose the program file inside it.');
  else if (!ctx.isFile(exe as string)) p(`exe ${exe as string} is not an existing file.`);

  const argList = (v: unknown, where: string, allowGroups: boolean, allowed: readonly string[]): CliArg[] | undefined => {
    if (!Array.isArray(v) || v.length > 64) { p(`${where} must be a list of at most 64 arguments.`); return undefined; }
    const out: CliArg[] = [];
    for (const a of v) {
      if (allowGroups && Array.isArray(a)) {
        if (!a.length || a.length > 8 || a.some((x) => !argOk(x, where, allowed, false))) { if (!a.length || a.length > 8) p(`${where}: a group must hold 1-8 arguments.`); return undefined; }
        out.push(a.map(String));
      } else if (argOk(a, where, allowed, true)) out.push(a as string);
      else return undefined;
    }
    return out;
  };
  const argOk = (a: unknown, where: string, allowed: readonly string[], slotOk: boolean): boolean => {
    if (typeof a !== 'string' || a.length > 2000 || UNSAFE_TEXT.test(a)) { p(`${where}: every argument must be text on one line (at most 2000 characters).`); return false; }
    const slot = slotOf(a);
    if (slot) {
      if (!slotOk || !allowed.includes(slot)) { p(`${where}: {${slot}} must be a whole argument of run.args.`); return false; }
      return true;
    }
    for (const m of a.matchAll(PLACEHOLDER_RE)) {
      if (!allowed.includes(m[1]!)) { p(`${where}: unknown or misplaced placeholder {${m[1]}}.`); return false; }
    }
    return true;
  };
  const flagList = (v: unknown, where: string, allowed: readonly string[] = []): string[] | undefined => {
    const l = argList(v, where, false, allowed);
    return l as string[] | undefined;
  };

  const out: Partial<CustomCliDescriptor> = { id: id as string, name: typeof name === 'string' ? name.trim() : '', exe: typeof exe === 'string' ? exe.trim() : '' };
  const cmd = (key: 'version' | 'login') => {
    const c = raw[key];
    if (c === undefined) return;
    if (!isObj(c)) { p(`${key} must be { "args": [...] }.`); return; }
    const args = flagList(c['args'], `${key}.args`);
    if (args) out[key] = { args };
  };
  cmd('version'); cmd('login');
  const st = raw['status'];
  if (st !== undefined) {
    if (!isObj(st)) p('status must be { "args": [...], "signedInExit"?, "signedOutPattern"? }.');
    else {
      const args = flagList(st['args'], 'status.args');
      const exit = st['signedInExit'], pat = st['signedOutPattern'];
      if (exit !== undefined && !(typeof exit === 'number' && Number.isInteger(exit) && exit >= 0 && exit <= 255)) p('status.signedInExit must be a whole number from 0 to 255.');
      if (pat !== undefined && (typeof pat !== 'string' || !pat.trim() || pat.length > 200 || UNSAFE_TEXT.test(pat))) p('status.signedOutPattern must be plain text of at most 200 characters.');
      if (args) out.status = { args, ...(typeof exit === 'number' ? { signedInExit: exit } : {}), ...(typeof pat === 'string' && pat.trim() ? { signedOutPattern: pat.trim() } : {}) };
    }
  }

  const run = raw['run'];
  if (!isObj(run)) p('run must be an object with at least "args".');
  else {
    const prompt = run['prompt'] ?? 'stdin';
    if (prompt !== 'stdin' && prompt !== 'file') p('run.prompt must be "stdin" or "file".');
    const inline = prompt === 'file' ? [...INLINE] : INLINE.filter((x) => x !== 'promptFile');
    const args = argList(run['args'], 'run.args', true, [...inline, ...SLOTS]);
    if (args && prompt === 'file' && !JSON.stringify(args).includes('{promptFile}')) p('run.args must contain {promptFile} when run.prompt is "file".');
    const r: CustomCliDescriptor['run'] = { args: args ?? [], ...(prompt === 'file' ? { prompt: 'file' as const } : {}) };
    const env = run['env'];
    if (env !== undefined) {
      if (!isObj(env) || Object.keys(env).length > 32) p('run.env must map at most 32 variable names to text.');
      else {
        const e: Record<string, string> = {};
        for (const [k, v] of Object.entries(env)) {
          if (!ENV_KEY_RE.test(k)) p(`run.env: "${k}" is not a valid variable name.`);
          else if (ENV_LOCKED.has(k.toLowerCase())) p(`run.env: ${k} cannot be changed for a custom CLI.`);
          else if (typeof v !== 'string' || v.length > 4096 || v.includes('\0')) p(`run.env.${k} must be text of at most 4096 characters.`);
          else e[k] = v;
        }
        if (Object.keys(e).length) r.env = e;
      }
    }
    const output = run['output'];
    if (output !== undefined) {
      if (!isObj(output) || (output['format'] !== 'text' && output['format'] !== 'jsonl')) p('run.output.format must be "text" or "jsonl".');
      else if (output['format'] === 'text') r.output = { format: 'text' };
      else {
        const map = output['map'];
        const m: NonNullable<NonNullable<CustomCliDescriptor['run']['output']>['map']> = {};
        if (!isObj(map)) p('run.output.map is required for jsonl output (at least "text").');
        else {
          for (const k of ['text', 'session', 'error'] as const) {
            const v = map[k];
            if (v === undefined) continue;
            if (typeof v !== 'string' || !parseJsonPath(v)) p(`run.output.map.${k} must be a path like $.message.text.`);
            else m[k] = v;
          }
          if (map['done'] !== undefined) {
            if (typeof map['done'] !== 'string' || !parseDoneTest(map['done'])) p('run.output.map.done must be a path like $.type==result.');
            else m.done = map['done'];
          }
          const u = map['usage'];
          if (u !== undefined) {
            if (!isObj(u)) p('run.output.map.usage must be { "input"?, "output"? }.');
            else {
              const usage: { input?: string; output?: string } = {};
              for (const k of ['input', 'output'] as const) {
                const v = u[k];
                if (v === undefined) continue;
                if (typeof v !== 'string' || !parseJsonPath(v)) p(`run.output.map.usage.${k} must be a path like $.usage.input_tokens.`);
                else usage[k] = v;
              }
              if (usage.input || usage.output) m.usage = usage;
            }
          }
          if (!m.text && !problems.some((x) => x.startsWith('run.output.map.text'))) p('run.output.map.text is required for jsonl output.');
        }
        r.output = { format: 'jsonl', map: m };
      }
    }
    const resume = run['resume'];
    if (resume !== undefined) {
      if (!isObj(resume)) p('run.resume must be { "args": [...] }.');
      else {
        const ra = argList(resume['args'], 'run.resume.args', true, [...inline, 'sessionId']);
        if (ra && !JSON.stringify(ra).includes('{sessionId}')) p('run.resume.args must contain {sessionId}.');
        if (ra) r.resume = { args: ra };
      }
    }
    const levels = (key: 'effort' | 'permissions', names: readonly string[]) => {
      const v = run[key];
      if (v === undefined) return undefined;
      if (!isObj(v)) { p(`run.${key} must map ${names.join(', ')} to argument lists.`); return undefined; }
      const o: Record<string, string[]> = {};
      for (const [k, list] of Object.entries(v)) {
        if (!names.includes(k)) { p(`run.${key}: unknown key "${k}" (use ${names.join(', ')}).`); continue; }
        const l = flagList(list, `run.${key}.${k}`);
        if (l) o[k] = l;
      }
      return o;
    };
    const effort = levels('effort', ['low', 'medium', 'high']);
    if (effort && Object.keys(effort).length) r.effort = effort;
    const perms = levels('permissions', ['read-only', 'edit', 'full']);
    if (perms && Object.keys(perms).length) r.permissions = perms;
    const image = run['image'];
    if (image !== undefined) {
      if (!isObj(image)) p('run.image must be { "args": [...] } with {path}.');
      else {
        const ia = flagList(image['args'], 'run.image.args', ['path']);
        if (ia && !ia.some((a) => a.includes('{path}'))) p('run.image.args must contain {path}.');
        else if (ia) r.image = { args: ia };
      }
    }
    const readDir = run['readDir'];
    if (readDir !== undefined) {
      if (!isObj(readDir)) p('run.readDir must be { "args": [...] } with {path}.');
      else {
        const da = flagList(readDir['args'], 'run.readDir.args', ['path']);
        if (da && !da.some((a) => a.includes('{path}'))) p('run.readDir.args must contain {path}.');
        else if (da) r.readDir = { args: da };
      }
    }
    const mcp = run['mcp'];
    if (mcp !== undefined) {
      if (!isObj(mcp)) p('run.mcp must be { "args": [...] } with {mcpConfigFile}.');
      else {
        const ma = flagList(mcp['args'], 'run.mcp.args', ['mcpConfigFile']);
        if (ma && !ma.some((a) => a.includes('{mcpConfigFile}'))) p('run.mcp.args must contain {mcpConfigFile}.');
        else if (ma) r.mcp = { args: ma };
      }
    }
    out.run = r;
  }

  const models = raw['models'];
  if (models !== undefined) {
    if (!Array.isArray(models) || !models.length || models.length > 20) p('models must be a list of 1 to 20 entries.');
    else {
      const seen = new Set<string>();
      const list: NonNullable<CustomCliDescriptor['models']> = [];
      models.forEach((m, i) => {
        if (!isObj(m) || typeof m['id'] !== 'string' || !m['id'].trim() || m['id'].length > 100 || UNSAFE_TEXT.test(m['id'])) { p(`models[${i}].id must be a model name.`); return; }
        const mid = m['id'].trim();
        if (seen.has(mid)) { p(`models: "${mid}" is listed twice.`); return; }
        seen.add(mid);
        const tier = m['tier'] ?? 'standard';
        if (!TIERS.includes(tier as Tier)) { p(`models[${i}].tier must be one of ${TIERS.join(', ')}.`); return; }
        const strengths = m['strengths'] ?? [];
        if (!Array.isArray(strengths) || strengths.some((x) => !NEEDS.includes(x as Need))) { p(`models[${i}].strengths must use ${NEEDS.join(', ')}.`); return; }
        list.push({ id: mid, tier: tier as Tier, strengths: [...new Set(strengths as string[])] });
      });
      if (list.length) out.models = list;
    }
  }
  if (raw['acceptReadOnlyRisk'] !== undefined) {
    if (typeof raw['acceptReadOnlyRisk'] !== 'boolean') p('acceptReadOnlyRisk must be true or false.');
    else if (raw['acceptReadOnlyRisk']) out.acceptReadOnlyRisk = true;
  }
  return problems.length ? { problems } : { descriptor: out as CustomCliDescriptor, problems };
}

// ---------------------------------------------------------------- derived views

export const hasReadOnlyMode = (d: CustomCliDescriptor): boolean => !!d.run.permissions?.['read-only'];

export function featuresOf(d: CustomCliDescriptor): CliFeatures {
  const jsonl = d.run.output?.format === 'jsonl';
  return {
    images: !!d.run.image, resume: !!d.run.resume && jsonl && !!d.run.output?.map?.session, structuredOutput: jsonl,
    permissionModes: !!d.run.permissions && Object.keys(d.run.permissions).length > 0, readOnly: hasReadOnlyMode(d),
    // MCP: Harbor writes its registry to a per-run file when the descriptor says how to pass one (run.mcp). No native skills
    // materializer for custom CLIs, and a custom CLI never reports quota.
    mcp: !!d.run.mcp, nativeSkills: false, usageReadings: false
  };
}

/** Sign-in status from the descriptor's own rules: the signed-out text wins, then the exit code; anything else is unknown. */
export function customStatus(d: CustomCliDescriptor, r: { code: number | null; stdout: string; stderr: string }): AuthState {
  const st = d.status;
  if (!st) return 'unknown';
  if (st.signedOutPattern && `${r.stdout}\n${r.stderr}`.toLowerCase().includes(st.signedOutPattern.toLowerCase())) return 'signedOut';
  if (st.signedInExit !== undefined) return r.code === st.signedInExit ? 'signedIn' : st.signedOutPattern ? 'unknown' : 'signedOut';
  return 'unknown';
}

export function definitionOf(d: CustomCliDescriptor): CliDefinition {
  return {
    id: d.id, name: d.name, exeNames: [], envVar: '', extraDirs: () => [], exe: d.exe, custom: true, features: featuresOf(d), env: customEnv(process.env, d.run.env),
    versionArgs: d.version?.args ?? ['--version'],
    ...(d.status ? { statusArgs: d.status.args, parseStatus: (r) => customStatus(d, r) } : {}),
    loginArgs: d.login?.args ?? [],
    models: (d.models ?? [{ id: 'default' }]).map((m) => m.id),
    ...(d.status ? {} : { noStatusNote: 'This custom CLI has no sign-in check; status is unknown.' })
  };
}

/** Catalog entries for the descriptor's models. A custom CLI has no quota pool of its own beyond `<id>:all` and no readings. */
export function catalogEntriesOf(d: CustomCliDescriptor): CatalogEntry[] {
  return (d.models ?? [{ id: 'default', tier: 'standard' as Tier, strengths: [] }]).map((m) => ({
    cli: d.id, model: m.id, tier: (m.tier ?? 'standard') as Tier, strengths: (m.strengths ?? []) as Need[], note: `custom CLI ${d.name}`
  }));
}

/** Built-in templates. Only CLIs whose flags were checked with `--help` ship here (none is installed on the build machine yet). */
export const CLI_TEMPLATES: CliTemplate[] = [
  {
    id: 'plain-text', name: 'Plain text CLI (start here)',
    description: 'Reads the prompt on stdin and prints its answer as plain text. Fill in the program and its print/headless flag, then run the dry run.',
    descriptor: { id: 'mycli', name: 'My CLI', version: { args: ['--version'] }, run: { args: [], prompt: 'stdin', output: { format: 'text' } }, models: [{ id: 'default', tier: 'standard', strengths: ['chat', 'code'] }] }
  },
  {
    id: 'jsonl-events', name: 'JSON-lines CLI',
    description: 'Prints one JSON event per line. Map where the text, the session id, the final event and the token counts are; resume is used only when a session id is mapped.',
    descriptor: {
      id: 'mycli', name: 'My CLI', version: { args: ['--version'] },
      run: { args: ['--output-format', 'jsonl'], prompt: 'stdin', output: { format: 'jsonl', map: { text: '$.text', session: '$.session_id', done: '$.type==result', error: '$.error', usage: { input: '$.usage.input_tokens', output: '$.usage.output_tokens' } } }, resume: { args: ['--resume', '{sessionId}'] } },
      models: [{ id: 'default', tier: 'standard', strengths: ['chat', 'code'] }]
    }
  }
];

// ---------------------------------------------------------------- files (data folder only)

export interface LoadedCustomClis { clis: CustomCliDescriptor[]; warnings: string[] }

/** Reads custom-clis.json. Invalid or duplicate entries are dropped with a warning; approval fields are kept as stored. */
export function loadCustomClis(file: string | undefined, ctx: Omit<ValidationContext, 'otherIds'>): LoadedCustomClis {
  if (!file || !existsSync(file)) return { clis: [], warnings: [] };
  let j: unknown;
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return { clis: [], warnings: [`${CUSTOM_CLIS_FILE} is not valid JSON (${e instanceof Error ? e.message : String(e)}); no custom CLI is loaded`] }; }
  const list = isObj(j) && Array.isArray(j['clis']) ? j['clis'] : undefined;
  if (!list) return { clis: [], warnings: [`${CUSTOM_CLIS_FILE} must be { "clis": [...] }; no custom CLI is loaded`] };
  const clis: CustomCliDescriptor[] = [], warnings: string[] = [];
  // A missing executable is reported by discovery ("not found"), not by dropping the CLI the user added.
  const lenient = { ...ctx, isFile: () => true, isDirectory: () => false };
  for (const [i, raw] of list.slice(0, MAX_CUSTOM_CLIS).entries()) {
    const v = validateDescriptor(raw, { ...lenient, otherIds: clis.map((c) => c.id) });
    if (!v.descriptor) { warnings.push(`${CUSTOM_CLIS_FILE} entry ${i + 1} dropped: ${v.problems.join(' ')}`); continue; }
    const r = raw as Record<string, unknown>;
    clis.push({ ...v.descriptor, ...(typeof r['approvedHash'] === 'string' ? { approvedHash: r['approvedHash'] } : {}), ...(typeof r['approvedAt'] === 'number' ? { approvedAt: r['approvedAt'] } : {}) });
  }
  return { clis, warnings };
}

export function saveCustomClis(file: string, clis: CustomCliDescriptor[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, clis }, null, 2));
  renameSync(tmp, file);
}

/** sha256 of a file, streamed (a CLI binary can be hundreds of MB). */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** Size and mtime of a file, to skip re-hashing an unchanged binary on every discovery. */
export const fileStamp = (path: string): string | undefined => { try { const s = statSync(path); return `${s.size}:${s.mtimeMs}`; } catch { return undefined; } };
