import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { DEFAULT_CATALOG, loadCatalog } from '../src/main/clis/capabilities';
import { Git } from '../src/main/git';
import { LockTable, WHOLE_PROJECT } from '../src/main/locks';
import { route, type RouteRequest } from '../src/main/router';
import { Store } from '../src/main/store';
import { COOLDOWN_MS, FreeResetCoordinator, UsageLedger, WINDOW_MS } from '../src/main/usage';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-core-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const cli = (id: string, over: Partial<ResolvedCli> = {}): ResolvedCli =>
  ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'], ...over });

function ledgerAt(t: { now: number }, budget = 10) {
  const store = new Store();
  const ledger = new UsageLedger(store, { now: () => t.now, runsPerWindow: { default: budget } });
  const run = (c: string, extra = {}) => ledger.record({ cli: c, model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, ...extra });
  return { store, ledger, run };
}

describe('usage ledger', () => {
  it('counts runs in a rolling window and derives levels', () => {
    const t = { now: 1_000_000 };
    const { ledger, run } = ledgerAt(t, 10);
    expect(ledger.level('claude')).toBe('plenty');
    for (let i = 0; i < 6; i++) run('claude');
    expect(ledger.usedPct('claude')).toBe(60);
    expect(ledger.level('claude')).toBe('limited');
    for (let i = 0; i < 3; i++) run('claude');
    expect(ledger.level('claude')).toBe('low');
    t.now += WINDOW_MS + 1; // old events fall out of the window
    expect(ledger.windows(['claude'])[0].usedPct).toBe(0); // the 5h window rolled over; the weekly one still remembers the runs
    expect(ledger.level('claude')).toBe('plenty');
  });

  it('rate limit forces exhausted until cooldown passes, and labels it honestly', () => {
    const t = { now: 5_000_000 };
    const { ledger, run } = ledgerAt(t);
    run('codex', { ok: false, rateLimited: true });
    expect(ledger.level('codex')).toBe('exhausted');
    const w = ledger.windows(['codex'])[0];
    expect(w.usedPct).toBe(100);
    expect(w.label).toMatch(/reported by the CLI/);
    expect(w.freeResetAvailable).toBeUndefined();
    t.now += COOLDOWN_MS + 1;
    expect(ledger.level('codex')).not.toBe('exhausted');
  });

  it('windows() are labelled as Harbor-only estimates', () => {
    const t = { now: 1 };
    const { ledger, run } = ledgerAt(t);
    run('claude');
    expect(ledger.windows(['claude'])[0].label).toMatch(/estimated from Harbor runs only/);
  });
});

describe('free reset', () => {
  function setup(opts: { entitlement: boolean; allow?: 'ask' | 'never'; backlog?: number; budget?: number }) {
    const t = { now: 10_000_000 };
    const store = new Store();
    const ledger = new UsageLedger(store, { now: () => t.now, runsPerWindow: { default: opts.budget ?? 2 }, entitlement: () => opts.entitlement });
    for (let i = 0; i < 2; i++) ledger.record({ cli: 'claude', model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true });
    const asked: string[] = [];
    let answer = true;
    const c = new FreeResetCoordinator({
      ledger, store, now: () => t.now, backlog: () => opts.backlog ?? 3, allow: () => opts.allow ?? 'ask',
      ask: async (p) => { asked.push(p); return answer; }, perform: async () => 'done'
    });
    return { c, asked, store, setAnswer: (a: boolean) => { answer = a; }, t };
  }

  it('never offers without a confirmed entitlement', async () => {
    const s = setup({ entitlement: false });
    expect(await s.c.maybePropose('claude')).toBe('not-offered');
    expect(s.asked).toHaveLength(0);
  });
  it('never offers when the user set never, or there is no backlog', async () => {
    expect(await setup({ entitlement: true, allow: 'never' }).c.maybePropose('claude')).toBe('not-offered');
    expect(await setup({ entitlement: true, backlog: 0 }).c.maybePropose('claude')).toBe('not-offered');
  });
  it('asks once, performs only after approval, records it', async () => {
    const s = setup({ entitlement: true });
    expect(await s.c.maybePropose('claude')).toBe('done');
    expect(s.asked).toHaveLength(1);
    expect(s.store.listResetApprovals()[0]).toMatchObject({ cli: 'claude', approved: true });
    expect(await s.c.maybePropose('claude')).toBe('not-offered'); // no repeated prompts in the same window
  });
  it('declining does not reset and does not re-prompt', async () => {
    const s = setup({ entitlement: true });
    s.setAnswer(false);
    expect(await s.c.maybePropose('claude')).toBe('declined');
    expect(await s.c.maybePropose('claude')).toBe('not-offered');
  });
});

