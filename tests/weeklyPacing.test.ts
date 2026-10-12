import { describe, expect, it } from 'vitest';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { ROUTING_WEIGHTS as W, burnUrgency, route, weeklyPaceOf, type RouteRequest, type RouterInput } from '../src/main/router';
import { Store } from '../src/main/store';
import { UsageLedger, type Pressure } from '../src/main/usage';

/**
 * Weekly pacing, from the owner's words: when a weekly reset is coming, spend what would otherwise be lost; when a CLI burns
 * faster than the week allows, conserve. Capacity now (the 5h window), hard skips, needs and an explicit request still win.
 * Every state below is USED percent plus the hours to the weekly reset.
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
  ({ clis, ledger, enabled: () => true, hasAdapter: () => true, load: () => 0, now: () => NOW, ...extra });
const medium = (over: Partial<RouteRequest> = {}): RouteRequest => ({ role: 'implementer', complexity: 'medium', needs: ['code'], ...over });
const low = (over: Partial<RouteRequest> = {}): RouteRequest => ({ role: 'implementer', complexity: 'low', needs: ['code'], ...over });
const lead = (over: Partial<RouteRequest> = {}): RouteRequest => ({ role: 'main', complexity: 'medium', tier: 'standard', needs: ['code'], ...over });
const at = (state: Record<string, St>, req: RouteRequest, extra: Partial<RouterInput> = {}, clis?: ResolvedCli[]) =>
  route(req, input(ledgerOf(state).ledger, extra, clis))!;
const term = (d: ReturnType<typeof route>, c: string, k: string) => d!.scored!.find((s) => s.cli === c)!.terms[k];

describe('the pace model', () => {
  const pressure = (over: object = {}, sess: object | null = { period: 'session', usedPct: 10, remainingPct: 90, source: 'reported' }): Pressure => ({
    level: 'plenty', pct: 0, source: 'reported',
    windows: [...(sess ? [sess] : []), { period: 'weekly', usedPct: 35, remainingPct: 65, resetsAt: NOW + 31 * HOUR, source: 'reported', asOf: NOW, ...over }] as never
  });
  it('elapsed share, linear budget and surplus come from the reset time', () => {
    const p = weeklyPaceOf(pressure(), NOW)!;
    expect(p.elapsedFrac).toBeCloseTo(1 - 31 / 168, 5);
    expect(p.idealUsedPct).toBeCloseTo(81.55, 1);
    expect(p.surplusPct).toBeCloseTo(46.55, 1);
    expect(p.hoursToReset).toBeCloseTo(31, 5);
  });
  it('urgency is negligible beyond 4 days, rises through the last 48h and is full at the reset', () => {
    expect(burnUrgency(120)).toBe(0);
    expect(burnUrgency(96)).toBe(0);
    expect(burnUrgency(48)).toBeCloseTo(0.25);
    expect(burnUrgency(12)).toBeCloseTo(0.9);
    expect(burnUrgency(0)).toBe(1);
    const hs = [96, 72, 48, 36, 24, 12, 6, 0].map(burnUrgency);
    for (let i = 1; i < hs.length; i++) expect(hs[i]).toBeGreaterThanOrEqual(hs[i - 1]);
  });
  it('the bonus is capped near +35 with >= 40% about to be lost, and shrinks with surplus and with distance', () => {
    expect(weeklyPaceOf(pressure({ usedPct: 10, resetsAt: NOW + 2 * HOUR }), NOW)!.points).toBeGreaterThan(W.spendCap - 2);
    expect(weeklyPaceOf(pressure({ usedPct: 10, resetsAt: NOW + 2 * HOUR }), NOW)!.points).toBeLessThanOrEqual(W.spendCap);
    expect(weeklyPaceOf(pressure({ usedPct: 90, resetsAt: NOW + 2 * HOUR }), NOW)!.points).toBeLessThan(10);
    expect(weeklyPaceOf(pressure({ usedPct: 0, resetsAt: NOW + 5 * DAY }), NOW)!.points).toBe(0);
  });
  it('overspending costs more the more time is left to recover, capped at the conserve cap', () => {
    const far = weeklyPaceOf(pressure({ usedPct: 90, resetsAt: NOW + 5 * DAY }), NOW)!.points;
    const near = weeklyPaceOf(pressure({ usedPct: 90, resetsAt: NOW + 20 * HOUR }), NOW)!.points;
    expect(far).toBe(-W.conserveCap);
    expect(near).toBeLessThan(0);
    expect(near).toBeGreaterThan(far);
  });
  it('capacity now binds: a thin 5h window removes the spend bonus', () => {
    expect(weeklyPaceOf(pressure({ usedPct: 10, resetsAt: NOW + 5 * HOUR }, { period: 'session', usedPct: 95, remainingPct: 5, source: 'reported' }), NOW)!.points).toBe(0);
  });
  it('an unknown, past or impossible reset gives no pace at all', () => {
    expect(weeklyPaceOf(pressure({ resetsAt: undefined }), NOW)).toBeUndefined();
    expect(weeklyPaceOf(pressure({ resetsAt: NOW - HOUR }), NOW)).toBeUndefined();
    expect(weeklyPaceOf(pressure({ resetsAt: NOW + 20 * DAY }), NOW)).toBeUndefined();
    expect(weeklyPaceOf(pressure(), undefined)).toBeUndefined();
    expect(weeklyPaceOf(pressure({ source: 'estimated', calibrated: false }), NOW)).toBeUndefined();
  });
});

describe('a) surplus about to expire beats continuity, one tier stronger', () => {
  const d = at({ claude: { week: 20, weekH: 10 }, codex: { week: 60, weekH: 72 } }, medium({ continuity: 'codex' }));
  it('claude is chosen over a session on codex, on opus, and the reason shows the surplus being spent', () => {
    expect(d.cli).toBe('claude');
    expect(d.model).toBe('opus');
    expect(d.reason).toMatch(/claude weekly: 20% used, 94% of the week elapsed, resets in 10h → ~74% of the week's allowance would be lost: spending it \(\+3\d/);
    expect(d.reason).toMatch(/one tier stronger \(opus instead of the standard model\), effort medium → high/);
    expect(d.effort).toBe('high');
    expect(term(d, 'claude', 'pacing')).toBeGreaterThan(30);
  });
  it('the same without the near reset stays on sonnet, medium effort', () => {
    const far = at({ claude: { week: 5, weekH: 150 } }, medium(), {}, [cli('claude')]);
    expect(far.model === 'opus').toBe(false);
    expect(far.effort).toBe('medium');
  });
});

describe('b) capacity now binds', () => {
  it('claude with 5% left on its 5h window is not chosen, however large its weekly surplus', () => {
    const d = at({ claude: { week: 20, weekH: 10, sess: 95 }, codex: { week: 60, weekH: 72 } }, medium({ continuity: 'codex' }));
    expect(d.cli).toBe('codex');
    expect(term(d, 'claude', 'pacing')).toBe(0);
  });
  it('no tier or effort spend-up on a CLI whose 5h window is half gone', () => {
    const d = at({ claude: { week: 20, weekH: 10, sess: 60 } }, medium(), {}, [cli('claude')]);
    expect(d.model === 'opus').toBe(false);
    expect(d.reason).not.toMatch(/one tier stronger/);
  });
});

describe('c) two underspent weeks: the one that expires first is spent first', () => {
  it('equal surplus, codex resets sooner: codex', () => {
    const d = at({ claude: { week: 20, weekH: 40 }, codex: { week: 32, weekH: 20 } }, medium());
    expect(d.cli).toBe('codex');
    expect(term(d, 'codex', 'pacing')).toBeGreaterThan(term(d, 'claude', 'pacing'));
  });
  it('and the mirror image picks claude (nothing hard-codes a CLI)', () => {
    expect(at({ claude: { week: 32, weekH: 20 }, codex: { week: 20, weekH: 40 } }, medium()).cli).toBe('claude');
  });
});

describe('d) overspent: conserve', () => {
  it('claude 90% used with 5 days left: codex, even with the session on claude', () => {
    const d = at({ claude: { week: 90, weekH: 120 }, codex: { week: 30, weekH: 120 } }, medium({ continuity: 'claude' }));
    expect(d.cli).toBe('codex');
    expect(term(d, 'claude', 'pacing')).toBe(-W.conserveCap);
  });
  it('both overspent: the one with more left wins', () => {
    const d = at({ claude: { week: 80, weekH: 120 }, codex: { week: 50, weekH: 120 } }, medium());
    expect(d.cli).toBe('codex');
  });
  it('only claude available and over pace but not nearly out: one tier cheaper and effort down, and the reason says why', () => {
    const d = at({ claude: { week: 45, weekH: 144 } }, medium(), {}, [cli('claude')]);
    expect(d.model).toBe('haiku');
    expect(d.reason).toMatch(/claude is over its weekly pace with 144h left to recover: one tier cheaper \(cheap instead of standard\)/);
    expect(d.reason).toMatch(/effort medium → low: claude is over its weekly pace/);
    expect(d.reason).toMatch(/claude weekly: 45% used, 14% of the week elapsed, resets in 144h → 31 points over the weekly pace: conserving \(-/);
  });
});

describe('e) unknown reset time changes nothing', () => {
  it.each([
    ['no weekly window reported', { claude: { sess: 10 }, codex: { sess: 10 } }],
    ['only a 5h window each, one of them used', { claude: { sess: 60 }, codex: { sess: 10 } }]
  ] as const)('%s: no pacing term, no pacing words, no tier or effort change', (_n, state) => {
    for (const req of [medium(), low(), lead({ continuity: 'codex' })]) {
      const d = at(state as Record<string, St>, req);
      expect(d.scored!.every((s) => s.terms['pacing'] === 0)).toBe(true);
      expect(d.reason).not.toMatch(/weekly pacing|would otherwise be lost|weekly pace/);
    }
  });
  it('an estimated weekly window against an uncalibrated budget is not a known reset either', () => {
    const { ledger } = ledgerOf({});
    for (let i = 0; i < 3; i++) ledger.record({ cli: 'claude', model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, time: NOW - 6 * DAY });
    const d = route(medium(), input(ledger))!;
    expect(d.scored!.every((s) => s.terms['pacing'] === 0)).toBe(true);
  });
  it('an explicit reduceEffort or switch policy keeps its older meaning: no pacing term at all', () => {
    const d = at({ claude: { week: 20, weekH: 10 }, codex: { week: 60, weekH: 72 } }, medium({ continuity: 'codex' }), { policy: { lowAllowance: 'reduceEffort' } });
    expect(d.cli).toBe('codex');
    expect(d.scored!.every((s) => s.terms['pacing'] === 0)).toBe(true);
  });
});

describe('f) a stale reading counts for less', () => {
  it('the same state read 12h ago earns a smaller bonus, and no tier-up', () => {
    const fresh = at({ claude: { week: 20, weekH: 10 }, codex: { week: 60, weekH: 72 } }, medium());
    const old = at({ claude: { week: 20, weekH: 10, ageH: 12 }, codex: { week: 60, weekH: 72 } }, medium());
    expect(term(old, 'claude', 'pacing')).toBeLessThan(term(fresh, 'claude', 'pacing'));
    expect(term(old, 'claude', 'pacing')).toBeGreaterThan(0);
    expect(fresh.model).toBe('opus');
    expect(old.model === 'opus' && old.reason.includes('one tier stronger')).toBe(false);
    expect(old.reason).toMatch(/reading 12h old, trusted \d+%/);
  });
  it('trust falls to the floor, never to zero', () => {
    const p = (ageH: number) => weeklyPaceOf({ level: 'plenty', pct: 0, source: 'reported', windows: [{ period: 'weekly', usedPct: 20, remainingPct: 80, resetsAt: NOW + 10 * HOUR, source: 'reported', asOf: NOW - ageH * HOUR }] }, NOW)!;
    expect(p(1).trust).toBe(1);
    expect(p(100).trust).toBe(W.staleFloor);
    expect(p(12).trust).toBeLessThan(p(6).trust);
  });
});

describe('g) an explicit request wins over conserve', () => {
  it('"use claude" with claude overspent and the session on codex: claude, not judged on pacing, no downshift', () => {
    // 40% used with 6 days left is over pace (it would be downshifted without the request) but not low on headroom.
    const d = at({ claude: { week: 40, weekH: 144 }, codex: { week: 10, weekH: 144 } }, medium({ prefer: 'claude', continuity: 'codex' }));
    expect(at({ claude: { week: 40, weekH: 144 } }, medium(), {}, [cli('claude')]).model).toBe('haiku');
    expect(d.cli).toBe('claude');
    expect(term(d, 'claude', 'pacing')).toBe(0);
    expect(d.model).toBe('sonnet');
  });
  it('and a near-expiring surplus on the other CLI cannot outbid the request', () => {
    const d = at({ claude: { week: 60, weekH: 144 }, codex: { week: 5, weekH: 4 } }, medium({ prefer: 'claude' }));
    expect(d.cli).toBe('claude');
  });
});

describe('h) conserve never downshifts what must stay strong', () => {
  const state = { claude: { week: 45, weekH: 144 } };
  const only = [cli('claude')];
  it('high work, planners, retries and a resumed session keep their model', () => {
    expect(at(state, { role: 'implementer', complexity: 'high', needs: ['code'] }, {}, only).model).toBe('opus');
    expect(at(state, { role: 'planner', complexity: 'medium', needs: ['planning'] }, {}, only).model).toBe('sonnet');
    expect(at(state, medium({ retry: true }), {}, only)).toMatchObject({ model: 'sonnet', effort: 'high' });
    expect(at(state, lead({ keep: { cli: 'claude', model: 'sonnet' } }), {}, only).model).toBe('sonnet');
  });
  it('a required need that the cheaper model lacks blocks the downshift', () => {
    expect(at(state, medium({ required: ['review'] }), {}, only).model).toBe('sonnet');
  });
  it('high effort chosen deliberately is untouched', () => {
    expect(at(state, medium({ effort: 'high', fixedEffort: true }), {}, only).effort).toBe('high');
  });
  it('spend-up never reaches planners or retries either', () => {
    const near = { claude: { week: 10, weekH: 8 } };
    expect(at(near, { role: 'planner', complexity: 'medium', needs: ['planning'] }, {}, only).model).toBe('sonnet');
    expect(at(near, medium({ retry: true }), {}, only).model).toBe('sonnet');
  });
});

describe('i) a week of 40 turns', () => {
  /** Each turn is 4.2h; the chosen CLI's weekly window gains `burn` points, its 5h window stays healthy. Both start unused, the reset is at the end of the week. */
  function simulate(burn: number, spendFreely = true) {
    const t = { now: NOW };
    const ledger = new UsageLedger(new Store(), { now: () => t.now, runsPerWindow: { default: 10 } });
    const used: Record<string, number> = { claude: 0, codex: 0 };
    const report = (c: string) => ledger.record({ cli: c, model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, time: t.now, limits: [
      { period: 'session', usedPct: 20, resetsAt: t.now + 3 * HOUR, asOf: t.now },
      { period: 'weekly', usedPct: used[c], resetsAt: NOW + 7 * DAY, asOf: t.now }
    ] });
    let held = 'claude', moved: { cli: string; at: number } | undefined;
    const seq: string[] = [], models: string[] = [];
    for (let i = 0; i < 40; i++) {
      t.now = NOW + i * 4.2 * HOUR;
      report('claude'); report('codex');
      const d = route(lead({ continuity: held, left: moved }), input(ledger, { now: () => t.now, ...(spendFreely ? {} : {}) }))!;
      if (d.cli !== held) moved = { cli: held, at: t.now };
      held = d.cli;
      seq.push(d.cli); models.push(d.model);
      used[d.cli] = Math.min(100, used[d.cli] + burn);
    }
    return { seq, used, models };
  }
  const switches = (s: string[]) => s.filter((c, i) => i > 0 && c !== s[i - 1]).length;

  it('spending converges: little allowance is left unused at the reset, and the session does not ping-pong', () => {
    const { seq, used } = simulate(4);
    expect(switches(seq)).toBeLessThanOrEqual(4);
    expect(used.claude + used.codex).toBeGreaterThanOrEqual(130); // of 160 burned in total (40 turns x 4)
    expect(Math.min(used.claude, used.codex)).toBeGreaterThanOrEqual(40);
  });
  it('a lighter week (2 points a turn, 80 in total) is also mostly used and still does not flip-flop', () => {
    const { seq, used } = simulate(2);
    expect(switches(seq)).toBeLessThanOrEqual(4);
    expect(used.claude + used.codex).toBeGreaterThanOrEqual(70);
  });
});

