import { describe, expect, it } from 'vitest';
import { EQUAL_POOLS, ONE_CODEX_MODEL } from './fixtures/catalogs';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { route, type RouteRequest, type RouterInput } from '../src/main/router';
import { CREDIT_FULL_HOURS, CREDIT_RUN_SHARE, CREDIT_START_HOURS } from '../src/main/routePrice';
import { Store } from '../src/main/store';
import { UsageLedger } from '../src/main/usage';

/**
 * Weekly pacing, from the owner's words: when a weekly reset is coming, spend what would otherwise be lost; when a CLI burns faster
 * than the week allows, conserve. Capacity now (the 5h window), hard skips, needs and an explicit request still win.
 * Every state below is USED percent plus the hours to the weekly reset.
 *
 * Phase 3 rewrote this file. The old mechanism (a +35 'pacing' score bonus, spend-up one tier and one effort step, conserve-down one
 * tier) is gone. The budget governor now prices the same intents: a pool whose week would end with quota unspent earns a
 * use-it-or-lose-it credit on the part of a run that fits in the leftover (whole within CREDIT_FULL_HOURS of the reset, none beyond
 * CREDIT_START_HOURS), and a pool burning faster than its week allows grows scarce (dearer). The work never moves below or above
 * what its difficulty needs because of pacing: the model and effort are the cheapest that clear the floor. The scenarios keep their
 * letters; what they assert is the new mechanism.
 *
 * Phase 5 changed the credit (routePrice.wasteCredit) and the tie-break: one run may draw up to CREDIT_RUN_SHARE of the projected
 * leftover (it was a share of the run's own cost, which left every price ratio unchanged until the last ~12 hours), from up to a week
 * before the reset; and when credit makes options free, the less risky one wins (to the whole percent), then the lower effort. So
 * expiring quota now DOES buy a stronger model at low effort ("Opus on low") for work below it: that is the spend-up the simulator
 * needed to keep a steady week from resetting 40-55% unused (tests/simWeek.test.ts property 2). It still never moves work below its floor.
 */
const NOW = 50_000_000_000;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

const cli = (id: string, over: Partial<ResolvedCli> = {}): ResolvedCli =>
  ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'], ...over });

interface St {
  /** Weekly used percent and hours to its reset; absent = the provider reported no weekly window. */
  week?: number; weekH?: number;
  /** 5h window used percent (default 10: healthy) and age of the reading in hours (default 0). */
  sess?: number; ageH?: number;
}
function ledgerOf(state: Record<string, St>, now = NOW, opts: { runsPerWeek?: number } = {}) {
  const t = { now };
  const ledger = new UsageLedger(new Store(), { now: () => t.now, runsPerWindow: { default: 10 }, ...opts });
  const set = (c: string, s: St) => {
    const asOf = t.now - (s.ageH ?? 0) * HOUR;
    ledger.record({
      cli: c, model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, time: asOf,
      limits: [
        { period: 'session', usedPct: s.sess ?? 10, resetsAt: t.now + 150 * MIN, asOf },
        ...(s.week !== undefined ? [{ period: 'weekly' as const, usedPct: s.week, resetsAt: t.now + (s.weekH ?? 72) * HOUR, asOf }] : [])
      ]
    });
  };
  for (const [c, s] of Object.entries(state)) set(c, s);
  return { ledger, t, set };
}
const input = (ledger: UsageLedger, extra: Partial<RouterInput> = {}, clis: ResolvedCli[] = [cli('claude'), cli('codex')]): RouterInput =>
  // Phase 5: Codex's pool calibrated to Claude's per-token figures (EQUAL_POOLS): two comparable accounts, as these tests assume.
  ({ clis, ledger, enabled: () => true, hasAdapter: () => true, load: () => 0, now: () => NOW, catalog: ONE_CODEX_MODEL, calibration: EQUAL_POOLS, ...extra });
const medium = (over: Partial<RouteRequest> = {}): RouteRequest => ({ role: 'implementer', complexity: 'medium', needs: ['code'], ...over });
const low = (over: Partial<RouteRequest> = {}): RouteRequest => ({ role: 'implementer', complexity: 'low', needs: ['code'], ...over });
const lead = (over: Partial<RouteRequest> = {}): RouteRequest => ({ role: 'main', complexity: 'medium', tier: 'standard', needs: ['code'], interactive: true, ...over });
const at = (state: Record<string, St>, req: RouteRequest, extra: Partial<RouterInput> = {}, clis?: ResolvedCli[]) =>
  route(req, input(ledgerOf(state).ledger, extra, clis))!;

