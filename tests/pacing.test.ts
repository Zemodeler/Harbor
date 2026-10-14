import { describe, expect, it } from 'vitest';
import { EQUAL_POOLS, ONE_CODEX_MODEL } from './fixtures/catalogs';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { ROUTING_WEIGHTS as W, route, type RouteRequest, type RouterInput } from '../src/main/router';
import { Store } from '../src/main/store';
import { UsageLedger } from '../src/main/usage';

/**
 * Moving work between subscriptions, from the owner's words: a subscription with 10% left should hand work to one with 90% left (both
 * the 5h and the weekly window count), without flip-flopping on small gaps, and otherwise behave like plain Claude Code or Codex.
 * Every number below is REMAINING percent, 5h first, then weekly.
 *
 * Phase 3: the headroom curve is gone. The budget governor turns each pool's windows into a scarcity (budget.ts) and the router
 * prices the work with it (routePrice.ts); a session moves when another CLI is about 7x cheaper (W.switchGap = 28 points at 10 per
 * doubling). The scenarios are the same; the headroom-curve unit tests were removed with the curve, and the scenarios whose outcome
 * the new model decides differently say why next to them. Leads are interactive work (they may use the reserve).
 */
const NOW = 50_000_000_000;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

const cli = (id: string, over: Partial<ResolvedCli> = {}): ResolvedCli =>
  ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'], ...over });

interface Win { sess: number; week: number; sessResetsIn?: number; weekResetsIn?: number }
/** A ledger whose providers reported these remaining percentages. Defaults: the 5h window resets in 2.5h (so a fresh CLI does not earn the use-it-or-lose-it bonus), the week in 3 days (both well past 10% elapsed). */
function ledgerOf(state: Record<string, Win>, now = NOW) {
  const t = { now };
  const ledger = new UsageLedger(new Store(), { now: () => t.now, runsPerWindow: { default: 10 } });
  const set = (c: string, w: Win, asOf = t.now) => ledger.record({
    cli: c, model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, time: asOf,
    limits: [
      { period: 'session', usedPct: 100 - w.sess, resetsAt: t.now + (w.sessResetsIn ?? 150 * MIN), asOf },
      { period: 'weekly', usedPct: 100 - w.week, resetsAt: t.now + (w.weekResetsIn ?? 3 * DAY), asOf }
    ]
  });
  for (const [c, w] of Object.entries(state)) set(c, w);
  return { ledger, t, set };
}
const input = (ledger: UsageLedger, extra: Partial<RouterInput> = {}, clis: ResolvedCli[] = [cli('claude'), cli('codex')]): RouterInput =>
  // Phase 5: Codex's pool calibrated to Claude's per-token figures (EQUAL_POOLS): two comparable accounts, as these tests assume.
  ({ clis, ledger, enabled: () => true, hasAdapter: () => true, load: () => 0, now: () => NOW, catalog: ONE_CODEX_MODEL, calibration: EQUAL_POOLS, ...extra });
const lead = (over: Partial<RouteRequest> = {}): RouteRequest => ({ role: 'main', complexity: 'medium', tier: 'standard', needs: ['code'], interactive: true, ...over });
const at = (state: Record<string, Win>, req: RouteRequest, extra: Partial<RouterInput> = {}, clis?: ResolvedCli[]) =>
  route(req, input(ledgerOf(state).ledger, extra, clis))!;

describe('constants', () => {
  it('the stickiness sits between continuity and a settings preference; switching back costs less than the stickiness', () => {
    expect(W.switchGap).toBeGreaterThan(W.continuity);
    expect(W.switchGap).toBeLessThan(W.preferred);
    expect(W.switchBack).toBeLessThan(W.switchGap);
  });
});

describe('a) a big gap beats continuity', () => {
  it('claude 10%/20% vs codex 90%/90%: codex, even with the session on claude, and the reason shows both windows of both pools', () => {
    const d = at({ claude: { sess: 10, week: 20 }, codex: { sess: 90, week: 90 } }, lead({ continuity: 'claude' }));
    expect(d.cli).toBe('codex');
    expect(d.reason).toMatch(/quota claude:all weekly: .* → protect[\s\S]*quota claude:all 5h: .* → protect[\s\S]*quota codex:all weekly: .* → spend[\s\S]*quota codex:all 5h: .* → spend/);
    expect(d.runnerUp!.scarcity).toBeGreaterThan(d.price!.scarcity);
  });
  it('the same state with an explicit reduceEffort keeps the session where it is (the older meaning)', () => {
    const d = at({ claude: { sess: 10, week: 20 }, codex: { sess: 90, week: 90 } }, lead({ continuity: 'claude' }), { policy: { lowAllowance: 'reduceEffort' } });
    expect(d.cli).toBe('claude');
  });
});

