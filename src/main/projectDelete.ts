import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DeletePreview, DeleteResult, DeleteScope, Project } from '../shared/api';
import { isInside, type Git } from './git';
import { projectPathRefusal } from './projectPath';
import { normPath, type Store } from './store';

export interface DeleteDeps {
  git: Git;
  store: Store;
  worktreesRoot: string;
  /** Settings.projectsDir or the default: a folder outside it makes the typed-name confirmation mandatory in the UI. */
  projectsDir: string;
  /** Harbor's own data folder and the folders Harbor itself runs from: never deleted. */
  protectedRoots: string[];
  /** Agents of the project that are queued, working or waiting. */
  running: (projectId: string) => number;
  /** Stops every agent and lead turn of the project. */
  stopAll: (projectId: string) => void;
  /** Delete one path recursively; injectable so a Windows file lock can be simulated. */
  rm?: (path: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const SIZE_LIMIT_ENTRIES = 20_000;

/** Size of a folder in bytes without following links, or undefined when it is too large to count quickly. */
export function folderSize(root: string): number | undefined {
  let total = 0, seen = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (++seen > SIZE_LIMIT_ENTRIES) return undefined;
      const p = join(dir, n);
      try {
        const st = lstatSync(p);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) stack.push(p); else total += st.size;
      } catch { /* vanished */ }
    }
  }
  return total;
}

/** Removes every link (symlink or junction) below `root` without following it, so a recursive delete can never reach a link's target. */
export function unlinkLinks(root: string): number {
  let n = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const p = join(dir, name);
      try {
        const st = lstatSync(p);
        if (st.isSymbolicLink()) { try { rmdirSync(p); } catch { unlinkSync(p); } n++; } else if (st.isDirectory()) stack.push(p);
      } catch { /* vanished */ }
    }
  }
  return n;
}

const harborBranchOf = (b?: string): string | undefined => (b && b.startsWith('harbor/') ? b : undefined);

/** Everything the three levels would remove, without touching anything. */
export async function previewDelete(project: Project, d: DeleteDeps): Promise<DeletePreview> {
  const { git } = d;
  const exists = existsSync(project.path);
  const isRepo = exists && await git.isRepoWithCommits(project.path);
  const base = isRepo ? await git.defaultBranch(project.path) : undefined;

  // Worktrees Harbor made for this project: agent records plus what git lists under Harbor's root.
  const paths = new Map<string, { path: string; branch?: string }>();
  for (const a of d.store.listAgentRecords(project.id)) if (a.worktree && existsSync(a.worktree) && isInside(a.worktree, d.worktreesRoot)) paths.set(normPath(a.worktree), { path: a.worktree, ...(harborBranchOf(a.branch) ? { branch: a.branch } : {}) });
  if (isRepo) for (const w of await git.listWorktrees(project.path)) if (isInside(w.path, d.worktreesRoot) && !paths.has(normPath(w.path))) paths.set(normPath(w.path), { path: resolve(w.path), ...(harborBranchOf(w.branch) ? { branch: w.branch } : {}) });
  const worktrees: DeletePreview['worktrees'] = [];
  for (const w of paths.values()) {
    worktrees.push({ path: w.path, ...(w.branch ? { branch: w.branch } : {}), dirty: existsSync(w.path) ? await git.hasLocalChanges(w.path) : false, unmergedCommits: w.branch && base ? await git.commitsNotIn(project.path, w.branch, base) : 0 });
  }
  const branches = isRepo ? (await git.harborBranches(project.path)).map((b) => ({ name: b.name, unpushed: b.unpushed, merged: b.merged })) : [];

  const outsideProjectsDir = !isInside(project.path, d.projectsDir);
  const folder: DeletePreview['folder'] = {
    exists, dirty: isRepo ? await git.hasLocalChanges(project.path) : false,
    unpushedCommits: isRepo ? await git.unpushedOnAnyBranch(project.path) : 0,
    hasRemote: isRepo ? await git.hasRemotes(project.path) : false,
    ...(exists ? { sizeBytes: folderSize(project.path) } : {}), outsideProjectsDir
  };

  const blockers: string[] = [];
  if (exists) {
    const refusal = projectPathRefusal(project.path);
    if (refusal) blockers.push(refusal);
    try { if (lstatSync(project.path).isSymbolicLink()) blockers.push('The project folder is a link to another folder; Harbor will not delete through it.'); } catch { /* checked by exists */ }
  }
  for (const root of d.protectedRoots) {
    if (normPath(root) === normPath(project.path) || isInside(root, project.path) || isInside(project.path, root)) { blockers.push("This folder is, contains or sits inside Harbor's own app or data folder."); break; }
  }
  for (const other of d.store.listProjects()) {
    if (other.id !== project.id && (normPath(other.path) === normPath(project.path) || isInside(other.path, project.path))) { blockers.push(`Another project (${other.name}) uses this folder or lives inside it.`); break; }
  }
  const unmergedBranch = branches.some((b) => !b.merged || b.unpushed > 0), loses = worktrees.some((w) => w.dirty || w.unmergedCommits > 0);
  return { projectId: project.id, path: project.path, running: d.running(project.id), worktrees, branches, folder, blockers, needsTypedName: { worktrees: loses || unmergedBranch, folder: true } };
}

