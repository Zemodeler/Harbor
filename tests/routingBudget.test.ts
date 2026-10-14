import { describe, expect, it } from 'vitest';
import { poolsOfEntry } from '../src/main/budget';
import { expectedTokens } from '../src/main/budgetCost';
import { poolPctPrior } from '../src/main/budgetPriors';
import { DEFAULT_CATALOG, entryFor } from '../src/main/clis/capabilities';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { difficultyOf, raiseDifficulty } from '../src/main/difficulty';
import { explainNoRoute, route, type RouteDecision, type RouteRequest, type RouterInput } from '../src/main/router';
import { helperBurnPctPerHour, poolInputsFromLedger, statesOf } from '../src/main/routePrice';
import { maxHelpers } from '../src/main/budget';
import { Store } from '../src/main/store';
import { UsageLedger } from '../src/main/usage';

/**
 * Phase 3: the router picks model AND effort by calculation. Every scenario below is a claim from the redesign; the numbers come from
 * the built-in catalog and the Phase 2 priors, with quota states set through provider readings like the real ones.
 */
const NOW = 50_000_000_000;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

const cli = (id: string, over: Partial<ResolvedCli> = {}): ResolvedCli =>
  ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'], ...over });

interface Reading { period: 'session' | 'weekly'; used: number; inH: number; scope?: string }
/** A ledger whose providers reported these windows just now (used %, hours to reset, optional model scope). */
function ledgerOf(readings: Record<string, Reading[]>) {
  const ledger = new UsageLedger(new Store(), { now: () => NOW, runsPerWindow: { default: 1000 } });
  for (const [c, rs] of Object.entries(readings)) {
    ledger.record({ cli: c, model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, time: NOW, limits: rs.map((r) => ({ period: r.period, usedPct: r.used, resetsAt: NOW + r.inH * HOUR, asOf: NOW, ...(r.scope ? { scope: r.scope } : {}) })) });
  }
  return ledger;
}
const input = (ledger: UsageLedger, clis: ResolvedCli[] = [cli('claude')], extra: Partial<RouterInput> = {}): RouterInput =>
  ({ clis, ledger, enabled: () => true, hasAdapter: () => true, load: () => 0, now: () => NOW, ...extra });
const healthy5h: Reading = { period: 'session', used: 10, inH: 2 };
const pick = (d: RouteDecision | undefined) => (d ? `${d.cli}/${d.model} ${d.effort}` : 'none');

