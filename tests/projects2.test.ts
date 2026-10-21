import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Git } from '../src/main/git';
import { GitHub, parseRepoList } from '../src/main/github';
import { runProcess, type RunResult, type Runner } from '../src/main/proc';
import { createHarborService, type HarborService } from '../src/main/service';
import { INVOKE_METHODS } from '../src/shared/ipc';
import { METHOD_SCOPE, scopeAllows } from '../src/main/remote/scopes';
import { validateInvoke } from '../src/main/ipcValidate';

// Track B, projects 2 (contract 0.1.48-0.1.59). Real git in temp dirs with a local bare origin; gh and the recycle bin are injected.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const dirs: string[] = [], services: HarborService[] = [];
const temp = (p = 'harbor-p2-') => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(async () => { for (const s of services.splice(0)) await s.shutdown(); dirs.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true, maxRetries: 3 })); });
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' }).toString();
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const LOGGED_IN: RunResult = { code: 0, stdout: '', stderr: '  ✓ Logged in to github.com account Zemodeler (keyring)\n', timedOut: false };

/** A fake gh with recorded calls; `answers` maps the first two args ("repo list", "pr view", ...) to a result. */
function fakeGh(answers: Record<string, (args: string[], input?: string) => RunResult> = {}, o: { missing?: boolean } = {}) {
  const calls: { args: string[]; input?: string }[] = [];
  const run: Runner = async (_exe, args, opts) => {
    calls.push({ args, ...(opts?.input !== undefined ? { input: opts.input } : {}) });
    if (o.missing) return { code: null, stdout: '', stderr: '', timedOut: false, error: 'spawn gh ENOENT' };
    if (args[0] === 'auth') return LOGGED_IN;
    const f = answers[`${args[0]} ${args[1]}`];
    return f ? f(args, opts?.input) : { code: 1, stdout: '', stderr: 'unexpected', timedOut: false };
  };
  return { gh: new GitHub(run), calls };
}

function setup(extra: Partial<Parameters<typeof createHarborService>[0]> = {}, gh = fakeGh()) {
  const dataDir = temp('harbor-data-'), parent = temp('harbor-projects-');
  const service = createHarborService({ dataDir, discover: async () => [], github: gh.gh, defaultProjectsDir: parent, deleteSleep: async () => {}, ...extra });
  services.push(service);
  return { service, dataDir, parent, gh, worktreesRoot: join(dataDir, 'worktrees') };
}

