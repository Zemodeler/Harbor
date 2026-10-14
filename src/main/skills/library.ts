import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Id, Skill, SkillDetail, SkillFile, SkillImportCandidate, SkillImportPreview, SkillImportSource, SkillSource } from '../../shared/api';
import { MAX_SKILL_MD_BYTES, SKILL_FILE, isScriptPath, parseSkillMd, safeFolderName } from './format';
import { planDelivery, type Delivery, type SkillAccess } from './delivery';
import { describeGitHub, downloadGitHub, listGitHub, parseGitHubRef, type FetchLike, type GitHubEntry, type GitHubListing, type GitHubRef } from './github';
import { ZipRefused, checkArchivePath, fmtBytes, readZip } from './zip';

/**
 * Skills (plan section 3): where they come from, who uses them, and importing them. A skill is prompt text plus possible
 * scripts written by someone else: Harbor reads it as data, never runs anything in it, and only hands an agent its name,
 * description and path (or, for a CLI that cannot open the folder, the SKILL.md text).
 *
 * Sources: the Harbor library (`<data>\skills`, the only place Harbor writes), the project's `.harbor\skills` (committable),
 * and read-only discovery of the CLIs' own folders:
 * - Claude Code: `~\.claude\skills\<name>\SKILL.md` and `<project>\.claude\skills\<name>`. Claude loads direct children
 *   natively (verified: the folder exists on the build machine; Claude Code's documented layout). Deeper folders (the desktop
 *   app's `skills\synced\<id>\<name>`) are listed too but not treated as native: NOT verified that Claude Code reads them.
 * - Codex: `$CODEX_HOME\skills` (default `~\.codex\skills`). Verified on codex-cli 0.162.0-alpha.17.2 from the binary's own
 *   strings ("$CODEX_HOME/skills", "~/.codex/skills", the skills feature flags) and a real folder of SKILL.md skills; Codex reads
 *   nested folders (its bundled `.system\<name>` skills), so anything under it counts as native. `.system` and other dot folders
 *   are Codex's built-ins and are not listed. NOT used: a repository-level `.agents\skills` folder seen only as a string in the
 *   binary.
 * Symbolic links and junctions are never followed, and a skill that contains one is not used.
 */

export interface SkillHomes { /** ~/.claude */ claude?: string; /** CODEX_HOME, default ~/.codex */ codex?: string }
export interface SkillPrefs { global: Record<string, boolean>; projects: Record<Id, Record<string, boolean>> }
export interface SkillImportRecord { source: string; hash: string; importedAt: number }
/** The parts of the Store skills need (persisted in state.json). */
export interface SkillState {
  skillPrefs(): SkillPrefs;
  setSkillPref(skillId: string, enabled: boolean | null, projectId?: Id): void;
  skillImports(): Record<string, SkillImportRecord>;
  setSkillImport(folder: string, rec: SkillImportRecord | null): void;
}

export const LIMITS = {
  /** Per import: what may land in the library. */
  maxFiles: 200, maxFileBytes: 1024 * 1024, maxTotalBytes: 5 * 1024 * 1024, maxSkills: 50,
  /** A .zip file may hold more than the skills (a repository download), so it gets its own, larger caps. */
  maxArchiveBytes: 20 * 1024 * 1024, maxArchiveEntries: 2000, maxArchiveContent: 20 * 1024 * 1024,
  /** Folder walks stop after this many entries (an import source, or a discovered skills folder). */
  maxWalk: 5000
};
const DEFAULT_ON: Record<SkillSource, boolean> = { library: true, project: true, claude: false, codex: false };
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn']);
const STAGE_TTL_MS = 30 * 60_000;
const MAX_STAGES = 6;

interface Scanned { skill: Skill; mdBytes: number; md: string }
interface StagedSkill extends SkillImportCandidate { data?: Map<string, Buffer> }
interface Stage { id: string; at: number; source: string; kind: SkillImportSource['kind']; skills: StagedSkill[]; github?: { ref: GitHubRef; listing: GitHubListing }; downloaded?: boolean }

export interface SkillManagerOptions {
  /** `<data>\skills`; undefined = no library (in-memory tests): nothing can be imported. */
  libraryDir?: string;
  homes?: SkillHomes;
  state: SkillState;
  fetch?: FetchLike;
  now?: () => number;
}

