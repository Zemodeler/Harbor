import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chunk, ToolPermissionDecision } from '../src/main/adapters/types';
import { minimalEnv } from '../src/main/checks';
import { NETWORK_RETRY_DELAYS_MS, OVERLOAD_RETRY_DELAY_MS, isTransientCliError, transientKind } from '../src/main/orchestrator';
import { Store } from '../src/main/store';
import { UsageLedger } from '../src/main/usage';
import { delegate, git, gitRepo, harness, isHelper, result, say, script, tmp, until } from './hardeningHarness';

// Wave 2: runtime reliability (transient errors, completion, fallback notes, watchdog, restart, permissions, usage, sessions, paging).

afterEach(() => { vi.restoreAllMocks(); });

const impl = (ref: string, over: Record<string, unknown> = {}) => ({ ref, title: `Write ${ref}`, role: 'implementer', instructions: `write ${ref}`, complexity: 'low', ...over });
const done = (summary = 'Done.') => `Done\n${result({ outcome: 'done', summary, checks: [] })}`;
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const fail = (error: string, rateLimited = false): Chunk[] => [{ kind: 'done', ok: false, error, rateLimited }];
/** Fires every injected wait at once, recording what was asked for. */
const instant = () => { const waits: number[] = []; return { waits, setTimer: (fn: () => void, ms: number) => { waits.push(ms); queueMicrotask(fn); return () => {}; } }; };

describe('which errors are transient', () => {
  it('knows the OAuth race and connection trouble, and nothing else', () => {
    expect(transientKind('Failed to refresh OAuth token')).toBe('oauth');
    for (const e of ['read ECONNRESET', 'getaddrinfo ENOTFOUND api.anthropic.com', 'connect ETIMEDOUT 1.2.3.4:443', 'Connection error.', 'Reconnecting... 2/5', 'network error while streaming']) expect(transientKind(e), e).toBe('network');
    for (const e of ['Not logged in', 'rate limit exceeded', 'model not found', 'exited with code 1', undefined]) expect(isTransientCliError(e), String(e)).toBe(false);
  });
});

describe('connection errors and overload', () => {
  it('retries the same CLI with backoff and does not exclude it', async () => {
    const t = instant();
    let calls = 0;
    const h = await harness({ claude: script({ concierge: () => (calls++ === 0 ? fail('read ECONNRESET') : say(JSON.stringify({ answer: 'back again' }))) }), codex: () => say(JSON.stringify({ answer: 'from codex' })) },
      { ids: ['claude', 'codex'], service: { setTimer: t.setTimer } });
    await h.svc.send(h.conv.id, 'good morning');
    await h.svc.whenIdle();
    expect(await h.texts()).toContain('back again');
    expect(h.adapters.codex!.calls).toHaveLength(0);
    expect(t.waits).toContain(NETWORK_RETRY_DELAYS_MS[0]);
    expect((await h.texts()).some((x) => x.includes('Falling back'))).toBe(false);
  });

  it('retries a busy provider once, then falls back, and holds nothing against the model', async () => {
    const t = instant();
    const h = await harness({ claude: script({ concierge: () => fail('API Error: 529 overloaded_error', true) }), codex: () => say(JSON.stringify({ answer: 'from codex' })) },
      { ids: ['claude', 'codex'], service: { setTimer: t.setTimer } });
    await h.svc.send(h.conv.id, 'good morning');
    await h.svc.whenIdle();
    expect(h.adapters.claude!.calls).toHaveLength(2); // the run and its single retry
    expect(t.waits).toContain(OVERLOAD_RETRY_DELAY_MS);
    expect(await h.texts()).toContain('from codex');
    expect(h.svc.store.listUsage().some((u) => u.rateLimited)).toBe(false); // no 30-minute cooldown
  });

  it('a real rate limit is still recorded against the model', async () => {
    const h = await harness({ claude: script({ concierge: () => fail('Claude usage limit reached', true) }), codex: () => say(JSON.stringify({ answer: 'from codex' })) }, { ids: ['claude', 'codex'] });
    await h.svc.send(h.conv.id, 'good morning');
    await h.svc.whenIdle();
    expect(h.svc.store.listUsage().filter((u) => u.rateLimited).length).toBeGreaterThan(0);
  });
});

