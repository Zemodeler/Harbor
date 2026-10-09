import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk, RunOptions } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { createHarborService } from '../src/main/service';
import type { HarborEvent, Message } from '../src/shared/api';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-orch-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const fakeCli = (id: string): ResolvedCli =>
  ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: `/fake/${id}` });

const isConcierge = (o: RunOptions) => !!o.systemPrompt?.includes('front desk');
const isLead = (o: RunOptions) => !!o.systemPrompt?.includes('LEAD agent');
const isHelper = (o: RunOptions) => !isConcierge(o) && !isLead(o);
const say = (text: string): Chunk[] => [{ kind: 'text', text }];
const answer = (text: string): Chunk[] => say(JSON.stringify({ answer: text }));
const escalate = (complexity = 'medium', ack = ''): Chunk[] => say(JSON.stringify({ escalate: { complexity, needs: ['code'], ack } }));
const delegate = (text: string, ...tasks: unknown[]): Chunk[] => say([text, ...tasks.map((t) => `HARBOR_DELEGATE: ${JSON.stringify(t)}`)].join('\n'));

function gitRepo(): string {
  const d = tmp();
  const g = (...a: string[]) => spawnSync('git', a, { cwd: d });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(d, 'README.md'), 'hi'); g('add', '.'); g('commit', '-q', '-m', 'init');
  return d;
}

/** One script per CLI is split by who is calling: front desk, lead, or helper. */
interface Roles { concierge?: FakeScript; lead?: FakeScript; helper?: FakeScript }
const script = (r: Roles): FakeScript => (prompt, o, i) => {
  if (isConcierge(o)) return (r.concierge ?? (() => escalate()))(prompt, o, i);
  if (isLead(o)) return (r.lead ?? (() => say('ok')))(prompt, o, i);
  return (r.helper ?? (() => say('ok')))(prompt, o, i);
};

async function harness(scripts: Record<string, FakeScript | undefined>, opts: { git?: boolean; ids?: string[] } = {}) {
  const adapters: Record<string, FakeAdapter> = {};
  for (const id of opts.ids ?? ['claude', 'codex']) adapters[id] = new FakeAdapter(id, scripts[id] ?? (() => say('ok')));
  const events: HarborEvent[] = [];
  const svc = createHarborService({
    discover: async () => Object.keys(adapters).map(fakeCli),
    adapterFor: (id) => adapters[id],
    worktreesRoot: join(tmp(), 'wt'),
    maxActivePerProject: 3
  });
  svc.onEvent((e) => events.push(e));
  const repoPath = opts.git === false ? tmp() : gitRepo();
  const project = (await svc.addProject(repoPath))!;
  const [conv] = await svc.listConversations(project.id);
  const messages = async (cid = conv!.id): Promise<Message[]> => svc.listMessages(cid);
  const texts = async (cid = conv!.id) => (await messages(cid)).map((m) => m.text);
  const calls = (pred: (o: RunOptions) => boolean, cli = 'claude') => adapters[cli]!.calls.filter((c) => pred(c.opts));
  return { svc, adapters, events, project, conv: conv!, repoPath, messages, texts, calls };
}

const helpers = (h: { svc: { store: { listAgentRecords: (id: string) => any[] } }; project: { id: string } }) =>
  h.svc.store.listAgentRecords(h.project.id).filter((a) => a.role !== 'main');

