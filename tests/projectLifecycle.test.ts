import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Git } from '../src/main/git';
import { GitHub } from '../src/main/github';
import { runProcess, type RunResult, type Runner } from '../src/main/proc';
import { deleteProject as deleteProjectImpl, previewDelete } from '../src/main/projectDelete';
import { repoNameFor, sanitizeFolderName } from '../src/main/projectCreate';
import { createHarborService, type HarborService } from '../src/main/service';
import { INVOKE_METHODS } from '../src/shared/ipc';
import { METHOD_SCOPE, scopeAllows } from '../src/main/remote/scopes';
import { validateInvoke } from '../src/main/ipcValidate';

// Each case spawns many git processes; under a parallel full run the default 20 s is not always enough.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const dirs: string[] = [], services: HarborService[] = [];
const temp = (p = 'harbor-life-') => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(async () => { for (const s of services.splice(0)) await s.shutdown(); dirs.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true, maxRetries: 3 })); });
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' }).toString();

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const LOGGED_IN: RunResult = { code: 0, stdout: '', stderr: '  ✓ Logged in to github.com account Zemodeler (keyring)\n', timedOut: false };
/** A fake gh: `repo create` adds the local bare repo as origin, `pr create` returns a URL. Everything is recorded. */
function fakeGh(o: { origin?: string; signedIn?: boolean; missing?: boolean } = {}) {
  const calls: { args: string[]; input?: string }[] = [];
  const run: Runner = async (_exe, args, opts) => {
    calls.push({ args, ...(opts?.input !== undefined ? { input: opts.input } : {}) });
    if (o.missing) return { code: null, stdout: '', stderr: '', timedOut: false, error: 'spawn gh ENOENT' };
    if (args[0] === 'auth') return o.signedIn === false ? { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.', timedOut: false } : LOGGED_IN;
    if (args[0] === 'repo') {
      if (o.origin && opts?.cwd) sh(opts.cwd, 'remote', 'add', 'origin', o.origin);
      return ok('https://github.com/Zemodeler/' + String(args[2]) + '\n');
    }
    if (args[0] === 'pr') return ok('https://github.com/Zemodeler/x/pull/12\n');
    return { code: 1, stdout: '', stderr: 'unexpected', timedOut: false };
  };
  return { gh: new GitHub(run), calls };
}

function setup(extra: Partial<Parameters<typeof createHarborService>[0]> = {}) {
  const dataDir = temp('harbor-data-'), parent = temp('harbor-projects-'), origin = temp('harbor-origin-');
  sh(origin, 'init', '--bare', '-b', 'main');
  const fake = fakeGh({ origin });
  const service = createHarborService({ dataDir, discover: async () => [], github: fake.gh, defaultProjectsDir: parent, deleteSleep: async () => {}, ...extra });
  services.push(service);
  return { service, dataDir, parent, origin, fake, worktreesRoot: join(dataDir, 'worktrees') };
}

describe('contract wiring', () => {
  it('lists every new method for IPC, never remotely, and validates the shapes', () => {
    const names = ['createProject', 'previewDeleteProject', 'deleteProject', 'previewPush', 'pushBranch', 'createPullRequest', 'setRemote', 'getGithubStatus', 'browseFolder'] as const;
    for (const m of names) { expect(INVOKE_METHODS).toContain(m); expect(METHOD_SCOPE[m]).toBe('never'); for (const s of ['read-only', 'answer-permissions', 'full'] as const) expect(scopeAllows(s, m)).toBe(false); }
    expect(() => validateInvoke('createProject', [{ name: 'ok', template: 'node-ts', github: { create: true, visibility: 'private' } }])).not.toThrow();
    for (const bad of [null, {}, { name: '' }, { name: 'x'.repeat(81) }, { name: 'x', template: 'rust' }, { name: 'x', github: { create: true, visibility: 'secret' } }, { name: 'x', parentDir: 5 }])
      expect(() => validateInvoke('createProject', [bad]), JSON.stringify(bad)).toThrow();
    expect(() => validateInvoke('deleteProject', ['p', 'everything'])).toThrow();
    expect(() => validateInvoke('deleteProject', ['p', 'folder', 'name'])).not.toThrow();
    expect(() => validateInvoke('pushBranch', ['p', '--force'])).toThrow();
    expect(() => validateInvoke('createPullRequest', ['p', { branch: 'harbor/x', title: 'a\nb' }])).toThrow();
    expect(() => validateInvoke('setRemote', ['p', ''])).toThrow();
  });
  it('validates and stores the projects folder setting', async () => {
    const { service, parent } = setup();
    expect((await service.setSettings({ projectsDir: parent })).projectsDir).toBe(parent);
    await expect(service.setSettings({ projectsDir: 'relative/dir' })).rejects.toThrow(/absolute/);
    await expect(service.setSettings({ projectsDir: 'C:\\' })).rejects.toThrow(/absolute/);
    expect('projectsDir' in (await service.setSettings({ projectsDir: '' }))).toBe(false);
  });
});

describe('folder names', () => {
  it('sanitises what the owner typed', () => {
    const table: [string, string | undefined][] = [['My App', 'My App'], ['a/b\\c', 'a-b-c'], ['  x. ', 'x'], ['CON', 'CON-project'], ['nul.txt', 'nul.txt-project'], ['we:ird*?name', 'we-ird--name'], ['...', undefined], ['', undefined], ['///', undefined]];
    for (const [i, o] of table) expect(sanitizeFolderName(i), i).toBe(o);
    expect(sanitizeFolderName('x'.repeat(200))!.length).toBe(80);
    expect(repoNameFor('My App v2')).toBe('My-App-v2');
  });
});

describe('createProject', () => {
  it.each([
    ['empty', ['.gitignore', 'AGENTS.md', 'README.md']],
    ['node-ts', ['.gitignore', 'AGENTS.md', 'README.md', 'package.json', 'src/index.ts', 'tsconfig.json']],
    ['python', ['.gitignore', 'AGENTS.md', 'README.md', 'main.py', 'pyproject.toml']],
    ['static-web', ['.gitignore', 'AGENTS.md', 'README.md', 'index.html']]
  ] as const)('makes the %s template, commits it and registers the project', async (template, files) => {
    const { service, parent } = setup();
    const r = await service.createProject({ name: 'Demo App', template });
    expect(r.path).toBe(join(parent, 'Demo App'));
    expect(r.warnings.filter((w) => !/no user name/.test(w))).toEqual([]);
    expect(sh(r.path, 'ls-files').split(/\r?\n/).filter(Boolean).sort()).toEqual([...files]);
    expect(sh(r.path, 'status', '--porcelain').trim()).toBe('');
    expect(sh(r.path, 'branch', '--show-current').trim()).toBe('main');
    expect((await service.listProjects()).map((p) => p.path)).toEqual([r.path]);
    if (template === 'node-ts') expect(JSON.parse(readFileSync(join(r.path, 'package.json'), 'utf8')).name).toBe('demo-app');
  });
  it('refuses a non-empty target and leaves it exactly as it was', async () => {
    const { service, parent } = setup();
    mkdirSync(join(parent, 'Taken')); writeFileSync(join(parent, 'Taken', 'mine.txt'), 'keep me');
    await expect(service.createProject({ name: 'Taken' })).rejects.toThrow(/not empty/);
    expect(readFileSync(join(parent, 'Taken', 'mine.txt'), 'utf8')).toBe('keep me');
    await expect(service.createProject({ name: 'taken' })).rejects.toThrow(/not empty/); // case-insensitive on Windows
    expect(await service.listProjects()).toEqual([]);
  });
  it('refuses a folder an existing project already uses, and Harbor\'s own folders', async () => {
    const { service, parent, dataDir } = setup();
    await service.createProject({ name: 'One' });
    await expect(service.createProject({ name: 'One' })).rejects.toThrow();
    await expect(service.createProject({ name: 'Inside', parentDir: dataDir })).rejects.toThrow(/own data folder/);
    await expect(service.createProject({ name: 'x', parentDir: join(parent, 'does-not-exist') })).rejects.toThrow(/does not exist/);
  });
  it('rolls back only what it made when the first commit fails', async () => {
    const failing: Runner = (exe, args, o) => (args.includes('commit') ? Promise.resolve({ code: 1, stdout: '', stderr: 'boom', timedOut: false }) : runProcess(exe, args, o));
    const { service, parent } = setup({ git: new Git(failing) });
    await expect(service.createProject({ name: 'Fresh' })).rejects.toThrow(/was not created/);
    expect(existsSync(join(parent, 'Fresh'))).toBe(false);
    mkdirSync(join(parent, 'Pre')); // existed, empty: stays, emptied
    await expect(service.createProject({ name: 'Pre' })).rejects.toThrow(/was not created/);
    expect(existsSync(join(parent, 'Pre'))).toBe(true);
    expect(readdirSync(join(parent, 'Pre'))).toEqual([]);
    expect(await service.listProjects()).toEqual([]);
  });
  it('creates the private GitHub repo through gh, pushes main once, and reports the remote', async () => {
    const { service, origin, fake } = setup();
    const r = await service.createProject({ name: 'Shared', github: { create: true, visibility: 'private' } });
    expect(r.remote).toBe('https://github.com/Zemodeler/Shared');
    expect(r.warnings.filter((w) => !/no user name/.test(w))).toEqual([]);
    expect(fake.calls.find((c) => c.args[0] === 'repo')!.args).toContain('--private');
    expect(sh(origin, 'rev-parse', 'refs/heads/main').trim()).toBe(sh(r.path, 'rev-parse', 'HEAD').trim());
  });
  it('still makes the local project, with a one-line fix, when gh is missing', async () => {
    const dataDir = temp('harbor-data-'), parent = temp('harbor-projects-');
    const service = createHarborService({ dataDir, discover: async () => [], github: fakeGh({ missing: true }).gh, defaultProjectsDir: parent }); services.push(service);
    const r = await service.createProject({ name: 'Local', github: { create: true, visibility: 'private' } });
    expect(r.remote).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/not created.*winget install GitHub\.cli/);
    expect(existsSync(join(r.path, '.git'))).toBe(true);
    expect((await service.getGithubStatus()).installed).toBe(false);
  });
  it('keeps the project and says so when the first push fails', async () => {
    const { service } = setup({ github: fakeGh({ origin: 'C:\\no\\such\\origin.git' }).gh });
    const r = await service.createProject({ name: 'Broken', github: { create: true, visibility: 'public' } });
    expect(r.warnings.join(' ')).toMatch(/first push failed/);
    expect((await service.listProjects()).length).toBe(1);
  });
  it('opens a conversation for the first prompt', async () => {
    const { service } = setup();
    const r = await service.createProject({ name: 'Prompted', firstPrompt: 'Add a hello world page' });
    expect(r.conversationId).toBeTruthy();
    expect((await service.listConversations(r.project.id)).map((c) => c.id)).toContain(r.conversationId);
  });
});