describe('budget routing: model and effort by price', () => {
  it('low difficulty with the Opus pool (and the account) about to expire unused: Opus at low effort', () => {
    const near = ledgerOf({ claude: [healthy5h, { period: 'weekly', used: 30, inH: 10 }, { period: 'weekly', used: 20, inH: 10, scope: 'opus' }] });
    const d = route({ role: 'implementer', complexity: 'low', difficulty: 2, size: 'small', needs: ['code'] }, input(near))!;
    expect(pick(d)).toBe('claude/claude-opus-5-5 low');
    expect(d.price!.wasteCreditPct).toBeGreaterThan(0);
    expect(d.reason).toMatch(/would expire unused/);
    // The same quota five days before its reset is not lost yet: the cheap model takes the easy work.
    const far = ledgerOf({ claude: [healthy5h, { period: 'weekly', used: 30, inH: 120 }, { period: 'weekly', used: 20, inH: 120, scope: 'opus' }] });
    expect(pick(route({ role: 'implementer', complexity: 'low', difficulty: 2, size: 'small', needs: ['code'] }, input(far)))).toBe('claude/claude-haiku-5-5 low');
  });

  it.each([
    ['conserve', 45],
    ['protect', 55]
  ] as const)('high difficulty with the Opus pool in %s: Sonnet at high effort, marked for review', (state, opusUsed) => {
    const ledger = ledgerOf({ claude: [healthy5h, { period: 'weekly', used: 25, inH: 96 }, { period: 'weekly', used: opusUsed, inH: 96, scope: 'opus' }] });
    const inp = input(ledger);
    const states = statesOf(poolInputsFromLedger(ledger, DEFAULT_CATALOG, ['claude']), NOW, 0, false);
    expect(states['claude:opus']!.state).toBe(state);
    const d = route({ role: 'implementer', complexity: 'high', difficulty: 8, needs: ['code'] }, inp)!;
    expect(pick(d)).toBe('claude/claude-sonnet-5-5 high');
    expect(d.needsReview).toBe(true);
    expect(d.reviewReason).toMatch(/only just clears difficulty 8/);
    expect(d.degraded).toBeUndefined();
    expect(d.reason).toMatch(/needs review:/);
    // With the Opus pool comfortable, Opus does the high work.
    const fine = ledgerOf({ claude: [healthy5h, { period: 'weekly', used: 25, inH: 96 }, { period: 'weekly', used: 10, inH: 96, scope: 'opus' }] });
    expect(route({ role: 'implementer', complexity: 'high', difficulty: 8, needs: ['code'] }, input(fine))!.model).toBe('claude-opus-5-5');
  });

  it('effort rises before the model does when that is cheaper', () => {
    const ledger = ledgerOf({});
    const at = (difficulty: number) => pick(route({ role: 'implementer', complexity: 'medium', difficulty, needs: ['code'] }, input(ledger)));
    expect(at(2)).toBe('claude/claude-haiku-5-5 low');
    // Phase 5: at 3 Haiku only just clears at low effort (12% risk); with low effort 0.8x the tokens of medium (was 0.6x), one more
    // effort step is cheaper than a likely redo (was: Haiku low).
    expect(at(3)).toBe('claude/claude-haiku-5-5 medium');
    expect(at(4)).toBe('claude/claude-haiku-5-5 high');
    expect(at(5)).toBe('claude/claude-sonnet-5-5 medium');
  });

  it('a premium model (autoRoute false) is never chosen automatically, even when it is the only one that clears', () => {
    const ledger = ledgerOf({ claude: [healthy5h, { period: 'weekly', used: 20, inH: 6, scope: 'fable' }] });
    ledger.record({ cli: 'claude', model: 'opus', projectId: 'p', agentId: 'a', durationMs: 1, ok: false, rateLimited: true });
    const d = route({ role: 'implementer', complexity: 'high', difficulty: 10, needs: ['code'] }, input(ledger))!;
    expect(d.model).not.toBe('claude-fable-5-1');
    expect(d.skipped).toContainEqual(expect.objectContaining({ model: 'claude-fable-5-1', why: 'not auto-routed' }));
    expect(d).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high', needsReview: true, degraded: { wantedTier: 'strong', gotTier: 'standard' } });
    // Named in the settings, it may be used.
    const named = route({ role: 'implementer', complexity: 'high', difficulty: 10, needs: ['code'] }, input(ledger, [cli('claude')], { policy: { preference: { cli: 'claude', model: 'claude-fable-5-1' } } }))!;
    expect(named.model).toBe('claude-fable-5-1');
  });
});

describe('difficulty: the lead\'s rating is a hint, clamped', () => {
  it('a lead that rates twelve ordinary helpers "high" gets none above 7, and no reviewer above medium', () => {
    const tasks = Array.from({ length: 12 }, (_, i) => ({
      role: (['implementer', 'reviewer', 'other', 'planner'] as const)[i % 4],
      text: `Update the handler in src/feature${i}.ts and add a test for the new branch.`,
      files: i % 3 === 0 ? [] : [`src/feature${i}.ts`, `tests/feature${i}.test.ts`].slice(0, 1 + (i % 2)),
      readOnly: i % 4 === 1 || i % 4 === 2
    }));
    for (const t of tasks) {
      const d = difficultyOf({ ...t, hint: 'high' });
      expect(d.difficulty, JSON.stringify(t)).toBeLessThanOrEqual(7);
      if (t.role === 'reviewer' || (t.role === 'other' && t.readOnly)) expect(d.difficulty).toBeLessThanOrEqual(5);
      // And routed: none of them buys Opus while Sonnet clears.
      const r = route({ role: t.role, complexity: 'high', difficulty: d.difficulty, size: d.size, needs: t.role === 'reviewer' ? ['review'] : ['code'] }, input(ledgerOf({})))!;
      if (d.difficulty <= 6) expect(r.model).not.toBe('claude-opus-5-5');
    }
  });
  it('two independent risk signals lift the cap; a planner never rates under 3', () => {
    const risky = difficultyOf({ role: 'implementer', hint: 'high', text: 'Migrate the schema and fix the race in the lock manager across src/db.ts, src/lock.ts, src/a.ts, src/b.ts', files: ['src/db.ts', 'src/lock.ts', 'src/a.ts', 'src/b.ts'] });
    expect(risky.difficulty).toBeGreaterThan(7);
    expect(risky.signals.join(' ')).toMatch(/risk: migration, race, lease\/lock\/transaction, schema/);
    expect(difficultyOf({ role: 'planner', hint: 'low', text: 'Plan the rename of foo in src/a.ts', files: ['src/a.ts'] }).difficulty).toBe(3);
  });
});

