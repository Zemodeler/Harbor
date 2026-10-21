import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { NewProjectDraft, ProjectTemplate } from '../shared/api';
import { Git, isInside } from './git';
import type { GitHub } from './github';
import { projectPathRefusal } from './projectPath';
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

  const parent = resolve(draft.parentDir?.trim() || deps.defaultParent);
  if (!draft.parentDir?.trim()) mkdirSync(parent, { recursive: true });
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

  // From here on, undo exactly what this call made.
  const undo = () => {
    try {
      if (!existed) rmSync(target, { recursive: true, force: true, maxRetries: 3 });
      else for (const e of readdirSync(target)) rmSync(join(target, e), { recursive: true, force: true, maxRetries: 3 });
    } catch { /* leftovers are reported by the caller's error text */ }
  };
  try {
    mkdirSync(target, { recursive: true });
    for (const [rel, content] of Object.entries(templateFiles(template, typed))) {
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