describe('concierge: the cheap front desk', () => {
  it('answers simple messages itself with one cheap call and never starts a lead', async () => {
    const h = await harness({ claude: script({ concierge: () => answer('Hi there!'), lead: () => say('SHOULD NOT RUN') }) });
    await h.svc.send(h.conv.id, 'hello');
    await h.svc.whenIdle();
    expect(await h.texts()).toEqual(['hello', 'Hi there!']);
    expect(h.adapters.claude!.calls).toHaveLength(1);
    expect(h.adapters.claude!.calls[0]!.opts).toMatchObject({ model: 'haiku', effort: 'low', permission: 'read-only' });
    const reply = (await h.messages()).find((m) => m.role === 'assistant')!;
    expect(reply.details).toMatchObject({ cli: 'claude', model: 'haiku' });
    expect(reply.details!.reason).toMatch(/cheap/);
  });

  it('does not let the front desk guess about files: a workspace request it answers goes to a medium lead', async () => {
    const h = await harness({ claude: script({ concierge: () => answer('Done, I renamed it.'), lead: () => say('Renamed for real.') }) });
    await h.svc.send(h.conv.id, 'rename the variable foo to bar in src/utils.ts');
    await h.svc.whenIdle();
    const texts = await h.texts();
    expect(texts).not.toContain('Done, I renamed it.');
    expect(texts).toContain('Renamed for real.');
    expect(h.calls(isLead)[0]!.opts).toMatchObject({ model: 'sonnet' });
  });

  it('keeps cheap/standard/strong models for low/medium/high complexity', async () => {
    const pick = async (cx: string) => {
      const h = await harness({ claude: script({ concierge: () => escalate(cx), lead: () => say('ok') }) });
      await h.svc.send(h.conv.id, 'x'); await h.svc.whenIdle();
      return h.calls(isLead)[0]!.opts.model;
    };
    expect([await pick('low'), await pick('medium'), await pick('high')]).toEqual(['haiku', 'sonnet', 'opus']);
  });

  it('shows its acknowledgement, then escalates to a lead that works directly in the project', async () => {
    const h = await harness({ claude: script({ concierge: () => escalate('medium', 'On it.'), lead: () => say('Fixed the typo.') }) });
    await h.svc.send(h.conv.id, 'fix the typo in the readme');
    await h.svc.whenIdle();
    expect((await h.messages()).filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual(['On it.', 'Fixed the typo.']);
    const [lead] = h.calls(isLead);
    expect(lead!.opts).toMatchObject({ model: 'sonnet', permission: 'edit', cwd: h.repoPath });
    expect(lead!.prompt).toContain('User:\nfix the typo in the readme');
    expect(helpers(h)).toHaveLength(0); // no ceremony: a plain edit needs no helpers
    expect((await h.messages()).filter((m) => m.role === 'assistant')[1]!.details).toMatchObject({ model: 'sonnet' });
  });

  it('picks the lead model from the work: strong for hard problems', async () => {
    const h = await harness({ claude: script({ concierge: () => escalate('high'), lead: () => say('done') }) });
    await h.svc.send(h.conv.id, 'redesign the storage layer');
    await h.svc.whenIdle();
    // The strong model already covers hard work; high effort on top is kept for planners, retries and /deep.
    expect(h.calls(isLead)[0]!.opts).toMatchObject({ model: 'opus', effort: 'medium' });
  });

  it('a short go-ahead continues the last request at its size without a new front-desk call', async () => {
    let n = 0;
    const h = await harness({ claude: script({ concierge: () => (n++ === 0 ? escalate('medium') : escalate('high')), lead: () => say('ok') }) });
    await h.svc.send(h.conv.id, 'draft a plan for the git view');
    await h.svc.whenIdle();
    await h.svc.send(h.conv.id, 'Yes, build the panel');
    await h.svc.whenIdle();
    expect(h.calls(isConcierge)).toHaveLength(1);
    expect(h.calls(isLead).map((c) => [c.opts.model, c.opts.effort])).toEqual([['sonnet', 'medium'], ['sonnet', 'medium']]);
    await h.svc.send(h.conv.id, 'thanks!');
    await h.svc.whenIdle();
    expect(h.calls(isConcierge)).toHaveLength(2); // small talk still goes to the cheap front desk
  });

  it('escalates when the front desk returns something unusable', async () => {
    const h = await harness({ claude: script({ concierge: () => say('well, sort of, maybe'), lead: () => say('lead handled it') }) });
    await h.svc.send(h.conv.id, 'do something');
    await h.svc.whenIdle();
    expect((await h.texts()).at(-1)).toBe('lead handled it');
  });

  it('/deep skips the front desk and uses a strong lead', async () => {
    const h = await harness({ claude: script({ lead: () => say('thought hard') }) });
    await h.svc.send(h.conv.id, '/deep fix everything');
    await h.svc.whenIdle();
    expect(h.calls(isConcierge)).toHaveLength(0);
    const [lead] = h.calls(isLead);
    expect(lead!.opts).toMatchObject({ model: 'opus', effort: 'high' }); // explicitly asked for: the one lead turn at high effort
    expect(lead!.prompt).toContain('User:\nfix everything');
  });

  it('fails with a clear message when no CLI is usable', async () => {
    const h = await harness({}, { ids: [] });
    await h.svc.send(h.conv.id, 'hello');
    await h.svc.whenIdle();
    expect((await h.texts()).some((t) => /No eligible CLI/.test(t))).toBe(true);
  });
});

describe('lead: delegation and sessions', () => {
  it('splits work into parallel helpers on suitable models, then resumes its own session with their reports', async () => {
    let started = 0;
    let both!: () => void;
    const bothStarted = new Promise<void>((r) => { both = r; });
    const claude = script({
      concierge: () => escalate('high', 'Splitting this up.'),
      lead: (prompt, o) => {
        if (prompt.includes('Helper reports')) return say('Both parts are done. Not independently verified.');
        return delegate('Two independent parts, starting both.',
          { ref: 'a', title: 'Build login', role: 'implementer', access: 'edit', instructions: 'Create login.ts', complexity: 'low', needs: ['code'], files: ['login.ts'] },
          { ref: 'b', title: 'Survey auth libs', role: 'other', access: 'read', instructions: 'Compare options', complexity: 'medium', needs: ['research'] });
      },
      helper: async (_p, o) => {
        // Both helpers must be running at the same time, or this never resolves.
        started++;
        if (started === 2) both();
        await bothStarted;
        if (o.permission === 'edit') writeFileSync(join(o.cwd, 'login.ts'), 'export const login = 1;');
        return say(o.permission === 'edit' ? 'Implemented login.ts' : 'Library X is best.');
      }
    });
    const h = await harness({ claude });
    await h.svc.send(h.conv.id, 'add login and tell me which auth library to use');
    await h.svc.whenIdle();

    const [impl, research] = ['Build login', 'Survey auth libs'].map((t) => helpers(h).find((a) => a.title === t)!);
    expect(impl.state).toBe('done');
    expect(research.state).toBe('done');
    expect(impl.worktree).toBeTruthy();
    expect(impl.branch).toMatch(/^harbor\//);
    expect(research.worktree).toBeUndefined();

    // Each helper got the cheapest model that fits its complexity.
    const helperCalls = h.calls(isHelper);
    expect(helperCalls.find((c) => c.opts.permission === 'edit')!.opts).toMatchObject({ model: 'haiku', cwd: impl.worktree });
    expect(helperCalls.find((c) => c.opts.permission === 'read-only')!.opts).toMatchObject({ model: 'sonnet', cwd: h.repoPath });

    // Edits happened in the worktree and the main checkout stays clean.
    const log = spawnSync('git', ['log', '--oneline', impl.branch], { cwd: h.repoPath, encoding: 'utf8' }).stdout;
    expect(log).toMatch(/harbor: Build login/);
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: h.repoPath, encoding: 'utf8' }).stdout).toBe('');

    // The lead is resumed in the same native session and sees the reports.
    const leads = h.calls(isLead);
    expect(leads).toHaveLength(2);
    expect(leads[0]!.opts.resumeId).toBeUndefined();
    expect(leads[1]!.opts.resumeId).toBeTruthy();
    expect(leads[1]!.prompt).toContain('Implemented login.ts');
    expect(leads[1]!.prompt).toContain('Library X is best.');

    const msgs = await h.messages();
    expect(msgs.some((m) => m.role === 'system' && m.text.startsWith('Delegated: 1. Build login'))).toBe(true);
    expect(msgs.filter((m) => m.role === 'assistant').map((m) => m.text).at(-1)).toBe('Both parts are done. Not independently verified.');
    expect(msgs.map((m) => m.text).join('\n')).not.toContain('HARBOR_DELEGATE');
    expect((await h.svc.getUsage()).find((w) => w.cli === 'claude')!.usedPct).toBeGreaterThan(0);

    const ic = await h.svc.openAgentConversation(impl.id);
    expect((await h.texts(ic.id)).some((t) => t.includes('Implemented login.ts'))).toBe(true);
  });

  it('a planner report becomes an implementer\'s spec verbatim when the lead chains them', async () => {
    const claude = script({
      lead: (prompt) => {
        if (prompt.includes('User:')) return delegate('Planning first.', { ref: 'p', title: 'Plan login', role: 'planner', instructions: 'Specify login', complexity: 'medium' });
        if (prompt.includes('role=planner') && !prompt.includes('role=implementer')) {
          const pid = prompt.match(/id=(\S+), role=planner/)![1]!;
          return delegate('Spec ready.', { ref: 'i', title: 'Build login', role: 'implementer', instructions: 'Implement', complexity: 'medium', specFrom: pid, files: ['login.ts'] });
        }
        return say('Login is built.');
      },
      helper: (_p, o) => say(o.systemPrompt!.includes('PLANNER') ? '## Goal\nSPEC-TEXT-123' : 'Implemented')
    });
    const h = await harness({ claude });
    await h.svc.send(h.conv.id, 'add login');
    await h.svc.whenIdle();
    const impl = helpers(h).find((a) => a.role === 'implementer')!;
    expect(impl.state).toBe('done');
    expect(impl.spec).toContain('SPEC-TEXT-123');
    expect(helpers(h).find((a) => a.role === 'planner')!.state).toBe('done');
  });

  it('gives image requests a paste-ready brief instead of pretending to generate one', async () => {
    const brief = 'HARBOR_IMAGE_BRIEF: {"subject":"harbor at dawn","style":"flat vector","prompt":"A harbor at dawn, flat vector, teal and orange, 16:9, no text","notes":"Use any image generator."}';
    const h = await harness({ claude: script({ lead: () => say(`I can't make images here.\n${brief}`) }) });
    await h.svc.send(h.conv.id, 'make me a picture of a harbor');
    await h.svc.whenIdle();
    const brieftext = (await h.texts()).find((t) => t.includes('Paste this into an image generator'))!;
    expect(brieftext).toContain('A harbor at dawn, flat vector, teal and orange, 16:9, no text');
    expect(helpers(h)).toHaveLength(0);
    expect((await h.texts()).join('\n')).not.toContain('HARBOR_IMAGE_BRIEF');
  });

  it('retries failed work one complexity level up (retryOf), never above high', async () => {
    const tier = (cx: string, retryOf?: string) => ({ ref: 'x', title: 'Do it', role: 'implementer', access: 'edit', instructions: 'do', complexity: cx, ...(retryOf ? { retryOf } : {}) });
    let failedId = '', helperRuns = 0;
    const claude = script({
      lead: (prompt) => {
        if (prompt.includes('User:')) return delegate('go', tier('low'));
        const m = /id=([\w-]+)/.exec(prompt);
        if (!failedId && m) { failedId = m[1]!; return delegate('again', tier('low', failedId)); }
        return say('fin');
      },
      helper: () => (helperRuns++ === 0 ? [{ kind: 'done', ok: false, error: 'tests failed' }] : say('ok'))
    });
    const h = await harness({ claude, codex: () => [{ kind: 'done', ok: false, error: 'no' }] });
    await h.svc.send(h.conv.id, 'implement it');
    await h.svc.whenIdle();
    const hs = helpers(h);
    expect(hs.length).toBeGreaterThanOrEqual(2);
    expect(hs[0]!.complexity).toBe('low');
    expect(hs[1]!.complexity).toBe('medium');
    expect(hs[0]!.retry).toBeUndefined();
    expect(hs[1]!.retry).toBe(true);
    expect(h.calls(isHelper).at(-1)!.opts.effort).toBe('high'); // a retry gets the highest effort
    expect((await h.texts()).some((t) => t.startsWith('Retrying "Do it" with a stronger model'))).toBe(true);
  });

  it('falls back to the next CLI on rate limit and records why', async () => {
    const claude = script({
      lead: (prompt) => (prompt.includes('User:') ? delegate('go', { ref: 'x', title: 'Investigate', role: 'other', access: 'read', instructions: 'look', complexity: 'low' }) : say('fin')),
      helper: () => [{ kind: 'done', ok: false, error: 'usage limit reached', rateLimited: true }]
    });
    const h = await harness({ claude, codex: () => say('found it') });
    await h.svc.send(h.conv.id, 'investigate');
    await h.svc.whenIdle();
    const a = helpers(h)[0]!;
    expect(a.state).toBe('done');
    expect(a.cli).toBe('codex');
    const conv = await h.svc.openAgentConversation(a.id);
    expect((await h.texts(conv.id)).some((t) => t.startsWith('Falling back to codex'))).toBe(true);
    expect((await h.svc.getUsage()).find((w) => w.cli === 'claude')!.usedPct).toBe(100);
  });

  it('a failed dependency blocks dependents without running them', async () => {
    const claude = script({
      lead: (prompt) => (prompt.includes('User:') ? delegate('go',
        { ref: 'a', title: 'First', role: 'other', instructions: 'x', complexity: 'low' },
        { ref: 'b', title: 'Second', role: 'other', instructions: 'y', complexity: 'low', dependsOn: ['a'] }) : say('Reporting the failure.')),
      helper: () => [{ kind: 'done', ok: false, error: 'boom' }]
    });
    const h = await harness({ claude }, { ids: ['claude'] });
    await h.svc.send(h.conv.id, 'go');
    await h.svc.whenIdle();
    const [a, b] = ['First', 'Second'].map((t) => helpers(h).find((x) => x.title === t)!);
    expect(a.state).toBe('failed');
    expect(b.state).toBe('failed');
    expect(b.error).toMatch(/dependency "First" failed/);
    expect(h.calls(isHelper)).toHaveLength(1);
    expect((await h.texts()).at(-1)).toBe('Reporting the failure.');
  });

  it('breaks circular dependencies instead of waiting forever', async () => {
    const claude = script({
      lead: (prompt) => (prompt.includes('User:') ? delegate('go',
        { ref: 'a', title: 'A', role: 'other', instructions: 'a', complexity: 'low', dependsOn: ['b'] },
        { ref: 'b', title: 'B', role: 'other', instructions: 'b', complexity: 'low', dependsOn: ['a'] }) : say('done'))
    });
    const h = await harness({ claude }, { ids: ['claude'], git: false });
    await h.svc.send(h.conv.id, 'go');
    await h.svc.whenIdle();
    expect((await h.texts()).some((t) => t.startsWith('Ignored a circular dependency'))).toBe(true);
    expect(helpers(h).every((a) => a.state === 'done')).toBe(true);
  });

  it('keeps conversations of one project separate: own agents, own lead session, no blocking', async () => {
    const leadPrompts: string[] = [];
    const claude = script({
      lead: (prompt) => {
        leadPrompts.push(prompt);
        if (prompt.includes('User:\nRouting')) return delegate('Investigating.', { ref: 'a', title: 'Routing report', role: 'other', access: 'read', instructions: 'Explain routing', complexity: 'low' });
        if (prompt.includes('User:\nSelf')) return delegate('Investigating.', { ref: 'b', title: 'Self-modification study', role: 'other', access: 'read', instructions: 'Study it', complexity: 'low' });
        return say('Done.');
      },
      helper: () => say('report')
    });
    const h = await harness({ claude }, { ids: ['claude'] });
    const second = await h.svc.newConversation(h.project.id);
    await h.svc.send(h.conv.id, 'Routing');
    await h.svc.whenIdle();
    await h.svc.send(second.id, 'Self');
    await h.svc.whenIdle();
    const forSecond = leadPrompts.filter((p) => p.includes('User:\nSelf') || p.includes('Self-modification study'));
    expect(forSecond.length).toBeGreaterThan(0);
    expect(forSecond.some((p) => p.includes('Routing report'))).toBe(false);
    const agents = h.svc.store.listAgentRecords(h.project.id);
    expect(agents.find((a) => a.title === 'Self-modification study')!.parentConversationId).toBe(second.id);
    expect((await h.texts(h.conv.id)).some((t) => t.includes('Self-modification'))).toBe(false);
    // The second conversation's first lead call starts a fresh native session.
    expect(h.calls(isLead).find((c) => c.prompt.includes('User:\nSelf'))!.opts.resumeId).toBeUndefined();
  });
});

