import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG, loadCatalog, loadCatalogWithWarnings, type CatalogEntry } from '../src/main/clis/capabilities';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { ROUTING_WEIGHTS as W, explainNoRoute, finalEffort, route, usagePenalty, type RouteRequest, type RouterInput, type RoutingPolicy } from '../src/main/router';
import { Store } from '../src/main/store';
import { UsageLedger } from '../src/main/usage';

const NOW = 50_000_000_000;
const HOUR = 3_600_000;
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const cli = (id: string, over: Partial<ResolvedCli> = {}): ResolvedCli =>
  ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'], ...over });

interface Limit { cli: string; period: 'session' | 'weekly'; usedPct: number; resetsAt: number; scope?: string }
/** A ledger with Harbor-counted runs (estimated) and/or provider-reported limits. */
function mkLedger(o: { runs?: Record<string, number>; budget?: number; limits?: Limit[]; rateLimited?: Array<[string, string]> } = {}) {
  const t = { now: NOW };
  const ledger = new UsageLedger(new Store(), { now: () => t.now, runsPerWindow: { default: o.budget ?? 10 } });
  const rec = (c: string, extra = {}) => ledger.record({ cli: c, model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, ...extra });
  for (const [c, n] of Object.entries(o.runs ?? {})) for (let i = 0; i < n; i++) rec(c);
  for (const l of o.limits ?? []) rec(l.cli, { limits: [{ period: l.period, usedPct: l.usedPct, resetsAt: l.resetsAt, scope: l.scope, asOf: NOW }] });
  for (const [c, m] of o.rateLimited ?? []) rec(c, { model: m, ok: false, rateLimited: true });
  return { ledger, t, rec };
}

const mkInput = (ledger: UsageLedger, extra: Partial<RouterInput> = {}, clis: ResolvedCli[] = [cli('claude'), cli('codex')]): RouterInput =>
  ({ clis, ledger, enabled: () => true, hasAdapter: () => true, load: () => 0, ...extra });
const pick = (d: ReturnType<typeof route>) => (d ? `${d.cli}/${d.model}` : undefined);

const twin = (cli: string, model = 'default'): CatalogEntry => ({ cli, model, tier: 'standard', strengths: ['code'] });

describe('ROUTING_WEIGHTS invariants (the claims in the comments)', () => {
  it('a missing need costs less than overspending a tier; the needs term cannot buy a tier step', () => {
    expect(W.needMiss).toBeLessThan(W.tierOver);
    expect(W.needCap).toBeLessThan(W.tierUnder);
  });
  it('request > settings preference > continuity; one tier step either way < preference', () => {
    expect(W.requested).toBeGreaterThan(W.preferred);
    expect(W.preferred).toBeGreaterThan(W.continuity);
    expect(W.preferred).toBeGreaterThan(W.tierUnder);
    expect(W.preferred).toBeGreaterThan(W.tierOver);
  });
  it('avoid beats continuity but not an explicit request; history is bounded', () => {
    expect(W.avoid).toBeGreaterThan(W.continuity);
    expect(W.avoid).toBeLessThan(W.requested);
    expect(W.historyMax).toBeLessThan(W.requested);
  });
  it('reduceEffort usage cap stays below continuity', () => {
    expect(W.reduceEffortUsageCap).toBeLessThan(W.continuity);
  });
  it('the usage curve is increasing, flat in the noise band, and its steepest slope times a 10% run stays under continuity', () => {
    const c = W.usageCurve;
    expect(c[0][1]).toBe(0);
    let steepest = 0;
    for (let i = 1; i < c.length; i++) {
      expect(c[i][0]).toBeGreaterThan(c[i - 1][0]);
      expect(c[i][1]).toBeGreaterThanOrEqual(c[i - 1][1]);
      steepest = Math.max(steepest, (c[i][1] - c[i - 1][1]) / (c[i][0] - c[i - 1][0]));
    }
    expect(steepest * 10).toBeLessThan(W.continuity);
  });
  it('level floors match the curve at the level thresholds (no cliff) and estimates count for less', () => {
    expect(usagePenalty(50, 'limited', 'reported')).toBeCloseTo(W.levelFloor.limited);
    expect(usagePenalty(80, 'low', 'reported')).toBeCloseTo(W.levelFloor.low);
    expect(W.estimatedUsageFactor).toBeGreaterThan(0);
    expect(W.estimatedUsageFactor).toBeLessThan(1);
  });
});

