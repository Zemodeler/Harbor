import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../src/main/adapters/fake';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { createHarborService } from '../src/main/service';
import type { AgentRecord } from '../src/main/types';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-queue-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const cli: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' };

/** One concurrency slot; the helper named BLOCK holds it until `release()` so the others stay queued. */
async function harness() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const order: string[] = [];
  const adapter = new FakeAdapter('claude', async (prompt) => {
    const tag = /TASK-\w+/.exec(prompt)?.[0] ?? '?';
    if (tag !== '?') order.push(tag); // lead turns that report back carry no tag
    if (tag === 'TASK-BLOCK') await gate;
    return [{ kind: 'text', text: 'ok' }];
  });
  const svc = createHarborService({ discover: async () => [cli], adapterFor: () => adapter, worktreesRoot: join(tmp(), 'wt'), maxActivePerProject: 1 });
  const project = (await svc.addProject(tmp()))!;
  const [conv] = await svc.listConversations(project.id);
  let n = 0;
  const add = (tag: string, extra: Partial<AgentRecord> = {}): AgentRecord => svc.store.upsertAgent({
    id: `agent-${tag}`, projectId: project.id, role: 'other', readOnly: true, title: tag, state: 'queued', cli: 'auto', model: 'auto', effort: 'low',
    task: `do ${tag}`, dependsOn: [], revision: 1, parentConversationId: conv!.id, attempts: 0, created: 1000 + n++, ...extra
  });
  const state = async (tag: string) => (await svc.listAgents(project.id)).find((a) => a.title === tag)!;
  return { svc, project, order, release, add, state };
}

// The task text reaches the helper's prompt; tags are embedded in it.
const tagged = (tag: string) => ({ task: `TASK-${tag}` });

describe('queue controls', () => {
  it('starts queued work by priority, oldest first within a priority', async () => {
    const h = await harness();
    h.add('BLOCK', tagged('BLOCK')); h.svc.orchestrator.pump(h.project.id);
    h.add('A', tagged('A')); h.add('B', tagged('B')); h.add('C', tagged('C'));
    await h.svc.setAgentPriority('agent-C', 5);
    await h.svc.setAgentPriority('agent-B', 5);
    expect((await h.state('C')).priority).toBe(5);
    h.release();
    await h.svc.whenIdle();
    expect(h.order).toEqual(['TASK-BLOCK', 'TASK-B', 'TASK-C', 'TASK-A']);
  });

  it('pauseAgent keeps queued work from starting until resumeAgent, and does not kill running work', async () => {
    const h = await harness();
    h.add('BLOCK', tagged('BLOCK')); h.svc.orchestrator.pump(h.project.id);
    h.add('A', tagged('A')); h.add('B', tagged('B'));
    await h.svc.pauseAgent('agent-A');
    await h.svc.pauseAgent('agent-BLOCK'); // running: flag only, no interruption
    expect(await h.state('A')).toMatchObject({ state: 'queued', paused: true });
    expect((await h.state('BLOCK')).state).toBe('working');
    h.release();
    await new Promise((r) => setTimeout(r, 100));
    expect(h.order).toEqual(['TASK-BLOCK', 'TASK-B']);
    expect((await h.state('BLOCK')).state).toBe('done');
    expect(await h.state('A')).toMatchObject({ state: 'queued', paused: true });
    await h.svc.resumeAgent('agent-A');
    await h.svc.whenIdle();
    expect(h.order).toEqual(['TASK-BLOCK', 'TASK-B', 'TASK-A']);
    expect((await h.state('A')).paused).toBeUndefined();
  });

  it('cancels a queued assignment through stopAgent without running it', async () => {
    const h = await harness();
    h.add('BLOCK', tagged('BLOCK')); h.svc.orchestrator.pump(h.project.id);
    h.add('A', tagged('A'));
    await h.svc.stopAgent('agent-A');
    expect((await h.state('A')).state).toBe('stopped');
    h.release();
    await h.svc.whenIdle();
    expect(h.order).toEqual(['TASK-BLOCK']);
  });

  it('rejects unknown agents and the lead agent', async () => {
    const h = await harness();
    await expect(h.svc.pauseAgent('nope')).rejects.toThrow(/Unknown agent/);
    const main = h.svc.store.mainAgent(h.project.id)!;
    await expect(h.svc.setAgentPriority(main.id, 1)).rejects.toThrow(/lead agent/);
    await expect(h.svc.setAgentPriority('agent-x', Number.NaN)).rejects.toThrow(/number/);
  });
});
