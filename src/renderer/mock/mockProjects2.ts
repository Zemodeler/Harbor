import type { Agent, Conversation, PullRequestCheck, PullRequestStatus, ReleaseTagPreview, TemplatePreview, UserTemplate, GithubRepo, GlobalUsage, HarborApi, Project, ProjectOverview, SearchAllHit, SearchHit } from '../../shared/api';

type Projects2Methods = Required<Pick<HarborApi, 'cloneProject' | 'listGithubRepos' | 'getPullRequestStatus' | 'rerunFailedChecks' | 'mergePullRequest' | 'previewReleaseTag' | 'createReleaseTag' | 'listTemplates' | 'previewTemplate' | 'saveProjectAsTemplate' | 'updateTemplate' | 'deleteTemplate' | 'setProjectFlags' | 'getProjectsOverview' | 'searchAll' | 'getGlobalUsage'>>;
interface Data { projects: Project[]; agents: Agent[]; conversations: Conversation[] }

const DEMO_DIR = 'C:\Projects\Harbor Projects';
const REPOS: GithubRepo[] = [
  { slug: 'demo-user/storefront', name: 'storefront', owner: 'demo-user', description: 'Online shop front end', isPrivate: true, updatedAt: Date.parse('2026-10-18T09:00:00Z'), url: 'https://github.com/demo-user/storefront.git' },
  { slug: 'demo-user/notes-cli', name: 'notes-cli', owner: 'demo-user', description: 'A tiny notes tool', isPrivate: false, isFork: true, updatedAt: Date.parse('2026-09-02T09:00:00Z'), url: 'https://github.com/demo-user/notes-cli.git' }
];

/**
 * Track B, projects 2 (CHANGELOG 0.1.48 and later) for the demo. Nothing touches a disk or a network. Failures are reachable by name:
 * a URL ending in `/missing.git` is "not found", `/private.git` needs a sign-in, `/taken.git` hits an existing folder, `/empty.git` clones an empty repository.
 */
