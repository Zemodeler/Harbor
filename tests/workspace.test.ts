import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarborService, type HarborService } from '../src/main/service';
import { reviewDirectory, reviewable } from '../src/main/review';

const dirs: string[] = [], services: HarborService[] = [];
const directory = () => { const p = mkdtempSync(join(tmpdir(), 'harbor-workspace-')); dirs.push(p); return p; };
afterEach(() => { services.splice(0).forEach(s => s.shutdown()); dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
async function setup() {
  const path = directory(), openFolder = vi.fn(async (_path: string) => {});
  const service = createHarborService({ discover: async () => [], openFolder }); services.push(service);
  const project = await service.addProject(path);
  if (!project) throw new Error('Fixture project was not created.');
  const first = await service.newConversation(project.id), second = await service.newConversation(project.id);
  return { service, project, first, second, openFolder, path };
}
describe('Workspace history and session APIs', () => {
  it('renames, pins, archives and restores without losing messages', async () => {
    const { service, first } = await setup();
    service.store.addMessage({ id: 'message', conversationId: first.id, time: 1, role: 'user', text: 'Address validation needs a review.' });
    await service.updateConversation(first.id, { title: '  Address flow  ', pinned: true, archived: true });
    const hits = await service.searchConversations('VALIDATION');
    expect(hits[0]).toMatchObject({ conversation: { id: first.id, title: 'Address flow', pinned: true, archived: true, customTitle: true }, excerpt: 'Address validation needs a review.' });
    await service.updateConversation(first.id, { archived: false });
    expect(await service.listMessages(first.id)).toHaveLength(1);
    await expect(service.updateConversation(first.id, { title: ' ' })).rejects.toThrow('conversation name');
  });
  it('stops only the selected session and blocks archiving active sessions', async () => {
    const { service, first, second } = await setup();
    for (const c of [first, second]) service.store.patchConversation(c.id, { activity: { state: 'working', updated: 1, started: 1 } });
    await expect(service.updateConversation(first.id, { archived: true })).rejects.toThrow('stop the session');
    await service.stopConversation(first.id);
    expect(service.store.getConversation(first.id)?.activity?.state).toBe('stopped');
    expect(service.store.getConversation(second.id)?.activity?.state).toBe('working');
    await service.updateConversation(first.id, { archived: true });
    await expect(service.send(first.id, 'New work')).rejects.toThrow(/Restore this conversation/i);
  });
  it('opens the chosen project folder and reports unavailable review history', async () => {
    const { service, project, first, path, openFolder } = await setup();
    await service.openProjectFolder(project.id);
    expect(openFolder).toHaveBeenCalledWith(path);
    expect((await service.getReview(first.id)).notes.join(' ')).toContain('No readable Git history');
    await service.setSettings({ desktopNotifications: true });
    expect((await service.getSettings()).desktopNotifications).toBe(true);
  });
});
describe('Change snapshots', () => {
  it('includes staged, unstaged and new files while excluding credential filenames', async () => {
    const path = directory();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: path, windowsHide: true, stdio: 'pipe' });
    git('init'); git('config', 'user.name', 'Harbor Test'); git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(path, 'staged.txt'), 'before\n'); writeFileSync(join(path, 'working.txt'), 'before\n');
    git('add', '.'); git('commit', '-m', 'Fixture');
    writeFileSync(join(path, 'staged.txt'), 'staged change\n'); git('add', 'staged.txt');
    writeFileSync(join(path, 'working.txt'), 'working change\n'); writeFileSync(join(path, 'new.txt'), 'new change\n');
    writeFileSync(join(path, '.env.fixture'), 'synthetic fixture excluded from review');
    const files = await reviewDirectory(path, 'Test project');
    expect(files.map(f => f.path).sort()).toEqual(['new.txt', 'staged.txt', 'working.txt']);
    expect(files.find(f => f.path === 'staged.txt')?.patch).toContain('+staged change');
    expect(files.find(f => f.path === 'new.txt')).toMatchObject({ untracked: true, patch: '+new change\n+' });
    expect(reviewable('nested/secrets.json')).toBe(false);
    expect(reviewable('private.key')).toBe(false);
  });
});