describe('a CLI that ends without a completion event', () => {
  it('counts exit code 0 after real output as finished, with a visible warning and no fallback', async () => {
    const h = await harness({ claude: script({ concierge: () => [{ kind: 'text', text: JSON.stringify({ answer: 'all finished' }) }, { kind: 'done', ok: false, error: 'exited with code 0', exitCode: 0 }] }), codex: () => say(JSON.stringify({ answer: 'from codex' })) }, { ids: ['claude', 'codex'] });
    await h.svc.send(h.conv.id, 'good morning');
    await h.svc.whenIdle();
    const texts = await h.texts();
    expect(texts).toContain('all finished');
    expect(texts.some((x) => x.includes('ended without a completion event'))).toBe(true);
    expect(h.adapters.codex!.calls).toHaveLength(0);
  });

  it('does not excuse a silent exit 0, or a non-zero exit', async () => {
    const h = await harness({ claude: script({ concierge: () => [{ kind: 'done', ok: false, error: 'exited with code 0', exitCode: 0 }] }), codex: () => say(JSON.stringify({ answer: 'from codex' })) }, { ids: ['claude', 'codex'] });
    await h.svc.send(h.conv.id, 'good morning');
    await h.svc.whenIdle();
    expect(await h.texts()).toContain('from codex');
  });
});

describe('a fallback after an edit run that already started', () => {
  it('is told what the first attempt left, instead of repeating blindly', async () => {
    let n = 0;
    const attempt = (_p: string, o: { cwd: string }): Chunk[] => {
      if (n++ === 0) { writeFileSync(join(o.cwd, 'half.txt'), 'half done'); return [{ kind: 'text', text: 'I created half.txt and then' }, { kind: 'done', ok: false, error: 'the model crashed' }]; }
      return say(done());
    };
    const lead = (p: string) => (p.includes('User:') ? delegate('go', impl('a')) : say('ok'));
    const h = await harness({ claude: script({ lead, helper: attempt }), codex: script({ lead, helper: attempt }) }, { ids: ['claude', 'codex'] });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    const helperCalls = [...h.calls(isHelper, 'claude'), ...h.calls(isHelper, 'codex')];
    expect(helperCalls).toHaveLength(2);
    const [first, second] = helperCalls;
    expect(first!.prompt).not.toContain('Harbor note');
    expect(second!.prompt).toContain('Harbor note: an earlier attempt');
    expect(second!.prompt).toContain('half.txt'); // git status --short
    expect(second!.prompt).toContain('I created half.txt and then'); // what was said so far
    expect(h.helper('Write a').state).toBe('done');
  });
});

describe('restart', () => {
  it('stops interrupted helpers once, commits their work, and tells each conversation in one summary', async () => {
    const h = await harness({ claude: script({ lead: (p) => (p.includes('User:') ? delegate('go', impl('a'), impl('b')) : say('ok')), helper: () => say(done()) }) });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    const a = h.helper('Write a'), b = h.helper('Write b');
    // Pretend Harbor died while both ran, with uncommitted work in the first one's worktree.
    writeFileSync(join(a.worktree!, 'unsaved.txt'), 'work in progress');
    for (const x of [a, b]) h.svc.store.patchAgent(x.id, { state: 'working', error: undefined });
    h.svc.orchestrator.recover();
    await h.svc.whenIdle();
    const summaries = (await h.texts()).filter((t) => t.startsWith('Harbor restarted while 2 helper(s) were running'));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain('Write a');
    expect(h.helper('Write a').state).toBe('stopped');
    expect(git(a.worktree!, 'ls-tree', '-r', '--name-only', 'HEAD')).toContain('unsaved.txt');
  });
});

describe('stall watchdog and run limits', () => {
  const manualTimers = () => {
    const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    let now = 1_000_000;
    return { timers, now: () => now, advance: (ms: number) => { now += ms; }, setTimer: (fn: () => void, ms: number) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; } };
  };

  it('flags a silent run as possibly stuck once, and clears it when output resumes', async () => {
    const m = manualTimers();
    const g = gate();
    let started = false;
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('a')) : say('ok')),
      helper: async () => { started = true; await g.p; return say(done()); }
    }) }, { service: { stall: { stallMs: 600_000, helperCapMs: 2_700_000, leadCapMs: 3_600_000, setTimer: m.setTimer, now: m.now } } });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await until(() => started);
    m.advance(11 * 60_000);
    for (const t of m.timers.filter((x) => !x.cancelled && x.ms === 600_000)) t.fn();
    const a = h.helper('Write a');
    expect(a.summary).toBe('possibly stuck');
    expect((await h.texts()).filter((t) => t.includes('may be stuck') && t.includes('Use Stop'))).toHaveLength(1);
    g.open();
    await h.svc.whenIdle();
    expect(h.helper('Write a').state).toBe('done');
    expect(h.helper('Write a').summary).not.toBe('possibly stuck');
  });

  // Phase 4: a run stopped at its hard limit is resumed ONCE automatically from its saved session, to finish and report (was: left
  // stopped for the user to resume). `helperCapMs` is the hard limit; the second cap stop and the lead wake are in phase4Wake.test.ts.
  it('stops a run at its hard limit and resumes it once from its saved session to finish', async () => {
    const m = manualTimers();
    const g = gate();
    let started = false, calls = 0;
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('a')) : say('ok')),
      helper: async () => { calls++; if (calls === 1) { started = true; await g.p; } return say(done()); }
    }) }, { service: { stall: { stallMs: 600_000, helperCapMs: 2_700_000, leadCapMs: 3_600_000, setTimer: m.setTimer, now: m.now } } });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await until(() => started);
    for (const t of m.timers.filter((x) => !x.cancelled && x.ms === 2_700_000)) t.fn();
    g.open();
    await h.svc.whenIdle();
    const a = h.helper('Write a');
    expect(a.state).toBe('done');
    expect(a.capResumes).toBe(1);
    const helperCalls = h.calls(isHelper);
    expect(helperCalls).toHaveLength(2);
    expect(helperCalls[1]!.prompt).toContain('Harbor stopped your run at its time limit');
    expect(helperCalls[1]!.opts.resumeId).toBeTruthy(); // its own saved session
    expect((await h.texts()).some((t) => t.includes('hard limit of 45 minutes') && t.includes('resumes it once'))).toBe(true);
  });
});

