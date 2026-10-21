import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Git } from '../src/main/git';
import { INVOKE_METHODS } from '../src/shared/ipc';
import { METHOD_SCOPE, scopeAllows } from '../src/main/remote/scopes';
import { validateInvoke } from '../src/main/ipcValidate';
import { setup, sh } from './projects2Harness';

// B2: archive, pin, overview, cross-project search and the global usage view (contract 0.1.49-0.1.52).
describe('B2 contract wiring', () => {
  it('lists the methods for IPC with the right remote scopes and validates the shapes', () => {
    for (const m of ['getProjectsOverview', 'searchAll', 'getGlobalUsage'] as const) { expect(INVOKE_METHODS).toContain(m); expect(METHOD_SCOPE[m]).toBe('read-only'); expect(scopeAllows('read-only', m)).toBe(true); }
    expect(INVOKE_METHODS).toContain('setProjectFlags');
    expect(METHOD_SCOPE['setProjectFlags']).toBe('full');
    expect(scopeAllows('read-only', 'setProjectFlags')).toBe(false);
    expect(() => validateInvoke('setProjectFlags', ['p', { archived: true, pinned: false }])).not.toThrow();
    for (const bad of [[], ['p'], ['p', null], ['p', { archived: 'yes' }], ['', { pinned: true }]]) expect(() => validateInvoke('setProjectFlags', bad), JSON.stringify(bad)).toThrow();
    expect(() => validateInvoke('searchAll', ['needle', { offset: 0, limit: 10 }])).not.toThrow();
    for (const bad of [[], [5], ['x', 'y'], ['x', { limit: 'a' }], ['x'.repeat(501)]]) expect(() => validateInvoke('searchAll', bad), JSON.stringify(bad)).toThrow();
  });
});

describe('B2 archive and pin', () => {
  it('pins first, archives and unarchives without deleting anything, and refuses to archive while agents run', async () => {
    const { service } = setup();
    const a = await service.createProject({ name: 'Alpha' }), b = await service.createProject({ name: 'Beta' });
    const order = (await service.listProjects()).map((p) => p.name); // the store's own order: most recently opened first
    const last = order[order.length - 1]!, lastId = last === 'Alpha' ? a.project.id : b.project.id;
    await service.setProjectFlags(lastId, { pinned: true });
    expect((await service.listProjects())[0]!.name).toBe(last);
    const archived = await service.setProjectFlags(a.project.id, { archived: true });
    expect(archived.archived).toBe(true);
    expect(existsSync(a.path)).toBe(true);
    expect((await service.listProjects()).find((p) => p.id === a.project.id)?.archived).toBe(true);
    const back = await service.setProjectFlags(a.project.id, { archived: false });
    expect('archived' in back).toBe(false);
    await service.setProjectFlags(lastId, { pinned: false });
    expect((await service.listProjects()).map((p) => p.name)).toEqual(order);

    service.store.upsertAgent({ id: 'helper1', projectId: b.project.id, role: 'implementer', title: 'Busy', state: 'working', cli: 'claude', model: 'm', effort: 'low', task: 'x' } as never);
    await expect(service.setProjectFlags(b.project.id, { archived: true })).rejects.toThrow(/still running/);
    await expect(service.setProjectFlags('nope', { pinned: true })).rejects.toThrow();
    await expect(service.setProjectFlags(a.project.id, { pinned: 'x' } as never)).rejects.toThrow();
  });
});

