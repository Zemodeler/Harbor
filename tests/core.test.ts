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
import { EQUAL_POOLS, ONE_CODEX_MODEL } from './fixtures/catalogs';
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
  // Phase 5: Codex's pool calibrated to Claude's per-token figures (EQUAL_POOLS): these are about two comparable accounts.
  const base = (clis: ResolvedCli[], ledger: UsageLedger, extra = {}) =>
    ({ clis, ledger, enabled: () => true, hasAdapter: () => true, load: () => 0, calibration: EQUAL_POOLS, ...extra });

  it('skips uninstalled, signed-out, adapter-less and disabled CLIs and explains why', () => {
    const { ledger } = ledgerAt({ now: 1 });
    const d = route({ role: 'implementer', complexity: 'medium' }, base([
      cli('claude'), cli('codex', { installed: false }), cli('gemini', { authState: 'signedOut', signedIn: false })
    ], ledger))!;
    expect(d.cli).toBe('claude');
    expect(d.reason).toMatch(/codex skipped: not installed/);
    expect(d.reason).toMatch(/gemini skipped: login required/);
    expect(d.model).toBe('claude-sonnet-5-5');
    expect(d.effort).toBe('medium');
  });

  it('prefers the less used CLI and honours continuity', () => {
    const t = { now: 1 };
    const { ledger, run } = ledgerAt(t, 10);
    for (let i = 0; i < 6; i++) run('claude');
    const inp = base([cli('claude'), cli('codex')], ledger);
    // Medium work: both CLIs have a standard model, so the difference is the allowance (a cheap request would favour claude's haiku on tier fit).
    expect(route({ role: 'implementer', complexity: 'medium' }, inp)!.cli).toBe('codex');
    expect(route({ role: 'implementer', complexity: 'medium', continuity: 'claude' }, inp)!.cli).toBe('claude');
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
    // The capped Opus is skipped and Fable is not auto-routed (catalog v2), so the work goes to Sonnet rather than spending Fable.
    // Phase 3: Sonnet at high effort just clears high work (difficulty 8), so it is not degraded (was { strong, standard }) but its
    // result is marked for review.
    expect(d).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high', needsReview: true });
    expect(d.degraded).toBeUndefined();
    expect(d.reason).toMatch(/claude-opus-5-5 skipped: allowance exhausted/);
  });

  it('lowers effort when allowance is low (explicit policy); a planner follows its difficulty', () => {
    const t = { now: 1 };
    const { ledger, run } = ledgerAt(t, 10);
    for (let i = 0; i < 8; i++) run('claude');
    // Phase 3: the price picks the effort (Opus clears high work at low effort); only an explicit low-allowance policy steps it down
    // further, and only where the work still clears (was: medium, lowered from high by the default policy).
    const d = route({ role: 'planner', complexity: 'high' }, base([cli('claude')], ledger))!;
    expect(d).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' });
    // Medium planning: Sonnet at medium effort, which an explicit reduceEffort policy cannot step lower (low would not clear it).
    // Phase 5: was Opus at low effort; low effort is no longer 0.6x the tokens of medium but 0.8x (budgetPriors.EFFORT_TOKEN_MULT:
    // thinking is a small share of an agentic run's tokens), so Opus low (1.6x Sonnet's quota) no longer undercuts Sonnet medium.
    const r = route({ role: 'planner', complexity: 'medium' }, base([cli('claude')], ledger, { policy: { lowAllowance: 'reduceEffort' } }))!;
    expect(r).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' });
    // Changed deliberately (quota audit): planners used to be strong at every complexity, which bought Opus for every plan.
    // Phase 3: easy planning (difficulty 2) fits Haiku at high effort on the built-in planning scores (was Sonnet).
    expect(route({ role: 'planner', complexity: 'low' }, base([cli('claude')], ledgerAt({ now: 1 }).ledger))!.model).toBe('claude-haiku-5-5');
    expect(route({ role: 'planner', complexity: 'medium' }, base([cli('claude')], ledgerAt({ now: 1 }).ledger))!.model).toBe('claude-sonnet-5-5');
    expect(route({ role: 'planner', complexity: 'high' }, base([cli('claude')], ledgerAt({ now: 1 }).ledger))!.model).toBe('claude-opus-5-5');
  });

  it('spreads parallel load', () => {
    const { ledger } = ledgerAt({ now: 1 });
    const d = route({ role: 'implementer', complexity: 'low' }, base([cli('claude'), cli('codex')], ledger, { load: (c: string) => (c === 'claude' ? 2 : 0) }))!;
    expect(d.cli).toBe('codex');
  });
});