describe('permission requests after sleep', () => {
  it('are re-armed against their wall-clock deadline, and denied when it passed', async () => {
    const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    const setTimer = (fn: () => void, ms: number) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
    let decision: ToolPermissionDecision | undefined;
    const h = await harness({ claude: script({
      lead: async (_p, o) => { decision = await o.onToolPermission!({ tool: 'Bash', input: { command: 'npm test' } }, o.signal ?? new AbortController().signal); return say('ok'); }
    }) }, { service: { setTimer, toolPermissionTimeoutMs: 300_000 } });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await until(async () => (await h.svc.listPendingPermissions()).length === 1);
    const armed = timers.filter((t) => !t.cancelled && t.ms === 300_000);
    expect(armed).toHaveLength(1);
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 100_000); // woke 100 s later: the timer may have stalled
    h.svc.onResume();
    expect(armed[0]!.cancelled).toBe(true);
    const rearmed = timers.filter((t) => !t.cancelled && t.ms < 300_000);
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0]!.ms).toBeGreaterThan(150_000);
    expect(rearmed[0]!.ms).toBeLessThanOrEqual(200_000);
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 400_000); // slept past the deadline
    h.svc.onResume();
    await h.svc.whenIdle();
    expect(decision).toMatchObject({ allow: false });
    expect(await h.svc.listPendingPermissions()).toEqual([]);
  });
});

describe('the usage ledger and spawn failures', () => {
  it('does not count a CLI that could not be started (missing binary, unsupported flag)', async () => {
    const h = await harness({ claude: script({ concierge: () => fail('spawn /fake/claude ENOENT') }), codex: () => fail("error: unknown option '--effort'") }, { ids: ['claude', 'codex'] });
    await h.svc.send(h.conv.id, 'good morning');
    await h.svc.whenIdle();
    expect(h.svc.store.listUsage()).toHaveLength(0);
    // An ordinary failure after output still counts.
    const h2 = await harness({ claude: script({ concierge: () => [{ kind: 'text', text: 'working' }, { kind: 'done', ok: false, error: 'boom' }] }) });
    await h2.svc.send(h2.conv.id, 'good morning');
    await h2.svc.whenIdle();
    expect(h2.svc.store.listUsage().length).toBeGreaterThan(0);
  });

  it('counts only runs after a reset the CLI reported, so a window that already reset is not a lockout', () => {
    const now = 10 * 3_600_000;
    const store = new Store();
    const ledger = new UsageLedger(store, { now: () => now, runsPerWindow: { default: 10 } });
    const rec = (minutesAgo: number, extra: object = {}) => ledger.record({ cli: 'claude', model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, time: now - minutesAgo * 60_000, ...extra });
    for (let i = 0; i < 10; i++) rec(120 - i); // a full window of runs, two hours ago
    expect(ledger.pressure('claude', 'm').level).toBe('exhausted');
    // The CLI reported (during a run) that this window resets at 60 minutes ago: that moment is already behind us.
    rec(100, { limits: [{ period: 'session', usedPct: 100, resetsAt: now - 60 * 60_000, asOf: now - 100 * 60_000 }] });
    rec(10); rec(5);
    const p = ledger.pressure('claude', 'm');
    expect(p.level).toBe('plenty');
    expect(p.pct).toBe(20); // only the two runs since the reset
  });

  it('a rate limit hit before a reset the CLI has since reported no longer holds the CLI out', () => {
    const now = 10 * 3_600_000;
    const store = new Store();
    const ledger = new UsageLedger(store, { now: () => now });
    ledger.record({ cli: 'claude', model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: false, rateLimited: true, time: now - 20 * 60_000 });
    expect(ledger.cooldownUntil('claude', 'm')).toBeDefined();
    ledger.record({ cli: 'claude', model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, time: now - 15 * 60_000, limits: [{ period: 'session', usedPct: 10, resetsAt: now - 10 * 60_000, asOf: now - 15 * 60_000 }] });
    expect(ledger.cooldownUntil('claude', 'm')).toBeUndefined();
  });
});

