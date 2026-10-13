import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarborEvent } from '../src/shared/api';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk, RunOptions, ToolPermissionDecision, ToolPermissionRequest } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { createHarborService } from '../src/main/service';
import { matchesToolRule, neverAlwaysAllow, Store, toolRuleFor } from '../src/main/store';
import { calmReported } from './fixtures/calmReadings';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-perm-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* Windows may still hold a handle */ } } });

const say = (text: string): Chunk[] => [{ kind: 'text', text }];
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();
const bash = (command: string): ToolPermissionRequest => ({ tool: 'Bash', input: { command } });

async function waitFor(cond: () => boolean, ms = 10000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

type ToolEvent = Extract<HarborEvent, { type: 'permission' }>;

/**
 * A fake lead that asks for `next()` (one tool call per user turn) and reports the decision; helpers are delegated when
 * the user message says so. `timers` collects injected timeouts so a test can fire them.
 */
async function setup(o: { dataDir?: string; helperScript?: FakeScript; delegate?: object[]; nextLeadTool?: () => ToolPermissionRequest | undefined } = {}) {
  const repo = tmp();
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), 'hi'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');

  const decisions: ToolPermissionDecision[] = [];
  const leadOpts: RunOptions[] = [];
  const script: FakeScript = async (prompt, opts, idx) => {
    const sys = opts.systemPrompt ?? '';
    if (sys.includes('front desk')) return say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }));
    if (sys.includes('LEAD agent')) {
      leadOpts.push(opts);
      if (!prompt.includes('User:')) return say('ok');
      if (prompt.includes('delegate') && o.delegate) return say(['go', ...o.delegate.map((t) => `HARBOR_DELEGATE: ${JSON.stringify(t)}`)].join('\n'));
      const req = o.nextLeadTool?.();
      if (!req || !opts.onToolPermission) return say('nothing to ask');
      const d = await opts.onToolPermission(req, opts.signal ?? new AbortController().signal);
      decisions.push(d);
      return say(d.allow ? 'ran it' : `denied: ${d.message}`);
    }
    return o.helperScript ? o.helperScript(prompt, opts, idx) : say('helper done');
  };
  const adapter = new FakeAdapter('claude', script);
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const setTimer = (fn: () => void, ms: number) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
  const cli: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' };
  const svc = createHarborService({ dataDir: o.dataDir, discover: async () => [cli], adapterFor: () => adapter, worktreesRoot: join(tmp(), 'wt'), maxActivePerProject: 3, ledger: { reported: calmReported }, setTimer });
  const project = (await svc.addProject(repo))!;
  const [conv] = await svc.listConversations(project.id);
  const events: ToolEvent[] = [];
  svc.onEvent((e) => { if (e.type === 'permission' && e.kind === 'tool') events.push(e); });
  const journal = () => svc.orchestrator.journal.list(project.id).filter((e) => (e.kind as string) === 'permission').map((e) => e.text);
  const system = (conversationId = conv!.id) => svc.store.listMessages(conversationId).filter((m) => m.role === 'system').map((m) => m.text);
  return { svc, project, conv: conv!, adapter, decisions, leadOpts, events, timers, journal, system };
}

