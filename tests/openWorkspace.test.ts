import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarborService, type HarborService } from '../src/main/service';
import { validateInvoke } from '../src/main/ipcValidate';

const dirs: string[] = [], services: HarborService[] = [];
afterEach(() => { services.splice(0).forEach(s => s.shutdown()); dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });

async function setup() {
  const path = mkdtempSync(join(tmpdir(), 'harbor-open-')); dirs.push(path);
  mkdirSync(join(path, 'src')); writeFileSync(join(path, 'src', 'a.ts'), 'x');
  const launch = vi.fn(async () => {}), openFolder = vi.fn(async (_p: string) => {});
  const service = createHarborService({ discover: async () => [], launch, openFolder }); services.push(service);
  const project = (await service.addProject(path))!;
  return { service, project, path, launch, openFolder };
}

describe('openWorkspace', () => {
  it('opens a terminal and the editor on the project folder, using the chosen editor', async () => {
    const { service, project, path, launch } = await setup();
    await service.openWorkspace(project.id, 'terminal');
    expect(launch).toHaveBeenLastCalledWith('terminal', { dir: path, file: undefined }, undefined);
    await service.setSettings({ editor: 'cursor' });
    await service.openWorkspace(project.id, 'editor', { file: 'src/a.ts' });
    expect(launch).toHaveBeenLastCalledWith('editor', { dir: path, file: join('src', 'a.ts') }, 'cursor');
  });

  it('reveals files through the folder opener', async () => {
    const { service, project, path, openFolder } = await setup();
    await service.openWorkspace(project.id, 'folder', { file: 'src/a.ts' });
    expect(openFolder).toHaveBeenCalledWith(join(path, 'src', 'a.ts'));
  });

  it('refuses paths that leave the folder, missing files and terminals on a file', async () => {
    const { service, project, launch } = await setup();
    for (const file of ['..\\outside.txt', '../x', 'C:\\Windows\\notepad.exe', '/etc/passwd', 'nope.ts']) {
      await expect(service.openWorkspace(project.id, 'editor', { file })).rejects.toThrow(/inside the folder|does not exist/);
    }
    await expect(service.openWorkspace(project.id, 'terminal', { file: 'src/a.ts' })).rejects.toThrow(/not a file/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses unknown projects, unknown helpers and helpers without a worktree', async () => {
    const { service, project } = await setup();
    await expect(service.openWorkspace('nope', 'terminal')).rejects.toThrow();
    await expect(service.openWorkspace(project.id, 'terminal', { agentId: 'nope' })).rejects.toThrow(/does not belong/);
  });

  it('rejects an unknown editor setting', async () => {
    const { service } = await setup();
    await expect(service.setSettings({ editor: 'notepad' as never })).rejects.toThrow(/editor must be one of/);
  });

  it('validates IPC arguments', () => {
    expect(() => validateInvoke('openWorkspace', ['p', 'terminal'])).not.toThrow();
    expect(() => validateInvoke('openWorkspace', ['p', 'shell'])).toThrow(/action/);
    expect(() => validateInvoke('openWorkspace', ['p', 'editor', { file: 'a\nb' }])).toThrow(/relative path/);
  });
});
