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

const isMain = (o: RunOptions) => !!o.systemPrompt?.includes('MAIN AGENT');
const say = (text: string): Chunk[] => [{ kind: 'text', text }];
const plan = (reply: string, tasks: unknown[] = []): Chunk[] => say(JSON.stringify({ reply, tasks }));
const idOf = (prompt: string, role: string, title?: string): string => {
  const re = new RegExp(`id=(\\S+) role=${role}[^\\n]*${title ? `title="${title}"` : ''}`);
  return prompt.match(re)![1]!;
};

function gitRepo(): string {
  const d = tmp();
  const g = (...a: string[]) => spawnSync('git', a, { cwd: d });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(d, 'README.md'), 'hi'); g('add', '.'); g('commit', '-q', '-m', 'init');
  return d;
}

interface Scripts { claude?: FakeScript; codex?: FakeScript }

async function harness(scripts: Scripts, opts: { git?: boolean; ids?: string[] } = {}) {
  const adapters: Record<string, FakeAdapter> = {};
  for (const id of opts.ids ?? ['claude', 'codex']) adapters[id] = new FakeAdapter(id, scripts[id as keyof Scripts] ?? (() => say('ok')));
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
  return { svc, adapters, events, project, conv: conv!, repoPath, messages, texts };
}

describe('end-to-end orchestration with fake CLIs', () => {
  it('main plans, planner specs, implementer works in a worktree, main summarizes', async () => {
    const claude: FakeScript = (prompt, o) => {
      if (isMain(o)) {
        if (prompt.includes('New message from the user')) return plan('On it. Planning first.', [{ ref: 't1', title: 'Plan login', role: 'planner', instructions: 'Specify login', complexity: 'medium' }]);
        if (prompt.includes('role=planner') && prompt.includes('state=done') && !prompt.includes('role=implementer')) {
          return plan('Spec ready; implementing.', [{ ref: 'i1', title: 'Build login', role: 'implementer', instructions: 'Implement', complexity: 'medium', dependsOn: [idOf(prompt, 'planner')], specFrom: idOf(prompt, 'planner'), files: ['login.ts'] }]);
        }
        return plan('Login is built on branch harbor/*. Not independently verified.');
      }
      if (o.systemPrompt!.includes('PLANNER')) return say('## Goal\nSPEC-TEXT-123');
      writeFileSync(join(o.cwd, 'login.ts'), 'export const login = 1;');
      return say('Implemented login.ts');
    };
    const h = await harness({ claude });
    await h.svc.send(h.conv.id, 'Add login');
    await h.svc.whenIdle();

    const agents = await h.svc.listAgents(h.project.id);
    const planner = agents.find((a) => a.role === 'planner')!;
    const impl = agents.find((a) => a.role === 'implementer')!;
    expect(planner.state).toBe('done');
    expect(impl.state).toBe('done');
    expect(impl.worktree).toBeTruthy();
    expect(impl.parentId).toBe(agents.find((a) => a.role === 'main')!.id);

    // The implementer received the planner's report verbatim as its spec.
    const rec = h.svc.store.getAgent(impl.id)!;
    expect(rec.spec).toContain('SPEC-TEXT-123');
    expect(rec.branch).toMatch(/^harbor\//);
    expect(h.adapters.claude!.calls.some((c) => c.opts.permission === 'edit' && c.opts.cwd === impl.worktree)).toBe(true);

    // Edits happened in the worktree, were committed, and the main checkout is untouched.
    const log = spawnSync('git', ['log', '--oneline', rec.branch!], { cwd: h.repoPath, encoding: 'utf8' }).stdout;
    expect(log).toMatch(/harbor: Build login/);
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: h.repoPath, encoding: 'utf8' }).stdout).toBe('');
    expect(rec.report).toMatch(/login\.ts/);

    // The main agent never ran with edit permission or in a worktree.
    const mainCalls = h.adapters.claude!.calls.filter((c) => isMain(c.opts));
    expect(mainCalls).toHaveLength(3);
    expect(mainCalls.every((c) => c.opts.permission === 'read-only' && c.opts.cwd === h.repoPath)).toBe(true);

    const msgs = await h.messages();
    expect(msgs.filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual([
      'On it. Planning first.', 'Spec ready; implementing.', 'Login is built on branch harbor/*. Not independently verified.'
    ]);
    expect(msgs.find((m) => m.role === 'assistant')!.details).toMatchObject({ cli: 'claude' });
    expect(msgs.find((m) => m.role === 'assistant')!.details!.reason).toMatch(/signed in/);
    expect(msgs.filter((m) => m.text.startsWith('Plan:'))).toHaveLength(1); // only the step with a dependency shows a plan
    expect(h.events.some((e) => e.type === 'usage')).toBe(true);
    expect((await h.svc.getUsage()).find((w) => w.cli === 'claude')!.usedPct).toBeGreaterThan(0);

    // Subagent conversation holds its own transcript.
    const ic = await h.svc.openAgentConversation(impl.id);
    expect((await h.texts(ic.id)).some((t) => t.includes('Implemented login.ts'))).toBe(true);
  });

  it('shows a plan when work has several assignments and fast-paths a clear implementer without a planner', async () => {
    const claude: FakeScript = (prompt, o) => {
      if (isMain(o)) {
        if (prompt.includes('New message from the user')) return plan('Two small edits.', [
          { ref: 'a', title: 'Edit A', role: 'implementer', instructions: 'Change A precisely', complexity: 'low' },
          { ref: 'b', title: 'Review A', role: 'reviewer', instructions: 'Review A', complexity: 'low', dependsOn: ['a'] }
        ]);
        return plan('All done.');
      }
      return say('done');
    };
    const h = await harness({ claude }, { git: false });
    await h.svc.send(h.conv.id, 'do A');
    await h.svc.whenIdle();
    const texts = await h.texts();
    expect(texts.some((t) => t.startsWith('Plan: 1. [implementer] Edit A'))).toBe(true);
    const impl = h.svc.store.listAgentRecords(h.project.id).find((a) => a.role === 'implementer')!;
    expect(impl.spec).toBe('Change A precisely'); // fast path: instructions are the spec
    expect(texts.at(-1)).toBe('All done.');
  });

  it('falls back to the next CLI on rate limit and records why', async () => {
    const claude: FakeScript = (_p, o) => (isMain(o) ? plan('ok') : [{ kind: 'done', ok: false, error: 'usage limit reached', rateLimited: true }]);
    const codex: FakeScript = (prompt, o) => {
      if (isMain(o)) {
        return prompt.includes('New message') ? plan('go', [{ ref: 'x', title: 'Investigate', role: 'other', instructions: 'look', complexity: 'low' }]) : plan('fin');
      }
      return say('found it');
    };
    // Make main always route to codex first so claude's failure is only hit by the subagent
    const h = await harness({ claude: (p, o) => (isMain(o) ? codex(p, o, 0) : claude(p, o, 0)), codex });
    await h.svc.send(h.conv.id, 'investigate');
    await h.svc.whenIdle();
    const a = h.svc.store.listAgentRecords(h.project.id).find((x) => x.role === 'other')!;
    expect(a.state).toBe('done');
    expect(a.cli).toBe('codex');
    const conv = await h.svc.openAgentConversation(a.id);
    expect((await h.texts(conv.id)).some((t) => t.startsWith('Falling back to codex'))).toBe(true);
    const usage = await h.svc.getUsage();
    expect(usage.find((w) => w.cli === 'claude')!.usedPct).toBe(100);
  });

  it('fails with a clear message when no CLI is usable', async () => {
    const h = await harness({}, { ids: [] });
    await h.svc.send(h.conv.id, 'hello');
    await h.svc.whenIdle();
    expect((await h.texts()).some((t) => /No eligible CLI/.test(t))).toBe(true);
  });

  it('a failed dependency blocks dependents without running them', async () => {
    const claude: FakeScript = (prompt, o) => {
      if (isMain(o)) {
        if (prompt.includes('New message')) return plan('go', [
          { ref: 'a', title: 'First', role: 'other', instructions: 'x', complexity: 'low' },
          { ref: 'b', title: 'Second', role: 'other', instructions: 'y', complexity: 'low', dependsOn: ['a'] }
        ]);
        return plan('Reporting the failure.');
      }
      return [{ kind: 'done', ok: false, error: 'boom' }];
    };
    const h = await harness({ claude, codex: claude }, { ids: ['claude'] });
    await h.svc.send(h.conv.id, 'go');
    await h.svc.whenIdle();
    const [a, b] = ['First', 'Second'].map((t) => h.svc.store.listAgentRecords(h.project.id).find((x) => x.title === t)!);
    expect(a.state).toBe('failed');
    expect(b.state).toBe('failed');
    expect(b.error).toMatch(/dependency "First" failed/);
    expect(h.adapters.claude!.calls.filter((c) => !isMain(c.opts))).toHaveLength(1);
  });
});