describe('b) small gaps never move a session', () => {
  it('claude 55%/60% vs codex 45%/50%, session on claude: stays', () => {
    expect(at({ claude: { sess: 55, week: 60 }, codex: { sess: 45, week: 50 } }, lead({ continuity: 'claude' })).cli).toBe('claude');
  });
  it('and the reverse state keeps a session on codex', () => {
    expect(at({ claude: { sess: 45, week: 50 }, codex: { sess: 55, week: 60 } }, lead({ continuity: 'codex' })).cli).toBe('codex');
  });
});

// Phase 3: 3% left with 2h to go (was 5% resetting in 20 minutes: at the pace that spent it, 5% is enough for 20 minutes, so the
// governor now calls that window merely tight, and a session stays).
describe('c) the 5h window binds now, however full the week is', () => {
  const claude = { sess: 3, week: 90, sessResetsIn: 2 * HOUR };
  it('claude 5h 3% left (resets in 2h) with 90% weekly vs codex 70%/70%: codex, and the reason says the 5h window is in protect', () => {
    const d = at({ claude, codex: { sess: 70, week: 70 } }, lead({ continuity: 'claude' }));
    expect(d.cli).toBe('codex');
    expect(d.reason).toMatch(/claude:all 5h: 3% free, resets in 2h.* → protect/);
  });
  it('codex signed out or exhausted: the work still goes to claude, never to nothing', () => {
    const signedOut = at({ claude, codex: { sess: 70, week: 70 } }, lead({ continuity: 'claude' }), {}, [cli('claude'), cli('codex', { authState: 'signedOut', signedIn: false })]);
    expect(signedOut.cli).toBe('claude');
    const exhausted = at({ claude, codex: { sess: 0, week: 70 } }, lead());
    expect(exhausted.cli).toBe('claude');
    expect(exhausted.skipped).toContainEqual(expect.objectContaining({ cli: 'codex', transient: true }));
  });
});

describe('d) a nearly spent week with a distant reset binds', () => {
  it('claude weekly 5% left, 6 days to reset, 5h at 100%: codex', () => {
    const d = at({ claude: { sess: 100, week: 5, weekResetsIn: 6 * DAY }, codex: { sess: 70, week: 70 } }, lead({ continuity: 'claude' }));
    expect(d.cli).toBe('codex');
    expect(d.reason).toMatch(/claude:all weekly: 5% free, resets in 144h, burning [\d.]+%\/h \(average since the window began\) → protect/);
  });
  it('a weekly window with plenty left and a distant reset is abundant: a thin 5h window on the other CLI does not pull the session', () => {
    const d = at({ claude: { sess: 80, week: 90, weekResetsIn: 6 * DAY }, codex: { sess: 100, week: 100 } }, lead({ continuity: 'claude' }));
    expect(d.cli).toBe('claude');
  });
});

// Phase 3: scarcity is capped (budget.SCARCITY_MAX), so two windows both deep in protect price alike; the scenario uses a clear gap
// (was 15%/30% vs 20%/40%), and the default policy no longer lowers effort for allowance (the price weighs it; explicit policies do).
describe('e) both low: more room wins', () => {
  it('claude 10%/30% vs codex 40%/40%, nothing held: codex', () => {
    const d = at({ claude: { sess: 10, week: 30 }, codex: { sess: 40, week: 40 } }, lead());
    expect(d.cli).toBe('codex');
    expect(d.effort).toBe('medium');
  });
});