describe('deleting a project', () => {
  it('forget is removeProject: records go, files stay', async () => {
    const { service } = setup();
    const r = await service.createProject({ name: 'Forgettable' });
    const out = await service.deleteProject(r.project.id, 'forget');
    expect(out.removed).toEqual({ records: true, worktrees: 0, branches: 0, folder: false });
    expect(await service.listProjects()).toEqual([]);
    expect(existsSync(r.path)).toBe(true);
  });
  async function withWork() {
    const s = setup();
    const r = await s.service.createProject({ name: 'Busy' });
    const git = new Git();
    const wt = await git.createWorktree(r.path, s.worktreesRoot, r.project.id.slice(0, 8), 'task', 'abc123');
    writeFileSync(join(wt.path, 'new.txt'), 'work'); sh(wt.path, 'add', '.'); sh(wt.path, '-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'commit', '-m', 'Unmerged work');
    sh(r.path, 'branch', 'feature/keep');
    return { ...s, r, wt };
  }
  it('previews worktrees, harbor branches and folder state without changing anything', async () => {
    const { service, r, wt } = await withWork();
    writeFileSync(join(r.path, 'dirty.txt'), 'x');
    const p = await service.previewDeleteProject(r.project.id);
    expect(p.worktrees).toMatchObject([{ path: wt.path, branch: wt.branch, dirty: false, unmergedCommits: 1 }]);
    expect(p.branches).toEqual([{ name: wt.branch, unpushed: 2, merged: false }]); // its own commit plus the project's first one: no remote has either
    expect(p.folder).toMatchObject({ exists: true, dirty: true, hasRemote: false, outsideProjectsDir: false });
    expect(p.folder.unpushedCommits).toBeGreaterThan(0);
    expect(p.needsTypedName).toEqual({ worktrees: true, folder: true });
    expect(p.blockers).toEqual([]);
    expect(existsSync(wt.path)).toBe(true);
  });
  it('worktrees level removes only Harbor worktrees and harbor/* branches, and needs the name for unmerged work', async () => {
    const { service, r, wt } = await withWork();
    await expect(service.deleteProject(r.project.id, 'worktrees')).rejects.toThrow(/Type the project name/);
    await expect(service.deleteProject(r.project.id, 'worktrees', 'wrong')).rejects.toThrow(/Type the project name/);
    expect(existsSync(wt.path)).toBe(true);
    const out = await service.deleteProject(r.project.id, 'worktrees', 'Busy');
    expect(out.removed).toEqual({ records: true, worktrees: 1, branches: 1, folder: false });
    expect(existsSync(wt.path)).toBe(false);
    expect(sh(r.path, 'branch', '--format=%(refname:short)').split(/\r?\n/).filter(Boolean).sort()).toEqual(['feature/keep', 'main']);
    expect(existsSync(join(r.path, 'README.md'))).toBe(true);
    expect(await service.listProjects()).toEqual([]);
  });
  it('worktrees level with nothing to lose needs no typed name', async () => {
    const { service } = setup();
    const r = await service.createProject({ name: 'Tidy' });
    expect((await service.deleteProject(r.project.id, 'worktrees')).removed.records).toBe(true);
  });
  it('folder level needs the exact name, then removes the folder, worktrees and records', async () => {
    const { service, r, wt } = await withWork();
    await expect(service.deleteProject(r.project.id, 'folder')).rejects.toThrow(/Type the project name/);
    await expect(service.deleteProject(r.project.id, 'folder', 'busy')).rejects.toThrow(/Type the project name/);
    expect(existsSync(r.path)).toBe(true);
    const out = await service.deleteProject(r.project.id, 'folder', 'Busy', { permanent: true, confirmPermanent: 'Busy' });
    expect(out.removed).toMatchObject({ records: true, folder: true, worktrees: 1 });
    expect(existsSync(r.path)).toBe(false);
    expect(existsSync(wt.path)).toBe(false);
    expect(await service.listProjects()).toEqual([]);
  });
  it('never deletes through a junction inside the project', async () => {
    const { service } = setup();
    const r = await service.createProject({ name: 'Linked' });
    const outside = temp('harbor-outside-'); writeFileSync(join(outside, 'precious.txt'), 'do not delete');
    mkdirSync(join(outside, 'deep')); writeFileSync(join(outside, 'deep', 'also.txt'), 'nor this');
    symlinkSync(outside, join(r.path, 'node_modules'), 'junction');
    await service.deleteProject(r.project.id, 'folder', 'Linked', { permanent: true, confirmPermanent: 'Linked' });
    expect(existsSync(r.path)).toBe(false);
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('do not delete');
    expect(readFileSync(join(outside, 'deep', 'also.txt'), 'utf8')).toBe('nor this');
  });
  it('refuses the folder level for the app\'s own folder, a link, and a folder holding another project', async () => {
    const parent = temp('harbor-projects-');
    const { service } = setup({ appRoots: [join(parent, 'App')], defaultProjectsDir: parent });
    const app = await service.createProject({ name: 'App' });
    const p = await service.previewDeleteProject(app.project.id);
    expect(p.blockers.join(' ')).toMatch(/Harbor's own app/);
    await expect(service.deleteProject(app.project.id, 'folder', 'App')).rejects.toThrow(/cannot be deleted/);
    expect(existsSync(app.path)).toBe(true);
    const outer = await service.createProject({ name: 'Outer', parentDir: parent });
    const inner = await service.addProject(join(outer.path, 'inner-proj')) .catch(() => null);
    expect(inner).toBeNull();
    mkdirSync(join(outer.path, 'inner')); await service.addProject(join(outer.path, 'inner'));
    expect((await service.previewDeleteProject(outer.project.id)).blockers.join(' ')).toMatch(/Another project/);
  });
  it('retries a locked file and keeps the project when the folder cannot be removed', async () => {
    const { service, dataDir, worktreesRoot } = setup();
    const r = await service.createProject({ name: 'Locked' });
    const deps = { git: new Git(), store: service.store, worktreesRoot, projectsDir: temp('harbor-p-'), protectedRoots: [dataDir], running: () => 0, stopAll: () => {}, sleep: async () => {} };
    let tries = 0;
    const lockTwice = (p: string) => { if (++tries < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); rmSync(p, { recursive: true, force: true }); };
    const done = await deleteProjectImpl(r.project, 'folder', 'Locked', { ...deps, rm: lockTwice }, { permanent: true, confirmPermanent: 'Locked' });
    expect(done.removed.folder).toBe(true);
    expect(tries).toBe(3);

    const r2 = await service.createProject({ name: 'Stuck' });
    const stuck = await deleteProjectImpl(r2.project, 'folder', 'Stuck', { ...deps, rm: () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }); } }, { permanent: true, confirmPermanent: 'Stuck' });
    expect(stuck.removed).toMatchObject({ folder: false, records: false });
    expect(stuck.warnings.join(' ')).toMatch(/still in use/);
    expect((await service.listProjects()).map((p) => p.id)).toEqual([r2.project.id]); // still listed, retryable
    expect(existsSync(r2.path)).toBe(true);
    void previewDelete;
  });
  it('flags a folder outside the projects folder', async () => {
    const { service } = setup();
    const elsewhere = temp('harbor-elsewhere-'); writeFileSync(join(elsewhere, 'a.txt'), 'x');
    const p = await service.addProject(elsewhere);
    expect((await service.previewDeleteProject(p!.id)).folder.outsideProjectsDir).toBe(true);
  });
});

