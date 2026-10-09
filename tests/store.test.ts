import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store, newId } from '../src/main/store';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-store-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('Store', () => {
  it('persists and reloads projects, conversations, messages', () => {
    const dir = tmp();
    const s = new Store(dir);
    const p = s.upsertProject({ id: 'p1', name: 'Proj', path: 'C:/x/proj', lastOpened: 1 });
    const c = s.addConversation({ id: 'c1', projectId: p.id, title: 'T', updated: 1, agentId: 'a1' });
    s.addMessage({ id: newId(), conversationId: c.id, role: 'user', text: 'hi', time: 5 });
    s.flush();
    const s2 = new Store(dir);
    expect(s2.listProjects()).toHaveLength(1);
    expect(s2.listMessages('c1').map((m) => m.text)).toEqual(['hi']);
  });

  it('removeProject drops Harbor records only', () => {
    const s = new Store();
    s.upsertProject({ id: 'p1', name: 'P', path: '/p', lastOpened: 1 });
    s.addConversation({ id: 'c1', projectId: 'p1', title: 'T', updated: 1, agentId: 'a' });
    s.addMessage({ id: 'm', conversationId: 'c1', role: 'user', text: 'x', time: 1 });
    s.removeProject('p1');
    expect(s.listProjects()).toEqual([]);
    expect(s.listMessages('c1')).toEqual([]);
  });

  it('finds projects by path regardless of slash style and case', () => {
    const s = new Store();
    s.upsertProject({ id: 'p1', name: 'P', path: 'C:\\Users\\A\\Repo\\', lastOpened: 1 });
    expect(s.findProjectByPath('c:/users/a/repo')?.id).toBe('p1');
  });

  it('quarantines a corrupt file instead of overwriting it', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'state.json'), '{not json');
    const s = new Store(dir);
    expect(s.listProjects()).toEqual([]);
    expect(readdirSync(dir).some((f) => f.includes('corrupt'))).toBe(true);
  });

  it('merges settings patches', () => {
    const s = new Store();
    s.setSettings({ cliOverrides: { claude: { enabled: false } } });
    s.setSettings({ cliOverrides: { codex: { enabled: true } } });
    expect(s.getSettings().cliOverrides).toEqual({ claude: { enabled: false }, codex: { enabled: true } });
  });

  it('defaults background running to off and persists the optional preference', () => {
    const dir = tmp();
    const s = new Store(dir);
    expect(s.getSettings().keepRunningInBackground ?? false).toBe(false);
    s.setSettings({ keepRunningInBackground: true });
    s.flush();
    const reloaded = new Store(dir);
    expect(reloaded.getSettings().keepRunningInBackground).toBe(true);
    reloaded.setSettings({ keepRunningInBackground: false });
    expect(reloaded.getSettings().keepRunningInBackground).toBe(false);
    reloaded.setSettings({ keepRunningInBackground: undefined });
    reloaded.flush();
    expect(new Store(dir).getSettings().keepRunningInBackground).toBeUndefined();
  });

  it.each(['true', 1, null, {}, []])('rejects malformed background preferences without applying any of the patch: %j', value => {
    const s = new Store();
    s.setSettings({ keepRunningInBackground: true, concurrencyLimit: 2 });
    expect(() => s.setSettings({ keepRunningInBackground: value as unknown as boolean, concurrencyLimit: 3 })).toThrow(/keepRunningInBackground must be a boolean/);
    expect(s.getSettings().keepRunningInBackground).toBe(true);
    expect(s.getSettings().concurrencyLimit).toBe(2);
  });
});