describe('router: capability catalog', () => {
  // Phase 5: Codex's pool calibrated to Claude's per-token figures (EQUAL_POOLS): these are about two comparable accounts.
  const base = (clis: ResolvedCli[], ledger: UsageLedger, extra = {}) =>
    ({ clis, ledger, enabled: () => true, hasAdapter: () => true, load: () => 0, calibration: EQUAL_POOLS, ...extra });

  it('maps tiers to the cheapest fitting model', () => {
    const { ledger } = ledgerAt({ now: 1 });
    const inp = base([cli('claude')], ledger);
    expect(route({ role: 'main', complexity: 'low', tier: 'cheap', effort: 'low' }, inp)!).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(route({ role: 'main', complexity: 'medium', tier: 'standard' }, inp)!.model).toBe('claude-sonnet-5-5');
    expect(route({ role: 'main', complexity: 'high', tier: 'strong', needs: ['planning'] }, inp)!.model).toBe('claude-opus-5-5');
    expect(route({ role: 'main', complexity: 'high', tier: 'strong' }, inp)!.reason).toContain('claude/claude-opus-5-5 (strong)');
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

  // The routing outcomes the weights are tuned for, with both subscriptions signed in and verified. Phase 3: on ONE_CODEX_MODEL (Codex
  // priced like Sonnet), so these stay about difficulty and effort rather than the built-in catalog's Codex price priors; efforts are
  // now the price's choice (hard work clears on Opus at low effort; a rejected retry gets one effort step more on the same model).
  it.each([
    ['front desk', { role: 'main', complexity: 'low', tier: 'cheap', effort: 'low', needs: ['chat'] }, 'claude/claude-haiku-5-5', 'low'],
    ['plain medium work goes to a standard model', { role: 'main', complexity: 'medium', tier: 'standard', needs: ['code'] }, 'claude/claude-sonnet-5-5', 'medium'],
    ['planning alone does not buy the strong model', { role: 'main', complexity: 'medium', tier: 'standard', needs: ['code', 'planning'] }, 'claude/claude-sonnet-5-5', 'medium'],
    ['a long context alone does not buy the strong model', { role: 'main', complexity: 'medium', tier: 'standard', needs: ['code', 'long-context'] }, 'claude/claude-sonnet-5-5', 'medium'],
    ['hard work: strong model at low effort', { role: 'main', complexity: 'high', tier: 'strong', needs: ['code'] }, 'claude/claude-opus-5-5', 'low'],
    ['hard planning: strong model', { role: 'planner', complexity: 'high', needs: ['planning'] }, 'claude/claude-opus-5-5', 'low'],
    ['a rejected retry: one effort step more on the same model', { role: 'implementer', complexity: 'medium', difficulty: 6.5, needs: ['code'], retry: true, escalateFrom: { cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' } }, 'claude/claude-sonnet-5-5', 'high'],
    ['a review', { role: 'reviewer', complexity: 'medium', needs: ['review'] }, 'claude/claude-sonnet-5-5', 'medium']
  ] as const)('scenario: %s', (_name, req, pick, effort) => {
    const inp = base([cli('claude'), cli('codex')], ledgerAt({ now: 1 }).ledger, { verified: () => true, catalog: ONE_CODEX_MODEL });
    const d = route({ ...req, needs: [...req.needs] } as RouteRequest, inp)!;
    expect(`${d.cli}/${d.model}`).toBe(pick);
    expect(d.effort).toBe(effort);
  });

  it('balances subscriptions: medium work moves to the less used one', () => {
    const t = { now: 1 };
    const { ledger, run } = ledgerAt(t, 20);
    for (let i = 0; i < 13; i++) run('claude'); // ~65% of the window
    for (let i = 0; i < 2; i++) run('codex'); // ~10%
    // Phase 3: on ONE_CODEX_MODEL, so the subscriptions' state decides, not the built-in Codex price priors.
    const inp = base([cli('claude'), cli('codex')], ledger, { verified: () => true, catalog: ONE_CODEX_MODEL });
    expect(route({ role: 'main', complexity: 'medium', tier: 'standard', needs: ['code'] }, inp)!.cli).toBe('codex');
    // Phase 3: the floor is per need. The fixture's Codex model scores 3 for planning and review, below medium work (4.1): those stay
    // on claude however its allowance stands (was: codex for every need).
    for (const needs of [['code', 'planning'], ['review']] as const)
      expect(route({ role: 'main', complexity: 'medium', tier: 'standard', needs: [...needs] }, inp)!.cli).toBe('claude');
    // A small difference does not flip the choice, and the session the lead already holds still wins.
    const close = ledgerAt({ now: 1 }, 40);
    close.run('claude');
    expect(route({ role: 'implementer', complexity: 'medium', needs: ['code'] }, base([cli('claude'), cli('codex')], close.ledger, { verified: () => true, catalog: ONE_CODEX_MODEL }))!.cli).toBe('claude');
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
