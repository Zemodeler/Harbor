import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResultRating } from '../src/shared/api';
import { aggregateRatings, withRating } from '../src/main/ratings';
import { createHarborService } from '../src/main/service';
import { Store } from '../src/main/store';
import type { AgentRecord } from '../src/main/types';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const agent = (id: string, extra: Partial<AgentRecord> = {}): AgentRecord => ({
  id, projectId: 'p', role: 'implementer', title: id, state: 'done', cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', task: 't', dependsOn: [],
  revision: 0, attempts: 0, created: 1, parentConversationId: 'c1', needs: ['code'], difficulty: 5, ...extra
});
const rating = (targetId: string, r: ResultRating['rating'], extra: Partial<ResultRating> = {}): ResultRating => ({
  id: `r-${targetId}-${r}`, time: 1, rating: r, target: 'agent', targetId, projectId: 'p', cli: 'claude', model: 'claude-sonnet-5-5', ...extra
});

describe('ratings (pure)', () => {
  it('keeps one rating per target, the newest, and caps the list', () => {
    let list = withRating([], rating('a', 'up', { time: 1 }));
    list = withRating(list, rating('b', 'down', { time: 2 }));
    list = withRating(list, rating('a', 'redo-stronger', { time: 3 }));
    expect(list.map((r) => `${r.targetId}:${r.rating}`)).toEqual(['b:down', 'a:redo-stronger']);
    expect(withRating(list, rating('c', 'up', { time: 4 }), 2).map((r) => r.targetId)).toEqual(['a', 'c']);
  });

  it('aggregates by CLI, by model and by need', () => {
    const rs = [
      rating('1', 'up', { needs: ['code', 'review'] }), rating('2', 'down', { needs: ['code'] }), rating('3', 'redo-stronger'),
      rating('4', 'up', { cli: 'codex', model: 'gpt-6-sol', needs: ['code', 'code'] })
    ];
    expect(aggregateRatings(rs, 'model')).toEqual([
      { cli: 'claude', model: 'claude-sonnet-5-5', up: 1, down: 1, redoStronger: 1, total: 3, approval: 0.333 },
      { cli: 'codex', model: 'gpt-6-sol', up: 1, down: 0, redoStronger: 0, total: 1, approval: 1 }
    ]);
    expect(aggregateRatings(rs, 'cli').map((r) => [r.cli, r.total])).toEqual([['claude', 3], ['codex', 1]]);
    expect(aggregateRatings(rs, 'need').map((r) => [r.need, r.up, r.down, r.redoStronger])).toEqual([['code', 2, 1, 0], ['review', 1, 0, 0], ['unspecified', 0, 0, 1]]);
  });
});

describe('rateResult (service)', () => {
  const setup = (dataDir?: string) => {
    const svc = createHarborService({ discover: async () => [], ...(dataDir ? { dataDir } : {}) });
    svc.store.upsertProject({ id: 'p', name: 'p', path: 'C:/nowhere', lastOpened: 1 });
    svc.store.upsertAgent(agent('lead', { role: 'main' }));
    svc.store.upsertAgent(agent('impl'));
    svc.store.upsertAgent(agent('integ', { role: 'other', cli: 'harbor', model: 'git', integration: { sources: [] } }));
    svc.store.addConversation({ id: 'c1', projectId: 'p', title: 'c', updated: 1, agentId: 'lead' });
    svc.store.addMessage({ id: 'm1', conversationId: 'c1', role: 'assistant', text: 'answer', time: 2, agentId: 'lead', details: { cli: 'codex', model: 'gpt-6-sol', effort: 'low', reason: 'r', difficulty: 3, request: { role: 'main', needs: ['chat'] } } });
    svc.store.addMessage({ id: 'm2', conversationId: 'c1', role: 'user', text: 'hi', time: 1 });
    return svc;
  };

  it('stores a rating of an agent or a routed message as evidence, replaces a re-rating and summarizes it', async () => {
    const svc = setup();
    const a = await svc.rateResult('impl', 'down', '  missed the edge case  ');
    expect(a).toMatchObject({ target: 'agent', targetId: 'impl', rating: 'down', note: 'missed the edge case', projectId: 'p', conversationId: 'c1', role: 'implementer', cli: 'claude', model: 'claude-sonnet-5-5', needs: ['code'], difficulty: 5 });
    const m = await svc.rateResult('m1', 'up');
    expect(m).toMatchObject({ target: 'message', targetId: 'm1', cli: 'codex', model: 'gpt-6-sol', conversationId: 'c1', role: 'main', needs: ['chat'], difficulty: 3 });
    expect(m.note).toBeUndefined();
    await svc.rateResult('impl', 'redo-stronger');
    expect((await svc.listRatings()).map((r) => `${r.targetId}:${r.rating}`)).toEqual(['impl:redo-stronger', 'm1:up']);
    expect(await svc.getRatingSummary({ by: 'cli' })).toEqual([
      { cli: 'claude', up: 0, down: 0, redoStronger: 1, total: 1, approval: 0 },
      { cli: 'codex', up: 1, down: 0, redoStronger: 0, total: 1, approval: 1 }
    ]);
    expect((await svc.getRatingSummary({ projectId: 'p' })).length).toBe(2);
    await svc.shutdown();
  });

  it('refuses what cannot be rated', async () => {
    const svc = setup();
    await expect(svc.rateResult('integ', 'up')).rejects.toThrow(/Harbor ran this task itself/);
    await expect(svc.rateResult('m2', 'up')).rejects.toThrow(/routed run/);
    await expect(svc.rateResult('nope', 'up')).rejects.toThrow(/no agent or message/);
    await expect(svc.rateResult('impl', 'great' as never)).rejects.toThrow(/up, down or redo-stronger/);
    await expect(svc.getRatingSummary({ by: 'x' as never })).rejects.toThrow(/cli, model or need/);
    await expect(svc.listRatings({ projectId: 'nope' })).rejects.toThrow(/Unknown project/);
    await svc.shutdown();
  });

  it('keeps ratings across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor-ratings-')); dirs.push(dir);
    const svc = setup(dir);
    await svc.rateResult('impl', 'up');
    await svc.shutdown();
    expect(new Store(dir).listRatings('p').map((r) => r.targetId)).toEqual(['impl']);
  });
});