describe('router', () => {
  const base = (clis: ResolvedCli[], ledger: UsageLedger, extra = {}) =>
    ({ clis, ledger, enabled: () => true, hasAdapter: () => true, load: () => 0, ...extra });

  it('skips uninstalled, signed-out, adapter-less and disabled CLIs and explains why', () => {
    const { ledger } = ledgerAt({ now: 1 });
    const d = route({ role: 'implementer', complexity: 'medium' }, base([
      cli('claude'), cli('codex', { installed: false }), cli('gemini', { authState: 'signedOut', signedIn: false })
    ], ledger))!;
    expect(d.cli).toBe('claude');
    expect(d.reason).toMatch(/codex skipped: not installed/);
    expect(d.reason).toMatch(/gemini skipped: login required/);
    expect(d.model).toBe('sonnet');
    expect(d.effort).toBe('medium');
  });

  it('prefers the less used CLI and honours continuity', () => {
    const t = { now: 1 };
    const { ledger, run } = ledgerAt(t, 10);
    for (let i = 0; i < 6; i++) run('claude');
    const inp = base([cli('claude'), cli('codex')], ledger);
    expect(route({ role: 'implementer', complexity: 'low' }, inp)!.cli).toBe('codex');
    expect(route({ role: 'implementer', complexity: 'low', continuity: 'claude' }, inp)!.cli).toBe('claude');
  });

  it('honours a CLI the user asked for, and says so when it cannot', () => {
    const t = { now: 1 };
    const { ledger } = ledgerAt(t, 10);
    const inp = base([cli('claude'), cli('codex')], ledger);
    const d = route({ role: 'main', complexity: 'low', tier: 'cheap', prefer: 'codex', continuity: 'claude' }, inp)!;
    expect(d.cli).toBe('codex');
    expect(d.reason).toMatch(/codex requested by you/);
    const only = base([cli('claude'), cli('codex', { installed: false })], ledger);
    const f = route({ role: 'main', complexity: 'low', prefer: 'codex' }, only)!;
    expect(f.cli).toBe('claude');
    expect(f.reason).toMatch(/you asked for codex but it is unavailable/);
  });

  it('falls back by excluding a failed CLI; returns undefined when none left', () => {
    const { ledger } = ledgerAt({ now: 1 });
    const inp = base([cli('claude'), cli('codex')], ledger);
    expect(route({ role: 'planner', complexity: 'high', exclude: ['claude'] }, inp)!.cli).toBe('codex');
    expect(route({ role: 'planner', complexity: 'high', exclude: ['claude', 'codex'] }, inp)).toBeUndefined();
  });

  it('skips exhausted CLIs and treats unknown sign-in as usable but less preferred', () => {
    const t = { now: 1 };
    const { ledger, run } = ledgerAt(t);
    for (const model of ['haiku', 'sonnet', 'opus', 'claude-fable-5-1']) ledger.record({ cli: 'claude', model, projectId: 'p', agentId: 'a', durationMs: 1, ok: false, rateLimited: true });
    expect(route({ role: 'reviewer', complexity: 'low' }, base([cli('claude'), cli('codex', { authState: 'unknown', signedIn: false })], ledger))!.cli).toBe('codex');
    const fresh = ledgerAt({ now: 1 }).ledger;
    expect(route({ role: 'reviewer', complexity: 'low' }, base([cli('claude'), cli('codex', { authState: 'unknown', signedIn: false })], fresh))!.cli).toBe('claude');
  });

  it('a rate limit on one model leaves its siblings on the same CLI usable', () => {
    const { ledger } = ledgerAt({ now: 1 });
    ledger.record({ cli: 'claude', model: 'opus', projectId: 'p', agentId: 'a', durationMs: 1, ok: false, rateLimited: true });
    expect(ledger.pressure('claude', 'opus').level).toBe('exhausted');
    expect(ledger.pressure('claude', 'sonnet').level).toBe('plenty');
    const d = route({ role: 'implementer', complexity: 'high' }, base([cli('claude')], ledger))!;
    expect(d.model).toBe('claude-fable-5-1'); // the strong tier minus the capped Opus
    expect(d.reason).toMatch(/opus skipped/);
  });

  it('lowers effort when allowance is low, planners get stronger models', () => {
    const t = { now: 1 };
    const { ledger, run } = ledgerAt(t, 10);
    for (let i = 0; i < 8; i++) run('claude');
    const d = route({ role: 'planner', complexity: 'high' }, base([cli('claude')], ledger))!;
    expect(d.effort).toBe('medium');
    expect(d.reason).toMatch(/effort lowered/);
    expect(route({ role: 'planner', complexity: 'low' }, base([cli('claude')], ledgerAt({ now: 1 }).ledger))!.model).toBe('opus');
  });

  it('spreads parallel load', () => {
    const { ledger } = ledgerAt({ now: 1 });
    const d = route({ role: 'implementer', complexity: 'low' }, base([cli('claude'), cli('codex')], ledger, { load: (c: string) => (c === 'claude' ? 2 : 0) }))!;
    expect(d.cli).toBe('codex');
  });
});