describe('publishing', () => {
  async function work(s = setup()) {
    const r = await s.service.createProject({ name: 'Pub', github: { create: true, visibility: 'private' } });
    sh(r.path, 'switch', '-c', 'harbor/feat'); writeFileSync(join(r.path, 'f.txt'), 'feature'); sh(r.path, 'add', '.'); sh(r.path, '-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'commit', '-m', 'Add f');
    sh(r.path, 'switch', 'main');
    return { ...s, r };
  }
  it('previews the commits and pushes a harbor branch plainly, recording it', async () => {
    const { service, r, origin } = await work();
    const pv = await service.previewPush(r.project.id, 'harbor/feat');
    expect(pv).toMatchObject({ branch: 'harbor/feat', remote: 'origin', ahead: 1, behind: 0, isDefaultBranch: false, needsRemote: false });
    expect(pv.commits.map((c) => c.subject)).toEqual(['Add f']);
    expect(pv.secretScan).toMatchObject({ findings: [], allowed: 0 });
    const out = await service.pushBranch(r.project.id, 'harbor/feat');
    expect(out).toMatchObject({ ok: true, remote: 'origin', branch: 'harbor/feat' });
    expect(sh(origin, 'rev-parse', 'refs/heads/harbor/feat').trim()).toBe(sh(r.path, 'rev-parse', 'harbor/feat').trim());
    expect(service.store.listCoordination?.(r.project.id)?.some((e: { text: string }) => /Pushed harbor\/feat/.test(e.text)) ?? true).toBe(true);
    expect((await service.previewPush(r.project.id, 'harbor/feat')).ahead).toBe(0);
  });
  it('refuses the default branch without the named confirmation, and a missing remote', async () => {
    const { service, r } = await work();
    sh(r.path, '-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'commit', '--allow-empty', '-m', 'Local main work');
    expect((await service.previewPush(r.project.id, 'main')).isDefaultBranch).toBe(true);
    await expect(service.pushBranch(r.project.id, 'main')).rejects.toThrow(/default branch/);
    expect((await service.pushBranch(r.project.id, 'main', { allowDefaultBranch: true })).ok).toBe(true);
    const s2 = setup();
    const bare = await s2.service.createProject({ name: 'NoRemote' });
    sh(bare.path, 'branch', 'harbor/x');
    expect((await s2.service.previewPush(bare.project.id, 'harbor/x')).needsRemote).toBe(true);
    await expect(s2.service.pushBranch(bare.project.id, 'harbor/x')).rejects.toThrow(/no remote/);
    await expect(s2.service.previewPush(bare.project.id, 'nope')).rejects.toThrow(/does not exist/);
  });
  it('blocks on secrets in any pushed commit, shows type and place only, and honours the allowlist and an exact override', async () => {
    const { service, r, origin } = await work();
    const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    sh(r.path, 'switch', 'harbor/feat');
    writeFileSync(join(r.path, 'config.txt'), `aws = ${key}\n`); sh(r.path, 'add', '.'); sh(r.path, '-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'commit', '-m', 'Oops');
    sh(r.path, 'rm', '-q', 'config.txt'); sh(r.path, '-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'commit', '-m', 'Remove it again'); // still in history
    sh(r.path, 'switch', 'main');
    const pv = await service.previewPush(r.project.id, 'harbor/feat');
    expect(pv.secretScan!.findings).toEqual([{ type: 'aws-access-key', file: 'config.txt', line: 1 }]);
    expect(JSON.stringify(pv)).not.toContain(key);
    const blocked = await service.pushBranch(r.project.id, 'harbor/feat').catch((e: Error) => e);
    expect((blocked as Error).message).toMatch(/secret scan found 1/);
    expect((blocked as Error).message).not.toContain(key);
    await expect(service.pushBranch(r.project.id, 'harbor/feat', { secretOverride: 'wrong' })).rejects.toThrow(/secret scan/);
    expect(() => sh(origin, 'rev-parse', '--verify', 'refs/heads/harbor/feat')).toThrow();
    await service.setSettings({ secretAllowlist: ['config.txt'] });
    const allowed = await service.previewPush(r.project.id, 'harbor/feat');
    expect(allowed.secretScan).toMatchObject({ findings: [], allowed: 1 });
    expect((await service.pushBranch(r.project.id, 'harbor/feat')).ok).toBe(true);
  });
  it('accepts the exact fingerprint of the findings as an override', async () => {
    const { service, r } = await work();
    sh(r.path, 'switch', 'harbor/feat');
    writeFileSync(join(r.path, 'x.txt'), 'token = ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8' + '\n'); sh(r.path, 'add', '.'); sh(r.path, '-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'commit', '-m', 'Fixture');
    sh(r.path, 'switch', 'main');
    const pv = await service.previewPush(r.project.id, 'harbor/feat');
    expect(pv.secretScan!.fingerprint).toBeTruthy();
    expect((await service.pushBranch(r.project.id, 'harbor/feat', { secretOverride: pv.secretScan!.fingerprint })).ok).toBe(true);
  });
  it('refuses to push a branch an agent is working on', async () => {
    const { service, r } = await work();
    service.store.upsertAgent({ id: 'h1', projectId: r.project.id, role: 'implementer', title: 'Feat', state: 'working', cli: 'claude', model: 'm', effort: 'low', task: 't', dependsOn: [], revision: 0, attempts: 0, created: 1, parentConversationId: 'c', branch: 'harbor/feat' });
    expect((await service.previewPush(r.project.id, 'harbor/feat')).busy).toBe(true);
    await expect(service.pushBranch(r.project.id, 'harbor/feat')).rejects.toThrow(/still working/);
  });
  it('opens a pull request after pushing, with the body on stdin and the default branch as base', async () => {
    const { service, r, origin, fake } = await work();
    const out = await service.createPullRequest(r.project.id, { branch: 'harbor/feat', title: 'Add f', body: 'Why: tests' });
    expect(out.url).toBe('https://github.com/Zemodeler/x/pull/12');
    expect(sh(origin, 'rev-parse', 'refs/heads/harbor/feat').trim()).toBe(sh(r.path, 'rev-parse', 'harbor/feat').trim());
    const pr = fake.calls.find((c) => c.args[0] === 'pr')!;
    expect(pr.args).toEqual(['pr', 'create', '--head', 'harbor/feat', '--base', 'main', '--title', 'Add f', '--body-file', '-']);
    expect(pr.input).toBe('Why: tests');
    await expect(service.createPullRequest(r.project.id, { branch: 'main', title: 't' })).rejects.toThrow();
  });
  it('sets and replaces the remote only on purpose', async () => {
    const { service } = setup();
    const r = await service.createProject({ name: 'Wire' });
    await service.setRemote(r.project.id, 'https://github.com/o/a.git');
    await expect(service.setRemote(r.project.id, 'https://github.com/o/b.git')).rejects.toThrow(/already has a remote/);
    await service.setRemote(r.project.id, 'git@github.com:o/b.git', { replace: true });
    expect(sh(r.path, 'remote', 'get-url', 'origin').trim()).toBe('git@github.com:o/b.git');
    await expect(service.setRemote(r.project.id, 'file:///x', { replace: true })).rejects.toThrow();
  });
});

describe('worktree housekeeping', () => {
  it('lists worktrees across projects and removes only merged, stale or orphaned ones that are idle and clean', async () => {
    const { service, worktreesRoot } = setup();
    const r = await service.createProject({ name: 'Keeper' });
    const git = new Git();
    const key = r.project.id.slice(0, 8);
    const commit = (cwd: string, f: string) => { writeFileSync(join(cwd, f), f); sh(cwd, 'add', '.'); sh(cwd, '-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'commit', '-m', f); };
    const merged = await git.createWorktree(r.path, worktreesRoot, key, 'merged', 'aaaaaa');           // no commits of its own: already merged
    const unmerged = await git.createWorktree(r.path, worktreesRoot, key, 'unmerged', 'bbbbbb'); commit(unmerged.path, 'u.txt');
    const dirty = await git.createWorktree(r.path, worktreesRoot, key, 'dirty', 'cccccc'); writeFileSync(join(dirty.path, 'wip.txt'), 'wip');
    const busy = await git.createWorktree(r.path, worktreesRoot, key, 'busy', 'dddddd');
    service.store.upsertAgent({ id: 'busy', projectId: r.project.id, role: 'implementer', title: 'busy', state: 'working', cli: 'claude', model: 'm', effort: 'low', task: 't', dependsOn: [], revision: 0, attempts: 0, created: 1, parentConversationId: 'c', branch: busy.branch, worktree: busy.path });
    const orphanDir = join(worktreesRoot, 'deadbeef', 'old-task'); mkdirSync(orphanDir, { recursive: true }); writeFileSync(join(orphanDir, 'x.txt'), 'x');
    const outside = temp('harbor-outside-'); writeFileSync(join(outside, 'keep.txt'), 'keep');
    symlinkSync(outside, join(orphanDir, 'node_modules'), 'junction');

    const list = await service.listWorktrees();
    const by = (p: string) => list.find((w) => w.path.toLowerCase() === p.toLowerCase())!;
    expect(by(merged.path)).toMatchObject({ merged: true, removable: true, orphan: false, projectName: 'Keeper' });
    expect(by(unmerged.path)).toMatchObject({ merged: false, removable: false });
    expect(by(dirty.path)).toMatchObject({ dirty: true, removable: false });
    expect(by(busy.path)).toMatchObject({ active: true, removable: false });
    expect(by(orphanDir)).toMatchObject({ orphan: true, removable: true });

    const out = await service.cleanupWorktrees();
    expect(out.removed).toBe(2);
    expect(out.branchesDeleted).toBe(1);
    expect(existsSync(merged.path)).toBe(false);
    expect(existsSync(orphanDir)).toBe(false);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    for (const kept of [unmerged, dirty, busy]) expect(existsSync(kept.path)).toBe(true);
    const branches = sh(r.path, 'branch', '--format=%(refname:short)').split(/\r?\n/).filter(Boolean);
    expect(branches).not.toContain(merged.branch);
    expect(branches).toEqual(expect.arrayContaining([unmerged.branch, dirty.branch, busy.branch]));
  });
  it('removes only the paths asked for', async () => {
    const { service, worktreesRoot } = setup();
    const r = await service.createProject({ name: 'Two' });
    const git = new Git(), key = r.project.id.slice(0, 8);
    const a = await git.createWorktree(r.path, worktreesRoot, key, 'a', 'aaaaaa'), b = await git.createWorktree(r.path, worktreesRoot, key, 'b', 'bbbbbb');
    expect((await service.cleanupWorktrees([a.path])).removed).toBe(1);
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(true);
    expect((await service.cleanupWorktrees([join(r.path)])).removed).toBe(0); // not a listed worktree: ignored
    expect(existsSync(r.path)).toBe(true);
  });
});