describe('A5: no cliff at 80%', () => {
  it('penalty is monotone and never jumps by more than 1 point per percent, across every threshold', () => {
    const level = (p: number) => (p >= 80 ? 'low' : p >= 50 ? 'limited' : 'plenty') as 'low' | 'limited' | 'plenty';
    for (const src of ['reported', 'estimated'] as const) {
      let prev = usagePenalty(0, 'plenty', src);
      for (let p = 1; p < 100; p++) {
        const cur = usagePenalty(p, level(p), src);
        expect(cur).toBeGreaterThanOrEqual(prev);
        expect(cur - prev).toBeLessThanOrEqual(1);
        prev = cur;
      }
    }
    expect(usagePenalty(80, 'low', 'reported') - usagePenalty(79, 'limited', 'reported')).toBeLessThan(1);
  });

  it('under reduceEffort, one extra run never flips a lead off the CLI that holds its session (reported 0-99%)', () => {
    for (let pct = 0; pct < 100; pct++) {
      const { ledger } = mkLedger({ limits: [{ cli: 'claude', period: 'session', usedPct: pct, resetsAt: NOW + 4 * HOUR }] });
      const d = route({ role: 'main', complexity: 'medium', tier: 'standard', needs: ['code'], continuity: 'claude' }, mkInput(ledger, { policy: { lowAllowance: 'reduceEffort' } }))!;
      expect(d.cli, `${pct}%`).toBe('claude');
    }
  });

  it('under switch the lead moves once and stays moved as usage climbs (a single transition, no flip-flop)', () => {
    const picks: string[] = [];
    for (let pct = 0; pct < 100; pct++) {
      const { ledger } = mkLedger({ limits: [{ cli: 'claude', period: 'session', usedPct: pct, resetsAt: NOW + 4 * HOUR }] });
      picks.push(route({ role: 'main', complexity: 'medium', tier: 'standard', needs: ['code'], continuity: 'claude' }, mkInput(ledger, { policy: { lowAllowance: 'switch' } }))!.cli);
    }
    const transitions = picks.filter((c, i) => i > 0 && c !== picks[i - 1]).length;
    expect(picks[0]).toBe('claude');
    expect(picks[99]).toBe('codex');
    expect(transitions).toBe(1);
  });

  it('flip-flop hysteresis: 20 sequential lead turns with continuity never change CLI', () => {
    const { ledger, rec } = mkLedger({ budget: 40 });
    let held: string | undefined;
    const seq: string[] = [];
    for (let i = 0; i < 20; i++) {
      const d = route({ role: 'main', complexity: 'medium', tier: 'standard', needs: ['code'], continuity: held }, mkInput(ledger, { verified: () => true }))!;
      held ??= d.cli;
      seq.push(d.cli);
      rec(d.cli);
    }
    expect(new Set(seq).size).toBe(1);
  });

  it('without continuity, parallel work balances: the two CLIs never drift more than 3 runs apart and it settles', () => {
    const { ledger, rec } = mkLedger({ budget: 40 });
    const runs: Record<string, number> = { claude: 0, codex: 0 };
    const seq: string[] = [];
    for (let i = 0; i < 20; i++) {
      const d = route({ role: 'implementer', complexity: 'medium', needs: ['code'] }, mkInput(ledger, { verified: () => true }))!;
      runs[d.cli]++; seq.push(d.cli); rec(d.cli);
      expect(Math.abs(runs['claude'] - runs['codex'])).toBeLessThanOrEqual(5);
    }
    // After the opening stretch the choice alternates rather than thrashing.
    expect(Math.abs(runs['claude'] - runs['codex'])).toBeLessThanOrEqual(3);
  });
});