export function createMockProjects2(data: () => Data, pause: () => Promise<void>, settings: () => { projectsDir?: string }, search: (query: string) => Promise<SearchHit[]>): Projects2Methods {
  const copy = <T,>(v: T): T => structuredClone(v);
  // Pull requests by branch: the sample helper branch has failing checks, fix-footer is green, conflict-demo conflicts, draft-demo is a draft, any other has none.
  // After a re-run the check shows as running for one read, then passes.
  const merged = new Set<string>(), restarted = new Map<string, number>();
  const tags = ['v1.2.3', 'v1.2.2'];
  const checksFor = (branch: string): PullRequestCheck[] => branch === 'harbor/implement-account-page-1a2b3c'
    ? [{ name: 'build', bucket: 'pass', workflow: 'CI' }, { name: 'test', bucket: !restarted.has(branch) ? 'fail' : (restarted.get(branch) ?? 0) < 1 ? 'pending' : 'pass', workflow: 'CI', link: 'https://github.com/demo-user/storefront/actions/runs/101/job/1' }]
    : [{ name: 'build', bucket: 'pass', workflow: 'CI' }, { name: 'test', bucket: 'pass', workflow: 'CI' }];
  const prOf = (branch: string): PullRequestStatus | null => {
    const known: Record<string, number> = { 'harbor/implement-account-page-1a2b3c': 12, 'harbor/fix-footer-77aa11': 13, 'harbor/conflict-demo': 14, 'harbor/draft-demo': 15 };
    const number = known[branch];
    if (!number) return null;
    const items = checksFor(branch);
    const failing = items.filter(c => c.bucket === 'fail').length, pending = items.filter(c => c.bucket === 'pending').length;
    const state = merged.has(branch) ? 'merged' as const : 'open' as const;
    const hard = [...(state === 'merged' ? ['The pull request is already merged.'] : []), ...(branch === 'harbor/conflict-demo' ? ['It has merge conflicts with its base branch.'] : []), ...(branch === 'harbor/draft-demo' ? ['It is a draft. Mark it ready for review on GitHub first.'] : [])];
    const soft = [...(failing ? [`${failing} check is failing.`] : []), ...(pending ? [`${pending} check is still running.`] : [])];
    return {
      number, url: `https://github.com/demo-user/storefront/pull/${number}`, title: branch.replace(/^harbor\//, '').replace(/-[0-9a-f]{6}$/, '').replace(/-/g, ' '), state, draft: branch === 'harbor/draft-demo', base: 'main', head: branch,
      mergeable: branch === 'harbor/conflict-demo' ? 'conflicting' : 'mergeable', checks: { total: items.length, passing: items.filter(c => c.bucket === 'pass').length, failing, pending, skipped: 0, items },
      blockers: [...hard, ...soft], checksOverridable: !hard.length && soft.length > 0, canMerge: !hard.length && !soft.length, canRerun: state === 'open' && failing > 0
    };
  };
  let templates: UserTemplate[] = [{ id: 'web-starter-1a2b3c', name: 'Web starter', description: 'Vite and React', created: Date.parse('2026-10-10T10:00:00Z'), files: 14, bytes: 52_000, checks: ['npm test', 'npm run build'], source: 'Storefront' }];
  const checks = (c: unknown) => { const list = Array.isArray(c) ? c.map(x => String(x).trim()).filter(Boolean) : []; if (list.length > 10) throw new Error('A template can hold at most 10 default checks.'); return list; };
  return {
    async cloneProject(draft) {
      await pause();
      const url = draft.url.trim();
      if (!/^(https:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)/i.test(url) || /\s/.test(url)) throw new Error('Only https and ssh remotes are supported (not file:, ext:: or local paths).');
      const repo = (url.replace(/\/+$/, '').split(/[/:]/).pop() ?? '').replace(/\.git$/i, '');
      if (repo === 'missing') throw new Error('The repository was not cloned: The repository was not found. Check the URL (private repositories need you to be signed in).');
      if (repo === 'private') throw new Error('The repository was not cloned: Not signed in to the remote, or you have no access to this repository. Sign in with git (for example `gh auth login`) and check the URL.');
      const name = draft.name?.trim() || repo;
      const parent = (draft.parentDir?.trim() || settings().projectsDir || DEMO_DIR).replace(/[\/]+$/, '');
      const path = `${parent}\${name}`;
      if (repo === 'taken' || data().projects.some(p => p.path.toLowerCase() === path.toLowerCase())) throw new Error(`The folder ${path} already exists and is not empty. Choose another name or location.`);
      const p: Project = { id: crypto.randomUUID(), name, path, lastOpened: Date.now() };
      data().projects.push(p);
      data().agents.push({ id: `main-${p.id}`, projectId: p.id, role: 'main', title: 'Main agent', state: 'waiting', cli: 'codex', model: 'default', effort: 'medium' });
      return { project: copy(p), path, remote: url, warnings: repo === 'empty' ? ['The repository has no commits yet. Make a first commit before asking an agent to work on it.'] : [] };
    },
    async getPullRequestStatus(_projectId, branch) { await pause(); const pr = prOf(branch); if (restarted.has(branch)) restarted.set(branch, (restarted.get(branch) ?? 0) + 1); return copy(pr); },
    async rerunFailedChecks(_projectId, branch) {
      await pause();
      const pr = prOf(branch);
      if (!pr) throw new Error('This branch has no pull request.');
      if (!pr.canRerun) throw new Error('No failed check belongs to a workflow run that can be re-run.');
      restarted.set(branch, 0);
      return { rerun: 1 };
    },
    async mergePullRequest(_projectId, o) {
      await pause();
      if (o.confirmNumber !== o.number) throw new Error(`Confirm by repeating the pull request number (#${o.number}).`);
      const pr = prOf(o.branch);
      if (!pr) throw new Error('This branch has no pull request.');
      if (!pr.canMerge && !pr.checksOverridable) throw new Error(`Harbor will not merge #${pr.number}: ${pr.blockers.join(' ')}`);
      if (!pr.canMerge && !o.overrideChecks) throw new Error(`#${pr.number} is not green: ${pr.blockers.join(' ')} Merging anyway needs an explicit override.`);
      merged.add(o.branch);
      return { merged: true, url: pr.url, message: `Merged ${pr.url}` };
    },
    async previewReleaseTag(projectId): Promise<ReleaseTagPreview> {
      await pause();
      const noRemote = projectId === 'tools';
      return { ...(noRemote ? {} : { remote: 'origin' }), defaultBranch: 'main', head: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', headSubject: 'Polish the checkout', headOnRemote: !noRemote, recent: [...tags].slice(0, 10), suggested: 'v1.2.4' };
    },
    async createReleaseTag(projectId, draft) {
      await pause();
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(draft.name) || draft.name.includes('..')) throw new Error('That tag name is not allowed (no "..", "//", trailing separators or ".lock").');
      if (tags.includes(draft.name)) throw new Error(`The tag ${draft.name} already exists. Harbor never moves or replaces a tag.`);
      if (draft.push && projectId === 'tools') throw new Error('This project has no remote yet, so a tag cannot be pushed. Add one first.');
      tags.unshift(draft.name);
      return { name: draft.name, commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', pushed: draft.push === true };
    },
    async listTemplates() { await pause(); return copy(templates); },
    async previewTemplate(projectId): Promise<TemplatePreview> {
      await pause();
      const p = data().projects.find(x => x.id === projectId);
      if (!p) throw new Error('This project is no longer available.');
      const leaky = /leak/i.test(p.name);
      return {
        projectId, files: 23, bytes: 410_000, sample: ['README.md', 'package.json', 'src/index.ts'],
        excluded: [{ path: '.env', reason: 'looks like a credential file' }, { path: 'assets/video.mp4', reason: 'larger than 1 MB' }],
        findings: leaky ? [{ type: 'github-token', file: 'src/config.ts', line: 4 }] : [], findingsTotal: leaky ? 1 : 0, suggestedChecks: ['npm test'], blocked: leaky
      };
    },
    async saveProjectAsTemplate(projectId, draft) {
      await pause();
      const p = data().projects.find(x => x.id === projectId);
      if (!p) throw new Error('This project is no longer available.');
      if (/leak/i.test(p.name)) throw new Error('The secret scan found 1 possible secret in the files to copy (github-token at src/config.ts:4). Remove or allowlist them, then save again.');
      const name = draft.name.trim();
      if (!name || name.length > 60) throw new Error('A template name needs 1 to 60 characters.');
      const t: UserTemplate = { id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(16).slice(2, 8)}`, name, ...(draft.description?.trim() ? { description: draft.description.trim() } : {}), created: Date.now(), files: 23, bytes: 410_000, checks: checks(draft.checks), source: p.name };
      templates = [t, ...templates];
      return copy(t);
    },
    async updateTemplate(id, patch) {
      await pause();
      const t = templates.find(x => x.id === id);
      if (!t) throw new Error('Unknown template.');
      if (patch.name !== undefined) t.name = patch.name.trim();
      if (patch.checks !== undefined) t.checks = checks(patch.checks);
      return copy(t);
    },
    async deleteTemplate(id) { await pause(); templates = templates.filter(x => x.id !== id); },
    async setProjectFlags(id, patch) {
      await pause();
      const p = data().projects.find(x => x.id === id);
      if (!p) throw new Error('This project is no longer available.');
      if (patch.archived && !p.archived && data().agents.some(a => a.projectId === id && a.role !== 'main' && ['queued', 'working', 'waiting'].includes(a.state))) throw new Error('Agents are still running in this project. Stop them or wait until they finish, then archive it.');
      if (patch.archived !== undefined) { if (patch.archived) p.archived = true; else delete p.archived; }
      if (patch.pinned !== undefined) { if (patch.pinned) p.pinned = true; else delete p.pinned; }
      data().projects.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
      return copy(p);
    },
    async getProjectsOverview() {
      await pause();
      const projects: ProjectOverview[] = data().projects.map((p, i) => {
        const agents = data().agents.filter(a => a.projectId === p.id);
        return {
          projectId: p.id, running: agents.filter(a => ['queued', 'working'].includes(a.state)).length, waiting: agents.filter(a => a.state === 'waiting' && a.role !== 'main').length,
          unmergedBranches: i === 0 ? 2 : 0, unpushedCommits: i === 0 ? 3 : 0, lastActivity: p.lastOpened, conversations: data().conversations.filter(c => c.projectId === p.id).length,
          recentRuns: i === 0 ? 14 : 0, recentKTok: i === 0 ? 812.4 : 0, ...(/missing/i.test(p.name) ? { missing: true } : {})
        };
      });
      return { generatedAt: Date.now(), projects, quota: [{ cli: 'claude', label: '5 hour', usedPct: 42, source: 'estimated' as const, period: 'session' as const }, { cli: 'codex', label: 'Weekly', usedPct: 18, source: 'reported' as const, period: 'weekly' as const }] };
    },
    async searchAll(query, opts) {
      await pause();
      const found = await search(query);
      const hits: SearchAllHit[] = found.map(h => ({ projectId: h.conversation.projectId, projectName: h.projectName, ...(data().projects.find(p => p.id === h.conversation.projectId)?.archived ? { projectArchived: true as const } : {}), conversation: h.conversation, kind: h.excerpt ? 'message' as const : 'title' as const, time: h.conversation.updated, ...(h.excerpt ? { excerpt: h.excerpt } : {}) }));
      const offset = opts?.offset ?? 0, limit = opts?.limit ?? 25;
      return { hits: hits.slice(offset, offset + limit), total: hits.length, hasMore: offset + limit < hits.length };
    },
    async getGlobalUsage(): Promise<GlobalUsage> {
      await pause();
      const row = (runs: number, k: number) => ({ runs, failedRuns: runs > 5 ? 1 : 0, inputTokens: k * 700, outputTokens: k * 300, cacheReadTokens: 0, cacheWriteTokens: 0, billableKTok: k, minutes: runs * 3.5, ...(runs > 5 ? { costUsd: 1.37 } : {}) });
      const first = data().projects[0];
      return {
        estimate: true, since: Date.now() - 8 * 86_400_000, total: row(20, 1100),
        byCli: [{ cli: 'claude', ...row(14, 812.4) }, { cli: 'codex', ...row(6, 287.6) }],
        byProject: [...(first ? [{ projectId: first.id, projectName: first.name, ...row(14, 812.4) }] : []), { projectId: 'removed-1', removed: true, ...row(6, 287.6) }],
        lifetime: { runs: 131, inputTokens: 4_100_000, outputTokens: 1_900_000, costUsd: 9.42 }, windows: [],
        notes: ['These numbers count only what Harbor ran, from its own records of the last 8 days. They are an estimate and not the provider quota or bill.', '2 runs reported no token counts (quota unknown, not zero).']
      };
    },
    async listGithubRepos(opts) { await pause(); return copy(REPOS).filter(r => !opts?.owner || r.owner.toLowerCase() === opts.owner.toLowerCase()); }
  };
}