const toPosix = (p: string) => p.split(sep).join('/');
const isInside = (child: string, parent: string): boolean => {
  const r = relative(resolve(parent), resolve(child));
  return !r || (!r.startsWith('..') && !isAbsolute(r));
};
const lst = (p: string) => { try { return lstatSync(p); } catch { return undefined; } };
const isRegularFile = (p: string) => !!lst(p)?.isFile();
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** sha256 over the sorted (path, content hash) pairs: the same files give the same hash on any machine. */
export function hashFiles(files: Array<{ path: string; data: Buffer }>): string {
  return sha256([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => `${f.path}\0${sha256(f.data)}\n`).join(''));
}

/** Every file under a folder (relative posix paths), without following links. `links` lists links met on the way. */
function walk(root: string, max: number): { files: Array<{ path: string; bytes: number }>; links: string[]; truncated: boolean } {
  const files: Array<{ path: string; bytes: number }> = [], links: string[] = [];
  const stack = [''];
  let seen = 0;
  while (stack.length) {
    const rel = stack.pop()!;
    let entries: Dirent[];
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > max) return { files, links, truncated: true };
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { links.push(r); continue; }
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(r); continue; }
      if (!e.isFile()) { links.push(r); continue; } // sockets, devices, reparse points Node cannot classify: never read
      let bytes = 0;
      try { bytes = lstatSync(join(root, r)).size; } catch { /* vanished */ }
      files.push({ path: r, bytes });
    }
  }
  return { files, links, truncated: false };
}

/** The skill folders of a file list: folders holding SKILL.md (outermost wins; a root SKILL.md makes the whole source one skill). */
export function findSkillDirs(paths: string[], maxDepth = 4): string[] {
  const dirs = paths.filter((p) => p === SKILL_FILE || p.endsWith(`/${SKILL_FILE}`)).map((p) => p.slice(0, -SKILL_FILE.length).replace(/\/$/, ''))
    .filter((d) => (d ? d.split('/').length : 0) <= maxDepth && !d.split('/').some((s) => s.startsWith('.') && s !== '.claude' && s !== '.harbor'))
    .sort((a, b) => a.length - b.length);
  const out: string[] = [];
  for (const d of dirs) if (!out.some((o) => o === '' || d === o || d.startsWith(`${o}/`))) out.push(d);
  return out.sort();
}

export class SkillManager {
  private stages = new Map<string, Stage>();
  private runCache = new Map<string, { at: number; skills: Scanned[] }>();
  constructor(private o: SkillManagerOptions) {}

  get libraryDir(): string | undefined { return this.o.libraryDir; }
  private now(): number { return (this.o.now ?? Date.now)(); }

  // ------------------------------------------------------------------ discovery

  private roots(project?: { id: Id; path: string }): Array<{ root: string; source: SkillSource; prefix: string; depth: number }> {
    const r: Array<{ root: string; source: SkillSource; prefix: string; depth: number }> = [];
    if (this.o.libraryDir) r.push({ root: this.o.libraryDir, source: 'library', prefix: '', depth: 1 });
    if (project) r.push({ root: join(project.path, '.harbor', 'skills'), source: 'project', prefix: '', depth: 2 });
    if (this.o.homes?.claude) r.push({ root: join(this.o.homes.claude, 'skills'), source: 'claude', prefix: 'user/', depth: 3 });
    if (project) r.push({ root: join(project.path, '.claude', 'skills'), source: 'claude', prefix: 'project/', depth: 2 });
    if (this.o.homes?.codex) r.push({ root: join(this.o.homes.codex, 'skills'), source: 'codex', prefix: 'user/', depth: 3 });
    return r;
  }