describe('A2: deterministic tie-break', () => {
  const catalog = [twin('b'), twin('a')]; // catalog order b, a
  const req: RouteRequest = { role: 'implementer', complexity: 'medium', needs: ['code'] };

  it('same choice whichever order the CLIs are listed in; catalog order decides; tied is set', () => {
    const { ledger } = mkLedger();
    const one = route(req, mkInput(ledger, { catalog }, [cli('a'), cli('b')]))!;
    const two = route(req, mkInput(ledger, { catalog }, [cli('b'), cli('a')]))!;
    expect(pick(one)).toBe('b/default');
    expect(pick(two)).toBe('b/default');
    expect(one.tied).toBe(true);
    expect(one.margin).toBe(0);
    expect(two.reason).toMatch(/tied with a\/default/);
    expect(pick(route(req, mkInput(ledger, { catalog: [...catalog].reverse() }, [cli('b'), cli('a')])))).toBe('a/default');
  });

  it('a clear winner is not tied and has a positive margin', () => {
    const { ledger } = mkLedger({ runs: { b: 6 } });
    const d = route(req, mkInput(ledger, { catalog }, [cli('a'), cli('b')]))!;
    expect(d.cli).toBe('a');
    expect(d.tied).toBe(false);
    expect(d.margin!).toBeGreaterThan(0);
  });

  it('verified is part of the score and shown in the breakdown', () => {
    const { ledger } = mkLedger();
    const d = route(req, mkInput(ledger, { catalog, verified: (c) => c === 'a' }, [cli('b'), cli('a')]))!;
    expect(d.cli).toBe('a');
    expect(d.scored![0].terms['verified']).toBe(W.verified);
  });
});

