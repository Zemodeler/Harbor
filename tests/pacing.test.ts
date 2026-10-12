import { describe, expect, it } from 'vitest';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { ROUTING_WEIGHTS as W, headroomOf, route, type RouteRequest, type RouterInput } from '../src/main/router';
import { Store } from '../src/main/store';
import { UsageLedger } from '../src/main/usage';

/**
 * Headroom routing, from the owner's words: a subscription with 10% left should hand work to one with 90% left (both the 5h and
 * the weekly window count), without flip-flopping on small gaps, and otherwise behave like plain Claude Code or Codex.
 * Every number below is REMAINING percent, 5h first, then weekly.
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
  ({ clis, ledger, enabled: () => true, hasAdapter: () => true, load: () => 0, now: () => NOW, ...extra });
const lead = (over: Partial<RouteRequest> = {}): RouteRequest => ({ role: 'main', complexity: 'medium', tier: 'standard', needs: ['code'], ...over });
const at = (state: Record<string, Win>, req: RouteRequest, extra: Partial<RouterInput> = {}, clis?: ResolvedCli[]) =>
  route(req, input(ledgerOf(state).ledger, extra, clis))!;

describe('headroom constants', () => {
  it('the stickiness sits between continuity and a settings preference; the whole term stays under an explicit request', () => {
    expect(W.switchGap).toBeGreaterThan(W.continuity);
    expect(W.switchGap).toBeLessThan(W.preferred);
    expect(W.headroomCap).toBeLessThan(W.requested);
    expect(W.headroomCurve[W.headroomCurve.length - 1][1]).toBeLessThanOrEqual(W.headroomCap);
    expect(W.switchBack).toBeLessThan(W.switchGap);
  });
  it('the curve is monotone: less remaining never costs less', () => {
    const pts = [100, 95, 90, 70, 60, 50, 40, 30, 25, 15, 10, 5, 0].map((r) => headroomOf({ level: 'plenty', pct: 100 - r, source: 'reported' }).penalty);
    for (let i = 1; i < pts.length; i++) expect(pts[i]).toBeGreaterThanOrEqual(pts[i - 1]);
    expect(pts[0]).toBe(0);
  });
});

describe('headroomOf: both windows, pace, estimates', () => {
  const win = (over: object) => ({ period: 'session' as const, usedPct: 0, remainingPct: 100, source: 'reported' as const, ...over });
  const p = (...windows: object[]) => ({ level: 'plenty' as const, pct: 0, source: 'reported' as const, windows: windows.map(win) as never });

  it('the tighter window binds, whichever it is', () => {
    expect(headroomOf(p({ usedPct: 20, remainingPct: 80 }, { period: 'weekly', usedPct: 92, remainingPct: 8 })).remainingPct).toBe(8);
    expect(headroomOf(p({ usedPct: 92, remainingPct: 8 }, { period: 'weekly', usedPct: 20, remainingPct: 80 })).remainingPct).toBe(8);
  });
  it('a weekly window on pace to run out keeps only part of what is left; one that is fine is not touched', () => {
    const slow = headroomOf(p({ period: 'weekly', usedPct: 50, remainingPct: 50, projectedPct: 80 }));
    const fast = headroomOf(p({ period: 'weekly', usedPct: 50, remainingPct: 50, projectedPct: 200 }));
    expect(slow.remainingPct).toBe(50);
    expect(fast.remainingPct).toBe(25);
    expect(fast.windows[0].paced).toBe(true);
    expect(headroomOf(p({ period: 'weekly', usedPct: 95, remainingPct: 5, projectedPct: 900 })).remainingPct).toBeCloseTo(5 * W.paceFloor);
  });
  it('a 5h window about to reset is not paced down (capacity now), one that resets later is', () => {
    const w = { usedPct: 70, remainingPct: 30, projectedPct: 150 };
    expect(headroomOf(p({ ...w, resetsAt: NOW + 20 * MIN }), NOW).remainingPct).toBe(30);
    expect(headroomOf(p({ ...w, resetsAt: NOW + 3 * HOUR }), NOW).remainingPct).toBeLessThan(30);
  });
  it('an estimate counts used% for the estimate factor only; without windows it falls back to the single reading', () => {
    expect(headroomOf(p({ usedPct: 80, remainingPct: 20, source: 'estimated' })).remainingPct).toBe(100 - 80 * W.estimatedUsageFactor);
    expect(headroomOf({ level: 'low', pct: 85, source: 'reported' }).remainingPct).toBe(15);
  });
});

describe('a) a big gap beats continuity', () => {
  it('claude 10%/20% vs codex 90%/90%: codex, even with the session on claude, and the reason shows both windows of both CLIs', () => {
    const d = at({ claude: { sess: 10, week: 20 }, codex: { sess: 90, week: 90 } }, lead({ continuity: 'claude' }));
    expect(d.cli).toBe('codex');
    expect(d.reason).toMatch(/headroom \(both windows count, the tighter binds\): codex: 5h 10% used.*weekly 10% used.*; claude: 5h 90% used.*weekly 80% used.* → codex/);
    expect(d.scored![0].headroom!.windows.map((w) => w.period).sort()).toEqual(['session', 'weekly']);
    expect(d.scored![0].headroom!.remainingPct).toBeGreaterThan(d.scored![1].headroom!.remainingPct);
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

describe('c) the 5h window binds now, however full the week is', () => {
  const claude = { sess: 5, week: 90, sessResetsIn: 20 * MIN };
  it('claude 5h 5% left (resets in 20 min) with 90% weekly vs codex 70%/70%: codex, and the reason does not pace-discount the 5h window', () => {
    const d = at({ claude, codex: { sess: 70, week: 70 } }, lead({ continuity: 'claude' }));
    expect(d.cli).toBe('codex');
    expect(d.reason).toMatch(/claude: 5h 95% used \(resets in 20m\)/);
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
    expect(d.reason).toMatch(/claude: 5h 0% used.*weekly 95% used \(pace → ~\d+% at reset: runs out before it/);
  });
  it('a weekly window with plenty left and a distant reset is abundant: a thin 5h window on the other CLI does not pull the session', () => {
    const d = at({ claude: { sess: 80, week: 90, weekResetsIn: 6 * DAY }, codex: { sess: 100, week: 100 } }, lead({ continuity: 'claude' }));
    expect(d.cli).toBe('claude');
  });
});

describe('e) both low: more headroom wins, effort steps down', () => {
  it('claude 15%/30% vs codex 20%/40%, nothing held: codex; effort drops one step and says why', () => {
    const d = at({ claude: { sess: 15, week: 30 }, codex: { sess: 20, week: 40 } }, lead());
    expect(d.cli).toBe('codex');
    expect(d.effort).toBe('low');
    expect(d.reason).toMatch(/effort lowered: allowance low/);
  });
});

describe('f) estimates weigh less than provider readings', () => {
  it("Harbor's own 90% count keeps the session; a reported 90% moves it", () => {
    const est = ledgerOf({ codex: { sess: 100, week: 100 } });
    for (let i = 0; i < 9; i++) est.ledger.record({ cli: 'claude', model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true });
    const a = route(lead({ continuity: 'claude' }), input(est.ledger))!;
    expect(a.cli).toBe('claude');
    expect(a.reason).toMatch(/claude: 5h 90% used \(est\.\)/);
    const b = at({ claude: { sess: 10, week: 100 }, codex: { sess: 100, week: 100 } }, lead({ continuity: 'claude' }));
    expect(b.cli).toBe('codex');
  });
});

describe('g) hysteresis over 20 lead turns', () => {
  /** Each turn burns the chosen CLI's 5h window by `burn` points (7 by default) and its week by 1; the session follows the choice. */
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
      t.now = NOW + i * 2 * MIN;
      const d = route(lead({ continuity: held, left: moved }), input(ledger, { now: () => t.now }));
      if (!d) break; // both exhausted
      if (held && d.cli !== held) moved = { cli: held, at: t.now };
      held = d.cli;
      seq.push(d.cli);
      left[d.cli].sess = Math.max(0, left[d.cli].sess - burn);
      left[d.cli].week = Math.max(0, left[d.cli].week - 1);
      report(d.cli);
    }
    return seq;
  }
  const switches = (s: string[]) => s.filter((c, i) => i > 0 && c !== s[i - 1]).length;

  it('a big gap switches once and never ping-pongs back while the other CLI is not exhausted', () => {
    const seq = simulate({ claude: { sess: 80, week: 90 }, codex: { sess: 95, week: 90 } });
    // claude holds the session until the gap exceeds the stickiness, then it moves exactly once.
    expect(seq[0]).toBe('claude');
    expect(switches(seq)).toBe(1);
    expect(seq[19]).toBe('codex');
  });
  it('when the other CLI runs out the session is forced back; that is the only extra move', () => {
    const seq = simulate({ claude: { sess: 60, week: 90 }, codex: { sess: 50, week: 90 } });
    expect(switches(seq)).toBeLessThanOrEqual(2);
    // The first move is a gap move (claude ran low, codex had room); the second only comes when codex, now burning, is spent: it is the forced one.
    expect(seq.slice(0, 3)).toEqual(['claude', 'claude', 'claude']);
    const idx = seq.flatMap((c, i) => (i > 0 && c !== seq[i - 1] ? [i] : []));
    expect(idx[1] - idx[0]).toBeGreaterThanOrEqual(5);
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
  it('high work is never downshifted to save headroom', () => {
    const only = [cli('claude')];
    const d = at({ claude: { sess: 15, week: 60 } }, { role: 'implementer', complexity: 'high', needs: ['code'] }, {}, only);
    expect(d.model).toBe('opus');
    expect(at({ claude: { sess: 15, week: 60 } }, { role: 'planner', complexity: 'medium', needs: ['planning'] }, {}, only).model).toBe('sonnet');
    expect(at({ claude: { sess: 15, week: 60 } }, { role: 'implementer', complexity: 'medium', needs: ['code'], retry: true }, {}, only).model).toBe('sonnet');
  });
  it('a strong request stays on the strong model while headroom is merely moderate', () => {
    const d = at({ claude: { sess: 50, week: 60 }, codex: { sess: 95, week: 95 } }, { role: 'implementer', complexity: 'high', needs: ['code'] });
    expect(d.model).toBe('opus');
  });
  it('low headroom steps standard work one tier cheaper on that CLI, says so, and never below what the work needs', () => {
    const only = [cli('claude')];
    const d = at({ claude: { sess: 15, week: 60 } }, { role: 'implementer', complexity: 'medium', needs: ['code'] }, {}, only);
    expect(d.model).toBe('haiku');
    expect(d.reason).toMatch(/claude headroom low \(~\d+% left\): one tier cheaper \(cheap instead of standard\)/);
    expect(d.degraded).toBeUndefined();
    // haiku has no 'review' strength in the catalog: the step down would drop below the need.
    expect(at({ claude: { sess: 15, week: 60 } }, { role: 'reviewer', complexity: 'medium', needs: ['review'] }, {}, only).model).toBe('sonnet');
    // Comfortable headroom: no step down.
    expect(at({ claude: { sess: 70, week: 70 } }, { role: 'implementer', complexity: 'medium', needs: ['code'] }, {}, only).model).toBe('sonnet');
  });
  it('a resumed session keeps its model: no step down (it would rewrite the prompt cache)', () => {
    const d = at({ claude: { sess: 15, week: 60 } }, { role: 'main', complexity: 'medium', tier: 'standard', needs: ['code'], keep: { cli: 'claude', model: 'sonnet' } }, {}, [cli('claude')]);
    expect(d.model).toBe('sonnet');
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
    expect(d).toMatchObject({ cli: 'claude', model: 'sonnet' });
  });
});