describe('direct prompts, help requests, peers, stop, recovery', () => {
  const oneTask = (role = 'other'): FakeScript => (prompt, o) => {
    if (isMain(o)) return prompt.includes('New message from the user:\nstart') ? plan('go', [{ ref: 'a', title: 'Worker', role, instructions: 'work', complexity: 'low' }]) : plan('done');
    return say('worked');
  };

  it('delivers a direct prompt by resuming the subagent session and notifies main', async () => {
    const h = await harness({ claude: oneTask() }, { ids: ['claude'] });
    await h.svc.send(h.conv.id, 'start');
    await h.svc.whenIdle();
    const a = h.svc.store.listAgentRecords(h.project.id).find((x) => x.title === 'Worker')!;
    const ac = await h.svc.openAgentConversation(a.id);
    await h.svc.send(ac.id, 'please also handle X');
    await h.svc.whenIdle();
    const calls = h.adapters.claude!.calls.filter((c) => !isMain(c.opts));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.opts.resumeId).toBeUndefined();
    expect(calls[1]!.opts.resumeId).toBeTruthy();
    expect(calls[1]!.prompt).toBe('please also handle X');
    expect(h.svc.store.getAgent(a.id)!.revision).toBe(2);
    expect(h.svc.store.listCoordination(h.project.id).some((c) => c.kind === 'direct')).toBe(true);
    expect((await h.texts()).some((t) => t.includes('You messaged "Worker" directly'))).toBe(true);
    // The next main turn sees the direct instruction.
    await h.svc.send(h.conv.id, 'status?');
    await h.svc.whenIdle();
    const mainPrompts = h.adapters.claude!.calls.filter((c) => isMain(c.opts)).map((c) => c.prompt);
    expect(mainPrompts.some((p) => p.includes('please also handle X'))).toBe(true);
  });

  it('request_help: main assigns a sibling, the blocked agent resumes with its report', async () => {
    let helperId = '';
    const claude: FakeScript = (prompt, o) => {
      if (isMain(o)) {
        if (prompt.includes('New message')) return plan('go', [{ ref: 'a', title: 'Impl', role: 'implementer', instructions: 'build', complexity: 'low' }]);
        if (prompt.includes('Help request from')) {
          const from = prompt.match(/id=(\S+), blocked=true/)![1]!;
          return plan('Assigning an investigator.', [{ ref: 'h', title: 'Investigate storage', role: 'other', instructions: 'answer storage question', complexity: 'low', helpFor: from }]);
        }
        return plan('finished');
      }
      if (o.resumeId && prompt.includes('Your requested sibling')) return say('Continued with the answer. All done.');
      if (prompt.includes('answer storage question')) { helperId = 'seen'; return say('Use JSON files.'); }
      return say('Need a decision.\nHARBOR_REQUEST_HELP: {"reason":"storage?","proposedRole":"other","instructions":"answer storage question","blocked":true}');
    };
    const h = await harness({ claude }, { ids: ['claude'], git: false });
    await h.svc.send(h.conv.id, 'build it');
    await h.svc.whenIdle();
    expect(helperId).toBe('seen');
    const impl = h.svc.store.listAgentRecords(h.project.id).find((x) => x.title === 'Impl')!;
    expect(impl.state).toBe('done');
    expect(impl.report).toContain('Continued with the answer');
    expect(h.svc.store.listCoordination(h.project.id).some((c) => c.kind === 'help')).toBe(true);
    expect(h.adapters.claude!.calls.find((c) => c.prompt.includes('Your requested sibling'))!.prompt).toContain('Use JSON files.');
  });

  it('sibling messages are logged to both conversations and delivered on the next run', async () => {
    const claude: FakeScript = (prompt, o) => {
      if (isMain(o)) return prompt.includes('New message') ? plan('go', [
        { ref: 'a', title: 'Alpha', role: 'other', instructions: 'a', complexity: 'low' },
        { ref: 'b', title: 'Beta', role: 'other', instructions: 'b', complexity: 'low', dependsOn: ['a'] }
      ]) : plan('done');
      if (prompt.includes('Assignment') || prompt.includes('Your assignment')) {
        if (prompt.includes('Your assignment (id=') && prompt.includes(': Alpha')) return say('hello\nHARBOR_PEER: {"to":"Beta","text":"interface is foo(x)"}');
      }
      return say('ok');
    };
    const h = await harness({ claude }, { ids: ['claude'], git: false });
    await h.svc.send(h.conv.id, 'go');
    await h.svc.whenIdle();
    const [alpha, beta] = ['Alpha', 'Beta'].map((t) => h.svc.store.listAgentRecords(h.project.id).find((x) => x.title === t)!);
    const betaCall = h.adapters.claude!.calls.find((c) => c.prompt.includes(': Beta'))!;
    expect(betaCall.prompt).toContain('interface is foo(x)');
    const entry = h.svc.store.listCoordination(h.project.id).find((c) => c.kind === 'peer')!;
    expect(entry).toMatchObject({ from: alpha.id, to: beta.id });
    const ac = await h.svc.openAgentConversation(alpha.id), bc = await h.svc.openAgentConversation(beta.id);
    expect((await h.texts(ac.id)).some((t) => t.startsWith('[sibling] Alpha → Beta'))).toBe(true);
    expect((await h.texts(bc.id)).some((t) => t.startsWith('[sibling] Alpha → Beta'))).toBe(true);
    expect((await h.texts(ac.id)).join('\n')).not.toContain('HARBOR_PEER'); // protocol lines are stripped from reports
    expect(alpha.report).not.toContain('HARBOR_PEER');
  });

  it('stop aborts a running agent, marks it stopped and frees its locks', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const claude: FakeScript = async (prompt, o) => {
      if (isMain(o)) return prompt.includes('New message') ? plan('go', [{ ref: 'a', title: 'Slow', role: 'implementer', instructions: 'slow', complexity: 'low', files: ['x.ts'] }]) : plan('stopped ack');
      await gate;
      return say('late');
    };
    const h = await harness({ claude }, { ids: ['claude'], git: false });
    await h.svc.send(h.conv.id, 'go');
    for (let i = 0; i < 100 && h.svc.store.listAgentRecords(h.project.id).every((a) => a.state !== 'working' || a.role === 'main'); i++) await new Promise((r) => setTimeout(r, 10));
    const a = h.svc.store.listAgentRecords(h.project.id).find((x) => x.title === 'Slow')!;
    expect(a.state).toBe('working');
    expect(h.svc.orchestrator.lockTable.heldBy(a.id)).toEqual(['x.ts']);
    await h.svc.stopAgent(a.id);
    release();
    await h.svc.whenIdle();
    expect(h.svc.store.getAgent(a.id)!.state).toBe('stopped');
    expect(h.svc.orchestrator.lockTable.heldBy(a.id)).toEqual([]);
  });

  it('recover() marks agents that were mid-run as stopped and never replays them', async () => {
    const h = await harness({ claude: oneTask() }, { ids: ['claude'] });
    const main = h.svc.store.mainAgent(h.project.id)!;
    h.svc.store.upsertAgent({ ...main, id: 'ghost', role: 'implementer', title: 'Ghost', state: 'working', parentConversationId: h.conv.id, dependsOn: [], revision: 1, attempts: 0, created: 1 });
    h.svc.orchestrator.recover();
    expect(h.svc.store.getAgent('ghost')!.state).toBe('stopped');
    expect(h.svc.store.getAgent('ghost')!.error).toMatch(/restarted/);
    expect(h.adapters.claude!.calls).toHaveLength(0);
  });
});

