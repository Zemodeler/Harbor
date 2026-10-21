import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Git } from '../src/main/git';
import { validateInvoke } from '../src/main/ipcValidate';
import { setup, sh, temp } from './projects2Harness';

// B4: the folder level moves the project to the Recycle Bin by default; permanent delete is a second explicit option (contract 0.1.55).
/** A trash that behaves like the Recycle Bin: the folder disappears from its place and is kept elsewhere. */
function fakeBin() {
  const bin = temp('harbor-bin-');
  const trashed: string[] = [];
  let fail: Error | undefined, keep = false;
  return {
    bin, trashed,
    failWith: (e: Error) => { fail = e; },
    leaveInPlace: () => { keep = true; },
    trashItem: async (path: string) => {
      if (fail) throw fail;
      trashed.push(path);
      if (keep) return;
      const dest = join(bin, `${trashed.length}`);
      const { renameSync } = await import('node:fs');
      renameSync(path, dest);
    }
  };
}
async function withWork(bin = fakeBin()) {
  const s = setup({ trashItem: bin.trashItem });
  const r = await s.service.createProject({ name: 'Busy' });
  const wt = await new Git().createWorktree(r.path, s.worktreesRoot, r.project.id.slice(0, 8), 'task', 'abc123');
  writeFileSync(join(wt.path, 'new.txt'), 'work'); sh(wt.path, 'add', '.'); sh(wt.path, '-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'commit', '-m', 'Unmerged work');
  return { ...s, r, wt, bin };
}

describe('B4 validation', () => {
  it('accepts the options object and rejects bad shapes', () => {
    expect(() => validateInvoke('deleteProject', ['p', 'folder', 'name', { permanent: true, confirmPermanent: 'name' }])).not.toThrow();
    expect(() => validateInvoke('deleteProject', ['p', 'folder', 'name', null])).not.toThrow();
    for (const bad of [[ 'p', 'folder', 'n', 'x'], ['p', 'folder', 'n', []], ['p', 'folder', 'n', { permanent: 'yes' }], ['p', 'folder', 'n', { confirmPermanent: 5 }]]) expect(() => validateInvoke('deleteProject', bad), JSON.stringify(bad)).toThrow();
  });
});

describe('B4 recycle-bin delete', () => {
  it('previews that the Recycle Bin is available (or not)', async () => {
    const a = await withWork();
    expect((await a.service.previewDeleteProject(a.r.project.id)).recycleBin).toBe(true);
    const plain = setup();
    const r = await plain.service.createProject({ name: 'Plain' });
    expect((await plain.service.previewDeleteProject(r.project.id)).recycleBin).toBe(false);
  });

  it('moves the folder to the bin by default, keeps its harbor branches inside it, removes Harbor worktrees and the records', async () => {
    const { service, r, wt, bin } = await withWork();
    await expect(service.deleteProject(r.project.id, 'folder')).rejects.toThrow(/Type the project name/);
    expect(bin.trashed).toEqual([]);
    const out = await service.deleteProject(r.project.id, 'folder', 'Busy');
    expect(out.removed).toMatchObject({ records: true, folder: true, trashed: true, worktrees: 1, branches: 0 });
    expect(bin.trashed).toEqual([r.path]);
    expect(existsSync(r.path)).toBe(false);
    expect(existsSync(wt.path)).toBe(false);
    // The trashed copy is whole: restoring it brings the unmerged branch back.
    expect(readFileSync(join(bin.bin, '1', 'README.md'), 'utf8')).toContain('Busy');
    expect(sh(join(bin.bin, '1'), 'branch', '--format=%(refname:short)')).toContain(wt.branch);
    expect(await service.listProjects()).toEqual([]);
  });

  it('does not touch a junction target when trashing', async () => {
    const { service, r } = await withWork();
    const outside = temp('harbor-outside-'); writeFileSync(join(outside, 'precious.txt'), 'do not delete');
    symlinkSync(outside, join(r.path, 'node_modules'), 'junction');
    await service.deleteProject(r.project.id, 'folder', 'Busy');
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('do not delete');
  });

  it('a failed trash never falls back to permanent: the project stays, and the error names the way out', async () => {
    const { service, r, bin } = await withWork();
    bin.failWith(new Error('The recycle bin is full'));
    await expect(service.deleteProject(r.project.id, 'folder', 'Busy')).rejects.toThrow(/could not be moved to the Recycle Bin: The recycle bin is full.*choose permanent delete/s);
    expect(existsSync(r.path)).toBe(true);
    expect((await service.listProjects()).map((p) => p.id)).toEqual([r.project.id]);
  });

  it('refuses to report success when the folder is still there after trashing', async () => {
    const { service, r, bin } = await withWork();
    bin.leaveInPlace();
    await expect(service.deleteProject(r.project.id, 'folder', 'Busy')).rejects.toThrow(/still there/);
    expect((await service.listProjects()).map((p) => p.id)).toEqual([r.project.id]);
  });

  it('without a Recycle Bin (headless) the default is refused, nothing changes', async () => {
    const { service } = setup();
    const r = await service.createProject({ name: 'Headless' });
    await expect(service.deleteProject(r.project.id, 'folder', 'Headless')).rejects.toThrow(/Recycle Bin is not available.*permanent/s);
    expect(existsSync(r.path)).toBe(true);
    expect((await service.listProjects()).length).toBe(1);
  });
});

describe('B4 permanent delete is a second explicit option', () => {
  it('needs the name typed twice and then deletes for good without using the bin', async () => {
    const { service, r, wt, bin } = await withWork();
    await expect(service.deleteProject(r.project.id, 'folder', 'Busy', { permanent: true })).rejects.toThrow(/name again/);
    await expect(service.deleteProject(r.project.id, 'folder', 'Busy', { permanent: true, confirmPermanent: 'busy' })).rejects.toThrow(/name again/);
    await expect(service.deleteProject(r.project.id, 'folder', undefined, { permanent: true, confirmPermanent: 'Busy' })).rejects.toThrow(/Type the project name/);
    expect(existsSync(r.path)).toBe(true);
    const out = await service.deleteProject(r.project.id, 'folder', 'Busy', { permanent: true, confirmPermanent: 'Busy' });
    expect(out.removed).toMatchObject({ records: true, folder: true, worktrees: 1, branches: 1 });
    expect(out.removed.trashed).toBeUndefined();
    expect(bin.trashed).toEqual([]);
    expect(existsSync(r.path)).toBe(false);
    expect(existsSync(wt.path)).toBe(false);
  });

  it('is the explicit way out after a failed trash', async () => {
    const { service, r, bin } = await withWork();
    bin.failWith(new Error('no bin on this drive'));
    await expect(service.deleteProject(r.project.id, 'folder', 'Busy')).rejects.toThrow(/permanent/);
    const out = await service.deleteProject(r.project.id, 'folder', 'Busy', { permanent: true, confirmPermanent: 'Busy' });
    expect(out.removed.folder).toBe(true);
    expect(existsSync(r.path)).toBe(false);
  });

  it('does not change the other levels: forget and worktrees never use the bin', async () => {
    const a = await withWork();
    const out = await a.service.deleteProject(a.r.project.id, 'worktrees', 'Busy');
    expect(out.removed).toMatchObject({ records: true, worktrees: 1, branches: 1, folder: false });
    expect(a.bin.trashed).toEqual([]);
    expect(existsSync(a.r.path)).toBe(true);
    const b = await withWork();
    await b.service.deleteProject(b.r.project.id, 'forget');
    expect(b.bin.trashed).toEqual([]);
    expect(existsSync(b.r.path)).toBe(true);
    void mkdirSync; void rmSync;
  });

  it('still refuses blocked folders at both modes', async () => {
    const parent = temp('harbor-projects-');
    const bin = fakeBin();
    const { service } = setup({ appRoots: [join(parent, 'App')], defaultProjectsDir: parent, trashItem: bin.trashItem });
    const app = await service.createProject({ name: 'App' });
    await expect(service.deleteProject(app.project.id, 'folder', 'App')).rejects.toThrow(/cannot be deleted/);
    await expect(service.deleteProject(app.project.id, 'folder', 'App', { permanent: true, confirmPermanent: 'App' })).rejects.toThrow(/cannot be deleted/);
    expect(bin.trashed).toEqual([]);
    expect(existsSync(app.path)).toBe(true);
  });
});