describe('helpers: direct prompts, help requests, stop, recovery', () => {
  const oneHelper = (role = 'other'): Roles => ({
    lead: (prompt) => (prompt.includes('User:\nstart') ? delegate('go', { ref: 'a', title: 'Worker', role, instructions: 'work', complexity: 'low' }) : say('done')),
    helper: () => say('worked')
  });

  it('delivers a direct prompt by resuming the helper session and tells the lead on its next turn', async () => {
    const h = await harness({ claude: script(oneHelper()) }, { ids: ['claude'] });
    await h.svc.send(h.conv.id, 'start');
    await h.svc.whenIdle();
    const a = helpers(h).find((x) => x.title === 'Worker')!;
    const ac = await h.svc.openAgentConversation(a.id);
    await h.svc.send(ac.id, 'please also handle X');
    await h.svc.whenIdle();
    const calls = h.calls(isHelper);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.opts.resumeId).toBeUndefined();
    expect(calls[1]!.opts.resumeId).toBeTruthy();
    expect(calls[1]!.prompt).toBe('please also handle X');
    expect(h.svc.store.getAgent(a.id)!.revision).toBe(2);
    expect(h.svc.store.listCoordination(h.project.id).some((c) => c.kind === 'direct')).toBe(true);
    await h.svc.send(h.conv.id, 'status?');
    await h.svc.whenIdle();
    expect(h.calls(isLead).some((c) => c.prompt.includes('please also handle X'))).toBe(true);
  });

  it('request_help: the lead assigns another helper and the blocked one resumes with its report', async () => {
    let helperSeen = false;
    const claude = script({
      lead: (prompt) => {
        if (prompt.includes('User:')) return delegate('go', { ref: 'a', title: 'Impl', role: 'implementer', instructions: 'build', complexity: 'low' });
        if (prompt.includes('Help request from')) {
          const from = prompt.match(/id=(\S+), blocked=true/)![1]!;
          return delegate('Assigning an investigator.', { ref: 'h', title: 'Investigate storage', role: 'other', access: 'read', instructions: 'answer storage question', complexity: 'low', helpFor: from });
        }
        return say('finished');
      },
      helper: (prompt, o) => {
        if (o.resumeId && prompt.includes('Your requested helper')) return say('Continued with the answer. All done.');
        if (prompt.includes('answer storage question')) { helperSeen = true; return say('Use JSON files.'); }
        return say('Need a decision.\nHARBOR_REQUEST_HELP: {"reason":"storage?","proposedRole":"other","instructions":"answer storage question","blocked":true}');
      }
    });
    const h = await harness({ claude }, { ids: ['claude'], git: false });
    await h.svc.send(h.conv.id, 'build it');
    await h.svc.whenIdle();
    expect(helperSeen).toBe(true);
    const impl = helpers(h).find((x) => x.title === 'Impl')!;
    expect(impl.state).toBe('done');
    expect(impl.report).toContain('Continued with the answer');
    expect(h.adapters.claude!.calls.find((c) => c.prompt.includes('Your requested helper'))!.prompt).toContain('Use JSON files.');
  });

  it('stop aborts a running helper, marks it stopped and frees its locks', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const claude = script({
      lead: (prompt) => (prompt.includes('User:') ? delegate('go', { ref: 'a', title: 'Slow', role: 'implementer', instructions: 'slow', complexity: 'low', files: ['x.ts'] }) : say('stopped ack')),
      helper: async () => { await gate; return say('late'); }
    });
    const h = await harness({ claude }, { ids: ['claude'], git: false });
    await h.svc.send(h.conv.id, 'go');
    for (let i = 0; i < 200 && !helpers(h).some((a) => a.state === 'working'); i++) await new Promise((r) => setTimeout(r, 10));
    const a = helpers(h).find((x) => x.title === 'Slow')!;
    expect(a.state).toBe('working');
    expect(h.svc.orchestrator.lockTable.heldBy(a.id)).toEqual(['x.ts']);
    await h.svc.stopAgent(a.id);
    release();
    await h.svc.whenIdle();
    expect(h.svc.store.getAgent(a.id)!.state).toBe('stopped');
    expect(h.svc.orchestrator.lockTable.heldBy(a.id)).toEqual([]);
  });

  it('stopping the lead aborts its turn and says so', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = await harness({ claude: script({ lead: async () => { await gate; return say('late'); } }) }, { ids: ['claude'] });
    await h.svc.send(h.conv.id, 'long job');
    for (let i = 0; i < 200 && h.calls(isLead).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await h.svc.stopAgent(h.svc.store.mainAgent(h.project.id)!.id);
    release();
    await h.svc.whenIdle();
    expect((await h.texts()).at(-1)).toBe('Stopped.');
  });

  it('stopping a session prevents stopped helpers restarting its lead', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const h = await harness({ claude: script({
      lead: () => delegate('Delegating.', { ref: 'slow', title: 'Slow helper', role: 'planner', instructions: 'Inspect only', access: 'read' }),
      helper: async () => { await gate; return say('Late result'); }
    }) }, { ids: ['claude'], git: false });
    await h.svc.send(h.conv.id, 'Inspect the project');
    for (let i = 0; i < 200 && !helpers(h).some(a => a.state === 'working'); i++) await new Promise(r => setTimeout(r, 10));
    expect(helpers(h).some(a => a.state === 'working')).toBe(true);
    await h.svc.stopConversation(h.conv.id);
    release(); await h.svc.whenIdle();
    expect(h.calls(isLead)).toHaveLength(1);
    expect(h.svc.store.getConversation(h.conv.id)?.activity?.state).toBe('stopped');
    expect(helpers(h).every(a => a.state === 'stopped')).toBe(true);
    h.svc.shutdown();
  });
  it('stopping a session cancels its queued lead turns while retaining user messages', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const h = await harness({ claude: script({ lead: async () => { await gate; return say('Late answer'); } }) }, { ids: ['claude'], git: false });
    await h.svc.send(h.conv.id, 'First request');
    for (let i = 0; i < 200 && h.calls(isLead).length === 0; i++) await new Promise(r => setTimeout(r, 10));
    await h.svc.send(h.conv.id, 'Second request');
    await h.svc.stopConversation(h.conv.id);
    release(); await h.svc.whenIdle();
    expect(h.calls(isLead)).toHaveLength(1);
    expect(await h.texts()).toContain('Second request');
    expect(await h.texts()).not.toContain('Late answer');
    expect(h.svc.store.getConversation(h.conv.id)?.activity?.state).toBe('stopped');
    h.svc.shutdown();
  });

  it('recover() marks agents that were mid-run as stopped and never replays them', async () => {
    const h = await harness({ claude: script(oneHelper()) }, { ids: ['claude'] });
    const main = h.svc.store.mainAgent(h.project.id)!;
    h.svc.store.upsertAgent({ ...main, id: 'ghost', role: 'implementer', title: 'Ghost', state: 'working', parentConversationId: h.conv.id, dependsOn: [], revision: 1, attempts: 0, created: 1 });
    h.svc.orchestrator.recover();
    expect(h.svc.store.getAgent('ghost')!.state).toBe('stopped');
    expect(h.svc.store.getAgent('ghost')!.error).toMatch(/restarted/);
    expect(h.adapters.claude!.calls).toHaveLength(0);
  });
});