describe('the credit window', () => {
  it('starts a week before a reset, is whole from CREDIT_FULL_HOURS on, and covers a run that fits in its share of the leftover', () => {
    expect(CREDIT_START_HOURS).toBe(168);
    expect(CREDIT_FULL_HOURS).toBe(48);
    expect(CREDIT_RUN_SHARE).toBe(0.5);
    const credit = (weekH: number) => at({ claude: { week: 2, weekH } }, medium(), {}, [cli('claude')]).price!;
    // A reset reported further out than a week earns nothing; inside it, a medium Claude run (~0.3% of the week) fits in the allowance.
    expect(credit(170).wasteCreditPct).toBe(0);
    for (const h of [160, 100, 48, 10]) expect(credit(h).wasteCreditPct).toBeCloseTo(credit(h).expectedCostPct, 6);
  });
});

describe('a) surplus about to expire beats continuity', () => {
  const d = at({ claude: { week: 20, weekH: 10 }, codex: { week: 60, weekH: 72 } }, medium({ continuity: 'codex' }));
  it('claude is chosen over a session on codex, and the reason shows the quota that would expire', () => {
    expect(d.cli).toBe('claude');
    // Phase 5: the expiring quota pays for the least risky option at the lowest effort, Opus at low (was Sonnet at medium, the floor).
    expect(d).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' });
    expect(d.reason).toMatch(/would expire unused/);
    expect(d.reason).toMatch(/claude:all weekly: .*resets in 10h.* → spend/);
  });
  // Phase 5: every reset within a week is inside the credit window now; a week on course to run dry is what earns nothing.
  it('a week projected to run dry earns no credit, and the work stays at its floor', () => {
    const dry = at({ claude: { week: 60, weekH: 100 } }, medium(), {}, [cli('claude')]);
    expect(dry.price!.wasteCreditPct).toBe(0);
    expect(dry).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' });
  });
});

describe('b) capacity now binds', () => {
  it('claude with 5% left on its 5h window earns no credit, however large its weekly surplus', () => {
    const d = at({ claude: { week: 20, weekH: 10, sess: 95 }, codex: { week: 60, weekH: 72 } }, medium({ continuity: 'codex' }));
    expect(d.cli).toBe('codex');
    expect(d.runnerUp?.wasteCreditPct ?? 0).toBe(0);
  });
});

// Phase 5: was "the one that expires first is spent first" (codex). With the per-run allowance both weeks pay for the whole run, so
// both are free and the least risky option wins; which week's quota is spent first no longer matters while both would expire.
describe('c) two underspent weeks: both pay for the work', () => {
  it('equal surplus, codex resets sooner: both credited in full, the least risky free option wins', () => {
    const d = at({ claude: { week: 20, weekH: 40 }, codex: { week: 32, weekH: 20 } }, medium());
    expect(d.price!.wasteCreditPct).toBeCloseTo(d.price!.expectedCostPct, 6);
    expect(d.runnerUp!.wasteCreditPct).toBeGreaterThan(0);
    expect(d.price!.routeTotal).toBe(0);
  });
  it('and the mirror image picks claude (nothing hard-codes a CLI)', () => {
    expect(at({ claude: { week: 32, weekH: 20 }, codex: { week: 20, weekH: 40 } }, medium()).cli).toBe('claude');
  });
});

describe('d) overspent: conserve', () => {
  it('claude 90% used with 5 days left: codex, even with the session on claude', () => {
    const d = at({ claude: { week: 90, weekH: 120 }, codex: { week: 30, weekH: 120 } }, lead({ continuity: 'claude' }));
    expect(d.cli).toBe('codex');
    expect(d.reason).toMatch(/claude:all weekly: .* → protect/);
  });
  it('both overspent: the one with more left wins', () => {
    expect(at({ claude: { week: 80, weekH: 120 }, codex: { week: 50, weekH: 120 } }, medium()).cli).toBe('codex');
  });
  it('only claude available and over pace: the work stays at its floor (no tier downshift), and the reason says the pool is tight', () => {
    const d = at({ claude: { week: 45, weekH: 144 } }, medium(), {}, [cli('claude')]);
    expect(d.model).not.toBe('claude-haiku-5-5');
    expect(d.degraded).toBeUndefined();
    expect(d.reason).toMatch(/claude:all weekly: .*resets in 144h.* → (conserve|protect)/);
  });
});

