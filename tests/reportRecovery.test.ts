import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import type { ProcessKiller } from '../src/main/proc';
import { createHarborService } from '../src/main/service';
import { Store } from '../src/main/store';
import type { AgentRecord } from '../src/main/types';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-rep-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const say = (text: string): Chunk[] => [{ kind: 'text', text }];
const cli: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' };
/** Never touches a real process. */
const killer: ProcessKiller = { inspect: async () => undefined, kill: async () => { throw new Error('must not kill'); } };
const delegate = (title: string) => `HARBOR_DELEGATE: ${JSON.stringify({ ref: title, title, role: 'other', access: 'read', instructions: `look into ${title}`, complexity: 'low' })}`;

/** Lead prompts that carry helper reports, and the helper titles each one reported. */
const reportTurns = (a: FakeAdapter) => a.calls
  .filter((c) => (c.opts.systemPrompt ?? '').includes('LEAD agent') && c.prompt.includes('Helper reports'))
  .map((c) => [...c.prompt.matchAll(/^### (.+?) \(id=/gm)].map((m) => m[1]));

/**
 * One Harbor "run" over a persisted data folder. The lead delegates a read-only helper named after the user's message
 * ("run Alpha Beta" -> helpers "Alpha" and "Beta"); `holdLead` holds a lead turn that carries reports.
 */
async function harbor(dataDir: string, project: string, opts: { holdLead?: () => Promise<void>; helper?: (title: string) => Chunk[] | Promise<Chunk[]> } = {}) {
  const script: FakeScript = async (prompt, o) => {
    const sys = o.systemPrompt ?? '';
    if (sys.includes('front desk')) return say(JSON.stringify({ escalate: { complexity: 'low', needs: ['code'], ack: '' } }));
    if (sys.includes('LEAD agent')) {
      const run = /User:\nrun ([\w ]+)/.exec(prompt);
      if (run) return say(['on it', ...run[1]!.trim().split(' ').map(delegate)].join('\n'));
      if (opts.holdLead && prompt.includes('Helper reports')) await opts.holdLead();
      return say('noted');
    }
    const title = /look into (\w+)/.exec(prompt)?.[1] ?? '?';
    return opts.helper ? opts.helper(title) : say(`report of ${title}`);
  };
  const adapter = new FakeAdapter('claude', script);
  const svc = createHarborService({ dataDir, discover: async () => [cli], adapterFor: () => adapter, worktreesRoot: join(dataDir, 'wt'), killer });
  const p = (await svc.addProject(project))!;
  const [conv] = await svc.listConversations(p.id);
  return { svc, adapter, project: p, conv: conv! };
}

describe('helper report delivery across restarts', () => {
  it('in one run, an earlier helper is not reported again when another one finishes (baseline)', async () => {
    const h = await harbor(tmp(), tmp());
    await h.svc.send(h.conv.id, 'run Alpha');
    await h.svc.whenIdle();
    await h.svc.send(h.conv.id, 'run Beta');
    await h.svc.whenIdle();
    expect(reportTurns(h.adapter)).toEqual([['Alpha'], ['Beta']]);
    h.svc.shutdown();
  });

  it('after a restart, completing another helper does not replay reports the lead already received', async () => {
    const data = tmp(), repo = tmp();
    const first = await harbor(data, repo);
    await first.svc.send(first.conv.id, 'run Alpha');
    await first.svc.whenIdle();
    expect(reportTurns(first.adapter)).toEqual([['Alpha']]);
    first.svc.shutdown();

    const second = await harbor(data, repo);
    await second.svc.send(second.conv.id, 'run Beta');
    await second.svc.whenIdle();
    expect(reportTurns(second.adapter)).toEqual([['Beta']]);
    second.svc.shutdown();
  });

  it('a revised result of an already-reported helper is still delivered after a restart', async () => {
    const data = tmp(), repo = tmp();
    const first = await harbor(data, repo);
    await first.svc.send(first.conv.id, 'run Alpha');
    await first.svc.whenIdle();
    first.svc.shutdown();

    const second = await harbor(data, repo);
    const alpha = second.svc.store.listAgentRecords(second.project.id).find((a) => a.title === 'Alpha')!;
    // The user messages the helper directly: a new revision, whose result the lead has not seen.
    const chat = await second.svc.openAgentConversation(alpha.id);
    await second.svc.send(chat.id, 'look again');
    await second.svc.whenIdle();
    expect(reportTurns(second.adapter)).toEqual([['Alpha']]);
    second.svc.shutdown();
  });

  it('a report queued behind a lead turn that never ran is delivered with the next batch after a restart', async () => {
    const data = tmp(), repo = tmp();
    let leadHeld!: () => void;
    const leadStarted = new Promise<void>((r) => { leadHeld = r; });
    // Alpha fails at once (a failure resumes the lead immediately); Beta finishes while the lead is still on Alpha's report.
    const first = await harbor(data, repo, {
      holdLead: () => { leadHeld(); return new Promise<void>(() => {}); },
      helper: async (title) => {
        if (title === 'Alpha') return [{ kind: 'done', ok: false, error: 'Alpha broke' }];
        await leadStarted;
        return say('Beta done');
      }
    });
    await first.svc.send(first.conv.id, 'run Alpha Beta');
    await waitFor(() => first.svc.store.listAgentRecords(first.project.id).find((a) => a.title === 'Beta')?.state === 'done');
    expect(reportTurns(first.adapter)).toEqual([['Alpha']]);
    // Harbor "crashes" here: state is on disk, the queued lead turn with Beta's report never ran.
    first.svc.shutdown();

    const second = await harbor(data, repo);
    await second.svc.whenIdle();
    // Recovery alone starts no lead turn.
    expect(reportTurns(second.adapter)).toEqual([]);
    await second.svc.send(second.conv.id, 'run Gamma');
    await second.svc.whenIdle();
    // Alpha was handed to a lead and is not replayed; Beta never reached one and comes with Gamma.
    expect(reportTurns(second.adapter)).toEqual([['Beta', 'Gamma']]);
    second.svc.shutdown();
  });
});

const rec = (id: string, state: AgentRecord['state'], role: AgentRecord['role'] = 'other'): AgentRecord => ({
  id, projectId: 'p', role, title: id, state, cli: 'claude', model: 'default', effort: 'low', task: 't', dependsOn: [], revision: 2,
  parentConversationId: 'c', attempts: 0, created: 1
});

describe('report delivery bookkeeping in the store', () => {
  it('marks finished helpers of a file written before the ledger as delivered, once', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, agents: [rec('done', 'done'), rec('failed', 'failed'), rec('stopped', 'stopped'), rec('queued', 'queued'), rec('main', 'waiting', 'main')] }));
    const store = new Store(dir);
    const mark = (id: string) => store.getAgent(id)!.reportDelivered;
    expect(mark('done')).toMatchObject({ v: 1, revision: 2, state: 'done' });
    expect(mark('failed')).toMatchObject({ v: 1, revision: 2, state: 'failed' });
    expect(mark('stopped')).toMatchObject({ v: 1, revision: 2, state: 'stopped' });
    expect(mark('queued')).toBeUndefined();
    expect(mark('main')).toBeUndefined();
    // Once the file has the ledger, a helper that finishes later is not baselined by a reload: its report is still owed.
    store.patchAgent('queued', { state: 'done' });
    store.flush();
    expect(new Store(dir).getAgent('queued')!.reportDelivered).toBeUndefined();
  });

  it('writes delivery marks to disk at once and never moves one back to an older revision', () => {
    const dir = tmp();
    const store = new Store(dir);
    store.upsertAgent(rec('a', 'done'));
    store.flush();
    store.markReportsDelivered([{ id: 'a', revision: 2, state: 'done' }, { id: 'missing', revision: 1, state: 'done' }]);
    expect(new Store(dir).getAgent('a')!.reportDelivered).toMatchObject({ revision: 2, state: 'done' });
    store.markReportsDelivered([{ id: 'a', revision: 1, state: 'failed' }]);
    expect(store.getAgent('a')!.reportDelivered).toMatchObject({ revision: 2, state: 'done' });
    store.clearReportDelivered('a');
    expect(store.getAgent('a')!.reportDelivered).toBeUndefined();
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
