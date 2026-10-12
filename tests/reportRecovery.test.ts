import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk, CliAdapter, RunOptions } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import type { ProcessKiller } from '../src/main/proc';
import { createHarborService } from '../src/main/service';
import { MAX_HELD_CHARS, MAX_HELD_REPORTS, pickHeld } from '../src/main/orchestrator';
import { REPORT_CHARS } from '../src/main/prompts';
import { Store, currentResult } from '../src/main/store';
import type { AgentRecord } from '../src/main/types';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-rep-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const say = (text: string): Chunk[] => [{ kind: 'text', text }];
const cli: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' };
/** Never touches a real process. */
const killer: ProcessKiller = { inspect: async () => undefined, kill: async () => { throw new Error('must not kill'); } };
const delegate = (title: string) => `HARBOR_DELEGATE: ${JSON.stringify({ ref: title, title, role: 'other', access: 'read', instructions: `look into ${title}`, complexity: 'low' })}`;
const POSSIBLY_SEEN = '[Harbor: you may already have seen this report';

const isLead = (o: RunOptions) => (o.systemPrompt ?? '').includes('LEAD agent');
const reportCalls = (a: FakeAdapter) => a.calls.filter((c) => isLead(c.opts) && c.prompt.includes('Helper reports'));
/** Lead prompts that carry helper reports, and the helper titles each one reported (`*` = flagged as possibly seen). */
const reportTurns = (a: FakeAdapter) => reportCalls(a).map((c) => c.prompt.split(/^### /m).slice(1)
  .map((sec) => `${/^(.+?) \(id=/.exec(sec)![1]}${sec.includes(POSSIBLY_SEEN) ? '*' : ''}`));

interface Opts {
  /** Runs inside every lead turn that carries reports; `n` counts those turns in this run, from 1. */
  holdLead?: (signal: AbortSignal | undefined, n: number) => Promise<void> | void;
  helper?: (title: string) => Chunk[] | Promise<Chunk[]>;
  /**
   * Read at every routing decision: 'none' leaves no eligible CLI at all; 'spawnFails' fails the lead's report turns before
   * any output; 'silent' takes a report turn's prompt, produces nothing, and ends only when stopped.
   */
  leadAdapter?: () => 'ok' | 'none' | 'spawnFails' | 'silent';
  onSilent?: () => void;
  /** The front desk answers these messages itself (as a cheap model may for "continue") instead of escalating. */
  conciergeAnswers?: (text: string) => boolean;
}

/**
 * One Harbor "run" over a persisted data folder. The lead delegates a read-only helper named after each word of the
 * user's message ("run Alpha Beta" -> helpers "Alpha" and "Beta").
 */
async function harbor(dataDir: string, project: string, opts: Opts = {}) {
  let reportTurn = 0;
  const script: FakeScript = async (prompt, o) => {
    const sys = o.systemPrompt ?? '';
    if (sys.includes('front desk') && opts.conciergeAnswers?.(prompt)) return say(JSON.stringify({ answer: 'Sure, carrying on.' }));
    if (sys.includes('front desk')) return say(JSON.stringify({ escalate: { complexity: 'low', needs: ['code'], ack: '' } }));
    if (isLead(o)) {
      const run = /User:\nrun ([\w ]+)/.exec(prompt);
      if (run) return say(['on it', ...run[1]!.trim().split(' ').map(delegate)].join('\n'));
      if (prompt.includes('Helper reports')) await opts.holdLead?.(o.signal, ++reportTurn);
      return say('noted');
    }
    const title = /look into (\w+)/.exec(prompt)?.[1] ?? '?';
    return opts.helper ? opts.helper(title) : say(`report of ${title}`);
  };
  const adapter = new FakeAdapter('claude', script);
  // Fails the way an adapter reports a CLI that could not start: one failed `done`, no output at all.
  const spawnFails: CliAdapter = { id: 'claude', run: async function* (prompt, o) {
    if (!isLead(o) || !prompt.includes('Helper reports')) { yield* adapter.run(prompt, o); return; }
    yield { kind: 'done', ok: false, error: 'spawn claude ENOENT' };
  } };
  // A CLI that read the prompt and was stopped before it printed anything: the adapter's only evidence is a failed `done`.
  const silent: CliAdapter = { id: 'claude', run: async function* (prompt, o) {
    if (!isLead(o) || !prompt.includes('Helper reports')) { yield* adapter.run(prompt, o); return; }
    opts.onSilent?.();
    await new Promise<void>((r) => o.signal?.addEventListener('abort', () => r()));
    yield { kind: 'done', ok: false, error: 'stopped' };
  } };
  // Routing asks for an adapter without knowing the role; only report turns of the lead are affected (see `spawnFails`).
  const svc = createHarborService({
    dataDir, discover: async () => [cli], worktreesRoot: join(dataDir, 'wt'), killer,
    adapterFor: () => { const m = opts.leadAdapter?.() ?? 'ok'; return m === 'none' ? undefined : m === 'spawnFails' ? spawnFails : m === 'silent' ? silent : adapter; }
  });
  const p = (await svc.addProject(project))!;
  const [conv] = await svc.listConversations(p.id);
  const agent = (title: string) => svc.store.listAgentRecords(p.id).find((a) => a.title === title)!;
  const systemText = async () => (await svc.listMessages(conv!.id)).filter((m) => m.role === 'system').map((m) => m.text);
  return { svc, adapter, project: p, conv: conv!, agent, systemText };
}

describe('helper report delivery across restarts', () => {
  it('in one run, an earlier helper is not reported again when another one finishes (baseline)', async () => {
    const h = await harbor(tmp(), tmp());
    await h.svc.send(h.conv.id, 'run Alpha');
    await h.svc.whenIdle();
    await h.svc.send(h.conv.id, 'run Beta');
    await h.svc.whenIdle();
    expect(reportTurns(h.adapter)).toEqual([['Alpha'], ['Beta']]);
    expect(h.agent('Alpha').reportDelivery).toMatchObject({ revision: 1, state: 'done', status: 'confirmed' });
    h.svc.shutdown();
  });

  it('after a restart, completing another helper does not replay reports a finished lead turn received', async () => {
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
    expect((await second.systemText()).some((t) => t.includes('cannot tell'))).toBe(false);
    second.svc.shutdown();
  });

  it('a revised result of an already-reported helper is still delivered after a restart', async () => {
    const data = tmp(), repo = tmp();
    const first = await harbor(data, repo);
    await first.svc.send(first.conv.id, 'run Alpha');
    await first.svc.whenIdle();
    first.svc.shutdown();

    const second = await harbor(data, repo);
    // The user messages the helper directly: a new revision, whose result the lead has not seen.
    const chat = await second.svc.openAgentConversation(second.agent('Alpha').id);
    await second.svc.send(chat.id, 'look again');
    await second.svc.whenIdle();
    expect(reportTurns(second.adapter)).toEqual([['Alpha']]);
    expect(second.agent('Alpha').reportDelivery).toMatchObject({ revision: 2, status: 'confirmed' });
    second.svc.shutdown();
  });

  it('with no eligible CLI for the lead, the report stays pending and a later "continue" carries it, also after a restart', async () => {
    const data = tmp(), repo = tmp();
    let lead: 'ok' | 'none' = 'ok';
    const first = await harbor(data, repo, { leadAdapter: () => lead, helper: (t) => { if (t === 'Alpha') lead = 'none'; return say(`report of ${t}`); } });
    await first.svc.send(first.conv.id, 'run Alpha');
    await first.svc.whenIdle();
    expect(reportTurns(first.adapter)).toEqual([]);
    expect((await first.systemText()).some((t) => t.includes('could not run'))).toBe(true);
    expect((await first.systemText()).some((t) => t.includes(`did not reach the lead: Alpha (id=${first.agent('Alpha').id}, done)`) && t.includes('your next message'))).toBe(true);
    // No turn started: no mark at all, so nothing claims the lead saw it.
    expect(first.agent('Alpha').reportDelivery).toBeUndefined();
    first.svc.shutdown();
    expect(new Store(data).getAgent(first.agent('Alpha').id)!.reportDelivery).toBeUndefined();

    const second = await harbor(data, repo);
    await second.svc.whenIdle();
    expect(reportTurns(second.adapter)).toEqual([]);
    // No helper will ever finish again here: the user's own message is the turn that carries the report.
    await second.svc.send(second.conv.id, 'continue');
    await second.svc.whenIdle();
    // A plain pending report (not flagged as possibly seen), with its full text, alongside the user's message.
    expect(reportTurns(second.adapter)).toEqual([['Alpha']]);
    const prompt = reportCalls(second.adapter)[0]!.prompt;
    expect(prompt).toContain('report of Alpha');
    expect(prompt.indexOf('User:\ncontinue')).toBeGreaterThan(prompt.indexOf('### Alpha'));
    expect(second.svc.store.listAgentRecords(second.project.id).filter((a) => a.role !== 'main')).toHaveLength(1);
    expect(second.agent('Alpha').reportDelivery).toMatchObject({ status: 'confirmed' });
    second.svc.shutdown();
  });

  it('a "continue" after a restart reaches the lead with retained reports even when the front desk would answer it', async () => {
    const data = tmp(), repo = tmp();
    const marker = 'FULL-REPORT-END-MARKER';
    const long = `report of Alpha ${'x'.repeat(400)} ${marker}`; // the marker is past the 300 characters the front desk sees
    const frontDesk = (a: FakeAdapter) => a.calls.filter((c) => (c.opts.systemPrompt ?? '').includes('front desk'));
    const withMarker = (a: FakeAdapter) => a.calls.filter((c) => isLead(c.opts) && c.prompt.includes(marker));
    let lead: 'ok' | 'none' = 'ok';
    const first = await harbor(data, repo, { leadAdapter: () => lead, helper: (t) => { lead = 'none'; return say(t === 'Alpha' ? long : `report of ${t}`); } });
    await first.svc.send(first.conv.id, 'run Alpha');
    await first.svc.whenIdle();
    expect(first.agent('Alpha').reportDelivery).toBeUndefined();
    first.svc.shutdown();

    const second = await harbor(data, repo, { conciergeAnswers: (p) => /\bcontinue\b/.test(p) });
    await second.svc.whenIdle();
    // Another conversation of the project holds nothing: its "continue" stays with the front desk.
    const other = await second.svc.newConversation(second.project.id);
    await second.svc.send(other.id, 'continue');
    await second.svc.whenIdle();
    expect(frontDesk(second.adapter)).toHaveLength(1);
    expect(second.adapter.calls.filter((c) => isLead(c.opts))).toHaveLength(0);

    await second.svc.send(second.conv.id, 'continue');
    await second.svc.whenIdle();
    expect(frontDesk(second.adapter)).toHaveLength(1); // the front desk was skipped, not overruled
    expect(withMarker(second.adapter)).toHaveLength(1);
    expect(reportTurns(second.adapter)).toEqual([['Alpha']]);
    expect(reportCalls(second.adapter)[0]!.prompt).toContain('User:\ncontinue'); // the user's own text, unchanged
    expect(second.agent('Alpha').reportDelivery).toMatchObject({ status: 'confirmed' });
    expect((await second.svc.listMessages(second.conv.id)).some((m) => m.text === 'Sure, carrying on.')).toBe(false);

    // Nothing is held any more: a later "continue" carries no report again.
    await second.svc.send(second.conv.id, 'continue');
    await second.svc.whenIdle();
    expect(withMarker(second.adapter)).toHaveLength(1);
    expect(reportTurns(second.adapter)).toEqual([['Alpha']]);
    second.svc.shutdown();

    const third = await harbor(data, repo, { conciergeAnswers: (p) => /\bcontinue\b/.test(p) });
    await third.svc.send(third.conv.id, 'continue');
    await third.svc.whenIdle();
    // With no retained reports the cheap front desk answers on its own, as before.
    expect(frontDesk(third.adapter)).toHaveLength(1);
    expect(third.adapter.calls.filter((c) => isLead(c.opts))).toHaveLength(0);
    expect((await third.svc.listMessages(third.conv.id)).some((m) => m.role === 'assistant' && m.text === 'Sure, carrying on.')).toBe(true);
    third.svc.shutdown();
  });

  it('a lead CLI that fails to spawn leaves the report pending in the same run', async () => {
    let lead: 'ok' | 'spawnFails' = 'ok';
    const h = await harbor(tmp(), tmp(), { leadAdapter: () => lead, helper: (t) => { if (t === 'Alpha') lead = 'spawnFails'; return say(`report of ${t}`); } });
    await h.svc.send(h.conv.id, 'run Alpha');
    await h.svc.whenIdle();
    expect(reportTurns(h.adapter)).toEqual([]);
    expect(h.agent('Alpha').reportDelivery).toBeUndefined();
    lead = 'ok';
    await h.svc.send(h.conv.id, 'run Beta');
    await h.svc.whenIdle();
    // The user's next message carries Alpha; Beta's own report comes when Beta finishes.
    expect(reportTurns(h.adapter)).toEqual([['Alpha'], ['Beta']]);
    expect(reportCalls(h.adapter)[0]!.prompt).toContain('User:\nrun Beta');
    expect(h.agent('Alpha').reportDelivery).toMatchObject({ status: 'confirmed' });
    h.svc.shutdown();
  });

  it('a crash during a report turn leaves it uncertain: recovery says so, and the next "continue" carries both reports', async () => {
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
    await waitFor(() => first.agent('Beta')?.state === 'done');
    expect(reportTurns(first.adapter)).toEqual([['Alpha']]);
    // Written before the CLI got the prompt, so the crash below cannot make it look never sent (or delivered).
    expect(first.agent('Alpha').reportDelivery).toMatchObject({ status: 'attempted', state: 'failed' });
    expect(first.agent('Beta').reportDelivery).toBeUndefined();
    // Harbor "crashes" here: state is on disk, Alpha's turn never finished and Beta's queued turn never ran.
    first.svc.shutdown();

    const second = await harbor(data, repo);
    await second.svc.whenIdle();
    // Recovery starts no lead turn, but tells the user which report may not have reached the lead.
    expect(reportTurns(second.adapter)).toEqual([]);
    const alphaId = second.agent('Alpha').id;
    const notices = (await second.systemText()).filter((t) => t.includes('cannot tell whether the lead received'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(`Alpha (id=${alphaId}, failed)`);
    expect(notices[0]).not.toContain('Beta');
    expect(notices[0]).toContain('your next message');
    await second.svc.send(second.conv.id, 'continue');
    await second.svc.whenIdle();
    // Beta never reached a lead and comes plain; Alpha comes again, flagged. No helper had to finish for this.
    expect(reportTurns(second.adapter)).toEqual([['Beta', 'Alpha*']]);
    expect(reportCalls(second.adapter)[0]!.prompt).toContain('User:\ncontinue');
    expect(['Alpha', 'Beta'].map((t) => second.agent(t).reportDelivery?.status)).toEqual(['confirmed', 'confirmed']);
    second.svc.shutdown();

    // The notice is not repeated by a later restart.
    const third = await harbor(data, repo);
    await third.svc.whenIdle();
    expect((await third.systemText()).filter((t) => t.includes('cannot tell whether the lead received'))).toHaveLength(1);
    third.svc.shutdown();
  });

  it('stopping a report turn keeps its reports recoverable; a turn dropped behind it releases its pending report', async () => {
    let leadHeld!: () => void;
    const leadStarted = new Promise<void>((r) => { leadHeld = r; });
    const h = await harbor(tmp(), tmp(), {
      // Only the first report turn is held, until the user stops the conversation.
      holdLead: (signal, n) => {
        if (n > 1) return;
        leadHeld();
        return new Promise<void>((r) => signal!.addEventListener('abort', () => r()));
      },
      helper: async (title) => {
        if (title === 'Alpha') return [{ kind: 'done', ok: false, error: 'Alpha broke' }];
        await leadStarted;
        return say('Beta done');
      }
    });
    await h.svc.send(h.conv.id, 'run Alpha Beta');
    await waitFor(() => h.agent('Beta')?.state === 'done');
    await h.svc.stopConversation(h.conv.id);
    await h.svc.whenIdle();
    // Beta's turn was queued behind Alpha's and dropped by the stop: it never ran.
    expect(reportTurns(h.adapter)).toEqual([['Alpha']]);
    expect(h.agent('Alpha').reportDelivery).toMatchObject({ status: 'attempted' });
    expect(h.agent('Beta').reportDelivery).toBeUndefined();
    const notice = (await h.systemText()).find((t) => t.includes("lead's turn ended before it finished"));
    expect(notice).toContain(`Alpha (id=${h.agent('Alpha').id}, failed)`);
    await h.svc.send(h.conv.id, 'run Gamma');
    await h.svc.whenIdle();
    expect(reportTurns(h.adapter)).toEqual([['Alpha'], ['Beta', 'Alpha*'], ['Gamma']]);
    expect(['Alpha', 'Beta', 'Gamma'].map((t) => h.agent(t).reportDelivery?.status)).toEqual(['confirmed', 'confirmed', 'confirmed']);
    h.svc.shutdown();
  });

  it('stopping helpers still starts no lead turn, even with uncertain reports waiting', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let leadHeld!: () => void;
    const leadStarted = new Promise<void>((r) => { leadHeld = r; });
    const h = await harbor(tmp(), tmp(), {
      holdLead: (signal, n) => { if (n > 1) return; leadHeld(); return new Promise<void>((r) => signal!.addEventListener('abort', () => r())); },
      helper: async (title) => {
        if (title === 'Alpha') return [{ kind: 'done', ok: false, error: 'Alpha broke' }];
        await leadStarted;
        await gate;
        return say(`${title} done`);
      }
    });
    await h.svc.send(h.conv.id, 'run Alpha Beta');
    await leadStarted;
    await waitFor(() => h.agent('Beta')?.state === 'working');
    // Stopping the lead aborts Alpha's report turn (Alpha becomes uncertain) and stops Beta.
    await h.svc.stopAgent(h.svc.store.mainAgent(h.project.id)!.id);
    release();
    await h.svc.whenIdle();
    expect(h.agent('Beta').state).toBe('stopped');
    expect(reportTurns(h.adapter)).toEqual([['Alpha']]);
    expect(h.agent('Alpha').reportDelivery).toMatchObject({ status: 'attempted' });
    expect(h.agent('Beta').reportDelivery).toMatchObject({ status: 'skipped', state: 'stopped' });
    h.svc.shutdown();
  });

  it('a file from before delivery tracking keeps its reports and flags them as possibly seen, once', async () => {
    const data = tmp(), repo = tmp();
    const first = await harbor(data, repo);
    await first.svc.send(first.conv.id, 'run Alpha');
    await first.svc.whenIdle();
    const alphaId = first.agent('Alpha').id;
    first.svc.shutdown();
    // Rewrite the saved state as an older Harbor wrote it: no ledger flag, no delivery marks.
    const legacy = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'));
    delete legacy.reportLedger;
    for (const a of legacy.agents) delete a.reportDelivery;
    writeFileSync(join(data, 'state.json'), JSON.stringify(legacy));

    const second = await harbor(data, repo);
    await second.svc.whenIdle();
    expect(second.agent('Alpha').reportDelivery).toMatchObject({ status: 'unknown', state: 'done' });
    expect((await second.systemText()).filter((t) => t.includes('cannot tell whether the lead received') && t.includes(`Alpha (id=${alphaId}, done)`))).toHaveLength(1);
    expect(reportTurns(second.adapter)).toEqual([]);
    await second.svc.send(second.conv.id, 'run Beta');
    await second.svc.whenIdle();
    const turns = reportCalls(second.adapter);
    expect(reportTurns(second.adapter)).toEqual([['Alpha*'], ['Beta']]);
    expect(turns[0]!.prompt).toContain('report of Alpha'); // the report itself is kept, not only a reference
    second.svc.shutdown();
  });

  it('a long upgraded backlog goes out a bounded part per turn, naming the rest, until "continue" drains it', async () => {
    const data = tmp(), repo = tmp();
    const titles = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'];
    const first = await harbor(data, repo);
    await first.svc.setSettings({ maxHelpersPerTurn: 8 }); // this scenario delegates six helpers at once; the default brake is four per turn
    await first.svc.send(first.conv.id, `run ${titles.join(' ')}`);
    await first.svc.whenIdle();
    first.svc.shutdown();
    const legacy = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'));
    delete legacy.reportLedger;
    for (const a of legacy.agents) delete a.reportDelivery;
    writeFileSync(join(data, 'state.json'), JSON.stringify(legacy));

    const second = await harbor(data, repo);
    await second.svc.whenIdle();
    expect(reportTurns(second.adapter)).toEqual([]); // nothing starts on its own after the upgrade
    await second.svc.send(second.conv.id, 'continue');
    await second.svc.whenIdle();
    const [carried] = reportTurns(second.adapter);
    expect(carried).toHaveLength(MAX_HELD_REPORTS);
    expect(carried!.every((t) => t.endsWith('*'))).toBe(true);
    const rest = titles.filter((t) => !carried!.includes(`${t}*`));
    const prompt = reportCalls(second.adapter)[0]!.prompt;
    expect(prompt).toContain(`${rest.length} more held report(s)`);
    for (const t of rest) {
      expect(prompt).toContain(`${t} (id=${second.agent(t).id}, done)`);
      expect(prompt).not.toContain(`### ${t} (id=`); // referenced, not carried (the register still shows its summary)
      expect(second.agent(t).reportDelivery).toMatchObject({ status: 'unknown' }); // kept, not dropped or assumed delivered
    }
    second.svc.shutdown();

    // The remainder survives a restart and goes with the next turn.
    const third = await harbor(data, repo);
    await third.svc.send(third.conv.id, 'continue');
    await third.svc.whenIdle();
    expect(reportTurns(third.adapter)).toEqual([rest.map((t) => `${t}*`)]);
    expect(reportCalls(third.adapter)[0]!.prompt).not.toContain('more held report(s)');
    expect(titles.map((t) => third.agent(t).reportDelivery?.status)).toEqual(titles.map(() => 'confirmed'));
    third.svc.shutdown();
  });

  it('a report turn stopped before the CLI printed anything is uncertain, not plain pending', async () => {
    let started!: () => void;
    const silentStarted = new Promise<void>((r) => { started = r; });
    let lead: 'ok' | 'silent' = 'ok';
    const h = await harbor(tmp(), tmp(), { leadAdapter: () => lead, onSilent: () => started(), helper: (t) => { lead = 'silent'; return say(`report of ${t}`); } });
    await h.svc.send(h.conv.id, 'run Alpha');
    await silentStarted;
    await h.svc.stopConversation(h.conv.id);
    await h.svc.whenIdle();
    // No output at all, but the prompt was handed over before the stop: the lead may have read it.
    expect(h.agent('Alpha').reportDelivery).toMatchObject({ status: 'attempted' });
    expect((await h.systemText()).some((t) => t.includes("lead's turn ended before it finished") && t.includes('your next message'))).toBe(true);
    lead = 'ok';
    await h.svc.send(h.conv.id, 'continue');
    await h.svc.whenIdle();
    expect(reportTurns(h.adapter)).toEqual([['Alpha*']]);
    expect(h.agent('Alpha').reportDelivery).toMatchObject({ status: 'confirmed' });
    h.svc.shutdown();
  });
});

const rec = (id: string, state: AgentRecord['state'], extra: Partial<AgentRecord> = {}): AgentRecord => ({
  id, projectId: 'p', role: 'other', title: id, state, cli: 'claude', model: 'default', effort: 'low', task: 't', dependsOn: [], revision: 2,
  parentConversationId: 'c', attempts: 0, created: 1, ...extra
});

describe('report delivery bookkeeping in the store', () => {
  it('marks finished helpers of a file written before the ledger as unknown, never as delivered, and only once', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, agents: [
      rec('done', 'done'), rec('failed', 'failed'), rec('stopped', 'stopped'), rec('queued', 'queued'), rec('main', 'waiting', { role: 'main' }), rec('user', 'done', { byUser: true })
    ] }));
    const store = new Store(dir);
    const mark = (id: string) => store.getAgent(id)!.reportDelivery;
    for (const id of ['done', 'failed', 'stopped']) expect(mark(id)).toMatchObject({ v: 1, revision: 2, state: id, status: 'unknown' });
    for (const id of ['queued', 'main', 'user']) expect(mark(id)).toBeUndefined();
    expect(store.getAgent('done')!.report).toBeUndefined(); // nothing else is touched
    // Once the file has the ledger, a helper that finishes later is not marked by a reload: its report is still owed.
    store.patchAgent('queued', { state: 'done' });
    store.flush();
    expect(new Store(dir).getAgent('queued')!.reportDelivery).toBeUndefined();
  });

  it('writes marks at once, never weakens one, and never lets a stale result overwrite the current one', () => {
    const dir = tmp();
    const store = new Store(dir);
    store.upsertAgent(rec('a', 'done'));
    store.flush();
    store.markReports([{ id: 'a', revision: 2, state: 'done' }, { id: 'missing', revision: 1, state: 'done' }], 'attempted');
    expect(new Store(dir).getAgent('a')!.reportDelivery).toMatchObject({ revision: 2, state: 'done', status: 'attempted' });
    store.markReports([{ id: 'a', revision: 2, state: 'done' }], 'confirmed');
    store.markReports([{ id: 'a', revision: 2, state: 'done' }], 'attempted');
    expect(new Store(dir).getAgent('a')!.reportDelivery).toMatchObject({ status: 'confirmed' });
    // A batch queued for revision 1 settles after the helper moved on: it must not replace revision 2's mark.
    store.markReports([{ id: 'a', revision: 1, state: 'failed' }], 'confirmed');
    expect(store.getAgent('a')!.reportDelivery).toMatchObject({ revision: 2, state: 'done' });
    // Revision 3 is current and unmarked; a late mark for revision 2 does not make it look delivered.
    store.patchAgent('a', { revision: 3, state: 'done', reportDelivery: undefined });
    store.markReports([{ id: 'a', revision: 2, state: 'done' }], 'confirmed');
    const d = store.getAgent('a')!.reportDelivery;
    expect(d?.revision === 3 && d.state === 'done').toBe(false);
    store.clearReportDelivery('a');
    expect(store.getAgent('a')!.reportDelivery).toBeUndefined();
  });

  it('restores the earlier mark when an attempt never reached a CLI', () => {
    const store = new Store();
    store.upsertAgent(rec('fresh', 'done'));
    store.upsertAgent(rec('legacy', 'done', { reportDelivery: { v: 1, revision: 2, state: 'done', status: 'unknown', time: 1 } }));
    const marks = [{ id: 'fresh', revision: 2, state: 'done' as const }, { id: 'legacy', revision: 2, state: 'done' as const }];
    store.markReports(marks, 'attempted');
    expect(store.getAgent('legacy')!.reportDelivery).toMatchObject({ status: 'attempted' });
    store.restoreReports([{ mark: marks[0]!, prev: undefined }, { mark: marks[1]!, prev: { v: 1, revision: 2, state: 'done', status: 'unknown', time: 1 } }]);
    expect(store.getAgent('fresh')!.reportDelivery).toBeUndefined();
    expect(store.getAgent('legacy')!.reportDelivery).toMatchObject({ status: 'unknown' });
  });

  it('a late confirmation for the result before a resume never marks the resumed run, even with the same revision and state', () => {
    const store = new Store();
    store.upsertAgent(rec('a', 'stopped'));
    // A lead turn carrying the stopped result is in flight when the user resumes the helper.
    const inFlight = currentResult(store.getAgent('a')!);
    store.markReports([inFlight], 'attempted');
    store.clearReportDelivery('a');
    // The resumed run stops again: same revision, same state, but another incarnation.
    store.patchAgent('a', { state: 'stopped' });
    store.markReports([inFlight], 'confirmed');
    expect(store.getAgent('a')!.reportDelivery).toBeUndefined();
    store.restoreReports([{ mark: inFlight, prev: undefined }]);
    expect(store.getAgent('a')!.reportDelivery).toBeUndefined();
    // The resumed result is still owed, and its own mark works.
    const now = currentResult(store.getAgent('a')!);
    expect(now).toMatchObject({ revision: inFlight.revision, state: inFlight.state, gen: 1 });
    store.markReports([now], 'confirmed');
    expect(store.getAgent('a')!.reportDelivery).toMatchObject({ gen: 1, status: 'confirmed' });
  });

  it('bounds held reports by count and by text, keeping order: never sent, then interrupted, then upgraded', () => {
    const mark = (status: 'attempted' | 'unknown') => ({ reportDelivery: { v: 1 as const, revision: 2, state: 'done' as const, status, time: 1 } });
    const big = 'x'.repeat(REPORT_CHARS * 2);
    const held = [
      rec('u1', 'done', { created: 1, report: 'short', ...mark('unknown') }),
      rec('a1', 'done', { created: 2, report: big, ...mark('attempted') }),
      rec('p1', 'done', { created: 3, report: big }),
      rec('p2', 'done', { created: 4, report: big })
    ];
    const byText = pickHeld(held);
    // Each report counts at most REPORT_CHARS (all the prompt shows of it). A third long one would pass the char budget, so
    // a1 waits (and goes first next turn) while the short upgraded one still fits.
    expect(MAX_HELD_CHARS).toBeLessThan(3 * REPORT_CHARS);
    expect(byText.items.map((a) => a.id)).toEqual(['p1', 'p2', 'u1']);
    expect(byText.omitted.map((a) => a.id)).toEqual(['a1']);
    expect(pickHeld(byText.omitted).items.map((a) => a.id)).toEqual(['a1']);
    const many = Array.from({ length: MAX_HELD_REPORTS + 3 }, (_, i) => rec(`r${i}`, 'done', { created: i, report: 'short' }));
    const byCount = pickHeld(many);
    expect(byCount.items.map((a) => a.id)).toEqual(many.slice(0, MAX_HELD_REPORTS).map((a) => a.id));
    expect(byCount.omitted).toHaveLength(3);
    // A single report always goes, however long.
    expect(pickHeld([rec('one', 'done', { report: big })]).items).toHaveLength(1);
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
