import { describe, expect, it } from 'vitest';
import { createMockApi } from '../mock/mockApi';
import type { HarborEvent } from '../../shared/api';

describe('Mock execution lifecycle', () => {
  it('stops a worker without emitting completion or permission afterward', async () => {
    const api = createMockApi({ delay: 1 }); const events: HarborEvent[] = [];
    api.onEvent(e => { events.push(e); if (e.type === 'agent' && e.agent.state === 'working') void api.stopAgent(e.agent.id); });
    await api.send('account', 'Stop this assignment');
    expect(events.some(e => e.type === 'agent' && e.agent.state === 'stopped')).toBe(true);
    expect(events.some(e => e.type === 'permission')).toBe(false);
    expect(events.some(e => e.type === 'agent' && e.agent.state === 'done')).toBe(false);
  });
  it('applies a reset only after approval and rejects duplicate answers', async () => {
    const api = createMockApi({ delay: 0 }); let requestId = '';
    api.onEvent(e => { if (e.type === 'permission') requestId = e.requestId; });
    await api.send('account', 'Demo'); expect((await api.getUsage())[1].usedPct).toBe(73);
    expect((await api.listPendingPermissions()).map(p => p.requestId)).toEqual([requestId]);
    await api.answerPermission(requestId, true); expect((await api.getUsage())[1].usedPct).toBe(0);
    expect(await api.listPendingPermissions()).toEqual([]);
    await expect(api.answerPermission(requestId, true)).rejects.toThrow('no longer pending');
  });
});

describe('Mock settings validate like Harbor', () => {
  it('clamps numbers, rejects bad values with Harbor\'s messages and keeps nothing half-applied', async () => {
    const api = createMockApi({ delay: 0 });
    expect((await api.setSettings({ concurrencyLimit: 99, subscriptionReserve: -5 }))).toMatchObject({ concurrencyLimit: 8, subscriptionReserve: 0 });
    await expect(api.setSettings({ effortPolicy: 'bogus' as never, concurrencyLimit: 2 })).rejects.toThrow('effortPolicy must be one of: adaptive, conserve, quality.');
    await expect(api.setSettings({ concurrencyLimit: 'x' as never })).rejects.toThrow('concurrencyLimit must be a number.');
    await expect(api.setSettings({ keepRunningInBackground: 'yes' as never })).rejects.toThrow('keepRunningInBackground must be a boolean.');
    await expect(api.setSettings({ allowedModels: { codex: 'x' } as never })).rejects.toThrow('allowedModels.codex must be a list of model names.');
    expect((await api.getSettings()).concurrencyLimit).toBe(8);
  });
  it('drops empty model lists, resets with undefined and clears a project with {}', async () => {
    const api = createMockApi({ delay: 0 });
    expect((await api.setSettings({ allowedModels: { codex: [], claude: [' opus '] }, rolePreferences: { reviewer: { cli: 'claude' } } }))).toMatchObject({ allowedModels: { claude: ['opus'] }, rolePreferences: { reviewer: { cli: 'claude' } } });
    expect((await api.setSettings({ projectOverrides: { store: { effortPolicy: 'conserve' } } })).projectOverrides).toEqual({ store: { effortPolicy: 'conserve' } });
    expect((await api.setSettings({ projectOverrides: { store: {} } })).projectOverrides).toBeUndefined();
    expect('allowedModels' in (await api.setSettings({ allowedModels: undefined }))).toBe(false);
  });
  it('emits usage windows of both sources and offers diagnostics', async () => {
    const api = createMockApi({ delay: 0 });
    expect(new Set((await api.getUsage()).map(w => w.source))).toEqual(new Set(['estimated', 'reported']));
    expect(await api.exportDiagnostics!()).toContain('No message text');
  });
});

describe('Mock roadmap wave 1 methods', () => {
  it('offers spend status, task report, ratings, replay, project notes and remote tokens like Harbor', async () => {
    const api = createMockApi({ delay: 0 });
    expect(await api.getSpendStatus!()).toEqual({ estimate: true, entries: [] });
    await api.setSettings({ spendCeilings: { day: { kTokens: 500 } } });
    expect((await api.getSpendStatus!()).entries.map(e => e.scope)).toEqual(['day']);
    expect((await api.getTaskReport!('account')).notes[0]).toMatch(/Demo/);
    const agent = (await api.listAgents('store'))[0];
    await api.rateResult!(agent.id, 'down');
    await api.rateResult!(agent.id, 'up', 'good');
    expect((await api.listRatings!()).map(r => r.rating)).toEqual(['up']);
    expect((await api.getRatingSummary!())[0]).toMatchObject({ up: 1, total: 1, approval: 1 });
    expect((await api.replayRouting!()).summary.decisions).toBe(0);
    const [note] = await api.listProjectNotes!('store');
    expect(await api.removeProjectNote!('store', note.id)).toEqual([]);
    await expect(api.createRemoteToken!('phone', 'full')).rejects.toThrow(/Full remote access is off/);
    const { info } = await api.createRemoteToken!('phone', 'read-only');
    expect((await api.listRemoteTokens!()).map(t => t.id)).toEqual([info.id]);
    await api.revokeRemoteToken!(info.id);
    expect(await api.listRemoteTokens!()).toEqual([]);
  });
});