describe('retries', () => {
  const ledger = ledgerOf({});
  it('an infrastructure failure keeps model and effort (avoiding the failed CLI only when another fits)', () => {
    const keep = { cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' as const };
    const d = route({ role: 'implementer', complexity: 'medium', difficulty: 5, needs: ['code'], keep, avoid: [{ cli: 'claude' }] }, input(ledger))!;
    expect(pick(d)).toBe('claude/claude-sonnet-5-5 medium');
  });
  it('rejected work raises the floor one step: more effort on the same model first', () => {
    const d6 = raiseDifficulty(5, 5.5);
    expect(d6).toBeGreaterThan(5);
    const d = route({ role: 'implementer', complexity: 'medium', difficulty: d6, needs: ['code'], retry: true, escalateFrom: { cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' } }, input(ledger))!;
    expect(pick(d)).toBe('claude/claude-sonnet-5-5 high');
    expect(d.reason).toMatch(/retry of rejected work/);
  });
  it('never above what the strongest auto-routable model can clear', () => {
    expect(raiseDifficulty(10, 5.5)).toBe(10);
    // With Sonnet at high effort (4.5) as the best there is, the floor stops at 8.
    expect(raiseDifficulty(8, 4.5)).toBe(8);
    expect(raiseDifficulty(7, 4.5)).toBeLessThanOrEqual(8);
    for (let d = 0; d <= 10; d += 0.5) expect(raiseDifficulty(d, 5.5)).toBeGreaterThanOrEqual(d);
  });
});

describe('sessions, requests, exhaustion and the reserve', () => {
  it('a resumed session keeps its model and effort while they can do the work', () => {
    const d = route({ role: 'main', complexity: 'low', difficulty: 2, interactive: true, keep: { cli: 'claude', model: 'claude-opus-5-5', effort: 'low' } }, input(ledgerOf({})))!;
    expect(pick(d)).toBe('claude/claude-opus-5-5 low');
    expect(d.reason).toMatch(/keeps the session model/);
  });

  it('a CLI the user named is not judged on scarcity', () => {
    const ledger = ledgerOf({ claude: [{ period: 'session', used: 80, inH: 3 }, { period: 'weekly', used: 70, inH: 100 }], codex: [healthy5h, { period: 'weekly', used: 5, inH: 100 }] });
    const d = route({ role: 'main', complexity: 'medium', difficulty: 5, interactive: true, prefer: 'claude', needs: ['code'] }, input(ledger, [cli('claude'), cli('codex')]))!;
    expect(d.cli).toBe('claude');
    expect(d.scored![0]!.terms['price']).toBe(0);
    expect(route({ role: 'main', complexity: 'medium', difficulty: 5, interactive: true, needs: ['code'] }, input(ledger, [cli('claude'), cli('codex')]))!.cli).toBe('codex');
  });

  it('an exhausted pool is skipped with its reset time', () => {
    const ledger = ledgerOf({ claude: [healthy5h, { period: 'weekly', used: 20, inH: 100 }, { period: 'weekly', used: 100, inH: 30, scope: 'opus' }] });
    const d = route({ role: 'implementer', complexity: 'high', difficulty: 9, needs: ['code'] }, input(ledger))!;
    expect(d.model).not.toBe('claude-opus-5-5');
    expect(d.skipped).toContainEqual(expect.objectContaining({ model: 'claude-opus-5-5', until: NOW + 30 * HOUR, transient: true }));
  });

  it('helpers leave the reserve to interactive work; the lead and the concierge may use it', () => {
    const ledger = ledgerOf({ claude: [healthy5h, { period: 'weekly', used: 85, inH: 100 }] });
    const helper: RouteRequest = { role: 'implementer', complexity: 'medium', difficulty: 5, needs: ['code'] };
    expect(route(helper, input(ledger))).toBeUndefined();
    expect(explainNoRoute(helper, input(ledger))).toMatch(/held in reserve for interactive work \(available again around/);
    const lead = route({ ...helper, role: 'main', interactive: true }, input(ledger))!;
    expect(lead.cli).toBe('claude');
    expect(lead.reason).toMatch(/interactive work: may use the reserve/);
  });

  it('a near deadline releases most of the reserve and prices time', () => {
    const ledger = ledgerOf({ claude: [healthy5h, { period: 'weekly', used: 85, inH: 100 }] });
    const helper: RouteRequest = { role: 'implementer', complexity: 'medium', difficulty: 5, needs: ['code'] };
    const rushed = route({ ...helper, urgency: 1 }, input(ledger))!;
    expect(rushed.cli).toBe('claude');
    expect(rushed.price!.timeCost).toBeGreaterThan(0);
    expect(rushed.reason).toMatch(/deadline urgency 1: reserve released in part, time priced/);
    // Time costs favour the faster option among those that clear: never a slower one than without the deadline.
    const calm = route(helper, input(ledgerOf({})))!;
    const fast = route({ ...helper, urgency: 1 }, input(ledgerOf({})))!;
    expect(fast.price!.minutes).toBeLessThanOrEqual(calm.price!.minutes);
  });
});

describe('the reason shows the calculation', () => {
  it('chosen model and effort, difficulty and signals, prices against the runner-up, pools, reserve and urgency, labelled as estimates', () => {
    const ledger = ledgerOf({ claude: [healthy5h, { period: 'weekly', used: 40, inH: 50 }] });
    const sig = difficultyOf({ role: 'implementer', hint: 'medium', text: 'Fix the parser in src/parse.ts', files: ['src/parse.ts'] });
    const d = route({ role: 'implementer', complexity: 'medium', difficulty: sig.difficulty, difficultySignals: sig.signals, size: sig.size, needs: ['code'] }, input(ledger))!;
    expect(d.reason).toMatch(new RegExp(`^claude/${d.model} \\(\\w+\\) at ${d.effort} effort for implementer work of difficulty ${sig.difficulty}`));
    expect(d.reason).toMatch(/difficulty from: hint medium = 5; -1 1 file/);
    expect(d.reason).toMatch(/price: claude\/.* \(estimate\); runner-up claude\/.* \(estimate\)/);
    expect(d.reason).toMatch(/quota claude:all weekly: .* → \w+[\s\S]*quota claude:all 5h: /);
    expect(d.reason).toMatch(/helper work: the reserve stays free for interactive work/);
    expect(d.reason).toMatch(/no deadline \(urgency 0\)/);
  });
});

describe('Phase 4 hook: per-helper burn for maxHelpers', () => {
  it('is cost over time per window, larger for a dearer model and effort, and feeds maxHelpers', () => {
    const sonnet = entryFor(DEFAULT_CATALOG, 'claude', 'sonnet')!, opus = entryFor(DEFAULT_CATALOG, 'claude', 'opus')!;
    const s = helperBurnPctPerHour({ role: 'implementer', size: 'medium', effort: 'medium', model: sonnet });
    const o = helperBurnPctPerHour({ role: 'implementer', size: 'medium', effort: 'high', model: opus });
    expect(s.weekly).toBeGreaterThan(0);
    expect(s.session).toBeGreaterThan(s.weekly);
    expect(o.weekly).toBeGreaterThan(s.weekly);
    const ledger = ledgerOf({ claude: [healthy5h, { period: 'weekly', used: 30, inH: 100 }] });
    const states = statesOf(poolInputsFromLedger(ledger, DEFAULT_CATALOG, ['claude']), NOW, 0, false);
    expect(maxHelpers({ states: [states['claude:all']!], perHelperBurnPctPerHour: s })).toBeGreaterThanOrEqual(1);
  });
});

describe('determinism', () => {
  it('same inputs give the same decision, whatever order the CLIs are listed in', () => {
    const ledger = ledgerOf({ claude: [healthy5h, { period: 'weekly', used: 40, inH: 50 }], codex: [{ period: 'session', used: 30, inH: 3 }, { period: 'weekly', used: 60, inH: 80 }] });
    for (const req of [
      { role: 'implementer', complexity: 'medium', difficulty: 5, needs: ['code'] },
      { role: 'reviewer', complexity: 'medium', difficulty: 4, needs: ['review'] },
      { role: 'planner', complexity: 'high', difficulty: 7.5, needs: ['planning'] },
      { role: 'main', complexity: 'low', difficulty: 2, interactive: true, needs: ['chat'] }
    ] as RouteRequest[]) {
      const a = route(req, input(ledger, [cli('claude'), cli('codex')]))!;
      const b = route(req, input(ledger, [cli('codex'), cli('claude')]))!;
      const c = route(req, input(ledger, [cli('claude'), cli('codex')]))!;
      expect(b).toEqual(a);
      expect(c).toEqual(a);
    }
  });
});

describe('a few days of mixed work against pools that burn down (router only)', () => {
  /**
   * A light preview of the Phase 5 simulator. Every 30 minutes the providers report their windows, then three tasks of a fixed mix
   * are routed; each decision draws its expected cost (the same priors the router prices with) from the chosen model's pools. The 5h
   * windows reset every 5 hours, the week does not reset within the run. Claim: the router never hands helper work to a pool with no
   * usable quota left (remaining at or below its reserve), so no weekly window is ever driven past 100 - reserve + one run, and
   * interactive work never past 100.
   */
  it('no pool is driven past its usable budget by routing decisions alone', () => {
    const t = { now: NOW };
    const ledger = new UsageLedger(new Store(), { now: () => t.now, runsPerWindow: { default: 1000 } });
    const catalog = DEFAULT_CATALOG;
    const used: Record<string, { session: number; weekly: number }> = {
      'claude:all': { session: 0, weekly: 20 }, 'claude:opus': { session: 0, weekly: 10 }, 'codex:all': { session: 0, weekly: 30 }
    };
    const weekReset = NOW + 7 * DAY;
    const sessionReset = () => NOW + (Math.floor((t.now - NOW) / (5 * HOUR)) + 1) * 5 * HOUR;
    const report = () => {
      ledger.record({ cli: 'claude', model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, time: t.now, limits: [
        { period: 'session', usedPct: used['claude:all']!.session, resetsAt: sessionReset(), asOf: t.now },
        { period: 'weekly', usedPct: used['claude:all']!.weekly, resetsAt: weekReset, asOf: t.now },
        { period: 'weekly', usedPct: used['claude:opus']!.weekly, resetsAt: weekReset, asOf: t.now, scope: 'opus' }
      ] });
      ledger.record({ cli: 'codex', model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, time: t.now, limits: [
        { period: 'session', usedPct: used['codex:all']!.session, resetsAt: sessionReset(), asOf: t.now },
        { period: 'weekly', usedPct: used['codex:all']!.weekly, resetsAt: weekReset, asOf: t.now }
      ] });
    };
    const mix: RouteRequest[] = [
      { role: 'implementer', complexity: 'low', difficulty: 2, size: 'small', needs: ['code'] },
      { role: 'implementer', complexity: 'medium', difficulty: 5, size: 'medium', needs: ['code'] },
      { role: 'reviewer', complexity: 'medium', difficulty: 5, size: 'medium', needs: ['review'] },
      { role: 'planner', complexity: 'high', difficulty: 7, size: 'medium', needs: ['planning'] },
      { role: 'implementer', complexity: 'high', difficulty: 8, size: 'large', needs: ['code'] },
      { role: 'main', complexity: 'medium', difficulty: 5, size: 'medium', needs: ['code'], interactive: true }
    ];
    const clis = [cli('claude'), cli('codex')];
    let routed = 0, refused = 0, k = 0, lastSession = sessionReset();
    for (let step = 0; step < 3 * 48; step++) {
      t.now = NOW + step * 30 * MIN;
      if (sessionReset() !== lastSession) { lastSession = sessionReset(); for (const p of Object.values(used)) p.session = 0; }
      report();
      for (let j = 0; j < 3; j++, k++) {
        const req = mix[k % mix.length]!;
        const states = statesOf(poolInputsFromLedger(ledger, catalog, ['claude', 'codex']), t.now, 0, !!req.interactive);
        const d = route(req, input(ledger, clis, { now: () => t.now }));
        if (!d) { refused++; continue; }
        routed++;
        const entry = entryFor(catalog, d.cli, d.model)!;
        for (const pool of poolsOfEntry(entry)) {
          for (const w of states[pool]!.windows) {
            if (w.source !== 'reported') continue;
            // The router only picks pools with usable quota left (helpers: beyond the reserve; interactive: anything left).
            expect(w.remainingPct, `${pool} ${w.period} at step ${step}`).toBeGreaterThan(w.reservePct);
          }
          const tokensK = expectedTokens(req.role === 'main' ? 'other' : req.role as 'implementer', req.size!, d.effort);
          const perK = entry.costPerKTok ?? 1;
          used[pool]!.weekly += tokensK * perK * poolPctPrior(pool, 'weekly');
          used[pool]!.session += tokensK * perK * poolPctPrior(pool, 'session');
        }
      }
    }
    expect(routed).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(0); // the 5h windows do fill up: work waits rather than overdraws
    // One run at most past the reserve line, never past the whole window.
    for (const [pool, u] of Object.entries(used)) expect(u.weekly, pool).toBeLessThanOrEqual(100);
  });
});