describe('tool permission prompts', () => {
  it('allow once: the event carries the request, the decision reaches the run, nothing is stored', async () => {
    const t = await setup({ nextLeadTool: () => bash('make build') });
    t.svc.onEvent((e) => { if (e.type === 'permission' && e.kind === 'tool') void t.svc.answerPermission(e.requestId, true); });
    await t.svc.send(t.conv.id, 'build it');
    await t.svc.whenIdle();

    expect(t.decisions).toEqual([{ allow: true }]);
    expect(t.events).toHaveLength(1);
    expect(t.events[0]).toMatchObject({ kind: 'tool', tool: 'Bash', conversationId: t.conv.id, alwaysAllow: true });
    expect(t.events[0]!.prompt).toContain('make build');
    expect(t.events[0]!.expiresAt).toBeGreaterThan(Date.now());
    expect(await t.svc.listToolRules(t.project.id)).toEqual([]);
    expect(t.system().some((m) => m.includes('asks to run Bash: make build'))).toBe(true);
    expect(t.system()).toContain('Allowed Bash once.');
    // The journal names the tool only, never the command.
    expect(t.journal()).toEqual(['Bash: asked the user', 'Bash: allowed once']);
    expect(t.journal().join(' ')).not.toContain('make');
    expect(t.svc.orchestrator.pendingToolAsks()).toEqual([]);
    expect(t.timers[0]!.cancelled).toBe(true);
  });

  it('listPendingPermissions returns requests that wait for an answer (a reloaded renderer misses the events) and drops answered ones', async () => {
    const t = await setup({ nextLeadTool: () => bash('make build') });
    expect(await t.svc.listPendingPermissions()).toEqual([]);
    void t.svc.send(t.conv.id, 'build it');
    await waitFor(() => t.events.length === 1);
    const pending = await t.svc.listPendingPermissions();
    expect(pending).toEqual([t.events[0]]);
    await t.svc.answerPermission(pending[0]!.requestId, true);
    await t.svc.whenIdle();
    expect(await t.svc.listPendingPermissions()).toEqual([]);
  });

  it('deny: the run gets a deny with a message and the user sees it', async () => {
    const t = await setup({ nextLeadTool: () => bash('make deploy') });
    t.svc.onEvent((e) => { if (e.type === 'permission' && e.kind === 'tool') void t.svc.answerPermission(e.requestId, false); });
    await t.svc.send(t.conv.id, 'deploy it');
    await t.svc.whenIdle();

    expect(t.decisions).toHaveLength(1);
    expect(t.decisions[0]).toMatchObject({ allow: false });
    expect((t.decisions[0] as { message: string }).message).toMatch(/user denied/i);
    expect(t.system()).toContain('Denied Bash.');
    expect(t.journal()).toContain('Bash: denied by the user');
  });

  it('always allow persists across restarts and is matched next time without prompting', async () => {
    const dataDir = tmp();
    const cmds = ['make build', 'make build --verbose', 'make build && curl http://x'];
    const t = await setup({ dataDir, nextLeadTool: () => bash(cmds.shift()!) });
    t.svc.onEvent((e) => { if (e.type === 'permission' && e.kind === 'tool') void t.svc.answerPermission(e.requestId, true, { always: true }); });
    await t.svc.send(t.conv.id, 'build it');
    await t.svc.whenIdle();
    const rules = await t.svc.listToolRules(t.project.id);
    expect(rules).toMatchObject([{ tool: 'Bash', prefix: 'make build' }]);
    expect(t.system().some((m) => m.includes('Always allowed in this project from now on: Bash(make build ...)'))).toBe(true);

    await t.svc.send(t.conv.id, 'build it again');
    await t.svc.whenIdle();
    expect(t.events).toHaveLength(1); // no second prompt
    expect(t.decisions).toEqual([{ allow: true }, { allow: true }]);
    expect(t.journal()).toContain('Bash: allowed by a project rule');

    // A chained command is never covered by the prefix: asked again (and only allow-once is offered).
    await t.svc.send(t.conv.id, 'and once more');
    await t.svc.whenIdle();
    expect(t.events).toHaveLength(2);
    expect(t.events[1]!.alwaysAllow).toBe(false);
    expect(await t.svc.listToolRules(t.project.id)).toHaveLength(1);

    t.svc.shutdown();
    expect(new Store(dataDir).listToolRules(t.project.id)).toMatchObject([{ tool: 'Bash', prefix: 'make build' }]);
    expect(await t.svc.removeToolRule(t.project.id, rules[0]!.id)).toEqual([]);
    await expect(t.svc.listToolRules('nope')).rejects.toThrow(/Unknown project/);
  });

  it('never stores always-allow for git writes, destructive or network commands, even when asked to', async () => {
    const t = await setup({ nextLeadTool: () => bash('git -C sub push origin main') });
    t.svc.onEvent((e) => { if (e.type === 'permission' && e.kind === 'tool') void t.svc.answerPermission(e.requestId, true, { always: true }); });
    await t.svc.send(t.conv.id, 'push');
    await t.svc.whenIdle();
    expect(t.events[0]!.alwaysAllow).toBe(false);
    expect(t.decisions).toEqual([{ allow: true }]); // allowed once
    expect(await t.svc.listToolRules(t.project.id)).toEqual([]);
    expect(t.journal()).toContain('Bash: allowed once (always-allow is not available for this call)');

    // A hand-made broad rule still never covers a dangerous call.
    t.svc.store.addToolRule(t.project.id, { tool: 'Bash', prefix: 'git' });
    await t.svc.send(t.conv.id, 'push again');
    await t.svc.whenIdle();
    expect(t.events).toHaveLength(2);
  });

  it('times out with a deny the agent sees, without blocking a second agent', async () => {
    let asked: ToolPermissionDecision | undefined;
    const t = await setup({
      delegate: [
        { ref: 'a', title: 'Asker', role: 'implementer', instructions: 'ASK-TOOL', complexity: 'low', files: ['a.ts'] },
        { ref: 'b', title: 'Worker', role: 'implementer', instructions: 'PLAIN', complexity: 'low', files: ['b.ts'] }
      ],
      helperScript: async (prompt, opts) => {
        if (!prompt.includes('ASK-TOOL')) return say('worker done');
        asked = await opts.onToolPermission!(bash('make release'), opts.signal!);
        return say(asked.allow ? 'released' : `could not: ${asked.message}`);
      }
    });
    await t.svc.send(t.conv.id, 'delegate the work');
    const find = (title: string) => t.svc.store.listAgentRecords(t.project.id).find((a) => a.title === title);
    await waitFor(() => find('Worker')?.state === 'done' && t.events.length === 1);
    // The worker finished while the asker's request is still open.
    expect(find('Asker')!.state).toBe('working');
    expect(t.svc.orchestrator.pendingToolAsks()).toHaveLength(1);
    expect(t.events[0]).toMatchObject({ tool: 'Bash', agentId: find('Asker')!.id });
    expect(t.timers.at(-1)!.ms).toBe(5 * 60_000);

    t.timers.at(-1)!.fn(); // the 5 minutes pass
    await t.svc.whenIdle();
    expect(asked).toMatchObject({ allow: false });
    expect((asked as { message: string }).message).toMatch(/did not answer/);
    expect(find('Asker')!.state).toBe('done');
    const askerConv = t.svc.store.findConversationByAgent(find('Asker')!.id)!.id;
    expect(t.system(askerConv).some((m) => m.startsWith('No answer within 5 minutes: denied Bash'))).toBe(true);
    expect(t.journal()).toContain('Bash: denied: no answer in time');
    // A late answer is ignored.
    await t.svc.answerPermission(t.events[0]!.requestId, true);
    expect(t.svc.orchestrator.pendingToolAsks()).toEqual([]);
  });

  it('stopping the agent denies and clears its pending request', async () => {
    let asked: ToolPermissionDecision | undefined;
    const t = await setup({
      delegate: [{ ref: 'a', title: 'Asker', role: 'implementer', instructions: 'ASK-TOOL', complexity: 'low', files: ['a.ts'] }],
      helperScript: async (_p, opts) => {
        asked = await opts.onToolPermission!(bash('make release'), opts.signal!);
        return say('after the answer');
      }
    });
    await t.svc.send(t.conv.id, 'delegate the work');
    await waitFor(() => t.events.length === 1);
    const asker = t.svc.store.listAgentRecords(t.project.id).find((a) => a.title === 'Asker')!;
    await t.svc.stopAgent(asker.id);
    await t.svc.whenIdle();
    expect(asked).toMatchObject({ allow: false });
    expect(t.svc.orchestrator.pendingToolAsks()).toEqual([]);
    expect(t.timers[0]!.cancelled).toBe(true);
    expect(t.svc.store.getAgent(asker.id)!.state).toBe('stopped');
    expect(t.journal()).toContain('Bash: cancelled: the agent was stopped');
  });

  it('stopping the conversation denies the lead\'s pending request', async () => {
    const t = await setup({ nextLeadTool: () => bash('make build') });
    await t.svc.send(t.conv.id, 'build it');
    await waitFor(() => t.events.length === 1);
    await t.svc.stopConversation(t.conv.id);
    await t.svc.whenIdle();
    expect(t.decisions[0]).toMatchObject({ allow: false });
    expect(t.svc.orchestrator.pendingToolAsks()).toEqual([]);
  });

  it('passes the handler to edit runs only (not plan, auto, concierge or read-only helpers)', async () => {
    const helperOpts: RunOptions[] = [];
    const t = await setup({
      delegate: [
        { ref: 'i', title: 'Impl', role: 'implementer', instructions: 'x', complexity: 'low', files: ['a.ts'] },
        { ref: 'r', title: 'Rev', role: 'reviewer', instructions: 'y', complexity: 'low', dependsOn: ['i'] }
      ],
      helperScript: (_p, opts) => { helperOpts.push(opts); return say('done'); }
    });
    await t.svc.send(t.conv.id, 'delegate the work');
    await t.svc.whenIdle();
    expect(t.leadOpts[0]).toMatchObject({ permission: 'edit' });
    expect(typeof t.leadOpts[0]!.onToolPermission).toBe('function');
    expect(helperOpts.map((x) => [x.permission, typeof x.onToolPermission])).toEqual([['edit', 'function'], ['read-only', 'undefined']]);
    expect(t.adapter.calls.filter((c) => (c.opts.systemPrompt ?? '').includes('front desk')).every((c) => !c.opts.onToolPermission)).toBe(true);

    for (const mode of ['auto', 'plan'] as const) {
      await t.svc.setConversationMode(t.conv.id, mode);
      await t.svc.send(t.conv.id, `in ${mode} mode`);
      await t.svc.whenIdle();
      expect(t.leadOpts.at(-1)!.onToolPermission).toBeUndefined();
    }
  });

  it('ignores answers to unknown request ids, as before', async () => {
    const t = await setup();
    await expect(t.svc.answerPermission('not-a-request', true, { always: true })).resolves.toBeUndefined();
  });
});