describe('file conflicts', () => {
  const twoEditors = script({
    lead: (prompt) => (prompt.includes('User:') ? delegate('go',
      { ref: 'a', title: 'Editor A', role: 'implementer', instructions: 'a', complexity: 'low', files: ['shared.ts'] },
      { ref: 'b', title: 'Editor B', role: 'implementer', instructions: 'b', complexity: 'low', files: ['Shared.ts'] }) : say('done')),
    helper: () => say('edited')
  });
  const run = async (allow: boolean) => {
    const h = await harness({ claude: twoEditors }, { ids: ['claude'], git: false });
    h.svc.onEvent((e) => { if (e.type === 'permission') void h.svc.answerPermission(e.requestId, allow); });
    await h.svc.send(h.conv.id, 'go');
    await h.svc.whenIdle();
    return h;
  };

  it('serializes on denial: B waits for A, then runs; permission was kind conflict', async () => {
    const h = await run(false);
    const perms = h.events.filter((e) => e.type === 'permission');
    expect(perms).toHaveLength(1);
    expect(perms[0]).toMatchObject({ kind: 'conflict' });
    const order = h.calls(isHelper).map((c) => (c.prompt.includes('Editor A') ? 'A' : 'B'));
    expect(order).toEqual(['A', 'B']);
    expect(helpers(h).every((a) => a.state === 'done')).toBe(true);
  });

  it('lets B proceed in parallel when the user allows it', async () => {
    const h = await run(true);
    expect(helpers(h).every((a) => a.state === 'done')).toBe(true);
    expect(h.svc.store.listCoordination(h.project.id).some((c) => c.kind === 'decision' && /allowed parallel/.test(c.text))).toBe(true);
  });
});

