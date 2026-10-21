import { describe, expect, it } from 'vitest';
import type { Message } from '../src/shared/api';
import { DEFAULT_CATALOG, type CatalogEntry } from '../src/main/clis/capabilities';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { validateInvoke } from '../src/main/ipcValidate';
import { detailsOf } from '../src/main/orchestrator';
import { route } from '../src/main/router';
import { recordedDecisions, replayDecisions, type ReplayScenario } from '../src/main/routingReplay';
import { createHarborService } from '../src/main/service';
import { Store } from '../src/main/store';
import type { AgentRecord } from '../src/main/types';
import { UsageLedger } from '../src/main/usage';

const T = 1_800_000_000_000;
const cli = (id: string): ResolvedCli => ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'] }) as ResolvedCli;
const agent = (id: string, extra: Partial<AgentRecord> = {}): AgentRecord => ({
  id, projectId: 'p', role: 'implementer', title: id, state: 'done', cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', task: 't', dependsOn: [],
  revision: 0, attempts: 0, created: T, parentConversationId: 'c1', needs: ['code'], difficulty: 5, size: 'medium', ...extra
});
const scenario = (catalog: readonly CatalogEntry[], allowed?: Record<string, string[]>): ReplayScenario => ({ catalog, policyFor: () => (allowed ? { allowedModels: allowed } : {}) });

/** A real decision as the orchestrator records it, with its request. */
function recordedMessage(id: string, req: Parameters<typeof route>[0]): Message {
  const ledger = new UsageLedger(new Store(undefined, { now: () => T }), { now: () => T });
  const d = route(req, { clis: [cli('claude'), cli('codex')], ledger, enabled: () => true, hasAdapter: () => true, load: () => 0, now: () => T, poolStates: {} })!;
  return { id, conversationId: 'c1', role: 'assistant', text: 'x', time: T, agentId: 'impl', details: detailsOf(d) };
}

describe('recorded requests', () => {
  it('a decision carries the stateless request, and the message details keep it', () => {
    const m = recordedMessage('m1', { role: 'implementer', complexity: 'medium', difficulty: 5, size: 'large', needs: ['code', 'code'], fanOut: true, retry: true });
    expect(m.details!.request).toEqual({ role: 'implementer', difficulty: 5, size: 'large', needs: ['code'], retry: true });
    const concierge = recordedMessage('m2', { role: 'main', complexity: 'low', tier: 'cheap', effort: 'low', fixedEffort: true, needs: ['chat'], interactive: true, size: 'small' });
    expect(concierge.details!.request).toEqual({ role: 'main', difficulty: 2, size: 'small', needs: ['chat'], tier: 'cheap', effort: 'low', fixedEffort: true, interactive: true });
  });
});