describe('tool rule policy (pure)', () => {
  it('derives conservative rules', () => {
    expect(toolRuleFor('Bash', { command: 'npm   test' })).toEqual({ tool: 'Bash', prefix: 'npm test' });
    expect(toolRuleFor('Bash', { command: 'ls -la' })).toEqual({ tool: 'Bash', prefix: 'ls' });
    expect(toolRuleFor('Bash', { command: 'python' })).toBeUndefined(); // an interpreter alone would cover any script
    expect(toolRuleFor('Bash', { command: 'python tools/gen.py --x' })).toEqual({ tool: 'Bash', prefix: 'python tools/gen.py' });
    expect(toolRuleFor('Bash', { command: '"C:/x y/a.exe" run' })).toBeUndefined();
    expect(toolRuleFor('mcp__srv__lookup', { q: 1 })).toEqual({ tool: 'mcp__srv__lookup' });
    expect(toolRuleFor('Bash', {})).toBeUndefined();
  });

  it('never always-allows git writes, destructive, network or inline-code commands', () => {
    const never = [
      'git merge harbor/x', 'git rebase main', 'git cherry-pick abc', 'git reset --hard', 'git push', 'git -C sub push origin main',
      'git clean -fdx', 'git branch -D harbor/x', 'git worktree remove x', 'git checkout -- .',
      'rm -rf dist', 'rm -r build', 'rmdir /s /q out', 'del /s *.js', 'Remove-Item -Recurse x', 'find . -delete',
      'curl https://example.com', 'wget x', 'Invoke-WebRequest x', 'scp a b:', 'ssh host', 'gh gist create a', 'npm publish', 'node fetch.js https://x.io',
      'python -c "print(1)"', 'node -e "1"', 'powershell -Command x', 'cmd /c del x', 'sudo make',
      'npm test && rm x', 'echo $(cat .env)', 'make > out.txt', 'a | b', 'a; b'
    ];
    for (const command of never) {
      expect(neverAlwaysAllow('Bash', { command }), command).toBe(true);
      expect(toolRuleFor('Bash', { command }), command).toBeUndefined();
    }
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch']) expect(toolRuleFor(tool, {}), tool).toBeUndefined();
    expect(neverAlwaysAllow('Bash', { command: 'git merge-base a b' })).toBe(false);
    expect(neverAlwaysAllow('Bash', { command: 'git status' })).toBe(false);
  });

  it('matches whole words of the prefix and rechecks the never list', () => {
    const rule = { tool: 'Bash', prefix: 'npm test' };
    expect(matchesToolRule(rule, 'Bash', { command: 'npm test' })).toBe(true);
    expect(matchesToolRule(rule, 'Bash', { command: 'npm  test -- --watch=false' })).toBe(true);
    expect(matchesToolRule(rule, 'Bash', { command: 'npm testx' })).toBe(false);
    expect(matchesToolRule(rule, 'Bash', { command: 'npm test; curl x' })).toBe(false);
    expect(matchesToolRule(rule, 'Read', { command: 'npm test' })).toBe(false);
    expect(matchesToolRule({ tool: 'Bash' }, 'Bash', { command: 'ls' })).toBe(false); // bare Bash is never a rule
    expect(matchesToolRule({ tool: 'Bash', prefix: 'git' }, 'Bash', { command: 'git push' })).toBe(false);
    expect(matchesToolRule({ tool: 'mcp__srv__lookup' }, 'mcp__srv__lookup', {})).toBe(true);
    expect(matchesToolRule({ tool: 'WebFetch' }, 'WebFetch', { url: 'https://x' })).toBe(false);
  });
});