describe('questions to the user', () => {
  const questions = (h: { events: HarborEvent[] }) => h.events.filter((e): e is Extract<HarborEvent, { type: 'question' }> => e.type === 'question');

  it('the lead asks, the pop-up answer goes straight back to the lead (no front desk), and work continues', async () => {
    const claude = script({
      concierge: () => escalate('medium'),
      lead: (prompt) => (prompt.includes('Blue') ? say('Going with blue.') : say('Need one detail.\nHARBOR_ASK: {"question":"Which theme?","options":["Blue","Green"]}'))
    });
    const h = await harness({ claude }, { ids: ['claude'] });
    await h.svc.send(h.conv.id, 'style it');
    await h.svc.whenIdle();
    const [q] = questions(h);
    expect(q).toMatchObject({ prompt: 'Which theme?', options: ['Blue', 'Green'], conversationId: h.conv.id });
    expect(await h.texts()).toContain('Need one detail.');
    expect(await h.texts()).toContain('Which theme?');
    expect(h.calls(isConcierge)).toHaveLength(1);
    await h.svc.answerQuestion(q!.requestId, 'Blue');
    await h.svc.whenIdle();
    expect(await h.texts()).toEqual(expect.arrayContaining(['Blue', 'Going with blue.']));
    expect(h.calls(isConcierge)).toHaveLength(1); // the answer skipped the front desk
    expect(h.calls(isLead)[1]!.opts.resumeId).toBeTruthy();
    await expect(h.svc.answerQuestion(q!.requestId, 'again')).rejects.toThrow(/no longer pending/);
  });

  it('a helper asks with HARBOR_ASK, waits without reporting to the lead, and resumes with the answer', async () => {
    const claude = script({
      lead: (prompt) => (prompt.includes('User:') ? delegate('go', { ref: 'a', title: 'Reviewer A', role: 'reviewer', instructions: 'review', complexity: 'low' }) : say('done')),
      helper: (prompt) => (prompt.includes('Use tabs') ? say('reviewed with tabs') : say('Stopping here.\nHARBOR_ASK: {"question":"Tabs or spaces?","options":["Use tabs","Use spaces"]}'))
    });
    const h = await harness({ claude }, { ids: ['claude'] });
    await h.svc.send(h.conv.id, 'go');
    await h.svc.whenIdle();
    const [q] = questions(h);
    const agent = helpers(h).find((a) => a.role === 'reviewer')!;
    expect(q).toMatchObject({ prompt: 'Tabs or spaces?', agentId: agent.id });
    expect(agent.state).toBe('waiting');
    expect(h.calls(isLead)).toHaveLength(1); // the lead is not called while the helper waits
    await h.svc.answerQuestion(q!.requestId, 'Use tabs');
    await h.svc.whenIdle();
    expect(h.svc.store.getAgent(agent.id)!.state).toBe('done');
    expect(h.svc.store.getAgent(agent.id)!.report).toContain('reviewed with tabs');
  });
});
