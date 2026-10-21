import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CloneProjectDraft, NewProjectDraft, ProjectTemplate } from '../shared/api';
import { Git, isInside, remoteUrlProblem } from './git';
import type { GitHub } from './github';
import { CHECKS_FILE } from './checks';
import { projectPathRefusal } from './projectPath';
import type { TemplateLibrary } from './templateLibrary';
import { normPath } from './store';
import { TEMPLATES, templateFiles } from './templates';

const RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** A folder name from what the owner typed: no characters Windows refuses, no reserved device names, no trailing dots or spaces. Undefined when nothing usable is left. */
export function sanitizeFolderName(raw: string): string | undefined {
  let s = String(raw ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').replace(/^[. ]+/, '').slice(0, 80).replace(/[. ]+$/, '');
  if (!s || /^-+$/.test(s)) return undefined;
  if (RESERVED.test(s.split('.')[0]!)) s = `${s}-project`;
  return s;
}

/** The GitHub repository name for a folder name: letters, digits, dots, dashes, underscores. */
export const repoNameFor = (folder: string): string => folder.replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+/, '').replace(/-{2,}/g, '-').slice(0, 100) || 'project';

export interface CreateDeps {
  git: Git;
  gh: GitHub;
  /** Where a project goes when the draft names no parent (Settings.projectsDir or the default). */
  defaultParent: string;
  /** Harbor's own folders: a new project is never made inside them. */
  harborRoots: string[];
  /** Paths of projects already registered, so a folder one of them uses is not taken twice. */
  isRegistered: (path: string) => boolean;
  /** The user's templates (draft.userTemplate). */
  templates?: TemplateLibrary;
}

/** Where a new project's folder goes, after every safety check; `undo` removes exactly what the caller makes there (never a pre-existing folder). */
export function prepareTarget(folder: string, parentDir: string | undefined, deps: CreateDeps): { target: string; parent: string; existed: boolean; undo: () => void } {
  const parent = resolve(parentDir?.trim() || deps.defaultParent);
  if (!parentDir?.trim()) mkdirSync(parent, { recursive: true });
  const parentRefusal = projectPathRefusal(parent);
  if (parentRefusal) throw new Error(parentRefusal);
  const target = join(parent, folder);
  for (const root of deps.harborRoots) if (normPath(root) === normPath(target) || isInside(target, root)) throw new Error("Harbor's own data folder cannot hold a project. Choose another location.");
  if (deps.isRegistered(target)) throw new Error('A project already uses this folder.');

  const existed = existsSync(target);
  if (existed) {
    let isDir = false;
    try { isDir = statSync(target).isDirectory(); } catch { /* unreadable */ }
    if (!isDir) throw new Error(`A file named ${folder} already exists in ${parent}.`);
    if (readdirSync(target).length) throw new Error(`The folder ${target} already exists and is not empty. Choose another name or location.`);
  }
  // From here on, undo exactly what the caller made.
  const undo = () => {
    try {
      if (!existed) rmSync(target, { recursive: true, force: true, maxRetries: 3 });
      else for (const e of readdirSync(target)) rmSync(join(target, e), { recursive: true, force: true, maxRetries: 3 });
    } catch { /* leftovers are reported by the caller's error text */ }
  };
  return { target, parent, existed, undo };
}

export interface CreatedFolder { path: string; name: string; remote?: string; warnings: string[]; /** Removes what this call made (used when registering the project fails). */ undo: () => void }

/**
 * Steps 1 to 4 of project creation: validate, make the folder and template files, `git init` + first commit, optionally a GitHub
 * repository. Registration and the first prompt are the service's. A failure before the repository step removes only what this call
 * created (a folder that did not exist before; the contents of one that existed empty), never anything that was there. A repository
 * that was created is left alone and reported, since deleting remote repositories is out of scope.
 */