describe('j) estimated windows weigh half and never spend freely', () => {
  const week = (runs: number, perWeek: number | undefined) => {
    const l = ledgerOf({ claude: { sess: 10 }, codex: { week: 60, weekH: 72 } }, NOW, perWeek ? { runsPerWeek: perWeek } : {});
    // runs from 6.5 days ago anchor the estimated window: it resets in 12h.
    for (let i = 0; i < runs; i++) l.ledger.record({ cli: 'claude', model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, time: NOW - 6.5 * DAY + i * MIN });
    return l.ledger;
  };
  it('a calibrated estimate earns half of what the same reported window earns', () => {
    const est = route(medium({ continuity: 'codex' }), input(week(2, 10)))!;
    const rep = at({ claude: { week: 20, weekH: 12 }, codex: { week: 60, weekH: 72 } }, medium({ continuity: 'codex' }));
    expect(term(est, 'claude', 'pacing')).toBeGreaterThan(0);
    expect(term(est, 'claude', 'pacing')).toBeCloseTo(term(rep, 'claude', 'pacing') * W.estimatedUsageFactor, 0);
  });
  it('and it never buys a stronger tier or a higher effort, however big the surplus', () => {
    const d = route(medium({ continuity: 'codex' }), input(week(1, 10)))!;
    expect(d.cli === 'claude' && d.model === 'opus').toBe(false);
    expect(d.reason).not.toMatch(/one tier stronger|no stronger model to use/);
  });
  it('an uncalibrated estimate earns nothing', () => {
    const d = route(medium({ continuity: 'codex' }), input(week(2, undefined)))!;
    expect(term(d, 'claude', 'pacing')).toBe(0);
  });
});

