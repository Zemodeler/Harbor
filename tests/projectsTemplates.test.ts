import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadChecks } from '../src/main/checks';
import { INVOKE_METHODS } from '../src/shared/ipc';
import { METHOD_SCOPE, scopeAllows } from '../src/main/remote/scopes';
import { validateInvoke } from '../src/main/ipcValidate';
import { setup, sh } from './projects2Harness';

// B3: user templates, save project as template, per-template default checks (contract 0.1.53-0.1.54).
const GH_TOKEN = `ghp_${'a1B2c3D4e5F6g7H8i9J0'.repeat(2)}`;
const commit = (cwd: string, msg: string) => { sh(cwd, 'add', '-A', '-f'); sh(cwd, '-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'commit', '-m', msg); };

/** A project with ordinary files, a credential-looking file, a big file, an ignored folder and its own checks file. */
async function sourceProject() {
  const s = setup();
  const r = await s.service.createProject({ name: 'Source' });
  mkdirSync(join(r.path, 'src'), { recursive: true });
  writeFileSync(join(r.path, 'src', 'app.ts'), 'export const x = 1;\n');
  writeFileSync(join(r.path, 'docs.md'), '# docs\n');
  writeFileSync(join(r.path, 'prod.pem'), 'not a real key but named like one');
  writeFileSync(join(r.path, '.env'), 'PLAIN=1\n');
  writeFileSync(join(r.path, 'big.bin'), Buffer.alloc(1_100_000, 1));
  mkdirSync(join(r.path, '.harbor'), { recursive: true });
  writeFileSync(join(r.path, '.harbor', 'checks.json'), JSON.stringify({ checks: ['npm test', 'npm run build'] }));
  commit(r.path, 'more files');
  mkdirSync(join(r.path, 'node_modules')); writeFileSync(join(r.path, 'node_modules', 'dep.js'), 'x'); // ignored by the template .gitignore? untracked at least
  return { ...s, r };
}

describe('B3 contract wiring', () => {
  it('lists the template methods for IPC, never remotely, and validates the shapes', () => {
    for (const m of ['listTemplates', 'previewTemplate', 'saveProjectAsTemplate', 'updateTemplate', 'deleteTemplate'] as const) {
      expect(INVOKE_METHODS).toContain(m); expect(METHOD_SCOPE[m]).toBe('never');
      for (const sc of ['read-only', 'answer-permissions', 'full'] as const) expect(scopeAllows(sc, m)).toBe(false);
    }
    expect(() => validateInvoke('saveProjectAsTemplate', ['p', { name: 'T', description: 'd', checks: ['npm test'] }])).not.toThrow();
    for (const bad of [[], ['p'], ['p', { name: '' }], ['p', { name: 'x'.repeat(61) }], ['p', { name: 'T', checks: 'npm test' }], ['p', { name: 'T', checks: Array(11).fill('x') }], ['p', { name: 'T', checks: ['a\nb'] }]]) expect(() => validateInvoke('saveProjectAsTemplate', bad), JSON.stringify(bad)).toThrow();
    expect(() => validateInvoke('updateTemplate', ['t1', { checks: [] }])).not.toThrow();
    expect(() => validateInvoke('updateTemplate', ['t1', { name: 5 }])).toThrow();
    expect(() => validateInvoke('deleteTemplate', [''])).toThrow();
    expect(() => validateInvoke('createProject', [{ name: 'x', userTemplate: 't1' }])).not.toThrow();
    expect(() => validateInvoke('createProject', [{ name: 'x', userTemplate: 5 }])).toThrow();
  });
});

describe('B3 save a project as a template', () => {
  it('previews what would be copied: tracked files only, credential-looking and oversized files left out', async () => {
    const { service, r } = await sourceProject();
    const p = await service.previewTemplate(r.project.id);
    expect(p.blocked).toBe(false);
    expect(p.sample).toEqual(expect.arrayContaining(['src/app.ts', 'docs.md', 'README.md']));
    expect(p.sample.some((f) => f.startsWith('node_modules') || f.startsWith('.harbor') || f === '.env' || f === 'prod.pem' || f === 'big.bin')).toBe(false);
    const why = Object.fromEntries(p.excluded.map((e) => [e.path, e.reason]));
    expect(why['prod.pem']).toMatch(/credential/);
    expect(why['.env']).toMatch(/credential/);
    expect(why['big.bin']).toMatch(/1 MB/);
    expect(p.suggestedChecks).toEqual(['npm test', 'npm run build']);
    expect(p.findingsTotal).toBe(0);
  });

  it('saves into the data folder, lists it, and never copies credential files', async () => {
    const { service, r, dataDir } = await sourceProject();
    const t = await service.saveProjectAsTemplate(r.project.id, { name: 'My Starter', description: 'Mine', checks: ['npm test'] });
    expect(t).toMatchObject({ name: 'My Starter', description: 'Mine', checks: ['npm test'], source: 'Source' });
    expect(t.id).toMatch(/^my-starter-[0-9a-f]{6}$/);
    expect(t.files).toBeGreaterThanOrEqual(3);
    const dir = join(dataDir, 'templates', t.id);
    expect(existsSync(join(dir, 'template.json'))).toBe(true);
    expect(readFileSync(join(dir, 'files', 'src', 'app.ts'), 'utf8')).toContain('export const x');
    for (const gone of ['.env', 'prod.pem', 'big.bin', '.harbor', '.git']) expect(existsSync(join(dir, 'files', gone)), gone).toBe(false);
    expect((await service.listTemplates()).map((x) => x.id)).toEqual([t.id]);
  });

  it('blocks the save when the secret scan finds something, without repeating the value, and leaves no folder', async () => {
    const { service, r, dataDir } = await sourceProject();
    writeFileSync(join(r.path, 'src', 'config.ts'), `export const token = '${GH_TOKEN}';\n`);
    commit(r.path, 'oops');
    const p = await service.previewTemplate(r.project.id);
    expect(p.blocked).toBe(true);
    expect(p.findings).toEqual([{ type: 'github-token', file: 'src/config.ts', line: 1 }]);
    let message = '';
    await service.saveProjectAsTemplate(r.project.id, { name: 'Leaky' }).catch((e: Error) => { message = e.message; });
    expect(message).toMatch(/secret scan found 1 possible secret/);
    expect(message).not.toContain(GH_TOKEN);
    expect(existsSync(join(dataDir, 'templates')) ? readdirSync(join(dataDir, 'templates')) : []).toEqual([]);
    // The project's allowlist applies, as for pushing.
    await service.setSettings({ projectOverrides: { [r.project.id]: { secretAllowlist: ['src/config.ts'] } } });
    expect((await service.saveProjectAsTemplate(r.project.id, { name: 'Allowed' })).name).toBe('Allowed');
  });

  it('refuses a project that is not a git repository with commits', async () => {
    const { service, parent } = setup();
    const plain = join(parent, 'plain'); mkdirSync(plain); writeFileSync(join(plain, 'a.txt'), 'x');
    const added = (await service.addProject(plain))!;
    await expect(service.saveProjectAsTemplate(added.id, { name: 'Nope' })).rejects.toThrow(/not a git repository/);
  });

  it('validates names and checks', async () => {
    const { service, r } = await sourceProject();
    await expect(service.saveProjectAsTemplate(r.project.id, { name: '  ' })).rejects.toThrow(/1 to 60/);
    await expect(service.saveProjectAsTemplate(r.project.id, { name: 'T', checks: Array(11).fill('npm test') })).rejects.toThrow(/at most 10/);
    await expect(service.saveProjectAsTemplate(r.project.id, { name: 'T', checks: ['a\nb'] })).rejects.toThrow(/one command/);
    expect(await service.listTemplates()).toEqual([]);
  });
});

describe('B3 new project from a user template, default checks', () => {
  it('copies the template, commits it, and writes the default checks as a checks file that is NOT approved', async () => {
    const { service, r, parent } = await sourceProject();
    const t = await service.saveProjectAsTemplate(r.project.id, { name: 'Starter', checks: ['npm test', 'npm run build'] });
    const made = await service.createProject({ name: 'From Template', userTemplate: t.id });
    expect(made.path).toBe(join(parent, 'From Template'));
    expect(made.warnings.filter((w) => !/no user name/.test(w))).toEqual([]);
    expect(readFileSync(join(made.path, 'src', 'app.ts'), 'utf8')).toContain('export const x');
    expect(existsSync(join(made.path, '.env'))).toBe(false);
    expect(loadChecks(made.path)).toEqual(['npm test', 'npm run build']);
    expect(sh(made.path, 'ls-files').split(/\r?\n/)).toContain('.harbor/checks.json');
    expect(sh(made.path, 'status', '--porcelain').trim()).toBe('');
    // The existing approval flow decides: nothing is pre-approved.
    expect(service.store.getChecksApproval(made.project.id)).toBeUndefined();
  });
  it('a template without checks adds no checks file', async () => {
    const { service, r } = await sourceProject();
    const t = await service.saveProjectAsTemplate(r.project.id, { name: 'Plain' });
    const made = await service.createProject({ name: 'No Checks', userTemplate: t.id });
    expect(existsSync(join(made.path, '.harbor'))).toBe(false);
    expect(loadChecks(made.path)).toEqual([]);
  });
  it('an unknown or malicious template id creates nothing', async () => {
    const { service, parent } = setup();
    for (const id of ['nope-123456', '../escape', '..', 'a/b']) await expect(service.createProject({ name: 'Ghost', userTemplate: id }), id).rejects.toThrow(/no longer exists/);
    expect(readdirSync(parent)).toEqual([]);
  });
  it('built-in templates are unchanged and a user template wins over a built-in one', async () => {
    const { service, r } = await sourceProject();
    const t = await service.saveProjectAsTemplate(r.project.id, { name: 'Wins' });
    const builtin = await service.createProject({ name: 'Built In', template: 'python' });
    expect(existsSync(join(builtin.path, 'main.py'))).toBe(true);
    const both = await service.createProject({ name: 'Both', template: 'python', userTemplate: t.id });
    expect(existsSync(join(both.path, 'main.py'))).toBe(false);
    expect(existsSync(join(both.path, 'src', 'app.ts'))).toBe(true);
  });
});

describe('B3 manage templates', () => {
  it('updates name, description and checks; deletes only the template folder', async () => {
    const { service, r, dataDir, parent } = await sourceProject();
    const t = await service.saveProjectAsTemplate(r.project.id, { name: 'Old' });
    const u = await service.updateTemplate(t.id, { name: 'New', description: 'Better', checks: ['npm test'] });
    expect(u).toMatchObject({ id: t.id, name: 'New', description: 'Better', checks: ['npm test'] });
    expect((await service.listTemplates())[0]).toMatchObject({ name: 'New', checks: ['npm test'] });
    await expect(service.updateTemplate(t.id, { checks: Array(11).fill('x') })).rejects.toThrow(/at most 10/);
    await expect(service.updateTemplate('missing-000000', { name: 'x' })).rejects.toThrow(/Unknown template/);
    const keep = join(dataDir, 'keepme.txt'); writeFileSync(keep, 'x');
    await expect(service.deleteTemplate('../keepme.txt')).rejects.toThrow(/Unknown template/);
    await expect(service.deleteTemplate('..')).rejects.toThrow(/Unknown template/);
    await service.deleteTemplate(t.id);
    expect(await service.listTemplates()).toEqual([]);
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(r.path)).toBe(true);
    expect(existsSync(parent)).toBe(true);
  });
});