describe('router: capability catalog', () => {
  const base = (clis: ResolvedCli[], ledger: UsageLedger, extra = {}) =>
    ({ clis, ledger, enabled: () => true, hasAdapter: () => true, load: () => 0, ...extra });

  it('maps tiers to the cheapest fitting model', () => {
    const { ledger } = ledgerAt({ now: 1 });
    const inp = base([cli('claude')], ledger);
    expect(route({ role: 'main', complexity: 'low', tier: 'cheap', effort: 'low' }, inp)!).toMatchObject({ model: 'haiku', effort: 'low' });
    expect(route({ role: 'main', complexity: 'medium', tier: 'standard' }, inp)!.model).toBe('sonnet');
    expect(route({ role: 'main', complexity: 'high', tier: 'strong', needs: ['planning'] }, inp)!.model).toBe('opus');
    expect(route({ role: 'main', complexity: 'high', tier: 'strong' }, inp)!.reason).toContain('claude/opus (strong)');
  });

  it('lets stated needs pull the choice toward a model that is good at them', () => {
    const { ledger } = ledgerAt({ now: 1 });
    const catalog = [
      { cli: 'claude', model: 'haiku', tier: 'cheap' as const, strengths: ['chat' as const] },
      { cli: 'codex', model: 'default', tier: 'cheap' as const, strengths: ['code' as const] }
    ];
    const inp = base([cli('claude'), cli('codex')], ledger, { catalog });
    expect(route({ role: 'main', complexity: 'low', tier: 'cheap', needs: ['code'] }, inp)!.cli).toBe('codex');
    expect(route({ role: 'main', complexity: 'low', tier: 'cheap', needs: ['chat'] }, inp)!.cli).toBe('claude');
  });

  // The routing outcomes the weights are tuned for, with both subscriptions signed in and verified.
  it.each([
    ['front desk', { role: 'main', complexity: 'low', tier: 'cheap', effort: 'low', needs: ['chat'] }, 'claude/haiku', 'low'],
    ['plain medium work goes to a standard model', { role: 'main', complexity: 'medium', tier: 'standard', needs: ['code'] }, 'claude/sonnet', 'medium'],
    ['planning alone does not buy the strong model', { role: 'main', complexity: 'medium', tier: 'standard', needs: ['code', 'planning'] }, 'claude/sonnet', 'medium'],
    ['a long context alone does not buy the strong model', { role: 'main', complexity: 'medium', tier: 'standard', needs: ['code', 'long-context'] }, 'claude/sonnet', 'medium'],
    ['hard work: strong model at medium effort', { role: 'main', complexity: 'high', tier: 'strong', needs: ['code'] }, 'claude/opus', 'medium'],
    ['hard planning keeps high effort', { role: 'planner', complexity: 'high', needs: ['planning'] }, 'claude/opus', 'high'],
    ['a retry gets high effort', { role: 'implementer', complexity: 'medium', needs: ['code'], retry: true }, 'claude/sonnet', 'high'],
    ['a review', { role: 'reviewer', complexity: 'medium', needs: ['review'] }, 'claude/sonnet', 'medium']
  ] as const)('scenario: %s', (_name, req, pick, effort) => {
    const inp = base([cli('claude'), cli('codex')], ledgerAt({ now: 1 }).ledger, { verified: () => true });
    const d = route({ ...req, needs: [...req.needs] } as RouteRequest, inp)!;
    expect(`${d.cli}/${d.model}`).toBe(pick);
    expect(d.effort).toBe(effort);
  });

  it('balances subscriptions: medium work moves to the less used one', () => {
    const t = { now: 1 };
    const { ledger, run } = ledgerAt(t, 20);
    for (let i = 0; i < 13; i++) run('claude'); // ~65% of the window
    for (let i = 0; i < 2; i++) run('codex'); // ~10%
    const inp = base([cli('claude'), cli('codex')], ledger, { verified: () => true });
    for (const needs of [['code'], ['code', 'planning'], ['review']] as const)
      expect(route({ role: 'main', complexity: 'medium', tier: 'standard', needs: [...needs] }, inp)!.cli).toBe('codex');
    // A small difference does not flip the choice, and the session the lead already holds still wins.
    const close = ledgerAt({ now: 1 }, 40);
    close.run('claude');
    expect(route({ role: 'implementer', complexity: 'medium', needs: ['code'] }, base([cli('claude'), cli('codex')], close.ledger, { verified: () => true }))!.cli).toBe('claude');
    expect(route({ role: 'main', complexity: 'medium', tier: 'standard', needs: ['code'], continuity: 'claude' }, inp)!.cli).toBe('claude');
  });

  it('a catalog cost makes a pricier model lose close calls', () => {
    const { ledger } = ledgerAt({ now: 1 });
    const catalog = [
      { cli: 'claude', model: 'sonnet', tier: 'standard' as const, strengths: ['code' as const], cost: 3 },
      { cli: 'codex', model: 'default', tier: 'standard' as const, strengths: ['code' as const] }
    ];
    expect(route({ role: 'implementer', complexity: 'medium', needs: ['code'] }, base([cli('claude'), cli('codex')], ledger, { catalog }))!.cli).toBe('codex');
  });

  it('uses a CLI that is missing from the catalog with its default model', () => {
    const { ledger } = ledgerAt({ now: 1 });
    expect(route({ role: 'main', complexity: 'low' }, base([cli('gemini')], ledger, { catalog: [] }))!).toMatchObject({ cli: 'gemini', model: 'default' });
  });
});

