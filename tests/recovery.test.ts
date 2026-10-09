import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../src/main/adapters/fake';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { matchesTracked, type ProcessKiller, type TrackedProcess } from '../src/main/proc';
import { createHarborService } from '../src/main/service';
import { Store } from '../src/main/store';
import type { AgentRecord } from '../src/main/types';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-rec-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const fakeCli = (id: string): ResolvedCli =>
  ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: `/fake/${id}` });

/** Never touches a real process: `live` is what "the OS" reports, `killed` what was asked to die. */
function fakeKiller(live: Record<number, { name: string; started: number }>) {
  const killed: number[] = [];
  const killer: ProcessKiller = { inspect: async (pid) => live[pid], kill: async (pid) => { killed.push(pid); } };
  return { killer, killed };
}

async function setup(killer: ProcessKiller) {
  const adapter = new FakeAdapter('claude', () => [{ kind: 'text', text: 'resumed work' }]);
  const svc = createHarborService({ discover: async () => [fakeCli('claude')], adapterFor: () => adapter, worktreesRoot: join(tmp(), 'wt'), killer });
  const project = (await svc.addProject(tmp()))!;
  const [conv] = await svc.listConversations(project.id);
  return { svc, adapter, project, conv: conv! };
}

const ghost = (projectId: string, conversationId: string, state: AgentRecord['state']): AgentRecord => ({
  id: 'ghost', projectId, role: 'other', title: 'Ghost', state, cli: 'claude', model: 'default', effort: 'low', task: 'do it', readOnly: true,
  dependsOn: [], revision: 1, parentConversationId: conversationId, attempts: 0, created: 1
});

describe('orphan sweep', () => {
  it('matchesTracked needs the same name and a start time near the recorded one', () => {
    const t: TrackedProcess = { pid: 5, name: 'claude', started: 100_000 };
    expect(matchesTracked(t, { name: 'claude', started: 101_000 })).toBe(true);
    expect(matchesTracked(t, { name: 'claude', started: 500_000 })).toBe(false); // PID reused later
    expect(matchesTracked(t, { name: 'chrome', started: 100_000 })).toBe(false);
    expect(matchesTracked(t, undefined)).toBe(false);
  });

  it('kills only recorded PIDs that still match, and forgets all of them', async () => {
    const { killer, killed } = fakeKiller({ 11: { name: 'claude', started: 1_000 }, 12: { name: 'notepad', started: 1_000 }, 99: { name: 'claude', started: 1_000 } });
    const h = await setup(killer);
    await h.svc.orchestrator.whenSwept();
    h.svc.store.trackProcess({ pid: 11, name: 'claude', started: 1_000 }); // matches
    h.svc.store.trackProcess({ pid: 12, name: 'claude', started: 1_000 }); // PID now belongs to another program
    h.svc.store.trackProcess({ pid: 13, name: 'claude', started: 1_000 }); // already gone
    h.svc.orchestrator.recover();
    const r = await h.svc.orchestrator.whenSwept();
    expect(killed).toEqual([11]); // 99 was never recorded by Harbor
    expect(r.killed).toEqual([11]);
    expect(r.skipped.sort()).toEqual([12, 13]);
    expect(h.svc.store.listTrackedProcesses()).toEqual([]);
    h.svc.shutdown();
  });

  it('leaves processes recorded by the current run alone', async () => {
    const { killer, killed } = fakeKiller({ 21: { name: 'claude', started: Date.now() + 1000 } });
    const h = await setup(killer);
    h.svc.store.trackProcess({ pid: 21, name: 'claude', started: Date.now() + 1000 });
    h.svc.orchestrator.recover();
    await h.svc.orchestrator.whenSwept();
    expect(killed).toEqual([]);
    expect(h.svc.store.listTrackedProcesses().map((p) => p.pid)).toEqual([21]);
    h.svc.shutdown();
  });

  it('persists tracked processes across a store reload', () => {
    const dir = tmp();
    const a = new Store(dir);
    a.trackProcess({ pid: 7, name: 'codex', started: 5 });
    a.trackProcess({ pid: 8, name: 'cmd', started: 6 });
    a.untrackProcess(8);
    a.flush();
    expect(new Store(dir).listTrackedProcesses()).toEqual([{ pid: 7, name: 'codex', started: 5 }]);
  });
});

describe('resumeAgentSession', () => {
  it('resumes a stopped helper in its saved session with a no-replay prompt', async () => {
    const h = await setup(fakeKiller({}).killer);
    h.svc.store.upsertAgent(ghost(h.project.id, h.conv.id, 'stopped'));
    h.svc.store.setSession({ agentId: 'ghost', cli: 'claude', sessionId: 'sess-1', updated: 1 });
    await h.svc.resumeAgentSession('ghost');
    await h.svc.whenIdle();
    // The helper's call, then the lead being told about its report.
    const helperCalls = h.adapter.calls.filter((c) => c.opts.resumeId === 'sess-1');
    expect(helperCalls).toHaveLength(1);
    expect(helperCalls[0]!.prompt).toMatch(/Do not repeat steps that already completed/);
    expect(h.svc.store.getAgent('ghost')!.state).toBe('done');
    h.svc.shutdown();
  });

  it('rejects agents that are not stopped, have no session, or are the lead', async () => {
    const h = await setup(fakeKiller({}).killer);
    await expect(h.svc.resumeAgentSession('missing')).rejects.toThrow(/no longer available/);
    h.svc.store.upsertAgent(ghost(h.project.id, h.conv.id, 'done'));
    await expect(h.svc.resumeAgentSession('ghost')).rejects.toThrow(/stopped/);
    h.svc.store.upsertAgent(ghost(h.project.id, h.conv.id, 'stopped'));
    await expect(h.svc.resumeAgentSession('ghost')).rejects.toThrow(/no saved session/);
    await expect(h.svc.resumeAgentSession(h.svc.store.mainAgent(h.project.id)!.id)).rejects.toThrow(/lead/);
    expect(h.adapter.calls).toHaveLength(0);
    h.svc.shutdown();
  });
});