describe('routing replay (pure)', () => {
  const agents = new Map([['impl', agent('impl')], ['lead', agent('lead', { role: 'main' })]]);
  const m1 = recordedMessage('m1', { role: 'implementer', complexity: 'medium', difficulty: 5, needs: ['code'] });

  it('replays under the same catalog without a change, and the baseline matches what was recorded', () => {
    const ds = recordedDecisions([m1, { ...m1, id: 'dup', time: T + 1 }], (id) => agents.get(id));
    expect(ds).toHaveLength(1);
    const r = replayDecisions(ds, { base: scenario(DEFAULT_CATALOG), alt: scenario(DEFAULT_CATALOG), now: T });
    expect(r.summary).toMatchObject({ decisions: 1, changed: 0, unroutable: 0, baselineMatchesRecorded: 1, priceDelta: 0 });
    expect(r.decisions[0]).toMatchObject({ approximate: false, changed: false, recorded: { cli: m1.details!.cli, model: m1.details!.model } });
    expect(r.assumption).toMatch(/neutral/);
  });

  it('reports the choices a catalog or settings change moves, and the price delta', () => {
    const chosen = m1.details!;
    const without = DEFAULT_CATALOG.filter((e) => !(e.cli === chosen.cli && e.model === chosen.model));
    const ds = recordedDecisions([m1], (id) => agents.get(id));
    const r = replayDecisions(ds, { base: scenario(DEFAULT_CATALOG), alt: scenario(without), now: T });
    expect(r.summary.changed).toBe(1);
    const d = r.decisions[0]!;
    expect(d.alternative).toBeDefined();
    expect(`${d.alternative!.cli}/${d.alternative!.model}`).not.toBe(`${chosen.cli}/${chosen.model}`);
    // The baseline was the cheapest option that clears the floor: removing it cannot make the work cheaper.
    expect(d.priceDelta!).toBeGreaterThanOrEqual(0);
    expect(r.summary.priceDelta).toBe(d.priceDelta);
    expect(r.summary.moves).toEqual([{ from: `${chosen.cli}/${chosen.model}`, to: `${d.alternative!.cli}/${d.alternative!.model}`, count: 1 }]);

    // Settings that allow only Opus on claude and keep codex out entirely.
    const pinned = replayDecisions(ds, { base: scenario(DEFAULT_CATALOG), alt: { ...scenario(DEFAULT_CATALOG, { claude: ['claude-opus-5-5'] }), enabled: (c) => c === 'claude' }, now: T });
    expect(pinned.decisions[0]!.alternative).toMatchObject({ cli: 'claude', model: 'claude-opus-5-5' });
    // A catalog with nothing for the work leaves it unroutable.
    const none = replayDecisions(ds, { base: scenario(DEFAULT_CATALOG), alt: { ...scenario(DEFAULT_CATALOG), enabled: () => false }, now: T });
    expect(none.summary).toMatchObject({ changed: 1, unroutable: 1 });
    expect(none.decisions[0]!.alternative).toBeUndefined();
  });

  it('rebuilds a request from the agent record for decisions recorded before requests were', () => {
    const old: Message = { id: 'old', conversationId: 'c1', role: 'assistant', text: 'x', time: T, agentId: 'impl', details: { cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', reason: 'old', difficulty: 6 } };
    const [d] = recordedDecisions([old], (id) => agents.get(id));
    expect(d).toMatchObject({ approximate: true, role: 'implementer', request: { role: 'implementer', difficulty: 6, complexity: 'medium', size: 'medium', needs: ['code'] } });
    const r = replayDecisions([d!], { base: scenario(DEFAULT_CATALOG), alt: scenario(DEFAULT_CATALOG), now: T });
    expect(r.notes.join('\n')).toMatch(/1 decision\(s\) predate recorded requests/);
  });
});

describe('replayRouting (service)', () => {
  it('replays a conversation with a what-if catalog and settings, and rejects a catalog with nothing usable', async () => {
    const svc = createHarborService({ discover: async () => [] });
    svc.store.upsertProject({ id: 'p', name: 'p', path: 'C:/nowhere', lastOpened: T });
    svc.store.upsertAgent(agent('lead', { role: 'main' }));
    svc.store.upsertAgent(agent('impl'));
    svc.store.addConversation({ id: 'c1', projectId: 'p', title: 'c', updated: T, agentId: 'lead' });
    svc.store.addMessage(recordedMessage('m1', { role: 'implementer', complexity: 'medium', difficulty: 5, needs: ['code'] }));

    const same = await svc.replayRouting({ conversationId: 'c1' });
    expect(same.summary).toMatchObject({ decisions: 1, changed: 0 });
    const opus = await svc.replayRouting({ projectId: 'p', settings: { allowedModels: { claude: ['claude-opus-5-5'] }, cliOverrides: { codex: { enabled: false }, gemini: { enabled: false } } } });
    expect(opus.decisions[0]!.alternative).toMatchObject({ cli: 'claude', model: 'claude-opus-5-5' });
    // The live settings are untouched.
    expect((await svc.getSettings()).allowedModels).toBeUndefined();
    const onlyHaiku = await svc.replayRouting({ catalog: [{ cli: 'claude', model: 'claude-haiku-5-5', tier: 'cheap', strengths: ['code'] }, { bad: true }] });
    expect(onlyHaiku.decisions[0]!.alternative).toMatchObject({ model: 'claude-haiku-5-5' });
    expect(onlyHaiku.notes.join('\n')).toMatch(/what-if catalog entry 2 dropped/);
    await expect(svc.replayRouting({ catalog: [{ bad: true }] })).rejects.toThrow(/no usable entry/);
    await expect(svc.replayRouting({ settings: { effortPolicy: 'wild' as never } })).rejects.toThrow(/effortPolicy/);
    await expect(svc.replayRouting({ conversationId: 'nope' })).rejects.toThrow(/no longer available/);
    await svc.shutdown();
  });
});

describe('IPC shape checks for the measurement methods', () => {
  it.each([
    ['getTaskReport', [42]], ['rateResult', ['a1', 'meh']], ['rateResult', ['a1', 'up', 'x'.repeat(1001)]], ['rateResult', ['', 'up']],
    ['listRatings', ['p']], ['getRatingSummary', [{ by: 'role' }]], ['replayRouting', [{ catalog: {} }]], ['replayRouting', [{ limit: 'all' }]],
    ['replayRouting', [{ settings: [] }]], ['replayRouting', [{ conversationId: '' }]]
  ])('rejects %s %j', (m, args) => { expect(() => validateInvoke(m, args)).toThrow(/Invalid request/); });
  it.each([
    ['getTaskReport', ['c1']], ['rateResult', ['a1', 'redo-stronger', 'note']], ['rateResult', ['a1', 'up']], ['listRatings', []], ['getRatingSummary', [{ by: 'need', projectId: 'p' }]],
    ['replayRouting', [{ catalog: [], settings: {}, limit: 5 }]], ['replayRouting', []]
  ])('accepts %s %j', (m, args) => { expect(() => validateInvoke(m, args)).not.toThrow(); });
});