describe('capability catalog file', () => {
  it('overrides the defaults from capabilities.json and falls back when it is missing or malformed', () => {
    const d = tmp();
    const f = join(d, 'capabilities.json');
    expect(loadCatalog(f)).toBe(DEFAULT_CATALOG);
    writeFileSync(f, 'not json');
    expect(loadCatalog(f)).toBe(DEFAULT_CATALOG);
    writeFileSync(f, JSON.stringify([{ cli: 'claude', model: 'sonnet', tier: 'cheap', strengths: ['code'] }, { cli: 'x', model: 'bad', tier: 'nope', strengths: [] }]));
    expect(loadCatalog(f)).toEqual([{ cli: 'claude', model: 'sonnet', tier: 'cheap', strengths: ['code'] }]);
  });
});

describe('locks', () => {
  const mk = () => { const s = new Store(); return new LockTable(() => s.locks, (l) => s.setLocks(l)); };

  it('one writer per file; same agent may re-acquire; release frees it', () => {
    const l = mk();
    expect(l.acquire('p', 'a', ['src/x.ts']).ok).toBe(true);
    expect(l.acquire('p', 'a', ['src/x.ts']).ok).toBe(true);
    const r = l.acquire('p', 'b', ['SRC/x.ts', 'src/y.ts']);
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual([{ file: 'src/x.ts', holder: 'a' }]);
    expect(l.heldBy('b')).toEqual([]); // all-or-nothing
    l.release('a');
    expect(l.acquire('p', 'b', ['src/x.ts']).ok).toBe(true);
  });
  it('locks are per project', () => {
    const l = mk();
    l.acquire('p1', 'a', ['f']);
    expect(l.acquire('p2', 'b', ['f']).ok).toBe(true);
  });
  it('whole-project lock excludes everyone', () => {
    const l = mk();
    expect(l.acquire('p', 'a', [WHOLE_PROJECT]).ok).toBe(true);
    expect(l.acquire('p', 'b', ['any.ts']).ok).toBe(false);
    l.release('a');
    l.acquire('p', 'b', ['any.ts']);
    expect(l.acquire('p', 'c', [WHOLE_PROJECT]).ok).toBe(false);
  });
  it('transfer requires the current holder', () => {
    const l = mk();
    l.acquire('p', 'a', ['f']);
    expect(l.transfer('p', 'zzz', 'b', 'f')).toBe(false);
    expect(l.transfer('p', 'a', 'b', 'f')).toBe(true);
    expect(l.heldBy('b')).toEqual(['f']);
  });
});