describe('f) estimates weigh less than provider readings', () => {
  it("Harbor's own 90% count keeps the session; a reported 90% moves it", () => {
    const est = ledgerOf({ codex: { sess: 100, week: 100 } });
    for (let i = 0; i < 9; i++) est.ledger.record({ cli: 'claude', model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true });
    const a = route(lead({ continuity: 'claude' }), input(est.ledger))!;
    expect(a.cli).toBe('claude');
    expect(a.reason).toMatch(/claude:all 5h \(estimate from Harbor runs only, not the provider's quota\)/);
    const b = at({ claude: { sess: 10, week: 100 }, codex: { sess: 100, week: 100 } }, lead({ continuity: 'claude' }));
    expect(b.cli).toBe('codex');
  });
});

// Phase 3: the governor measures burn rates from successive readings, so the simulation is paced like real turns: one every 6 minutes
// (was 2), each burning the week by 0.05 points (was 1: a week emptied in hours, which the governor rightly calls 'protect').
describe('g) hysteresis over 20 lead turns', () => {
  /** Each turn burns the chosen CLI's 5h window by `burn` points (7 by default) and its week by 0.05; the session follows the choice. */
  function simulate(start: Record<string, Win>, burn = 7, held0: string = 'claude') {
    const t = { now: NOW };
    const ledger = new UsageLedger(new Store(), { now: () => t.now, runsPerWindow: { default: 10 } });
    const left: Record<string, Win> = JSON.parse(JSON.stringify(start));
    const report = (c: string) => ledger.record({
      cli: c, model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, time: t.now,
      limits: [
        { period: 'session', usedPct: 100 - left[c].sess, resetsAt: NOW + 150 * MIN, asOf: t.now },
        { period: 'weekly', usedPct: 100 - left[c].week, resetsAt: NOW + 5 * DAY, asOf: t.now }
      ]
    });
    Object.keys(left).forEach(report);
    let held: string | undefined = held0, moved: { cli: string; at: number } | undefined;
    const seq: string[] = [];
    for (let i = 0; i < 20; i++) {
      t.now = NOW + i * 6 * MIN;
      const d = route(lead({ continuity: held, left: moved }), input(ledger, { now: () => t.now }));
      if (!d) break; // both exhausted
      if (held && d.cli !== held) moved = { cli: held, at: t.now };
      held = d.cli;
      seq.push(d.cli);
      left[d.cli].sess = Math.max(0, left[d.cli].sess - burn);
      left[d.cli].week = Math.max(0, left[d.cli].week - 0.05);
      report(d.cli);
    }
    return seq;
  }
  const switches = (s: string[]) => s.filter((c, i) => i > 0 && c !== s[i - 1]).length;

  it('a big gap switches once and never ping-pongs back while the other CLI is not exhausted', () => {
    const seq = simulate({ claude: { sess: 80, week: 90 }, codex: { sess: 95, week: 90 } });
    // claude holds the session until its pool is running out, then it moves once. Phase 3: at 7 points a turn codex is nearly spent
    // within the 20 turns (95 / 7), and a session is not held on a pool in protect, so it may move back once near the end (was:
    // exactly one move, codex last).
    expect(seq[0]).toBe('claude');
    expect(switches(seq)).toBeLessThanOrEqual(2);
    if (switches(seq) === 2) expect(seq.filter((c) => c === 'codex').length * 7).toBeGreaterThanOrEqual(85);
    else expect(seq[19]).toBe('codex');
  });
  it('when the other CLI runs out the session is forced back; that is the only extra move', () => {
    const seq = simulate({ claude: { sess: 60, week: 90 }, codex: { sess: 50, week: 90 } });
    expect(switches(seq)).toBeLessThanOrEqual(2);
    // Phase 3: codex (half its window used, on pace to empty it) is not 7x cheaper, so the session stays until claude is out; any
    // second move is the forced one and comes several turns later.
    expect(seq.slice(0, 3)).toEqual(['claude', 'claude', 'claude']);
    const idx = seq.flatMap((c, i) => (i > 0 && c !== seq[i - 1] ? [i] : []));
    if (idx.length > 1) expect(idx[1]! - idx[0]!).toBeGreaterThanOrEqual(5);
  });
  it('equal CLIs never switch at all', () => {
    expect(switches(simulate({ claude: { sess: 90, week: 90 }, codex: { sess: 90, week: 90 } }, 1))).toBe(0);
  });
  it('going straight back to the CLI just left costs the switch-back points, only within the window', () => {
    const { ledger } = ledgerOf({ claude: { sess: 80, week: 80 }, codex: { sess: 80, week: 80 } });
    const base = route(lead({ continuity: 'codex' }), input(ledger))!;
    expect(base.cli).toBe('codex');
    const within = route(lead({ continuity: 'codex', left: { cli: 'claude', at: NOW - 5 * MIN } }), input(ledger))!;
    expect(within.scored!.find((s) => s.cli === 'claude')!.terms['switchBack']).toBe(-W.switchBack);
    const later = route(lead({ continuity: 'codex', left: { cli: 'claude', at: NOW - 2 * W.switchBackMs } }), input(ledger))!;
    expect(later.scored!.find((s) => s.cli === 'claude')!.terms['switchBack']).toBe(0);
  });
});

describe('h) needs, vision and tier fit still win', () => {
  it('a CLI lacking a required need is never chosen for its headroom', () => {
    const d = at({ claude: { sess: 8, week: 20 }, codex: { sess: 100, week: 100 } }, lead({ required: ['vision'] }));
    expect(d.cli).toBe('claude');
    expect(d.reason).toMatch(/codex\/default skipped: lacks required vision/);
  });
  it('high work is never downshifted below its floor to save quota', () => {
    const only = [cli('claude')];
    const d = at({ claude: { sess: 15, week: 60 } }, { role: 'implementer', complexity: 'high', needs: ['code'] }, {}, only);
    expect(d.model).toBe('claude-opus-5-5');
    // With the account pool scarce, Opus at low effort (fewer retries, the account-wide cost Sonnet at medium has) may undercut Sonnet
    // for medium work (was: Sonnet); what is guaranteed is that it never falls below the floor.
    for (const req of [{ role: 'planner', complexity: 'medium', needs: ['planning'] }, { role: 'implementer', complexity: 'medium', needs: ['code'], retry: true }] as RouteRequest[]) {
      const m = at({ claude: { sess: 15, week: 60 } }, req, {}, only);
      expect(['claude-sonnet-5-5', 'claude-opus-5-5']).toContain(m.model);
      expect(m.degraded).toBeUndefined();
    }
  });
  // Phase 3: difficulty 9 (beyond what Sonnet-class models reach by effort): high work at 8 may go to a weaker model at high effort
  // with a review when that is cheaper, which is the designed trade (was: complexity 'high' alone).
  it('work only the strong model can do stays on it while its pool is merely moderate', () => {
    const d = at({ claude: { sess: 50, week: 60 }, codex: { sess: 95, week: 95 } }, { role: 'implementer', complexity: 'high', difficulty: 9, needs: ['code'] });
    expect(d.model).toBe('claude-opus-5-5');
  });
  // Phase 3 (was: low headroom steps standard work one tier cheaper): a scarce pool raises every model's price alike, so it never
  // pushes work below its capability floor; the cheaper model is used only when it can do the work.
  it('a scarce pool never pushes work below what it needs', () => {
    const only = [cli('claude')];
    const d = at({ claude: { sess: 15, week: 60 } }, { role: 'implementer', complexity: 'medium', needs: ['code'] }, {}, only);
    expect(d.model).not.toBe('claude-haiku-5-5');
    expect(d.degraded).toBeUndefined();
    expect(at({ claude: { sess: 15, week: 60 } }, { role: 'reviewer', complexity: 'medium', needs: ['review'] }, {}, only).model).not.toBe('claude-haiku-5-5');
    expect(at({ claude: { sess: 15, week: 60 } }, { role: 'implementer', complexity: 'low', needs: ['code'] }, {}, only).model).toBe('claude-haiku-5-5');
  });
  it('a resumed session keeps its model: no step down (it would rewrite the prompt cache)', () => {
    const d = at({ claude: { sess: 15, week: 60 } }, { role: 'main', complexity: 'medium', tier: 'standard', needs: ['code'], keep: { cli: 'claude', model: 'sonnet' } }, {}, [cli('claude')]);
    expect(d.model).toBe('claude-sonnet-5-5');
  });
});

describe('i) an explicit request for a CLI still wins unless it is exhausted', () => {
  it('"use claude" while claude is nearly spent and the session sits on a healthy codex: claude', () => {
    const d = at({ claude: { sess: 6, week: 30 }, codex: { sess: 100, week: 100 } }, lead({ prefer: 'claude', continuity: 'codex' }));
    expect(d.cli).toBe('claude');
    expect(d.reason).toMatch(/claude requested by you/);
  });
  it('"use codex" is honoured over a healthy continuity; an exhausted codex is skipped and the reason says so', () => {
    expect(at({ claude: { sess: 90, week: 90 }, codex: { sess: 40, week: 40 } }, lead({ prefer: 'codex', continuity: 'claude' })).cli).toBe('codex');
    const d = at({ claude: { sess: 90, week: 90 }, codex: { sess: 0, week: 40 } }, lead({ prefer: 'codex', continuity: 'claude' }));
    expect(d.cli).toBe('claude');
    expect(d.reason).toMatch(/you asked for codex but it is unavailable/);
  });
});

describe('model-scoped windows', () => {
  it("claude's Opus-only window being spent does not push work that fits Sonnet off claude", () => {
    const { ledger, t } = ledgerOf({ claude: { sess: 90, week: 90 }, codex: { sess: 90, week: 90 } });
    ledger.record({ cli: 'claude', model: 'opus', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, limits: [{ period: 'weekly', usedPct: 97, resetsAt: t.now + 3 * DAY, scope: 'opus', asOf: t.now }] });
    const d = route(lead({ continuity: 'claude' }), input(ledger))!;
    expect(d).toMatchObject({ cli: 'claude', model: 'claude-sonnet-5-5' });
  });
});