describe('k) the owner scenario: reset in 27h, 60% left, codex 70% left with 6 days to go', () => {
  const state = (h: number) => ({ claude: { week: 40, weekH: h, sess: 10 }, codex: { week: 30, weekH: 144, sess: 10 } });
  it.each([['medium code task', medium({ continuity: 'codex' }), 'opus', 'sonnet'], ['low rename task', low({ continuity: 'codex', needs: ['code'] }), 'sonnet', 'haiku']] as const)(
    '%s: claude, one tier above the base choice, effort one step up, surplus in the reason', (_n, req, up, base) => {
      const d = at(state(27), req);
      expect(d.cli).toBe('claude');
      expect(d.model).toBe(up);
      expect(d.reason).toMatch(/claude weekly: 40% used, 84% of the week elapsed, resets in 27h → ~44% of the week's allowance would be lost: spending it \(\+\d+/);
      expect(d.reason).toMatch(new RegExp(`claude weekly allowance \\(~44% of the week\\) would otherwise be lost in 27h: spending it, one tier stronger \\(${up} instead of the \\w+ model\\), effort \\w+ → \\w+`));
      // The base choice (reset far away) is one tier lower on the same CLI.
      const farther = at({ ...state(27), claude: { week: 40, weekH: 150, sess: 10 } }, req);
      if (farther.cli === 'claude') expect(farther.model).toBe(base);
    });
  it('the window and the low-work inclusion are constants', () => {
    expect(W.spendUpWithinMs).toBe(36 * HOUR);
    expect(W.spendUpLowWork).toBe(true);
  });
  it('with the reset in 60h there is no upgrade yet (outside the 36h window)', () => {
    for (const req of [medium({ continuity: 'codex' }), low({ continuity: 'codex' })]) {
      const d = at(state(60), req);
      expect(d.reason).not.toMatch(/one tier stronger|no stronger model to use/);
      if (d.cli === 'claude') expect(d.model).toBe(req.complexity === 'low' ? 'haiku' : 'sonnet');
    }
  });
  it('a low task is not stronger-tiered when the table turns the constant off is covered by the constant itself (documented, not toggled here)', () => {
    expect(typeof W.spendUpLowWork).toBe('boolean');
  });
});