describe('git worktrees (real git)', () => {
  const g = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' });
  function repo() {
    const d = tmp();
    g(d, 'init', '-q', '-b', 'main');
    g(d, 'config', 'user.email', 't@t'); g(d, 'config', 'user.name', 't');
    writeFileSync(join(d, 'a.txt'), 'a');
    g(d, 'add', '.'); g(d, 'commit', '-q', '-m', 'init');
    return d;
  }

  it('detects repos without commits', async () => {
    const d = tmp(); g(d, 'init', '-q');
    expect(await new Git().isRepoWithCommits(d)).toBe(false);
  });

  it('creates an isolated worktree on harbor/<slug>, checkpoints work, and reports the diff', async () => {
    const d = repo(), root = join(tmp(), 'wt');
    const git = new Git();
    const wt = await git.createWorktree(d, root, 'proj1', 'Add Login Form!', 'abcdef123');
    expect(wt.branch).toBe('harbor/add-login-form-abcdef');
    writeFileSync(join(wt.path, 'new.txt'), 'x');
    expect(readFileSync(join(d, 'a.txt'), 'utf8')).toBe('a'); // main checkout untouched
    const cp = await git.checkpoint(wt.path, 'harbor: task');
    expect(cp.committed).toBe(true);
    expect(await git.changedFiles(wt.path, wt.baseCommit)).toEqual(['new.txt']);
    expect(await git.diffStat(wt.path, wt.baseCommit)).toMatch(/new\.txt/);
    expect((await git.checkpoint(wt.path, 'again')).committed).toBe(false);
    await git.removeWorktree(d, root, wt.path, wt.branch);
    expect(g(d, 'branch', '--list', 'harbor/*').stdout.trim()).toBe('');
  });

  it('refuses to remove paths outside Harbor worktrees', async () => {
    const d = repo();
    mkdirSync(join(d, 'sub'));
    await expect(new Git().removeWorktree(d, join(tmp(), 'wt'), join(d, 'sub'))).rejects.toThrow(/Refusing/);
  });
});
