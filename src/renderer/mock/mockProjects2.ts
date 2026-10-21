import type { Agent, Conversation, GithubRepo, HarborApi, Project } from '../../shared/api';

type Projects2Methods = Required<Pick<HarborApi, 'cloneProject' | 'listGithubRepos'>>;
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
export function createMockProjects2(data: () => Data, pause: () => Promise<void>, settings: () => { projectsDir?: string }): Projects2Methods {
  const copy = <T,>(v: T): T => structuredClone(v);
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
    async listGithubRepos(opts) { await pause(); return copy(REPOS).filter(r => !opts?.owner || r.owner.toLowerCase() === opts.owner.toLowerCase()); }
  };
}