describe('e) unknown reset time earns nothing', () => {
  it.each([
    ['no weekly window reported', { claude: { sess: 10 }, codex: { sess: 10 } }],
    ['only a 5h window each, one of them used', { claude: { sess: 60 }, codex: { sess: 10 } }]
  ] as const)('%s: no credit and no credit words', (_n, state) => {
    for (const req of [medium(), low(), lead({ continuity: 'codex' })]) {
      const d = at(state as Record<string, St>, req);
      expect(d.price!.wasteCreditPct).toBe(0);
      expect(d.reason).not.toMatch(/would expire unused/);
    }
  });
  it('an estimated weekly window is never credited', () => {
    const { ledger } = ledgerOf({});
    for (let i = 0; i < 3; i++) ledger.record({ cli: 'claude', model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, time: NOW - 6 * DAY });
    const d = route(medium(), input(ledger, { now: () => NOW }, [cli('claude')]))!;
    expect(d.price!.wasteCreditPct).toBe(0);
  });
});

describe('f) a stale reading counts for less', () => {
  it('the same state read 12h ago earns no credit and is treated as neutral', () => {
    const fresh = at({ claude: { week: 20, weekH: 10 } }, medium(), {}, [cli('claude')]);
    const old = at({ claude: { week: 20, weekH: 10, ageH: 12 } }, medium(), {}, [cli('claude')]);
    expect(fresh.price!.wasteCreditPct).toBeGreaterThan(0);
    expect(old.price!.wasteCreditPct).toBe(0);
    expect(old.reason).toMatch(/reading 12h old, trusted \d+%, treated as neutral/);
  });
});

describe('g) an explicit request wins over conserve', () => {
  it('"use claude" with claude overspent and the session on codex: claude, not judged on price', () => {
    const d = at({ claude: { week: 40, weekH: 144 }, codex: { week: 10, weekH: 144 } }, medium({ prefer: 'claude', continuity: 'codex' }));
    expect(d.cli).toBe('claude');
    expect(d.scored!.find((s) => s.cli === 'claude')!.terms['price']).toBe(0);
    expect(d.reason).toMatch(/price \(not weighed: you asked for this CLI\)/);
  });
  it('and a near-expiring surplus on the other CLI cannot outbid the request', () => {
    expect(at({ claude: { week: 60, weekH: 144 }, codex: { week: 5, weekH: 4 } }, medium({ prefer: 'claude' })).cli).toBe('claude');
  });
});

describe('h) conserve never pushes work below what it needs', () => {
  const state = { claude: { week: 45, weekH: 144 } };
  const only = [cli('claude')];
  it('high work, planners, retries and a resumed session keep a model that clears their floor', () => {
    expect(at(state, { role: 'implementer', complexity: 'high', needs: ['code'] }, {}, only).model).toBe('claude-opus-5-5');
    expect(at(state, { role: 'planner', complexity: 'medium', needs: ['planning'] }, {}, only).model).not.toBe('claude-haiku-5-5');
    expect(at(state, medium({ retry: true }), {}, only).model).not.toBe('claude-haiku-5-5');
    expect(at(state, lead({ keep: { cli: 'claude', model: 'sonnet' } }), {}, only).model).toBe('claude-sonnet-5-5');
  });
  it('a required need that the cheaper model lacks blocks it', () => {
    expect(at(state, low({ required: ['review'] }), {}, only).model).not.toBe('claude-haiku-5-5');
  });
  it('high effort chosen deliberately is untouched', () => {
    expect(at(state, medium({ effort: 'high', fixedEffort: true }), {}, only).effort).toBe('high');
  });
});