  private scanRoot(root: string, source: SkillSource, prefix: string, maxDepth: number): Scanned[] {
    const st = lst(root);
    if (!st?.isDirectory()) return [];
    const out: Scanned[] = [];
    const imports = source === 'library' ? this.o.state.skillImports() : {};
    const stack: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 1 }];
    let seen = 0;
    while (stack.length && out.length < 200) {
      const { rel, depth } = stack.pop()!;
      let entries: Dirent[];
      try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { continue; }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (++seen > LIMITS.maxWalk) break;
        if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        const dir = join(root, r);
        if (isRegularFile(join(dir, SKILL_FILE))) out.push(this.describe(dir, `${source}:${prefix}${r}`, source, imports[r]));
        else if (depth < maxDepth) stack.push({ rel: r, depth: depth + 1 });
      }
    }
    return out;
  }

  private describe(dir: string, id: string, source: SkillSource, rec?: SkillImportRecord): Scanned {
    const mdPath = join(dir, SKILL_FILE);
    let mdBytes = 0, md = '';
    const problems: string[] = [];
    try { mdBytes = statSync(mdPath).size; } catch { /* listed below */ }
    if (mdBytes <= MAX_SKILL_MD_BYTES) { try { md = readFileSync(mdPath, 'utf8'); } catch { problems.push('SKILL.md could not be read.'); } }
    const parsed = parseSkillMd(md, basename(dir), mdBytes);
    problems.push(...parsed.problems);
    const w = walk(dir, 1000);
    if (w.links.length) problems.push(`It contains a link or special file (${w.links[0]}); Harbor does not use skills with links.`);
    if (w.truncated) problems.push('It holds more than 1000 files.');
    const skill: Skill = {
      id, name: parsed.name, description: parsed.description, source, path: dir, readOnly: source !== 'library',
      enabled: false, defaultEnabled: DEFAULT_ON[source],
      files: w.files.length, bytes: w.files.reduce((n, f) => n + f.bytes, 0), hasScripts: w.files.some((f) => isScriptPath(f.path)),
      ...(rec ? { hash: rec.hash, importedFrom: rec.source, importedAt: rec.importedAt } : {}),
      ...(problems.length ? { problems } : {})
    };
    return { skill, mdBytes, md };
  }

  private scanAll(project?: { id: Id; path: string }): Scanned[] {
    return this.roots(project).flatMap((r) => this.scanRoot(r.root, r.source, r.prefix, r.depth));
  }

  private withChoice(s: Scanned[], projectId?: Id): Skill[] {
    const prefs = this.o.state.skillPrefs();
    return s.map(({ skill }) => {
      const def = prefs.global[skill.id] ?? DEFAULT_ON[skill.source];
      const chosen = projectId ? prefs.projects[projectId]?.[skill.id] ?? def : def;
      return { ...skill, defaultEnabled: def, enabled: chosen && !skill.problems?.length };
    });
  }

  list(project?: { id: Id; path: string }): Skill[] { return this.withChoice(this.scanAll(project), project?.id); }

  private find(skillId: string, project?: { id: Id; path: string }): Scanned {
    const s = this.scanAll(project).find((x) => x.skill.id === skillId);
    if (!s) throw new Error(project ? 'That skill is no longer available.' : 'That skill is no longer available (project skills need their project).');
    return s;
  }

  read(skillId: string, project?: { id: Id; path: string }): SkillDetail {
    const s = this.find(skillId, project);
    const [skill] = this.withChoice([s], project?.id);
    const w = walk(skill!.path, 1000);
    const fileList: SkillFile[] = w.files.sort((a, b) => a.path.localeCompare(b.path)).map((f) => ({ path: f.path, bytes: f.bytes, ...(isScriptPath(f.path) ? { script: true } : {}) }));
    let currentHash: string | undefined;
    if (skill!.source === 'library' && !w.links.length && !w.truncated && skill!.bytes <= LIMITS.maxTotalBytes) {
      try { currentHash = hashFiles(w.files.map((f) => ({ path: f.path, data: readFileSync(join(skill!.path, ...f.path.split('/'))) }))); } catch { /* changed while reading */ }
    }
    const truncated = s.mdBytes > MAX_SKILL_MD_BYTES;
    return {
      ...skill!, text: truncated ? '' : s.md, ...(truncated ? { truncated: true } : {}), fileList,
      ...(currentHash ? { currentHash } : {}), ...(currentHash && skill!.hash ? { modified: currentHash !== skill!.hash } : {})
    };
  }

  setEnabled(skillId: string, enabled: boolean | null, project?: { id: Id; path: string }): Skill[] {
    if (typeof skillId !== 'string' || !/^(library|project|claude|codex):[^\0\r\n]{1,300}$/.test(skillId)) throw new Error('Unknown skill.');
    if (enabled !== null && typeof enabled !== 'boolean') throw new Error('enabled must be true, false or null.');
    this.find(skillId, project);
    this.o.state.setSkillPref(skillId, enabled, project?.id);
    this.runCache.clear();
    return this.list(project);
  }

  remove(skillId: string): Skill[] {
    const m = /^library:([a-z0-9-]{1,64})$/.exec(typeof skillId === 'string' ? skillId : '');
    if (!m || !this.o.libraryDir) throw new Error('Only skills in Harbor\'s library can be removed; other sources belong to the project or another tool.');
    const dir = join(this.o.libraryDir, m[1]!);
    const st = lst(dir);
    if (!st?.isDirectory() || !isInside(dir, this.o.libraryDir) || resolve(dir) === resolve(this.o.libraryDir)) throw new Error('That skill is no longer in the library.');
    rmSync(dir, { recursive: true, force: true });
    this.o.state.setSkillImport(m[1]!, null);
    this.o.state.setSkillPref(skillId, null);
    for (const pid of Object.keys(this.o.state.skillPrefs().projects)) this.o.state.setSkillPref(skillId, null, pid);
    this.runCache.clear();
    return this.list();
  }

  // ------------------------------------------------------------------ delivery to a run

  /**
   * The skills section for one run of `cli` in `cwd`, and the folders it must be able to read. Undefined when nothing applies.
   * `native` says whether that CLI loads its own skills folder (CliFeatures.nativeSkills).
   */
  forRun(project: { id: Id; path: string }, cli: string, cwd: string, access: SkillAccess, native: boolean): { delivery: Delivery } | undefined {
    const key = project.id;
    const cached = this.runCache.get(key);
    const scanned = cached && this.now() - cached.at < 3000 ? cached.skills : this.scanAll(project);
    if (!cached || cached.skills !== scanned) this.runCache.set(key, { at: this.now(), skills: scanned });
    const enabled = new Set(this.withChoice(scanned, project.id).filter((s) => s.enabled).map((s) => s.id));
    const usable = scanned.filter((s) => enabled.has(s.skill.id));
    if (!usable.length) return undefined;
    // A project skill (or Claude project skill) also present in the run's own checkout (a worktree of a commit that has it) is used from there.
    const relocate = (p: string): string => {
      if (resolve(cwd) === resolve(project.path) || !isInside(p, project.path)) return p;
      const local = join(cwd, relative(project.path, p));
      return isRegularFile(join(local, SKILL_FILE)) ? local : p;
    };
    const nativeRoots = !native ? [] : cli === 'claude' ? this.o.homes?.claude ? [join(this.o.homes.claude, 'skills'), join(cwd, '.claude', 'skills')] : [join(cwd, '.claude', 'skills')]
      : cli === 'codex' && this.o.homes?.codex ? [join(this.o.homes.codex, 'skills')] : [];
    const isNative = (path: string): boolean => cli === 'codex'
      ? nativeRoots.some((r) => isInside(path, r))
      : nativeRoots.some((r) => resolve(dirname(path)).toLowerCase() === resolve(r).toLowerCase());
    const bySkill = new Map(usable.map((s) => [s.skill.id, s]));
    const delivery = planDelivery({
      skills: usable.map((s) => ({ id: s.skill.id, name: s.skill.name, description: s.skill.description, path: relocate(s.skill.path), mdBytes: s.mdBytes })),
      cwd, access,
      isNative: (s) => isNative(s.path),
      inside: (dir, c) => isInside(dir, c),
      readText: (s) => bySkill.get(s.id)?.md || undefined,
      fileOf: (s) => join(s.path, SKILL_FILE)
    });
    return delivery.listed.length || delivery.inline.length || delivery.unavailable.length ? { delivery } : undefined;
  }

  // ------------------------------------------------------------------ import

  private sweep(): void {
    const t = this.now();
    for (const [k, s] of this.stages) if (t - s.at > STAGE_TTL_MS) this.stages.delete(k);
    while (this.stages.size >= MAX_STAGES) this.stages.delete(this.stages.keys().next().value!);
  }

  private libraryFolders(): Set<string> {
    if (!this.o.libraryDir) return new Set();
    try { return new Set(readdirSync(this.o.libraryDir).map((n) => n.toLowerCase())); } catch { return new Set(); }
  }

  /** Library folder names for these candidates: the skill's name, suffixed -2, -3... when taken (name collisions keep both). */
  private assignTargets(cands: StagedSkill[]): void {
    const taken = this.libraryFolders();
    for (const c of cands) {
      const base = safeFolderName(c.name);
      let name = base;
      for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base.slice(0, 60)}-${i}`;
      taken.add(name.toLowerCase());
      c.targetName = name;
    }
  }

  /** Candidates from a list of relative file paths and a reader for the files of the chosen skill folders. */
  private candidates(paths: Array<{ path: string; bytes: number; executable?: boolean; link?: boolean }>, rootName: string, read: ((dir: string, files: string[]) => Map<string, Buffer>) | undefined): { skills: StagedSkill[]; problems: string[]; warnings: string[] } {
    const problems: string[] = [], warnings: string[] = [];
    const dirs = findSkillDirs(paths.filter((p) => !p.link).map((p) => p.path));
    if (!dirs.length) return { skills: [], problems: ['No SKILL.md was found (a skill is a folder with a SKILL.md, at the top or up to four folders deep).'], warnings };
    if (dirs.length > LIMITS.maxSkills) return { skills: [], problems: [`It holds ${dirs.length} skills; at most ${LIMITS.maxSkills} can be imported at once. Pick a folder further down.`], warnings };
    const skills: StagedSkill[] = [];
    let files = 0, total = 0;
    for (const dir of dirs) {
      const prefix = dir ? `${dir}/` : '';
      const mine = paths.filter((p) => p.path.startsWith(prefix) && !dirs.some((o) => o !== dir && o.length > dir.length && p.path.startsWith(`${o}/`)));
      const own: SkillFile[] = mine.map((p) => ({ path: p.path.slice(prefix.length), bytes: p.bytes, ...(isScriptPath(p.path.slice(prefix.length), p.executable) ? { script: true } : {}) }));
      const cprob: string[] = [];
      const link = mine.find((p) => p.link);
      if (link) cprob.push(`It contains a link or special file (${link.path}); links are not imported.`);
      const big = own.find((f) => f.bytes > LIMITS.maxFileBytes);
      if (big) cprob.push(`${big.path} is larger than ${fmtBytes(LIMITS.maxFileBytes)}.`);
      const bytes = own.reduce((n, f) => n + f.bytes, 0);
      files += own.length; total += bytes;
      skills.push({ name: dir ? basename(dir) : rootName, description: '', dir, targetName: '', files: own, bytes, hasScripts: own.some((f) => f.script), ...(cprob.length ? { problems: cprob } : {}) });
    }
    if (files > LIMITS.maxFiles) problems.push(`The skills hold ${files} files; at most ${LIMITS.maxFiles} can be imported at once.`);
    if (total > LIMITS.maxTotalBytes) problems.push(`The skills add up to ${fmtBytes(total)}; at most ${fmtBytes(LIMITS.maxTotalBytes)} can be imported at once.`);
    if (!problems.length && read) {
      for (const c of skills) {
        if (c.problems?.length) continue;
        const prefix = c.dir ? `${c.dir}/` : '';
        let data: Map<string, Buffer>;
        try { data = read(c.dir, c.files.map((f) => prefix + f.path)); } catch (e) { (c.problems ??= []).push(e instanceof Error ? e.message : String(e)); continue; }
        this.fill(c, data, prefix);
      }
    }
    for (const c of skills) if (c.hasScripts) warnings.push(`${c.name} contains scripts or programs (${c.files.filter((f) => f.script).slice(0, 3).map((f) => f.path).join(', ')}). Harbor never runs them; an agent could run them only through its normal tool permissions.`);
    this.assignTargets(skills);
    return { skills, problems, warnings };
  }

  /** Parses SKILL.md from the read files and records the hash. `prefix` is the skill folder inside the source. */
  private fill(c: StagedSkill, data: Map<string, Buffer>, prefix: string): void {
    const own = new Map<string, Buffer>();
    for (const [p, b] of data) own.set(p.startsWith(prefix) ? p.slice(prefix.length) : p, b);
    const md = own.get(SKILL_FILE);
    const parsed = parseSkillMd(md ? md.toString('utf8') : '', c.name, md?.length ?? 0);
    c.name = parsed.name; c.description = parsed.description;
    c.text = md && md.length <= MAX_SKILL_MD_BYTES ? md.toString('utf8') : '';
    c.hash = hashFiles([...own].map(([path, d]) => ({ path, data: d })));
    c.data = own;
    if (parsed.problems.length) (c.problems ??= []).push(...parsed.problems);
  }

  private stage(kind: SkillImportSource['kind'], source: string, r: { skills: StagedSkill[]; problems: string[]; warnings: string[] }, extra: Partial<Stage> = {}): SkillImportPreview {
    this.sweep();
    const usable = !r.problems.length && r.skills.some((s) => !s.problems?.length);
    let token: string | undefined;
    if (usable) { token = randomUUID(); this.stages.set(token, { id: token, at: this.now(), source, kind, skills: r.skills, ...extra }); }
    return {
      ...(token ? { token } : {}), source, ...(extra.github && !extra.downloaded ? { needsDownload: true } : {}),
      fileCount: r.skills.reduce((n, s) => n + s.files.length, 0), totalBytes: r.skills.reduce((n, s) => n + s.bytes, 0),
      skills: r.skills.map(({ data: _d, ...c }) => c),
      ...(r.problems.length ? { problems: r.problems } : {}), ...(r.warnings.length ? { warnings: r.warnings } : {})
    };
  }

  async preview(src: SkillImportSource, opts: { confirmDownload?: string } = {}, signal?: AbortSignal): Promise<SkillImportPreview> {
    if (!src || typeof src !== 'object') throw new Error('Choose a folder, a .zip file or a GitHub address.');
    if (src.kind === 'folder') return this.previewFolder(src.path);
    if (src.kind === 'zip') return this.previewZip(src.path);
    if (src.kind === 'github') return this.previewGitHub(src.ref, opts.confirmDownload, signal);
    throw new Error('Choose a folder, a .zip file or a GitHub address.');
  }

  private absolutePath(p: unknown, what: string): string {
    if (typeof p !== 'string' || !p.trim() || /[\0\r\n]/.test(p) || !isAbsolute(p.trim())) throw new Error(`Choose the ${what} by its full path.`);
    return resolve(p.trim());
  }

  private previewFolder(p: unknown): SkillImportPreview {
    const root = this.absolutePath(p, 'folder');
    const st = lst(root);
    if (!st) throw new Error(`${root} does not exist.`);
    if (st.isSymbolicLink()) return this.stage('folder', root, { skills: [], problems: ['That folder is a link; choose the folder it points to.'], warnings: [] });
    if (!st.isDirectory()) throw new Error(`${root} is not a folder.`);
    if (this.o.libraryDir && isInside(root, this.o.libraryDir)) throw new Error('That folder is already in Harbor\'s library.');
    const w = walk(root, LIMITS.maxWalk);
    const list = [...w.files, ...w.links.map((l) => ({ path: l, bytes: 0, link: true }))];
    const r = this.candidates(list, basename(root), (_dir, files) => {
      const out = new Map<string, Buffer>();
      for (const f of files) {
        const full = join(root, ...f.split('/'));
        // Checked again right before reading: a file swapped for a link since the walk is refused, not followed.
        const s = lst(full);
        if (!s?.isFile()) throw new Error(`${f} changed while it was being read.`);
        if (s.size > LIMITS.maxFileBytes) throw new Error(`${f} is larger than ${fmtBytes(LIMITS.maxFileBytes)}.`);
        out.set(f, readFileSync(full));
      }
      return out;
    });
    if (w.truncated) r.problems.push(`The folder holds more than ${LIMITS.maxWalk} entries; choose the skill's own folder.`);
    return this.stage('folder', root, r);
  }

  private previewZip(p: unknown): SkillImportPreview {
    const file = this.absolutePath(p, '.zip file');
    const st = lst(file);
    if (!st?.isFile()) throw new Error(`${file} is not a file.`);
    if (st.size > LIMITS.maxArchiveBytes) return this.stage('zip', file, { skills: [], problems: [`The archive is larger than ${fmtBytes(LIMITS.maxArchiveBytes)}.`], warnings: [] });
    let files;
    try { files = readZip(readFileSync(file), { maxEntries: LIMITS.maxArchiveEntries, maxFileBytes: LIMITS.maxFileBytes, maxTotalBytes: LIMITS.maxArchiveContent, maxArchiveBytes: LIMITS.maxArchiveBytes }); }
    catch (e) { if (e instanceof ZipRefused) return this.stage('zip', file, { skills: [], problems: [e.message], warnings: [] }); throw e; }
    const byPath = new Map(files.map((f) => [f.path, f]));
    const r = this.candidates(files.map((f) => ({ path: f.path, bytes: f.data.length, executable: f.executable })), basename(file).replace(/\.zip$/i, ''),
      (_dir, list) => new Map(list.map((f) => [f, byPath.get(f)!.data])));
    return this.stage('zip', file, r);
  }

  private async previewGitHub(refText: unknown, confirm: string | undefined, signal?: AbortSignal): Promise<SkillImportPreview> {
    if (!this.o.fetch) throw new Error('Importing from GitHub is not available here.');
    const ref = parseGitHubRef(typeof refText === 'string' ? refText : '');
    if ('why' in ref) throw new Error(ref.why);
    const rootName = ref.path ? ref.path.split('/').pop()! : ref.repo;
    if (confirm === undefined) {
      // Step 1 (a click): names and sizes only. The user sees the source pinned to one commit, the file count and the size first.
      const listing = await listGitHub(this.o.fetch, ref, signal);
      const r = this.candidates(listing.entries, rootName, undefined);
      return this.stage('github', describeGitHub(listing), r, { github: { ref, listing } });
    }
    // Step 2 (a second click, naming the listing): download exactly the listed files of the skills found, at that commit.
    const st = typeof confirm === 'string' ? this.stages.get(confirm) : undefined;
    if (!st?.github || st.downloaded) throw new Error('That GitHub listing has expired. Check the address again first.');
    if (st.github.ref.owner.toLowerCase() !== ref.owner.toLowerCase() || st.github.ref.repo.toLowerCase() !== ref.repo.toLowerCase() || st.github.ref.path !== ref.path || st.github.ref.ref !== ref.ref) throw new Error('The address changed since it was checked. Check it again first.');
    this.stages.delete(confirm);
    const listing = st.github.listing;
    const byPath = new Map<string, GitHubEntry>(listing.entries.map((e) => [e.path, e]));
    const wanted = st.skills.filter((s) => !s.problems?.length).flatMap((s) => s.files.map((f) => byPath.get(s.dir ? `${s.dir}/${f.path}` : f.path)!));
    const data = await downloadGitHub(this.o.fetch, listing, wanted, LIMITS.maxFileBytes, signal);
    for (const s of st.skills) {
      if (s.problems?.length) continue;
      const prefix = s.dir ? `${s.dir}/` : '';
      this.fill(s, new Map(s.files.map((f) => [prefix + f.path, data.get(prefix + f.path)!])), prefix);
    }
    const warnings = st.skills.filter((s) => s.hasScripts).map((c) => `${c.name} contains scripts or programs (${c.files.filter((f) => f.script).slice(0, 3).map((f) => f.path).join(', ')}). Harbor never runs them; an agent could run them only through its normal tool permissions.`);
    this.assignTargets(st.skills);
    return this.stage('github', st.source, { skills: st.skills, problems: [], warnings }, { github: st.github, downloaded: true });
  }

  /**
   * A skill's files for a Harbor bundle (plan section 6.1): a usable skill only (no links, no problems), within the import caps, so
   * the other side can import it. `folder` is a safe name for the bundle; nothing of the absolute path goes along.
   */
  exportFiles(skillId: string, project?: { id: Id; path: string }): { name: string; folder: string; files: Array<{ path: string; data: Buffer }> } {
    const s = this.find(skillId, project);
    if (s.skill.problems?.length) throw new Error(`${s.skill.name} cannot be exported: ${s.skill.problems.join(' ')}`);
    const w = walk(s.skill.path, LIMITS.maxFiles + 1);
    if (w.links.length || w.truncated || w.files.length > LIMITS.maxFiles) throw new Error(`${s.skill.name} cannot be exported: it has links or more than ${LIMITS.maxFiles} files.`);
    if (w.files.reduce((n, f) => n + f.bytes, 0) > LIMITS.maxTotalBytes) throw new Error(`${s.skill.name} is larger than ${fmtBytes(LIMITS.maxTotalBytes)}.`);
    const files = w.files.sort((a, b) => a.path.localeCompare(b.path)).map((f) => {
      const full = join(s.skill.path, ...f.path.split('/'));
      const st = lst(full);
      if (!st?.isFile() || st.size > LIMITS.maxFileBytes) throw new Error(`${s.skill.name}: ${f.path} changed or is larger than ${fmtBytes(LIMITS.maxFileBytes)}.`);
      return { path: f.path, data: readFileSync(full) };
    });
    return { name: s.skill.name, folder: safeFolderName(s.skill.name), files };
  }

  /** Stages skills found in files from another container (a Harbor bundle) with the same checks as a .zip import. Writes nothing. */
  previewFiles(source: string, files: Array<{ path: string; data: Buffer }>): SkillImportPreview {
    const byPath = new Map<string, Buffer>();
    const problems: string[] = [];
    for (const f of files) {
      const ok = checkArchivePath(f.path);
      if (!ok.path || ok.path.endsWith('/')) { problems.push(`It contains ${ok.why ?? 'a folder entry'}.`); continue; }
      byPath.set(ok.path, f.data);
    }
    if (problems.length) return this.stage('zip', source, { skills: [], problems, warnings: [] });
    const r = this.candidates([...byPath].map(([path, data]) => ({ path, bytes: data.length })), basename(source), (_dir, list) => new Map(list.map((p) => [p, byPath.get(p)!])));
    return this.stage('zip', source, r);
  }

  /** Writes a checked preview into the library. Each skill goes to a temp folder first and is renamed into place. */
  importStaged(token: string, names?: string[]): Skill[] { return this.importStagedDetailed(token, names).skills; }

  /** importStaged, plus which library skill each imported source folder became (`dir` inside the source -> new skill id). */
  importStagedDetailed(token: string, names?: string[]): { skills: Skill[]; byDir: Record<string, string> } {
    if (!this.o.libraryDir) throw new Error('Harbor has no library folder here.');
    const st = typeof token === 'string' ? this.stages.get(token) : undefined;
    if (!st) throw new Error('That import preview has expired. Check the source again.');
    if (st.github && !st.downloaded) throw new Error('Download the files first: only names and sizes are known.');
    if (names !== undefined && (!Array.isArray(names) || names.some((n) => typeof n !== 'string'))) throw new Error('names must be a list of skill names.');
    const chosen = st.skills.filter((s) => !s.problems?.length && s.data && (!names || names.includes(s.name) || names.includes(s.targetName)));
    if (!chosen.length) throw new Error('None of the chosen skills can be imported.');
    this.stages.delete(token);
    mkdirSync(this.o.libraryDir, { recursive: true });
    this.assignTargets(chosen); // the library may have changed since the preview
    const done: string[] = [];
    const byDir: Record<string, string> = {};
    for (const c of chosen) {
      const tmp = join(this.o.libraryDir, `.import-${randomUUID()}`);
      try {
        for (const [p, data] of c.data!) {
          const ok = checkArchivePath(p);
          const dest = resolve(tmp, ...(ok.path ?? '').split('/'));
          if (!ok.path || !isInside(dest, tmp) || dest === resolve(tmp)) throw new Error(`Refused path ${p}.`);
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, data, { flag: 'wx' });
        }
        renameSync(tmp, join(this.o.libraryDir, c.targetName));
      } catch (e) {
        try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort: only Harbor's own temp folder */ }
        throw e;
      }
      this.o.state.setSkillImport(c.targetName, { source: c.dir ? `${st.source} (${c.dir})` : st.source, hash: c.hash!, importedAt: this.now() });
      done.push(`library:${c.targetName}`);
      byDir[c.dir] = `library:${c.targetName}`;
    }
    this.runCache.clear();
    return { skills: this.list().filter((s) => done.includes(s.id)), byDir };
  }
}