describe('file conflicts', () => {
  const twoEditors: FakeScript = (prompt, o) => {
    if (isMain(o)) return prompt.includes('New message') ? plan('go', [
      { ref: 'a', title: 'Editor A', role: 'implementer', instructions: 'a', complexity: 'low', files: ['shared.ts'] },
      { ref: 'b', title: 'Editor B', role: 'implementer', instructions: 'b', complexity: 'low', files: ['Shared.ts'] }
    ]) : plan('done');
    return say('edited');
  };
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
    const order = h.adapters.claude!.calls.filter((c) => !isMain(c.opts)).map((c) => (c.prompt.includes('Editor A') ? 'A' : 'B'));
    expect(order).toEqual(['A', 'B']);
    expect(h.svc.store.listAgentRecords(h.project.id).filter((a) => a.role === 'implementer').every((a) => a.state === 'done')).toBe(true);
    expect(h.svc.store.listCoordination(h.project.id).map((c) => c.kind)).toContain('conflict');
  });

  it('lets B proceed in parallel when the user allows it', async () => {
    const h = await run(true);
    expect(h.svc.store.listAgentRecords(h.project.id).filter((a) => a.role === 'implementer').every((a) => a.state === 'done')).toBe(true);
    expect(h.svc.store.listCoordination(h.project.id).some((c) => c.kind === 'decision' && /allowed parallel/.test(c.text))).toBe(true);
  });
});