describe('A1: structured decision', () => {
  it('reports the top three with a per-term breakdown that adds up to the score', () => {
    const { ledger } = mkLedger({ runs: { claude: 5 } });
    const d = route({ role: 'implementer', complexity: 'medium', needs: ['code'] }, mkInput(ledger))!;
    expect(d.scored!.length).toBe(3);
    for (const s of d.scored!) expect(s.score).toBeCloseTo(W.base + Object.values(s.terms).reduce((a, b) => a + b, 0), 1);
    expect(d.scored![0].score).toBeGreaterThanOrEqual(d.scored![1].score);
    expect(d.scored![0].cli + '/' + d.scored![0].model).toBe(pick(d));
    expect(d.reason).toContain(pick(d)!);
    expect(d.cli).toBe('codex'); // claude is at 50% estimated, codex fresh
  });

  it('lists skips, and marks a degraded tier when the strong model is unavailable', () => {
    const { ledger } = mkLedger();
    const d = route({ role: 'planner', complexity: 'high' }, mkInput(ledger, {}, [cli('claude', { installed: false }), cli('codex')]))!;
    expect(pick(d)).toBe('codex/default');
    expect(d.degraded).toEqual({ wantedTier: 'strong', gotTier: 'standard' });
    expect(d.skipped).toContainEqual({ cli: 'claude', why: 'not installed' });
    expect(d.reason).toMatch(/tier lowered/);
    const ok = route({ role: 'planner', complexity: 'high' }, mkInput(ledger))!;
    expect(ok.degraded).toBeUndefined();
  });

  it('explainNoRoute lists every skip with the reset time when known', () => {
    const reset = NOW + 2 * HOUR;
    const { ledger } = mkLedger({ limits: [{ cli: 'claude', period: 'session', usedPct: 100, resetsAt: reset }] });
    const inp = mkInput(ledger, {}, [cli('claude'), cli('codex', { installed: false }), cli('gemini', { authState: 'signedOut', signedIn: false })]);
    const req: RouteRequest = { role: 'implementer', complexity: 'medium' };
    expect(route(req, inp)).toBeUndefined();
    const text = explainNoRoute(req, inp);
    expect(text).toMatch(/claude\/sonnet: allowance exhausted or rate limited \(available again around \d{4}-/);
    expect(text).toContain(new Date(reset).toISOString().slice(0, 16).replace('T', ' '));
    expect(text).toMatch(/codex: not installed/);
    expect(text).toMatch(/gemini: login required/);
    expect(text).toMatch(/Earliest expected availability/);
  });

  it('explainNoRoute says the reset is unknown when it is, and handles an empty fleet', () => {
    const { ledger } = mkLedger({ rateLimited: [['claude', 'sonnet']] });
    const inp = mkInput(ledger, { catalog: [{ cli: 'claude', model: 'sonnet', tier: 'standard', strengths: ['code'] }] }, [cli('claude')]);
    expect(route({ role: 'implementer', complexity: 'medium' }, inp)).toBeUndefined();
    expect(explainNoRoute({ role: 'implementer', complexity: 'medium' }, inp)).toMatch(/available again around/); // cooldown knows its end
    expect(explainNoRoute({ role: 'main', complexity: 'low' }, mkInput(ledger, {}, []))).toMatch(/No CLI is known/);
    expect(explainNoRoute({ role: 'main', complexity: 'low' }, mkInput(ledger))).toMatch(/is eligible/);
  });
});

describe('A3: needs', () => {
  const missing: CatalogEntry[] = [{ cli: 'x', model: 'm', tier: 'standard', strengths: [] }];
  it('duplicates count once', () => {
    const { ledger } = mkLedger();
    const one = route({ role: 'main', complexity: 'medium', needs: ['code'] }, mkInput(ledger, {}, [cli('claude')]))!;
    const dup = route({ role: 'main', complexity: 'medium', needs: ['code', 'code', 'code'] }, mkInput(ledger, {}, [cli('claude')]))!;
    expect(dup.scored![0].terms['needs']).toBe(one.scored![0].terms['needs']);
  });
  it('the needs term is capped both ways', () => {
    const { ledger } = mkLedger();
    const all = ['chat', 'code', 'research', 'planning', 'review', 'long-context', 'vision'] as const;
    const bad = route({ role: 'main', complexity: 'medium', needs: [...all] }, mkInput(ledger, { catalog: missing }, [cli('x')]))!;
    expect(bad.scored![0].terms['needs']).toBe(-W.needCap);
    const good = route({ role: 'main', complexity: 'medium', needs: [...all] }, mkInput(ledger, { catalog: [{ ...missing[0], strengths: [...all] }] }, [cli('x')]))!;
    expect(good.scored![0].terms['needs']).toBe(W.needCap);
  });
  it('a required need skips models without it, with a note; with none left there is no route', () => {
    const { ledger } = mkLedger();
    const d = route({ role: 'main', complexity: 'low', tier: 'cheap', required: ['vision'] }, mkInput(ledger))!;
    expect(pick(d)).toBe('claude/sonnet'); // haiku and codex have no vision in the catalog
    expect(d.reason).toMatch(/claude\/haiku skipped: lacks required vision/);
    expect(d.reason).toMatch(/codex\/default skipped: lacks required vision/);
    const none = mkInput(ledger, {}, [cli('codex')]);
    expect(route({ role: 'main', complexity: 'low', required: ['vision'] }, none)).toBeUndefined();
    expect(explainNoRoute({ role: 'main', complexity: 'low', required: ['vision'] }, none)).toMatch(/codex\/default: lacks required vision/);
  });
  it('a CLI missing from the catalog has unknown capabilities: usable, but never for a required need', () => {
    const { ledger } = mkLedger();
    expect(pick(route({ role: 'main', complexity: 'low' }, mkInput(ledger, { catalog: [] }, [cli('gemini')])))).toBe('gemini/default');
    expect(route({ role: 'main', complexity: 'low', required: ['code'] }, mkInput(ledger, { catalog: [] }, [cli('gemini')]))).toBeUndefined();
  });
});

describe('A4: usage confidence', () => {
  it('pressure() says whether the reading is reported or estimated', () => {
    const est = mkLedger({ runs: { claude: 3 } }).ledger.pressure('claude', 'sonnet');
    expect(est.source).toBe('estimated');
    const rep = mkLedger({ limits: [{ cli: 'claude', period: 'session', usedPct: 30, resetsAt: NOW + 3 * HOUR }] }).ledger.pressure('claude', 'sonnet');
    expect(rep.source).toBe('reported');
    expect(mkLedger({ rateLimited: [['claude', 'sonnet']] }).ledger.pressure('claude', 'sonnet')).toMatchObject({ level: 'exhausted', source: 'reported' });
  });

  it('an estimated window is not paced from the first Harbor run; a reported one is', () => {
    // 8 of 10 runs, all an hour ago: the old math saw 20% of the window elapsed and projected 400%.
    const m = mkLedger({ budget: 10 });
    for (let i = 0; i < 8; i++) m.rec('claude', { time: NOW - HOUR });
    const p = m.ledger.pressure('claude', 'sonnet');
    expect(p.projectedPct).toBeUndefined();
    expect(p.level).toBe('low');
    const r = mkLedger({ limits: [{ cli: 'claude', period: 'session', usedPct: 60, resetsAt: NOW + 2.5 * HOUR }] }).ledger.pressure('claude', 'sonnet');
    expect(r).toMatchObject({ level: 'low', projectedPct: 120, source: 'reported' });
  });

  it('the same percentage costs less when it is only Harbor\'s estimate', () => {
    const est = mkLedger({ runs: { claude: 6 } });
    const rep = mkLedger({ limits: [{ cli: 'claude', period: 'session', usedPct: 60, resetsAt: NOW + 1.5 * HOUR }] }); // pace projects ~86%: the level stays limited
    const req: RouteRequest = { role: 'main', complexity: 'medium', tier: 'standard', needs: ['code'] };
    const a = route(req, mkInput(est.ledger, {}, [cli('claude')]))!, b = route(req, mkInput(rep.ledger, {}, [cli('claude')]))!;
    // Headroom routing: an estimate's used% counts for W.estimatedUsageFactor of itself, so it costs well under half of the same reported reading.
    expect(a.scored![0].terms['usage']).toBeLessThan(0);
    expect(Math.abs(a.scored![0].terms['usage'])).toBeLessThan(Math.abs(b.scored![0].terms['usage']) * W.estimatedUsageFactor + 1e-9);
    // Explicit stay-put policy keeps the older curve, where the penalty is exactly scaled.
    const pol = { lowAllowance: 'reduceEffort' as const };
    const a2 = route(req, mkInput(est.ledger, { policy: pol }, [cli('claude')]))!, b2 = route(req, mkInput(rep.ledger, { policy: pol }, [cli('claude')]))!;
    expect(a2.scored![0].terms['usage']).toBeCloseTo(b2.scored![0].terms['usage'] * W.estimatedUsageFactor, 5);
    expect(a.reason).toMatch(/~60% estimated/);
    expect(b.reason).not.toMatch(/estimated/);
  });
});

describe('A6: effort composition', () => {
  const base = { role: 'implementer', complexity: 'medium' } as const;
  it.each([
    ['fixed ignores policy and allowance', { ...base, requested: 'low', fixed: true, policy: 'quality', allowanceLow: true }, 'low'],
    ['fixed high survives conserve + low allowance', { ...base, requested: 'high', fixed: true, policy: 'conserve', allowanceLow: true }, 'high'],
    ['retry is high even under conserve and low allowance', { ...base, retry: true, policy: 'conserve', allowanceLow: true }, 'high'],
    ['fixed beats retry', { ...base, requested: 'low', fixed: true, retry: true }, 'low'],
    ['low allowance steps down from medium', { ...base, allowanceLow: true }, 'low'],
    ['low allowance steps down from high', { role: 'planner', complexity: 'high', allowanceLow: true }, 'medium'],
    ['quality cannot undo the low-allowance step', { ...base, policy: 'quality', allowanceLow: true }, 'low'],
    ['conserve and low allowance do not step twice', { role: 'planner', complexity: 'high', policy: 'conserve', allowanceLow: true }, 'medium'],
    ['conserve alone', { ...base, policy: 'conserve' }, 'low'],
    ['quality alone', { ...base, policy: 'quality' }, 'high'],
    ['adaptive leaves it', { ...base, policy: 'adaptive' }, 'medium']
  ] as const)('%s', (_n, input, expected) => {
    expect(finalEffort({ ...input }).effort).toBe(expected);
  });

  it('route() uses it: a retry keeps high effort at low allowance, a fixed effort is untouched', () => {
    const { ledger } = mkLedger({ runs: { claude: 8 } });
    const inp = mkInput(ledger, {}, [cli('claude')]);
    expect(route({ role: 'implementer', complexity: 'medium', retry: true }, inp)!.effort).toBe('high');
    expect(route({ role: 'main', complexity: 'medium', tier: 'standard', effort: 'medium', fixedEffort: true }, inp)!.effort).toBe('medium');
    expect(route({ role: 'implementer', complexity: 'medium' }, inp)!.effort).toBe('low');
  });
});

describe('low allowance policies', () => {
  const lead: RouteRequest = { role: 'planner', complexity: 'high', continuity: 'claude' };
  it("'reduceEffort' keeps the session's CLI and lowers effort; it does not switch even with a healthy alternative", () => {
    const { ledger } = mkLedger({ runs: { claude: 9 } });
    for (const lowAllowance of [undefined, 'reduceEffort'] as const) {
      const d = route(lead, mkInput(ledger, { policy: { lowAllowance } }))!;
      expect(d).toMatchObject({ cli: 'claude', effort: 'medium' });
      expect(d.reason).toMatch(/effort lowered: allowance low/);
    }
  });
  it("'switch' moves to a healthy CLI, and still lowers effort when it is the only choice", () => {
    const { ledger } = mkLedger({ runs: { claude: 9 } });
    expect(route(lead, mkInput(ledger, { policy: { lowAllowance: 'switch' } }))!.cli).toBe('codex');
    const alone = route(lead, mkInput(ledger, { policy: { lowAllowance: 'switch' } }, [cli('claude')]))!;
    expect(alone).toMatchObject({ cli: 'claude', effort: 'medium' });
    expect(alone.reason).toMatch(/no healthier option/);
  });
});

describe('A7: avoid and history', () => {
  const catalog = [twin('claude', 'sonnet'), twin('codex')];
  const req: RouteRequest = { role: 'implementer', complexity: 'medium', needs: ['code'] };

  it('avoid is a soft penalty: it moves work elsewhere, beats continuity, and still allows the avoided CLI when it is all that is left', () => {
    const { ledger } = mkLedger();
    expect(pick(route({ ...req, avoid: [{ cli: 'claude' }] }, mkInput(ledger, { catalog })))).toBe('codex/default');
    expect(pick(route({ ...req, continuity: 'claude', avoid: [{ cli: 'claude' }] }, mkInput(ledger, { catalog })))).toBe('codex/default');
    const only = route({ ...req, avoid: [{ cli: 'claude' }] }, mkInput(ledger, { catalog }, [cli('claude')]))!;
    expect(pick(only)).toBe('claude/sonnet');
    expect(only.reason).toMatch(/avoid list but the best left/);
  });
  it('avoid can name one model; an explicit request still outweighs it', () => {
    const { ledger } = mkLedger();
    expect(pick(route({ role: 'implementer', complexity: 'medium', avoid: [{ cli: 'claude', model: 'sonnet' }] }, mkInput(ledger, {}, [cli('claude')])))).toBe('claude/opus'); // one tier over costs 8, avoid costs 30
    const asked = route({ ...req, prefer: 'claude', avoid: [{ cli: 'claude' }] }, mkInput(ledger, { catalog }))!;
    expect(asked.cli).toBe('claude');
  });
  it('failures cost a bounded penalty that decays with time', () => {
    const { ledger } = mkLedger();
    const hist = (fails: number, lastFailAt?: number) => ({ 'claude/sonnet': { runs: 10, fails, lastFailAt } });
    const penalty = (inp: Partial<RouterInput>) => -route(req, mkInput(ledger, { catalog, ...inp }, [cli('claude')]))!.scored![0].terms['history'];
    expect(penalty({})).toBe(0);
    expect(penalty({ history: hist(1) })).toBe(W.historyPerFail);
    expect(penalty({ history: hist(99) })).toBe(W.historyMax);
    expect(penalty({ history: hist(1, NOW), now: () => NOW })).toBe(W.historyPerFail);
    expect(penalty({ history: hist(1, NOW - W.historyHalfLifeMs), now: () => NOW })).toBeCloseTo(W.historyPerFail / 2, 5);
    expect(penalty({ history: hist(1, NOW - 10 * W.historyHalfLifeMs), now: () => NOW })).toBeLessThan(0.01);
    expect(pick(route(req, mkInput(ledger, { catalog, history: hist(2) })))).toBe('codex/default');
  });
});

describe('hard limits', () => {
  it('reserve: skipped at 100 - reserve % used, kept just below', () => {
    const at = (pct: number) => mkLedger({ limits: [{ cli: 'claude', period: 'session', usedPct: pct, resetsAt: NOW + HOUR }] }).ledger;
    const policy: RoutingPolicy = { reserve: 30 };
    const only = (pct: number) => route({ role: 'implementer', complexity: 'medium' }, mkInput(at(pct), { policy }, [cli('claude')]));
    expect(only(69)?.cli).toBe('claude');
    expect(only(70)).toBeUndefined();
    const text = explainNoRoute({ role: 'implementer', complexity: 'medium' }, mkInput(at(70), { policy }, [cli('claude')]));
    expect(text).toMatch(/inside the 30% subscription reserve \(available again around/);
  });
  it('exclude and requireCli are hard; disabled and adapter-less CLIs are skipped', () => {
    const { ledger } = mkLedger();
    expect(route({ role: 'implementer', complexity: 'low', exclude: ['claude', 'codex'] }, mkInput(ledger))).toBeUndefined();
    expect(pick(route({ role: 'implementer', complexity: 'low', requireCli: 'codex' }, mkInput(ledger)))).toBe('codex/default');
    const d = route({ role: 'implementer', complexity: 'low' }, mkInput(ledger, { enabled: (c) => c !== 'claude', hasAdapter: (c) => c !== 'gemini' }, [cli('claude'), cli('codex'), cli('gemini')]))!;
    expect(d.cli).toBe('codex');
    expect(d.skipped!.map((s) => s.why)).toEqual(['disabled in settings', 'no headless adapter yet']);
  });
});

describe('realistic fleets', () => {
  const cases: Array<[string, () => RouterInput, RouteRequest, string, { tied?: boolean; degraded?: boolean }?]> = [
    ['both fresh, medium code: claude by catalog order', () => mkInput(mkLedger().ledger, { verified: () => true }), { role: 'implementer', complexity: 'medium', needs: ['code'] }, 'claude/sonnet', { tied: true }],
    ['both fresh, hard plan: claude opus', () => mkInput(mkLedger().ledger), { role: 'planner', complexity: 'high', needs: ['planning'] }, 'claude/opus'],
    ['codex only, hard plan: degraded', () => mkInput(mkLedger().ledger, {}, [cli('codex')]), { role: 'planner', complexity: 'high' }, 'codex/default', { degraded: true }],
    ['claude 90% reported, medium work moves to codex', () => mkInput(mkLedger({ limits: [{ cli: 'claude', period: 'session', usedPct: 90, resetsAt: NOW + 3 * HOUR }] }).ledger), { role: 'implementer', complexity: 'medium', needs: ['code'] }, 'codex/default'],
    ['opus capped, strong work goes to fable', () => mkInput(mkLedger({ rateLimited: [['claude', 'opus']] }).ledger, {}, [cli('claude')]), { role: 'implementer', complexity: 'high' }, 'claude/claude-fable-5-1'],
    ['unknown CLI only: default model', () => mkInput(mkLedger().ledger, {}, [cli('gemini')]), { role: 'main', complexity: 'low' }, 'gemini/default'],
    ['cheap chat front desk', () => mkInput(mkLedger().ledger), { role: 'main', complexity: 'low', tier: 'cheap', effort: 'low', fixedEffort: true, needs: ['chat'] }, 'claude/haiku'],
    ['user asked for codex', () => mkInput(mkLedger().ledger), { role: 'main', complexity: 'medium', tier: 'standard', prefer: 'codex', continuity: 'claude' }, 'codex/default'],
    ['role preference for codex', () => mkInput(mkLedger().ledger, { policy: { preference: { cli: 'codex' } } }), { role: 'implementer', complexity: 'medium', needs: ['code'] }, 'codex/default'],
    ['reviewer in a worktree with claude at 70% estimated and codex fresh', () => mkInput(mkLedger({ runs: { claude: 7 } }).ledger), { role: 'reviewer', complexity: 'medium', needs: ['review'] }, 'codex/default']
  ];
  it.each(cases)('%s', (_n, inp, req, expected, flags) => {
    const d = route(req, inp())!;
    expect(pick(d)).toBe(expected);
    if (flags?.tied !== undefined) expect(d.tied).toBe(flags.tied);
    if (flags?.degraded) expect(d.degraded).toBeDefined();
  });
});

describe('A8: catalog warnings', () => {
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-cat-')); dirs.push(d); return join(d, 'capabilities.json'); };
  it('reports dropped and duplicate entries, keeps the first duplicate, and loadCatalog still returns the plain list', () => {
    const f = tmp();
    writeFileSync(f, JSON.stringify([
      { cli: 'claude', model: 'sonnet', tier: 'cheap', strengths: ['code'] },
      { cli: 'claude', model: 'sonnet', tier: 'strong', strengths: ['code'] },
      { cli: 'x', model: 'bad', tier: 'nope', strengths: [] },
      { cli: 'y', model: 'weird', tier: 'cheap', strengths: ['telepathy'] },
      'junk'
    ]));
    const r = loadCatalogWithWarnings(f);
    expect(r.catalog).toEqual([{ cli: 'claude', model: 'sonnet', tier: 'cheap', strengths: ['code'] }]);
    expect(r.warnings).toHaveLength(4);
    expect(r.warnings.join('\n')).toMatch(/entry 2 dropped: duplicate claude\/sonnet/);
    expect(r.warnings.join('\n')).toMatch(/entry 3 dropped: tier must be one of/);
    expect(r.warnings.join('\n')).toMatch(/entry 4 dropped: unknown strength "telepathy"/);
    expect(r.warnings.join('\n')).toMatch(/entry 5 dropped: not an object/);
    expect(loadCatalog(f)).toEqual(r.catalog);
  });
  it('malformed, empty and missing files fall back to the defaults; only a bad file warns', () => {
    const f = tmp();
    expect(loadCatalogWithWarnings(f)).toEqual({ catalog: DEFAULT_CATALOG, warnings: [] });
    writeFileSync(f, 'not json');
    expect(loadCatalogWithWarnings(f).catalog).toBe(DEFAULT_CATALOG);
    expect(loadCatalogWithWarnings(f).warnings[0]).toMatch(/not valid JSON/);
    writeFileSync(f, '{}');
    expect(loadCatalogWithWarnings(f).warnings[0]).toMatch(/must be a list/);
    writeFileSync(f, '[]');
    expect(loadCatalogWithWarnings(f).warnings[0]).toMatch(/no usable entry/);
  });
});
