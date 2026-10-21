import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WorktreeInfo } from '../shared/api';
import { isInside, type Git } from './git';
import { folderSize, unlinkLinks } from './projectDelete';
import { normPath, type Store } from './store';

export interface HousekeepingDeps { git: Git; store: Store; worktreesRoot: string; now: number; maxAgeDays?: number }

const LIVE = ['queued', 'working', 'waiting'];
const DAY = 86_400_000;

/** Every worktree folder under Harbor's root, across all projects, with what decides whether it can go. Read-only. */
export async function listHarborWorktrees(d: HousekeepingDeps): Promise<WorktreeInfo[]> {
  const out: WorktreeInfo[] = [];
  const maxAge = (d.maxAgeDays ?? 14) * DAY;
  if (!existsSync(d.worktreesRoot)) return out;
  const projects = d.store.listProjects();
  for (const key of safeList(d.worktreesRoot)) {
    const keyDir = join(d.worktreesRoot, key);
    if (!isDir(keyDir)) continue;
    const project = projects.find((p) => p.id.slice(0, 8) === key);
    const registered = project && existsSync(project.path) ? await d.git.listWorktrees(project.path) : [];
    for (const slug of safeList(keyDir)) {
      const path = join(keyDir, slug);
      if (!isDir(path)) continue;
      const agent = project ? d.store.listAgentRecords(project.id).find((a) => a.worktree && normPath(a.worktree) === normPath(path)) : undefined;
      const branch = registered.find((w) => normPath(w.path) === normPath(path))?.branch ?? agent?.branch;
      const base = project && existsSync(project.path) ? await d.git.defaultBranch(project.path) : undefined;
      const merged = !!(project && branch && base && await d.git.isAncestor(project.path, `refs/heads/${branch}`, `refs/heads/${base}`).catch(() => false));
      const updated = agent?.updated ?? agent?.created ?? statSafe(path);
      const active = !!agent && LIVE.includes(agent.state);
      const dirty = project ? await d.git.hasLocalChanges(path) : false;
      const orphan = !project;
      const ageDays = Math.max(0, Math.floor((d.now - updated) / DAY));
      const landed = !!agent && !!(agent.integration?.applied || agent.rollback?.applied);
      out.push({
        path, ...(project ? { projectId: project.id, projectName: project.name } : {}), ...(branch ? { branch } : {}),
        ageDays, sizeBytes: folderSize(path), merged, dirty, active, orphan,
        removable: !active && !dirty && (orphan || merged || landed || d.now - updated > maxAge)
      });
    }
  }
  return out.sort((a, b) => b.ageDays - a.ageDays);
}

/**
 * Remove the worktrees that are merged, applied, stale or orphaned (never active or with uncommitted changes), or only the given
 * `paths` among those. A branch goes with its worktree only when it is a merged harbor/* branch; the rest stay.
 */
export async function cleanupWorktrees(d: HousekeepingDeps, paths?: string[]): Promise<{ removed: number; branchesDeleted: number; warnings: string[] }> {
  const wanted = paths ? new Set(paths.map(normPath)) : undefined;
  const result = { removed: 0, branchesDeleted: 0, warnings: [] as string[] };
  for (const w of await listHarborWorktrees(d)) {
    if (!w.removable || (wanted && !wanted.has(normPath(w.path)))) continue;
    if (!isInside(w.path, d.worktreesRoot)) continue;
    try {
      const project = w.projectId ? d.store.getProject(w.projectId) : undefined;
      if (project && existsSync(project.path)) {
        await d.git.removeWorktree(project.path, d.worktreesRoot, resolve(w.path)); // no branch argument: only merged ones are deleted below
        if (w.merged && w.branch?.startsWith('harbor/') && await d.git.deleteBranch(project.path, w.branch).catch(() => false)) result.branchesDeleted++;
        const a = d.store.listAgentRecords(project.id).find((x) => x.worktree && normPath(x.worktree) === normPath(w.path));
        if (a) { a.worktree = undefined; d.store.upsertAgent(a); }
      } else {
        // Nobody owns it any more: links first (never followed), then the folder. The old repository forgets it at its next prune.
        unlinkLinks(w.path);
        rmSync(w.path, { recursive: true, force: true, maxRetries: 3 });
      }
      if (existsSync(w.path)) result.warnings.push(`${w.path} is still in use and was kept.`); else result.removed++;
    } catch (e) { result.warnings.push(`Could not remove ${w.path}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  for (const key of safeList(d.worktreesRoot)) { try { if (!readdirSync(join(d.worktreesRoot, key)).length) rmSync(join(d.worktreesRoot, key), { recursive: false }); } catch { /* not empty */ } }
  return result;
}

function safeList(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }
function isDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }
function statSafe(p: string): number { try { return statSync(p).mtimeMs; } catch { return 0; } }
