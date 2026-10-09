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