describe('B2 overview', () => {
  it('counts running agents, unmerged branches, unpushed commits and recent usage per project', async () => {
    const { service, worktreesRoot } = setup();
    const a = await service.createProject({ name: 'Alpha' }), b = await service.createProject({ name: 'Beta' });
    const git = new Git();
    const wt = await git.createWorktree(a.path, worktreesRoot, a.project.id.slice(0, 8), 'task', 'abc123');
    writeFileSync(join(wt.path, 'x.txt'), 'x'); sh(wt.path, 'add', '.'); sh(wt.path, '-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'commit', '-m', 'work');
    service.store.upsertAgent({ id: 'h1', projectId: a.project.id, role: 'implementer', title: 'Busy', state: 'working', cli: 'claude', model: 'm', effort: 'low', task: 'x' } as never);
    service.store.addUsage({ id: 'u1', time: Date.now() - 60_000, cli: 'claude', model: 'm', projectId: a.project.id, agentId: 'h1', durationMs: 60_000, ok: true, inputTokens: 2000, outputTokens: 1000, costUsd: 0.5 });
    const o = await service.getProjectsOverview();
    const oa = o.projects.find((p) => p.projectId === a.project.id)!, ob = o.projects.find((p) => p.projectId === b.project.id)!;
    expect(oa).toMatchObject({ running: 1, unmergedBranches: 1, recentRuns: 1, recentKTok: 3, recentCostUsd: 0.5, conversations: 1 });
    expect(oa.unpushedCommits).toBeGreaterThan(0);
    expect(ob).toMatchObject({ running: 0, unmergedBranches: 0, recentRuns: 0 });
    expect(ob.missing).toBeUndefined();
    expect(Array.isArray(o.quota)).toBe(true);
    rmSync(b.path, { recursive: true, force: true });
    expect((await service.getProjectsOverview()).projects.find((p) => p.projectId === b.project.id)!.missing).toBe(true);
  });
});

describe('B2 cross-project search', () => {
  async function chats() {
    const s = setup();
    const a = await s.service.createProject({ name: 'Alpha' }), b = await s.service.createProject({ name: 'Beta' });
    const mk = async (p: typeof a, title: string, texts: string[], t0: number) => {
      const conv = await s.service.newConversation(p.project.id);
      texts.forEach((text, i) => s.service.store.addMessage({ id: `${conv.id}-${i}`, conversationId: conv.id, role: i % 2 ? 'assistant' : 'user', text, time: t0 + i } as never));
      s.service.store.patchConversation(conv.id, { title, updated: t0 });
      return conv;
    };
    return { ...s, a, b, mk };
  }
  it('searches titles and messages across projects, paginated, newest first', async () => {
    const { service, a, b, mk } = await chats();
    await mk(a, 'Pricing page', ['please fix the Needle in the footer', 'Needle fixed'], 1_000);
    await mk(b, 'Needle hunt', ['nothing here', 'no luck'], 5_000);
    await mk(b, 'Other', ['a needle, a needle, a NEEDLE, one more needle'], 9_000);
    const all = await service.searchAll('needle');
    expect(all.total).toBe(4); // two messages in Alpha, the "Needle hunt" title in Beta, one message in Beta's "Other"
    expect(all.hits.map((h) => h.time)).toEqual([...all.hits.map((h) => h.time)].sort((x, y) => y - x));
    expect(all.hits.filter((h) => h.kind === 'title').map((h) => h.conversation.title)).toEqual(['Needle hunt']);
    expect(all.hits.every((h) => h.kind === 'title' || (h.excerpt ?? '').toLowerCase().includes('needle'))).toBe(true);
    const page1 = await service.searchAll('needle', { limit: 2 });
    expect(page1.hits).toHaveLength(2); expect(page1.hasMore).toBe(true);
    const page2 = await service.searchAll('needle', { limit: 2, offset: 2 });
    expect(page2.hits).toHaveLength(2); expect(page2.hasMore).toBe(false);
    const key = (h: { messageId?: string; conversation: { id: string } }) => h.messageId ?? h.conversation.id;
    expect(new Set([...page1.hits, ...page2.hits].map(key)).size).toBe(4);
    expect((await service.searchAll('needle', { projectId: a.project.id })).hits.every((h) => h.projectId === a.project.id)).toBe(true);
    expect((await service.searchAll('   ')).hits).toEqual([]);
    await service.setProjectFlags(a.project.id, { archived: true });
    expect((await service.searchAll('pricing')).hits[0]).toMatchObject({ projectName: 'Alpha', projectArchived: true });
  });
  it('stops at 500 hits and says so; one conversation gives at most three message hits', async () => {
    const { service, a } = await chats();
    for (let i = 0; i < 200; i++) {
      const conv = await service.newConversation(a.project.id);
      for (let k = 0; k < 5; k++) service.store.addMessage({ id: `${conv.id}-${k}`, conversationId: conv.id, role: 'user', text: `needle ${k}`, time: i * 10 + k } as never);
    }
    const r = await service.searchAll('needle', { limit: 100 });
    expect(r.total).toBe(500); expect(r.capped).toBe(true); expect(r.hits).toHaveLength(100);
    const per = new Map<string, number>();
    for (let off = 0; off < 500; off += 100) for (const h of (await service.searchAll('needle', { limit: 100, offset: off })).hits) per.set(h.conversation.id, (per.get(h.conversation.id) ?? 0) + 1);
    expect(Math.max(...per.values())).toBeLessThanOrEqual(3);
  });
});

describe('B2 global usage', () => {
  it("groups Harbor's own runs per CLI and per project, always as an estimate", async () => {
    const { service } = setup();
    const a = await service.createProject({ name: 'Alpha' });
    const ev = (id: string, cli: string, projectId: string, o: Record<string, unknown> = {}) => ({ id, time: Date.now() - 1000, cli, model: 'm', projectId, agentId: 'x', durationMs: 120_000, ok: true, inputTokens: 1000, outputTokens: 500, ...o });
    service.store.addUsage(ev('u1', 'claude', a.project.id, { costUsd: 0.25 }) as never);
    service.store.addUsage(ev('u2', 'codex', a.project.id, { ok: false }) as never);
    service.store.addUsage(ev('u3', 'claude', 'gone-project', { inputTokens: undefined, outputTokens: undefined }) as never);
    const u = await service.getGlobalUsage();
    expect(u.estimate).toBe(true);
    expect(u.total).toMatchObject({ runs: 3, failedRuns: 1, inputTokens: 2000, outputTokens: 1000, minutes: 6, costUsd: 0.25 });
    expect(u.byCli.map((r) => [r.cli, r.runs])).toEqual(expect.arrayContaining([['claude', 2], ['codex', 1]]));
    expect(u.byProject.find((r) => r.projectId === a.project.id)).toMatchObject({ projectName: 'Alpha', runs: 2 });
    expect(u.byProject.find((r) => r.projectId === 'gone-project')).toMatchObject({ removed: true, runs: 1 });
    expect(u.notes.join(' ')).toMatch(/estimate/);
    expect(u.notes.join(' ')).toMatch(/1 run reported no token counts/);
    expect(u.lifetime.runs).toBe(0);
  });
});