export async function createProjectFolder(draft: NewProjectDraft, deps: CreateDeps): Promise<CreatedFolder> {
  const warnings: string[] = [];
  const typed = typeof draft?.name === 'string' ? draft.name.trim() : '';
  if (!typed || typed.length > 80) throw new Error('A project name needs 1 to 80 characters.');
  const folder = sanitizeFolderName(typed);
  if (!folder) throw new Error('That name cannot be used as a folder name. Use letters or digits.');
  const template: ProjectTemplate = draft.template ?? 'empty';
  if (!TEMPLATES.includes(template)) throw new Error('Unknown project template.');
  // A user template wins over the built-in one; its files are read before anything is created, so a broken template fails early.
  let userFiles: Array<{ path: string; read: () => Buffer }> | undefined, checks: string[] = [];
  if (draft.userTemplate !== undefined) {
    const t = typeof draft.userTemplate === 'string' ? deps.templates?.get(draft.userTemplate) : undefined;
    if (!t || !deps.templates) throw new Error('That template no longer exists. Pick another one.');
    userFiles = deps.templates.files(t.id);
    checks = t.checks;
  }

  const { target, undo } = prepareTarget(folder, draft.parentDir, deps);

  try {
    mkdirSync(target, { recursive: true });
    if (userFiles) {
      for (const f of userFiles) {
        const file = join(target, ...f.path.split('/'));
        if (f.path.split('/').includes('..') || f.path.startsWith('.git/') || f.path.startsWith('.harbor/') || !isInside(file, target)) throw new Error(`The template file ${f.path} is not allowed.`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, f.read());
      }
      // Default checks become this project's checks file. They are not approved here: the first run asks the owner, as for any checks file.
      if (checks.length) {
        mkdirSync(join(target, '.harbor'), { recursive: true });
        writeFileSync(join(target, CHECKS_FILE), JSON.stringify({ checks }, null, 2) + '\n', 'utf8');
      }
    } else for (const [rel, content] of Object.entries(templateFiles(template, typed))) {
      const file = join(target, ...rel.split('/'));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, 'utf8');
    }
    await deps.git.init(target, 'main');
    const c = await deps.git.initialCommit(target, 'Initial commit');
    if (!c.ok) throw new Error(c.error ?? 'The first commit failed.');
    if (c.fallbackIdentity) warnings.push('Git has no user name or email configured, so the first commit is by "Harbor". Set them with `git config --global user.name` and `user.email`.');
  } catch (e) {
    undo();
    throw new Error(`The project was not created: ${e instanceof Error ? e.message : String(e)}`);
  }

  let remote: string | undefined;
  if (draft.github && draft.github.create) {
    const r = await deps.gh.createRepo({ name: repoNameFor(folder), visibility: draft.github.visibility, ...(draft.github.owner ? { owner: draft.github.owner } : {}), sourcePath: target });
    if (!r.ok) warnings.push(`The GitHub repository was not created: ${r.message} The project itself was created.`);
    else {
      remote = r.value.url;
      // The one push of the default branch Harbor makes on its own: the first publish of a repository that was empty a moment ago.
      const p = await deps.git.push(target, 'origin', 'main', { setUpstream: true });
      if (!p.ok) warnings.push(`The repository ${r.value.url} was created but the first push failed: ${p.output}`);
    }
  }
  return { path: target, name: typed, ...(remote ? { remote } : {}), warnings, undo };
}

/** The repository name at the end of a git URL (`https://host/o/name.git`, `git@host:o/name.git`), without `.git`. */
export function repoNameOfUrl(url: string): string | undefined {
  const last = url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  const name = last.replace(/\.git$/i, '');
  return name || undefined;
}

/**
 * Clone an existing repository into the projects folder. Same target rules as a new project (non-empty target refused, Harbor's own
 * folders refused, a folder that was there before is never removed). A failed or interrupted clone removes only what this call made.
 * `origin` is the URL git recorded; nothing is pushed.
 */
export async function cloneProjectFolder(draft: CloneProjectDraft, deps: CreateDeps): Promise<CreatedFolder> {
  const url = typeof draft?.url === 'string' ? draft.url.trim() : '';
  const bad = remoteUrlProblem(url);
  if (bad) throw new Error(bad);
  const typed = (typeof draft.name === 'string' && draft.name.trim() ? draft.name.trim() : repoNameOfUrl(url)) ?? '';
  if (!typed || typed.length > 80) throw new Error('A project name needs 1 to 80 characters.');
  const folder = sanitizeFolderName(typed);
  if (!folder) throw new Error('That name cannot be used as a folder name. Use letters or digits.');
  const { target, parent, undo } = prepareTarget(folder, draft.parentDir, deps);

  const warnings: string[] = [];
  let r: { ok: boolean; output: string };
  try { r = await deps.git.clone(url, target, parent); } catch (e) { undo(); throw e; }
  if (!r.ok) { undo(); throw new Error(`The repository was not cloned: ${r.output}`); }
  if (!(await deps.git.isRepoWithCommits(target))) warnings.push('The repository has no commits yet. Make a first commit before asking an agent to work on it.');
  return { path: target, name: typed, remote: url, warnings, undo };
}