describe('i) a week of 40 turns', () => {
  /** Each turn is 4.2h; the chosen CLI's weekly window gains `burn` points, its 5h window stays healthy. Both start unused, the reset is at the end of the week. */
  function simulate(burn: number) {
    const t = { now: NOW };
    const ledger = new UsageLedger(new Store(), { now: () => t.now, runsPerWindow: { default: 10 } });
    const used: Record<string, number> = { claude: 0, codex: 0 };
    const report = (c: string) => ledger.record({ cli: c, model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, time: t.now, limits: [
      { period: 'session', usedPct: 20, resetsAt: t.now + 3 * HOUR, asOf: t.now },
      { period: 'weekly', usedPct: used[c]!, resetsAt: NOW + 7 * DAY, asOf: t.now }
    ] });
    let held = 'claude', moved: { cli: string; at: number } | undefined;
    const seq: string[] = [];
    for (let i = 0; i < 40; i++) {
      t.now = NOW + i * 4.2 * HOUR;
      report('claude'); report('codex');
      const d = route(lead({ continuity: held, left: moved }), input(ledger, { now: () => t.now }))!;
      if (d.cli !== held) moved = { cli: held, at: t.now };
      held = d.cli;
      seq.push(d.cli);
      used[d.cli] = Math.min(100, used[d.cli]! + burn);
    }
    return { seq, used };
  }
  const switches = (s: string[]) => s.filter((c, i) => i > 0 && c !== s[i - 1]).length;

  it('the session does not ping-pong, and neither week is run past its end', () => {
    const { seq, used } = simulate(4);
    expect(switches(seq)).toBeLessThanOrEqual(4);
    expect(used['claude']! + used['codex']!).toBe(160); // every turn found a CLI: 40 turns x 4
    expect(Math.max(used['claude']!, used['codex']!)).toBeLessThanOrEqual(100);
  });
  it('a lighter week (2 points a turn) also never ping-pongs', () => {
    const { seq } = simulate(2);
    expect(switches(seq)).toBeLessThanOrEqual(4);
  });
});

describe('j) estimated windows never earn credit', () => {
  const week = (runs: number, perWeek: number | undefined) => {
    const l = ledgerOf({ claude: { sess: 10 }, codex: { week: 60, weekH: 72 } }, NOW, perWeek ? { runsPerWeek: perWeek } : {});
    // runs from 6.5 days ago anchor the estimated window: it resets in 12h.
    for (let i = 0; i < runs; i++) l.ledger.record({ cli: 'claude', model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, time: NOW - 6.5 * DAY + i * MIN });
    return l.ledger;
  };
  it.each([[2, 10], [1, 10], [2, undefined]] as const)('%i runs against a budget of %s: no credit for claude', (runs, perWeek) => {
    const d = route(medium({ continuity: 'codex' }), input(week(runs, perWeek)))!;
    const claude = [d.price!, d.runnerUp!].find((p) => p?.cli === 'claude');
    expect(claude?.wasteCreditPct ?? 0).toBe(0);
  });
});

describe('k) the owner scenario: reset in 27h, 60% left, codex 70% left with 6 days to go', () => {
  const state = (h: number) => ({ claude: { week: 40, weekH: h, sess: 10 }, codex: { week: 30, weekH: 144, sess: 10 } });
  // Phase 5: the expiring quota pays for Opus at low effort for both (was Sonnet and Haiku, each at its floor).
  it.each([['medium code task', medium({ continuity: 'codex' }), 'claude-opus-5-5'], ['low rename task', low({ continuity: 'codex' }), 'claude-opus-5-5']] as const)(
    '%s: claude, Opus at low effort paid by the expiring quota, credited in the reason', (_n, req, model) => {
      const d = at(state(27), req);
      expect(d.cli).toBe('claude');
      expect(d.model).toBe(model);
      expect(d.price!.wasteCreditPct).toBeGreaterThan(0);
      expect(d.reason).toMatch(/claude:all weekly: .*resets in 27h.* → spend/);
    });
  it('with the reset in 80h there is no credit yet (outside the 72h window)', () => {
    for (const req of [medium({ continuity: 'codex' }), low({ continuity: 'codex' })]) {
      const d = at(state(80), req);
      expect(d.price!.wasteCreditPct).toBe(0);
      if (d.runnerUp) expect(d.runnerUp.wasteCreditPct).toBe(0);
    }
  });
});