/** A bare "remote" holding one commit on main, reachable only through the fake URL mapping below. */
function bareWithCommit(): string {
  const origin = temp('harbor-origin-'), work = temp('harbor-work-');
  sh(origin, 'init', '--bare', '-b', 'main');
  sh(work, 'init', '-b', 'main');
  writeFileSync(join(work, 'README.md'), '# remote project\n');
  sh(work, '-c', 'user.name=T', '-c', 'user.email=t@t', 'add', '-A');
  sh(work, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-m', 'first');
  sh(work, 'push', origin, 'main');
  return origin;
}
/** A git whose clone of the https test URL reads the local bare origin instead (the real URL checks still run first). */
const gitCloningFrom = (origin: string, inspect?: (args: string[]) => RunResult | undefined): Git => new Git((exe, args, o) => {
  const hit = inspect?.(args);
  if (hit) return Promise.resolve(hit);
  const i = args.indexOf('clone');
  return runProcess(exe, i >= 0 ? args.map((a, k) => (k > i && /^https:\/\/example\.test\//.test(a) ? origin : a)) : args, o);
});

describe('B1 contract wiring', () => {
  it('lists cloneProject and listGithubRepos for IPC, never remotely, and validates the shapes', () => {
    for (const m of ['cloneProject', 'listGithubRepos'] as const) { expect(INVOKE_METHODS).toContain(m); expect(METHOD_SCOPE[m]).toBe('never'); for (const s of ['read-only', 'answer-permissions', 'full'] as const) expect(scopeAllows(s, m)).toBe(false); }
    expect(() => validateInvoke('cloneProject', [{ url: 'https://github.com/o/r.git', name: 'r' }])).not.toThrow();
    for (const bad of [null, {}, { url: '' }, { url: 5 }, { url: 'https://x/y', name: '' }, { url: 'https://x/y', parentDir: 5 }, { url: 'https://x/y', firstPrompt: 'x'.repeat(20001) }]) expect(() => validateInvoke('cloneProject', [bad]), JSON.stringify(bad)).toThrow();
    expect(() => validateInvoke('listGithubRepos', [])).not.toThrow();
    expect(() => validateInvoke('listGithubRepos', [{ owner: 'octo-org', limit: 50, refresh: true }])).not.toThrow();
    for (const bad of [{ owner: '-x' }, { owner: 'a/b' }, { limit: 'many' }, { refresh: 1 }, []]) expect(() => validateInvoke('listGithubRepos', [bad]), JSON.stringify(bad)).toThrow();
  });
});

describe('B1 cloneProject', () => {
  it('clones into the projects folder, names the project after the repository and registers it', async () => {
    const origin = bareWithCommit();
    const { service, parent } = setup({ git: gitCloningFrom(origin) });
    const r = await service.cloneProject({ url: 'https://example.test/owner/Cool-Repo.git' });
    expect(r.path).toBe(join(parent, 'Cool-Repo'));
    expect(r.project.name).toBe('Cool-Repo');
    expect(r.remote).toBe('https://example.test/owner/Cool-Repo.git');
    expect(readFileSync(join(r.path, 'README.md'), 'utf8')).toContain('remote project');
    expect(sh(r.path, 'remote').trim()).toBe('origin');
    expect((await service.listProjects()).map((p) => p.path)).toEqual([r.path]);
    expect(r.warnings).toEqual([]);
  });
  it('accepts a name and parent folder, and sends no first prompt unless asked', async () => {
    const origin = bareWithCommit(), other = temp('harbor-other-');
    const { service } = setup({ git: gitCloningFrom(origin) });
    const r = await service.cloneProject({ url: 'https://example.test/o/x.git', name: 'My Copy', parentDir: other });
    expect(r.path).toBe(join(other, 'My Copy'));
    expect(r.conversationId).toBeUndefined();
  });
  it('refuses a non-empty target and leaves it exactly as it was', async () => {
    const origin = bareWithCommit();
    const { service, parent } = setup({ git: gitCloningFrom(origin) });
    mkdirSync(join(parent, 'Taken')); writeFileSync(join(parent, 'Taken', 'mine.txt'), 'keep me');
    await expect(service.cloneProject({ url: 'https://example.test/o/x.git', name: 'Taken' })).rejects.toThrow(/not empty/);
    expect(readFileSync(join(parent, 'Taken', 'mine.txt'), 'utf8')).toBe('keep me');
    expect(await service.listProjects()).toEqual([]);
  });
  it('refuses urls that are not plain https or ssh, before git runs', async () => {
    const calls: string[][] = [];
    const { service, parent } = setup({ git: new Git(async (_e, args) => { calls.push(args); return ok(); }) });
    for (const url of ['file:///C:/secret', 'ext::sh -c evil', '--upload-pack=evil', 'C:\\local\\repo', 'https://user:pw@github.com/o/r.git', '']) await expect(service.cloneProject({ url }), url).rejects.toThrow();
    expect(calls.filter((a) => a[0] === 'clone')).toEqual([]);
    expect(readdirSync(parent)).toEqual([]);
  });
  it('maps auth and not-found failures and removes only the folder this call made', async () => {
    const origin = bareWithCommit();
    for (const [stderr, expected] of [["fatal: could not read Username for 'https://example.test': terminal prompts disabled", /Not signed in/], ['remote: Repository not found.\nfatal: repository not found', /was not found/]] as const) {
      const { service, parent } = setup({ git: gitCloningFrom(origin, (a) => (a.includes('clone') ? { code: 128, stdout: '', stderr, timedOut: false } : undefined)) });
      await expect(service.cloneProject({ url: 'https://example.test/o/x.git', name: 'Gone' })).rejects.toThrow(expected);
      expect(existsSync(join(parent, 'Gone'))).toBe(false);
      mkdirSync(join(parent, 'Pre')); // existed and empty: stays, emptied
      await expect(service.cloneProject({ url: 'https://example.test/o/x.git', name: 'Pre' })).rejects.toThrow();
      expect(readdirSync(join(parent, 'Pre'))).toEqual([]);
      expect(await service.listProjects()).toEqual([]);
    }
  });
  it('removes a half-made clone when the process is interrupted', async () => {
    let target = '';
    const git = new Git(async (exe, args, o) => {
      if (args[0] !== 'clone') return runProcess(exe, args, o);
      target = args[args.length - 1]!;
      mkdirSync(join(target, '.git'), { recursive: true }); writeFileSync(join(target, 'partial.bin'), 'x');
      return { code: null, stdout: '', stderr: 'killed', timedOut: true };
    });
    const { service } = setup({ git });
    await expect(service.cloneProject({ url: 'https://example.test/o/x.git', name: 'Half' })).rejects.toThrow(/timed out/);
    expect(target).not.toBe('');
    expect(existsSync(target)).toBe(false);
  });
  it('warns about an empty repository', async () => {
    const origin = temp('harbor-empty-origin-'); sh(origin, 'init', '--bare', '-b', 'main');
    const { service } = setup({ git: gitCloningFrom(origin) });
    const r = await service.cloneProject({ url: 'https://example.test/o/empty.git' });
    expect(r.warnings.join(' ')).toMatch(/no commits/);
  });
});

describe('B1 listGithubRepos', () => {
  const JSON_LIST = JSON.stringify([
    { nameWithOwner: 'Zemodeler/harbor', name: 'harbor', owner: { login: 'Zemodeler' }, description: 'router', isPrivate: true, isFork: false, updatedAt: '2026-10-01T10:00:00Z', url: 'https://github.com/Zemodeler/harbor' },
    { nameWithOwner: 'Zemodeler/evil', name: 'evil', owner: { login: 'Zemodeler' }, isPrivate: false, url: 'file:///C:/x' }
  ]);
  it('lists repositories through gh, ignores entries without an https url, caches for five minutes', async () => {
    const fake = fakeGh({ 'repo list': () => ok(JSON_LIST) });
    let now = 1_000_000;
    const { service } = setup({ now: () => now }, fake);
    const first = await service.listGithubRepos();
    expect(first).toEqual([{ slug: 'Zemodeler/harbor', name: 'harbor', owner: 'Zemodeler', description: 'router', isPrivate: true, updatedAt: Date.parse('2026-10-01T10:00:00Z'), url: 'https://github.com/Zemodeler/harbor.git' }]);
    await service.listGithubRepos();
    expect(fake.calls.filter((c) => c.args[0] === 'repo')).toHaveLength(1);
    await service.listGithubRepos({ refresh: true });
    expect(fake.calls.filter((c) => c.args[0] === 'repo')).toHaveLength(2);
    now += 6 * 60_000;
    await service.listGithubRepos();
    expect(fake.calls.filter((c) => c.args[0] === 'repo')).toHaveLength(3);
  });
  it('passes the owner and a clamped limit as separate arguments, and caches per owner', async () => {
    const fake = fakeGh({ 'repo list': () => ok('[]') });
    const { service } = setup({}, fake);
    await service.listGithubRepos({ owner: 'octo-org', limit: 9999 });
    await service.listGithubRepos();
    const lists = fake.calls.filter((c) => c.args[0] === 'repo');
    expect(lists).toHaveLength(2);
    expect(lists[0]!.args.slice(0, 5)).toEqual(['repo', 'list', 'octo-org', '--limit', '200']);
    await expect(service.listGithubRepos({ owner: '--json' })).rejects.toThrow(/valid account/);
  });
  it('rejects with the fix when gh is missing', async () => {
    const { service } = setup({}, fakeGh({}, { missing: true }));
    await expect(service.listGithubRepos()).rejects.toThrow(/winget install GitHub.cli/);
  });
  it('parseRepoList tolerates garbage', () => {
    expect(parseRepoList('not json')).toEqual([]);
    expect(parseRepoList('{}')).toEqual([]);
    expect(parseRepoList('[null, 5, {}]')).toEqual([]);
  });
});
