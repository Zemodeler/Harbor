import type { Agent, Conversation, DeletePreview, GithubStatus, HarborApi, Project, PushPreview, WorktreeInfo } from '../../shared/api';

type LifecycleMethods = Required<Pick<HarborApi, 'createProject' | 'previewDeleteProject' | 'deleteProject' | 'previewPush' | 'pushBranch' | 'createPullRequest' | 'setRemote' | 'getGithubStatus' | 'browseFolder' | 'listWorktrees' | 'cleanupWorktrees'>>;
interface Data { projects: Project[]; agents: Agent[]; conversations: Conversation[] }

const DEMO_DIR = 'C:\\Projects\\Harbor Projects';
const SAMPLE_BRANCH = 'harbor/implement-account-page-1a2b3c';

/**
 * Project lifecycle and publishing for the demo (CHANGELOG 0.1.47). Nothing touches a disk or a network. Failures a real machine can
 * produce are reachable by name so every state of the UI can be seen:
 *  - a project named "Taken" already exists; "Fail" fails; "No gh" gets a warning instead of a repository;
 *  - the sample branch pushes cleanly, "harbor/secret-demo" is blocked by the secret scan, "harbor/behind-demo" is behind its remote.
 */
export function createMockLifecycle(data: () => Data, pause: () => Promise<void>, removeProject: (id: string) => Promise<void>, settings: () => { projectsDir?: string }): LifecycleMethods {
  const copy = <T,>(v: T): T => structuredClone(v);
  const id = () => crypto.randomUUID();
  const project = (projectId: string) => { const p = data().projects.find(x => x.id === projectId); if (!p) throw new Error('This project is no longer available.'); return p; };
  let worktrees: WorktreeInfo[] = [
    { path: 'C:\\Harbor\\worktrees\\store\\implement-account-page-1a2b3c', projectId: 'store', projectName: 'Storefront', branch: SAMPLE_BRANCH, ageDays: 2, sizeBytes: 48_000_000, merged: false, dirty: false, active: false, orphan: false, removable: false },
    { path: 'C:\\Harbor\\worktrees\\store\\fix-footer-77aa11', projectId: 'store', projectName: 'Storefront', branch: 'harbor/fix-footer-77aa11', ageDays: 20, sizeBytes: 31_000_000, merged: true, dirty: false, active: false, orphan: false, removable: true },
    { path: 'C:\\Harbor\\worktrees\\9f8e7d6c\\old-task-aa00bb', ageDays: 63, sizeBytes: 12_000_000, merged: false, dirty: false, active: false, orphan: true, removable: true }
  ];
  const pushed = new Set<string>();
  const plan = (projectId: string, branch: string): PushPreview => {
    project(projectId);
    const isDefaultBranch = branch === 'main';
    const secret = branch === 'harbor/secret-demo';
    const hash = (n: number) => `${n}`.repeat(40).slice(0, 40);
    return {
      branch, remote: projectId === 'tools' ? undefined : 'origin', upstream: pushed.has(branch) ? `origin/${branch}` : undefined,
      ahead: pushed.has(branch) ? 0 : 2, behind: branch === 'harbor/behind-demo' ? 3 : 0, isDefaultBranch, needsRemote: projectId === 'tools',
      commits: pushed.has(branch) ? [] : [{ hash: hash(1), subject: 'Add account page form' }, { hash: hash(2), subject: 'Handle empty address list' }],
      secretScan: secret ? { findings: [{ type: 'aws-access-key', file: 'config/settings.ts', line: 12 }], total: 1, allowed: 0, fingerprint: 'demo-fingerprint' } : { findings: [], total: 0, allowed: 0 }
    };
  };
  return {
    async getGithubStatus(): Promise<GithubStatus> { await pause(); return { installed: true, loggedIn: true, account: 'demo-user' }; },
    async browseFolder() { await pause(); return settings().projectsDir ?? DEMO_DIR; },
    async createProject(draft) {
      await pause();
      const name = draft.name.trim();
      if (!name) throw new Error('A project name needs 1 to 80 characters.');
      if (/^fail$/i.test(name)) throw new Error('The project was not created: git commit failed: Author identity unknown.');
      const parent = (draft.parentDir?.trim() || settings().projectsDir || DEMO_DIR).replace(/[\\/]+$/, '');
      const path = `${parent}\\${name}`;
      if (/^taken$/i.test(name) || data().projects.some(p => p.path.toLowerCase() === path.toLowerCase())) throw new Error(`The folder ${path} already exists and is not empty. Choose another name or location.`);
      const warnings: string[] = [];
      let remote: string | undefined;
      if (draft.github?.create) {
        if (/no gh/i.test(name)) warnings.push('The GitHub repository was not created: The GitHub CLI (gh) is not installed. Install the GitHub CLI (winget install GitHub.cli), then run `gh auth login`. The project itself was created.');
        else remote = `https://github.com/demo-user/${name.replace(/\s+/g, '-')}`;
      }
      const p: Project = { id: id(), name, path, lastOpened: Date.now() };
      data().projects.push(p);
      data().agents.push({ id: `main-${p.id}`, projectId: p.id, role: 'main', title: 'Main agent', state: 'waiting', cli: 'codex', model: 'default', effort: 'medium' });
      return { project: copy(p), path, ...(remote ? { remote } : {}), warnings };
    },
    async previewDeleteProject(projectId): Promise<DeletePreview> {
      await pause();
      const p = project(projectId);
      const busy = projectId === 'store';
      return {
        projectId, path: p.path, running: busy ? 1 : 0,
        worktrees: busy ? [{ path: 'C:\\Harbor\\worktrees\\store\\implement-account-page-1a2b3c', branch: SAMPLE_BRANCH, dirty: true, unmergedCommits: 2 }] : [],
        branches: busy ? [{ name: SAMPLE_BRANCH, unpushed: 2, merged: false }] : [],
        folder: { exists: true, dirty: busy, unpushedCommits: busy ? 2 : 0, hasRemote: busy, sizeBytes: busy ? 182_000_000 : 4_200, outsideProjectsDir: !p.path.startsWith(DEMO_DIR) },
        blockers: projectId === 'harbor' ? ["This folder is, contains or sits inside Harbor's own app or data folder."] : [],
        needsTypedName: { worktrees: busy, folder: true }, recycleBin: true
      };
    },
    async deleteProject(projectId, scope, confirmName, opts) {
      await pause();
      const p = project(projectId);
      const pv = await this.previewDeleteProject(projectId);
      if (scope === 'folder') {
        if (pv.blockers.length) throw new Error(`The folder cannot be deleted: ${pv.blockers[0]}`);
        if (confirmName !== p.name) throw new Error('Type the project name to confirm deleting its folder.');
        if (opts?.permanent && opts.confirmPermanent !== p.name) throw new Error('Type the project name again to delete the folder permanently. It cannot be undone and skips the Recycle Bin.');
        // "Internal tools" has no usable Recycle Bin in the demo, so the failure and its way out can be seen.
        if (!opts?.permanent && /^internal tools$/i.test(p.name)) throw new Error('The folder could not be moved to the Recycle Bin: the bin is not available on this drive. Harbor’s worktrees were already removed and the project is still listed. To delete the folder permanently instead, choose permanent delete.');
      } else if (scope === 'worktrees' && pv.needsTypedName.worktrees && confirmName !== p.name) throw new Error('Some worktrees or branches hold work that exists nowhere else. Type the project name to confirm removing them.');
      await removeProject(projectId);
      return { removed: { records: true, worktrees: scope === 'forget' ? 0 : pv.worktrees.length, branches: scope === 'forget' || (scope === 'folder' && !opts?.permanent) ? 0 : pv.branches.length, folder: scope === 'folder', ...(scope === 'folder' && !opts?.permanent ? { trashed: true } : {}) }, warnings: [] };
    },
    async previewPush(projectId, branch) { await pause(); return copy(plan(projectId, branch)); },
    async pushBranch(projectId, branch, opts) {
      await pause();
      const pv = plan(projectId, branch);
      if (!pv.remote) throw new Error('This project has no remote yet. Add one (Set remote) or create a GitHub repository first.');
      if (pv.isDefaultBranch && !opts?.allowDefaultBranch) throw new Error(`${branch} is the default branch. Pushing it needs an explicit confirmation naming the commits.`);
      if (pv.secretScan?.findings.length && pv.secretScan.fingerprint !== opts?.secretOverride) throw new Error('The secret scan found 1 possible secret in the commits to push (aws-access-key at config/settings.ts:12). Remove it, add the path to the secret allowlist, or confirm the exact findings to push anyway.');
      if (pv.behind > 0) return { ok: false, output: 'The remote has commits this branch does not. Merge or rebase them into the branch first (Harbor never force-pushes), then push again.', remote: 'origin', branch };
      pushed.add(branch);
      return { ok: true, output: `To https://github.com/demo-user/${project(projectId).name}\n * [new branch] ${branch} -> ${branch}`, remote: 'origin', branch };
    },
    async createPullRequest(projectId, draft) {
      await pause();
      const pv = plan(projectId, draft.branch);
      if (!pv.remote) throw new Error('This project has no remote yet. Add one (Set remote) or create a GitHub repository first.');
      if (pv.isDefaultBranch) throw new Error('Open a pull request from a working branch, not the default branch.');
      pushed.add(draft.branch);
      return { url: 'https://github.com/demo-user/demo/pull/42' };
    },
    async setRemote(projectId, url) {
      await pause(); project(projectId);
      if (!/^(https:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(url.trim())) throw new Error('Only https and ssh remotes are supported (not file:, ext:: or local paths).');
    },
    async listWorktrees() { await pause(); return copy(worktrees); },
    async cleanupWorktrees(paths) {
      await pause();
      const gone = worktrees.filter(w => w.removable && (!paths || paths.includes(w.path)));
      worktrees = worktrees.filter(w => !gone.includes(w));
      return { removed: gone.length, branchesDeleted: gone.filter(w => w.merged && w.branch).length, warnings: [] };
    }
  };
}