/** Delete a folder tree: links first (never followed), then a recursive remove retried against Windows file locks. */
async function removeFolder(path: string, d: DeleteDeps): Promise<boolean> {
  const rm = d.rm ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  unlinkLinks(path);
  for (let attempt = 0; attempt < 3; attempt++) {
    try { rm(path); } catch (e) { const code = (e as NodeJS.ErrnoException).code; if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw e; }
    if (!existsSync(path)) return true;
    await sleep(400 * (attempt + 1));
  }
  return !existsSync(path);
}

export async function deleteProject(project: Project, scope: DeleteScope, confirmName: string | undefined, d: DeleteDeps): Promise<DeleteResult> {
  const warnings: string[] = [];
  const removed: DeleteResult['removed'] = { records: false, worktrees: 0, branches: 0, folder: false };
  if (scope === 'forget') {
    d.stopAll(project.id);
    d.store.removeProject(project.id);
    removed.records = true;
    return { removed, warnings };
  }
  const preview = await previewDelete(project, d);
  const typed = confirmName === project.name;
  if (scope === 'folder') {
    if (preview.blockers.length) throw new Error(`The folder cannot be deleted: ${preview.blockers[0]}`);
    if (!typed) throw new Error('Type the project name to confirm deleting its folder.');
  } else if (preview.needsTypedName.worktrees && !typed) {
    throw new Error('Some worktrees or branches hold work that exists nowhere else. Type the project name to confirm removing them.');
  }

  d.stopAll(project.id);
  const repo = project.path, isRepo = existsSync(repo) && await d.git.isRepoWithCommits(repo);
  // Worktrees first (path-guarded by removeWorktree), then their branches, harbor/* only.
  for (const w of preview.worktrees) {
    try { await d.git.removeWorktree(repo, d.worktreesRoot, w.path); removed.worktrees++; } catch (e) { warnings.push(`Could not remove the worktree ${w.path}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  if (isRepo) {
    await d.git.pruneWorktrees(repo);
    for (const b of await d.git.harborBranches(repo)) {
      try { if (await d.git.deleteBranch(repo, b.name, { force: !b.merged })) removed.branches++; } catch (e) { warnings.push(`Kept branch ${b.name}: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }
  try { rmdirSync(join(d.worktreesRoot, project.id.slice(0, 8))); } catch { /* not empty or absent */ }

  if (scope === 'folder' && existsSync(repo)) {
    // Checked again right before deleting: the stored path must still be a real folder, never a link to somewhere else.
    try { if (lstatSync(repo).isSymbolicLink()) throw new Error('x'); } catch { throw new Error('The project folder is now a link to another folder; nothing was deleted.'); }
    if (await removeFolder(repo, d)) removed.folder = true;
    else {
      warnings.push(`Some files in ${repo} are still in use (an editor, a terminal or a sync tool may hold them). Close them and delete the project again; it stays in the list until then.`);
      return { removed, warnings };
    }
  } else if (scope === 'folder') removed.folder = true; // already gone
  d.store.removeProject(project.id);
  removed.records = true;
  return { removed, warnings };
}