describe('one session link per CLI', () => {
  it('keeps the session of the CLI that was left when a fallback runs elsewhere', async () => {
    const h = await harness({ claude: script({ concierge: () => fail('model exploded') }), codex: () => say(JSON.stringify({ answer: 'from codex' })) }, { ids: ['claude', 'codex'] });
    await h.svc.send(h.conv.id, 'good morning');
    await h.svc.whenIdle();
    const key = `concierge:${h.conv.id}`;
    expect(h.svc.store.getSession(key, 'claude')).toBeDefined(); // the failed attempt's session is not destroyed
    expect(h.svc.store.getSession(key, 'codex')).toBeDefined();
    expect(h.svc.store.getSession(key)!.cli).toBe('codex'); // without a CLI: the newest link
  });

  it('store: set replaces only the same CLI, clear removes all, and an old file with one link per key still loads', () => {
    const s = new Store();
    s.setSession({ agentId: 'k', cli: 'claude', sessionId: 'c1', updated: 1 });
    s.setSession({ agentId: 'k', cli: 'codex', sessionId: 'x1', updated: 2 });
    s.setSession({ agentId: 'k', cli: 'claude', sessionId: 'c2', updated: 3 });
    expect(s.getSession('k', 'claude')!.sessionId).toBe('c2');
    expect(s.getSession('k', 'codex')!.sessionId).toBe('x1');
    expect(s.getSession('k')!.sessionId).toBe('c2');
    s.clearSession('k');
    expect(s.getSession('k')).toBeUndefined();
    const dir = tmp();
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, sessions: [{ agentId: 'old', cli: 'claude', sessionId: 's', updated: 5 }] }));
    const old = new Store(dir);
    expect(old.getSession('old')!.sessionId).toBe('s');
    expect(old.getSession('old', 'claude')!.sessionId).toBe('s');
    expect(old.getSession('old', 'codex')).toBeUndefined();
  });
});

describe('minimal environment for checks', () => {
  it('keeps tool lookup and temp folders, drops credentials and Harbor\'s own settings', () => {
    const env = minimalEnv({ PATH: '/bin', Path: 'C:\\x', SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', GITHUB_TOKEN: 't',
      npm_config_registry: 'https://r', npm_config__authToken: 'secret', NODE_OPTIONS: '--max-old-space-size=4096', HARBOR_ANYTHING: '1', AWS_SECRET_ACCESS_KEY: 's' });
    expect(Object.keys(env).sort()).toEqual(['NODE_OPTIONS', 'PATH', 'Path', 'SystemRoot', 'TEMP', 'npm_config_registry']);
  });
});

describe('startup notices and paging', () => {
  it('an unreadable state file shows up in the diagnostics', async () => {
    const dir = tmp('harbor-data-');
    writeFileSync(join(dir, 'state.json'), '{ this is not json');
    const { createHarborService } = await import('../src/main/service');
    const svc = createHarborService({ dataDir: dir, discover: async () => [] });
    const text = await svc.exportDiagnostics();
    expect(text).toMatch(/could not be read/);
    await svc.shutdown();
  });

  it('pages messages and the git log through the service', async () => {
    const repo = gitRepo();
    for (let i = 0; i < 3; i++) { writeFileSync(join(repo, `f${i}.txt`), String(i)); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', `c${i}`); }
    const h = await harness({ claude: script({ concierge: () => say(JSON.stringify({ answer: 'hi' })) }) }, { git: repo });
    for (const t of ['one', 'two', 'three']) { await h.svc.send(h.conv.id, t); await h.svc.whenIdle(); }
    const all = await h.svc.listMessages(h.conv.id);
    expect(all.length).toBe(6);
    const last = await h.svc.listMessages(h.conv.id, { limit: 2 });
    expect(last.map((m) => m.id)).toEqual(all.slice(-2).map((m) => m.id));
    const before = await h.svc.listMessages(h.conv.id, { before: last[0]!.id, limit: 2 });
    expect(before.map((m) => m.id)).toEqual(all.slice(-4, -2).map((m) => m.id));
    await expect(h.svc.listMessages(h.conv.id, { limit: 'x' as unknown as number })).rejects.toThrow(/Invalid paging/);

    const page1 = await h.svc.getGitLogPage(h.project.id, { limit: 2 });
    expect(page1.commits).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    const page2 = await h.svc.getGitLogPage(h.project.id, { limit: 2, skip: 2 });
    expect(page2.commits).toHaveLength(2);
    expect(page2.hasMore).toBe(false);
    expect((await h.svc.getGitLog(h.project.id, { limit: 10, skip: 3 })).map((c) => c.subject)).toEqual(['init']);
  });
});
