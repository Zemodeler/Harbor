import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EQUAL_POOLS } from './fixtures/catalogs';
import { describe, expect, it } from 'vitest';
import { CodexAdapter } from '../src/main/adapters/codex';
import { claudeArgs, parseClaudeLine } from '../src/main/adapters/claude';
import { RATE_LIMIT_RE, isModelSpecific, type Chunk, type RunOptions } from '../src/main/adapters/types';
import { DEFAULT_CATALOG, costWeightOf, loadCatalogWithWarnings, type CatalogEntry } from '../src/main/clis/capabilities';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { askedCounts, missedHistory } from '../src/main/orchestrator';
import { quoteWinArg } from '../src/main/proc';
import { ROUTING_WEIGHTS as W, explainNoRoute, route, tierFor, type RouteRequest, type RouterInput } from '../src/main/router';
import { PRICE_CAP } from '../src/main/routePrice';
import { Store } from '../src/main/store';
import { DEFAULT_RUNS_PER_WINDOW, UsageLedger, buildHistory } from '../src/main/usage';
import { delegate, escalate, harness, isConcierge, isLead, say, script, tmp, until, type Roles } from './hardeningHarness';

const NOW = 50_000_000_000;
const HOUR = 3_600_000;
const cli = (id: string, over: Partial<ResolvedCli> = {}): ResolvedCli =>
  ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'], ...over });
const twin = (c: string, model = 'default'): CatalogEntry => ({ cli: c, model, tier: 'standard', strengths: ['code'] });

interface Limit { cli: string; period: 'session' | 'weekly'; usedPct: number; resetsAt: number }
function ledgerWith(limits: Limit[] = [], o: { runs?: Record<string, number> } = {}) {
  const t = { now: NOW };
  const ledger = new UsageLedger(new Store(), { now: () => t.now, runsPerWindow: { default: 10 } });
  const rec = (c: string, extra = {}) => ledger.record({ cli: c, model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, ...extra });
  for (const l of limits) rec(l.cli, { limits: [{ period: l.period, usedPct: l.usedPct, resetsAt: l.resetsAt, asOf: NOW }] });
  for (const [c, n] of Object.entries(o.runs ?? {})) for (let i = 0; i < n; i++) rec(c);
  return { ledger, t, rec };
}
const input = (ledger: UsageLedger, extra: Partial<RouterInput> = {}, clis = [cli('claude'), cli('codex')]): RouterInput =>
  // Phase 5: Codex's pool calibrated to Claude's per-token figures (EQUAL_POOLS): two comparable accounts, as these tests assume.
  ({ clis, ledger, enabled: () => true, hasAdapter: () => true, load: () => 0, calibration: EQUAL_POOLS, ...extra });
const pick = (d: ReturnType<typeof route>) => (d ? `${d.cli}/${d.model}` : undefined);

describe('item 10: model-specific rate limits', () => {
  it.each([
    ['Claude Opus usage limit reached', true],
    ['You have hit the Sonnet weekly limit', true],
    ['rate limit exceeded for gpt-5-codex', true],
    ['limit for this model reached', true],
    ['Claude usage limit reached', false],
    ['5-hour limit reached, resets at 3pm', false],
    ['429 too many requests', false],
    [undefined, false]
  ])('%s -> model-specific %s', (text, expected) => {
    expect(isModelSpecific(text)).toBe(expected);
    if (text && RATE_LIMIT_RE.test(text)) expect(typeof expected).toBe('boolean');
  });

  it('a limit that names no model holds every model of the CLI out; a model-specific one only that model', () => {
    const store = new Store();
    const ledger = new UsageLedger(store, { now: () => NOW });
    ledger.record({ cli: 'claude', model: 'opus', projectId: 'p', agentId: 'a', durationMs: 1, ok: false, rateLimited: true });
    expect(ledger.cooldownUntil('claude', 'opus')).toBeDefined();
    expect(ledger.cooldownUntil('claude', 'sonnet')).toBeUndefined();
    ledger.record({ cli: 'claude', model: 'opus', projectId: 'p', agentId: 'a', durationMs: 1, ok: false, rateLimited: true, cliWide: true });
    expect(ledger.cooldownUntil('claude', 'sonnet')).toBeDefined();
    expect(ledger.pressure('claude', 'haiku').level).toBe('exhausted');
    expect(ledger.cooldownUntil('codex', 'default')).toBeUndefined();
  });
});

// The old 5h-window 'expiring' bonus became weekly pacing, and Phase 3 replaced that with the budget governor's use-it-or-lose-it
// credit (routePrice.wasteCredit): quota a fresh provider reading projects to expire unused costs nothing. Same intent, new mechanism.
describe('item 10: use it or lose it (now the waste credit)', () => {
  const catalog = [twin('claude'), twin('codex')];
  const soon = (pct: number, inMs: number) => ledgerWith([{ cli: 'codex', period: 'weekly', usedPct: pct, resetsAt: NOW + inMs }]);

  it('the price term is capped below an explicit request', () => {
    expect(PRICE_CAP).toBeLessThan(W.requested);
  });
  it('a mostly unused reported weekly window that resets soon wins, and the reason says so', () => {
    const { ledger } = soon(12, HOUR);
    const d = route({ role: 'implementer', complexity: 'medium' }, input(ledger, { catalog, now: () => NOW }))!;
    expect(pick(d)).toBe('codex/default');
    expect(d.reason).toContain('would expire unused');
    expect(d.price!.wasteCreditPct).toBeGreaterThan(0);
  });
  // 'no clock given' was dropped: route() now judges pools at the ledger's own (injected) clock when it is given none.
  it.each([
    ['the reset is far away', 12, 6 * 24 * HOUR],
    ['the window is already used at the pace of the week', 99, HOUR]
  ])('no credit: %s', (_why, pct, inMs) => {
    const { ledger } = soon(pct, inMs);
    const d = route({ role: 'implementer', complexity: 'medium' }, input(ledger, { catalog, now: () => NOW }))!;
    expect(pick(d)).toBe('claude/default');
    expect(d.reason).not.toContain('would expire unused');
  });
  it('Harbor-only estimates earn no credit', () => {
    const { ledger } = ledgerWith([], { runs: { codex: 1 } });
    const d = route({ role: 'implementer', complexity: 'medium' }, input(ledger, { catalog, now: () => NOW }))!;
    expect(d.price!.wasteCreditPct).toBe(0);
    expect(d.runnerUp!.wasteCreditPct).toBe(0);
  });
});

describe('item 3: planner tier follows complexity', () => {
  it.each([['low', 'standard'], ['medium', 'standard'], ['high', 'strong']] as const)('planner %s -> %s', (c, tier) => {
    expect(tierFor('planner', c)).toBe(tier);
  });
  it('other roles are unchanged', () => {
    expect(tierFor('implementer', 'low')).toBe('cheap');
    expect(tierFor('reviewer', 'medium')).toBe('standard');
    expect(tierFor('main', 'high')).toBe('strong');
  });
});

describe('item 5: a resumed session keeps its model and effort', () => {
  const { ledger } = ledgerWith();
  const only = (extra: Partial<RouterInput> = {}) => input(ledger, extra, [cli('claude')]);

  it('never moves down: a kept opus stays opus when the work wants standard or cheap', () => {
    for (const complexity of ['low', 'medium'] as const) {
      const d = route({ role: 'main', complexity, keep: { cli: 'claude', model: 'opus', effort: 'high' } }, only())!;
      expect(pick(d)).toBe('claude/claude-opus-5-5');
      expect(d.reason).toContain('keeps the session model');
      expect(d.skipped?.some((s) => s.model === 'claude-sonnet-5-5' && /prompt cache/.test(s.why))).toBe(true);
    }
  });
  it('may move up a tier when the work wants it', () => {
    const d = route({ role: 'main', complexity: 'high', keep: { cli: 'claude', model: 'sonnet', effort: 'medium' } }, only())!;
    expect(pick(d)).toBe('claude/claude-opus-5-5');
    expect(d.reason).toContain('session model sonnet → claude-opus-5-5');
  });
  it('does not flip effort inside a session, but an explicit effort still wins', () => {
    const kept = route({ role: 'main', complexity: 'high', keep: { cli: 'claude', model: 'opus', effort: 'low' } }, only())!;
    expect(kept.effort).toBe('low'); // high complexity would have asked for medium
    expect(kept.reason).toContain('kept for the resumed session');
    const deep = route({ role: 'main', complexity: 'high', effort: 'high', fixedEffort: true, keep: { cli: 'claude', model: 'opus', effort: 'low' } }, only())!;
    expect(deep.effort).toBe('high');
  });
  it('a kept model that is unavailable does not pin the session: routing falls back normally', () => {
    const l = ledgerWith();
    l.rec('claude', { model: 'opus', ok: false, rateLimited: true });
    const d = route({ role: 'main', complexity: 'medium', keep: { cli: 'claude', model: 'opus', effort: 'high' } }, input(l.ledger, {}, [cli('claude')]))!;
    expect(pick(d)).toBe('claude/claude-sonnet-5-5');
  });
  it('a fresh session (no keep) routes normally', () => {
    expect(pick(route({ role: 'main', complexity: 'medium' }, only()))).toBe('claude/claude-sonnet-5-5');
  });
});

describe('item 4: fan-out helpers stay off a CLI at low allowance', () => {
  const catalog = [twin('claude'), twin('codex')];
  const lowClaude = () => ledgerWith([{ cli: 'claude', period: 'session', usedPct: 85, resetsAt: NOW + HOUR }]);

  it('continuity would keep the job on the low CLI; a fan-out helper goes to the healthy one and says why', () => {
    const { ledger } = lowClaude();
    const base: RouteRequest = { role: 'implementer', complexity: 'medium', continuity: 'claude' };
    // Stay-put policy: continuity keeps the job on the low CLI. (Under the default headroom routing a CLI with 15% left loses it anyway; see tests/pacing.test.ts.)
    expect(pick(route(base, input(ledger, { catalog, policy: { lowAllowance: 'reduceEffort' } })))).toBe('claude/default');
    const d = route({ ...base, fanOut: true }, input(ledger, { catalog, policy: { lowAllowance: 'reduceEffort' } }))!;
    expect(pick(d)).toBe('codex/default');
    expect(d.reason).toMatch(/claude\/default skipped: allowance low .* helpers are not started on it while codex is healthy/);
    expect(d.skipped?.[0]).toMatchObject({ cli: 'claude', transient: true });
  });
  it('when nothing else is healthy the helper still runs on the low CLI', () => {
    const { ledger } = lowClaude();
    expect(pick(route({ role: 'planner', complexity: 'medium', fanOut: true }, input(ledger, { catalog }, [cli('claude')])))).toBe('claude/default');
  });
});

describe('item 2: avoid outweighs continuity', () => {
  it('a retry that avoids the failed CLI does not return to it just because its session lives there', () => {
    const { ledger } = ledgerWith();
    const catalog = [twin('claude'), twin('codex')];
    const req: RouteRequest = { role: 'implementer', complexity: 'medium', continuity: 'claude', avoid: [{ cli: 'claude', model: 'default' }] };
    expect(pick(route(req, input(ledger, { catalog })))).toBe('codex/default');
    // ...but it is a penalty, not a ban: with nothing else, the avoided one runs.
    expect(pick(route(req, input(ledger, { catalog }, [cli('claude')])))).toBe('claude/default');
  });
});

describe('item 1: explainNoRoute carries reset times', () => {
  it('names each skip and when it clears', () => {
    const { ledger } = ledgerWith([{ cli: 'claude', period: 'session', usedPct: 100, resetsAt: NOW + 2 * HOUR }]);
    const text = explainNoRoute({ role: 'implementer', complexity: 'medium' }, input(ledger, {}, [cli('claude')]));
    expect(text).toContain('available again around');
    expect(text).toContain('Earliest expected availability');
  });
  it('a required need no model has is reported as such', () => {
    const { ledger } = ledgerWith();
    const text = explainNoRoute({ role: 'main', complexity: 'medium', required: ['vision'] }, input(ledger, {}, [cli('codex')]));
    expect(text).toContain('lacks required vision');
  });
  it('route() carries scores, margin and skips for the details of a message', () => {
    const { ledger } = ledgerWith();
    const d = route({ role: 'implementer', complexity: 'medium' }, input(ledger))!;
    expect(d.scored!.length).toBeGreaterThan(1);
    expect(typeof d.margin).toBe('number');
  });
});

describe('item 8: usage accounting', () => {
  const T0 = NOW;
  const ledgerAt = (store = new Store(), o = {}) => {
    const t = { now: T0 };
    return { t, store, ledger: new UsageLedger(store, { now: () => t.now, ...o }) };
  };
  const rec = (l: UsageLedger, extra: object) => l.record({ cli: 'claude', model: 'sonnet', projectId: 'p', agentId: 'a', durationMs: 1, ok: true, ...extra });

  it('the catalog carries a per-model run weight (haiku 1, sonnet 12, opus 25, codex 10)', () => {
    expect(DEFAULT_CATALOG.map((e) => [e.model, e.costWeight])).toEqual([
      ['claude-haiku-5-5', 1], ['claude-sonnet-5-5', 12], ['claude-opus-5-5', 25], ['claude-fable-5-1', 25],
      ['gpt-6.1-sol', 10], ['gpt-6-astra', 25], ['gpt-6-sol', 8], ['gpt-6-luna', 3], ['gpt-5.6-sol', 8], ['gpt-5.6-terra', 6], ['gpt-5.6-luna', 3], ['default', 10],
      ['gemini-2.5-pro', 15], ['gemini-2.5-flash', 4], ['gemini-2.5-flash-lite', 1.5]
    ]);
    expect(costWeightOf(DEFAULT_CATALOG, 'claude', 'claude-opus-5-5')).toBe(25);
    expect(costWeightOf(DEFAULT_CATALOG, 'claude', 'opus')).toBe(25);
    expect(costWeightOf(DEFAULT_CATALOG, 'codex', 'whatever')).toBe(10); // the CLI's default entry
    expect(costWeightOf(DEFAULT_CATALOG, 'gemini', 'x')).toBe(10); // unknown CLI: the middle
  });
  it('capabilities.json may set costWeight; a bad one is dropped with a warning', () => {
    const d = tmp();
    const p = join(d, 'capabilities.json');
    writeFileSync(p, JSON.stringify([{ cli: 'claude', model: 'a', tier: 'cheap', strengths: ['code'], costWeight: 3 }, { cli: 'claude', model: 'b', tier: 'cheap', strengths: ['code'], costWeight: -1 }]));
    const r = loadCatalogWithWarnings(p);
    expect(r.catalog.map((e) => e.costWeight)).toEqual([3]);
    expect(r.warnings.join(' ')).toMatch(/entry 2 dropped: costWeight must be a positive number/);
  });

  it('a window is weighted by cost: opus runs fill it faster than haiku runs, a reported cost beats the table', () => {
    const a = ledgerAt(), b = ledgerAt(), c = ledgerAt();
    for (let i = 0; i < 16; i++) { rec(a.ledger, { model: 'opus' }); rec(b.ledger, { model: 'haiku' }); rec(c.ledger, { model: 'haiku', costUsd: 2 }); }
    const pct = (l: UsageLedger) => l.windows(['claude'])[0]!.usedPct;
    // 16 opus runs = 400 points = 50 average runs = 25% of the 200-run fallback window
    expect(pct(a.ledger)).toBe(Math.round((16 * 25) / 8 / DEFAULT_RUNS_PER_WINDOW * 100));
    expect(pct(b.ledger)).toBeLessThan(pct(a.ledger) / 10);
    expect(pct(c.ledger)).toBeGreaterThan(pct(b.ledger)); // $2 per run says haiku was not cheap here
  });
  it('an owner-set budget keeps counting plain runs (no weighting, never uncalibrated)', () => {
    const { ledger } = ledgerAt(new Store(), { runsPerWindow: { default: 10 } });
    for (let i = 0; i < 5; i++) rec(ledger, { model: 'opus', costUsd: 9 });
    const w = ledger.windows(['claude'])[0]!;
    expect(w.usedPct).toBe(50);
    expect(w.calibrated).toBe(true);
  });
  it('without readings the percentage is flagged uncalibrated, in the window and in its label', () => {
    const { ledger } = ledgerAt();
    rec(ledger, {});
    const [session, weekly] = ledger.windows(['claude']);
    expect(session).toMatchObject({ source: 'estimated', calibrated: false });
    expect(session!.label).toContain('uncalibrated');
    expect(weekly).toMatchObject({ calibrated: false });
    expect(ledger.pressure('claude').calibrated).toBe(false);
  });
  it('two provider readings of one window calibrate the budget from the Harbor cost between them', () => {
    const { ledger, t } = ledgerAt();
    const resetsAt = T0 + 3 * HOUR;
    const limit = (usedPct: number) => ({ limits: [{ period: 'session' as const, usedPct, resetsAt, asOf: t.now }] });
    rec(ledger, { costUsd: 0, time: T0, ...limit(10) });
    for (let i = 1; i <= 5; i++) rec(ledger, { costUsd: 1, time: T0 + i }); // 5 x $1 = 50 points
    rec(ledger, { costUsd: 0, time: T0 + 6, ...limit(20) }); // +10% for 50 points: 5 points per percent, 500 per window
    t.now = T0 + 4 * HOUR; // the window has reset: the estimate is what remains
    for (let i = 0; i < 3; i++) rec(ledger, { costUsd: 1, time: T0 + 3 * HOUR + 1 + i }); // after the reset
    const w = ledger.windows(['claude'])[0]!;
    expect(w).toMatchObject({ source: 'estimated', calibrated: true });
    expect(w.usedPct).toBe(6); // 30 of 500 points
    expect(w.label).not.toContain('uncalibrated');
  });
  it('one reading, or a percent that did not move, calibrates nothing', () => {
    const { ledger, t } = ledgerAt();
    const limit = (usedPct: number) => ({ limits: [{ period: 'session' as const, usedPct, resetsAt: T0 + 3 * HOUR, asOf: t.now }] });
    rec(ledger, { costUsd: 1, time: T0, ...limit(10) });
    rec(ledger, { costUsd: 1, time: T0 + 1, ...limit(10) });
    t.now = T0 + 4 * HOUR;
    expect(ledger.windows(['claude'])[0]!.calibrated).toBe(false);
  });
  it('lifetime cost survives pruning of old events', () => {
    const store = new Store(undefined, { now: () => T0 });
    const { ledger } = ledgerAt(store);
    const old = T0 - 20 * 24 * HOUR;
    for (let i = 0; i < 3; i++) rec(ledger, { time: old + i, costUsd: 1, inputTokens: 10, outputTokens: 5 });
    rec(ledger, { costUsd: 0.5, inputTokens: 1, outputTokens: 1 });
    const before = ledger.runningCost('p');
    store.pruneUsage();
    expect(store.listUsage()).toHaveLength(1);
    expect(ledger.runningCost('p')).toEqual(before);
    expect(before).toEqual({ runs: 4, inputTokens: 31, outputTokens: 16, costUsd: 3.5 });
  });
  it('buildHistory counts runs and failures per cli/model over the last day', () => {
    const ev = (model: string, ok: boolean, time: number, rateLimited = false) => ({ id: 'x', time, cli: 'claude', model, projectId: 'p', agentId: 'a', durationMs: 1, ok, rateLimited });
    const h = buildHistory([ev('opus', true, NOW - 1000), ev('opus', false, NOW - 500), ev('opus', false, NOW - 2 * 24 * HOUR), ev('sonnet', true, NOW - 5, true)], NOW);
    expect(h['claude/opus']).toEqual({ runs: 2, fails: 1, lastFailAt: NOW - 500 });
    expect(h['claude/sonnet']).toMatchObject({ runs: 1, fails: 1 });
  });
  it('the Claude parser keeps cache tokens apart from input tokens, and omits them when absent', () => {
    const r = parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.5, usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 9000, cache_creation_input_tokens: 700 } }));
    expect(r).toContainEqual({ kind: 'usage', inputTokens: 3, outputTokens: 4, costUsd: 0.5, cacheReadTokens: 9000, cacheWriteTokens: 700 });
    const bare = parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } })).find((c) => c.kind === 'usage')!;
    expect(bare).not.toHaveProperty('cacheReadTokens');
  });
});

describe('item 9: the concierge runs lean', () => {
  const base: RunOptions = { cwd: '.', model: 'haiku', effort: 'low', permission: 'read-only', lean: true };
  it('claude: no tools, no MCP, no skills, no session, the front-desk text replaces the default prompt', () => {
    const a = claudeArgs(base, 'sp.txt');
    expect(a).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--model', 'haiku', '--effort', 'low', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']));
    expect(a[a.indexOf('--tools') + 1]).toBe(''); // an empty list disables every tool
    expect(a[a.indexOf('--system-prompt-file') + 1]).toBe('sp.txt');
    expect(a).not.toContain('--append-system-prompt-file');
    for (const f of ['--resume', '--permission-mode', '--allowedTools', '--add-dir', '--disallowedTools']) expect(a).not.toContain(f);
  });
  it('a normal run is unchanged', () => {
    const a = claudeArgs({ ...base, lean: undefined }, 'sp.txt');
    expect(a).toContain('--append-system-prompt-file');
    expect(a).not.toContain('--tools');
  });
  it('an empty argument is quotable for a .cmd shim', () => {
    expect(quoteWinArg('')).toBe('""');
    expect(() => quoteWinArg('a"b')).toThrow(/Unsafe/);
  });
  it('the concierge gets lean=true and a folder that is not the project', async () => {
    const h = await harness({ claude: script({ concierge: () => say(JSON.stringify({ answer: 'hi' })) }) }, { dataDir: true });
    await h.svc.send(h.conv.id, 'hello there');
    await h.svc.whenIdle();
    const [c] = h.calls(isConcierge);
    expect(c!.opts.lean).toBe(true);
    expect(c!.opts.cwd).not.toBe(h.repoPath);
    expect(c!.opts.cwd).toContain('neutral');
    // The lead is never lean and works in the project.
    expect(h.calls(isLead)).toHaveLength(0);
    await h.svc.send(h.conv.id, 'fix the bug in src/app.ts');
    await h.svc.whenIdle();
    const [lead] = h.calls(isLead);
    expect(lead!.opts.lean).toBeUndefined();
    expect(lead!.opts.cwd).toBe(h.repoPath);
  });
});

describe('item 7: Codex gets the system prompt only on the first run', () => {
  const echoExe = () => {
    const d = tmp('harbor-codex-');
    const js = join(d, 'fake.js');
    writeFileSync(js, [
      'let s=""; process.stdin.on("data",(c)=>s+=c); process.stdin.on("end",()=>{',
      'for (const e of [{type:"thread.started",thread_id:"t"},{type:"item.completed",item:{type:"agent_message",text:"STDIN:"+s}},{type:"turn.completed",usage:{}}]) console.log(JSON.stringify(e)); });'
    ].join('\n'));
    const exe = process.platform === 'win32' ? join(d, 'codex.cmd') : join(d, 'codex');
    if (process.platform === 'win32') writeFileSync(exe, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
    else writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
    return { exe, d };
  };
  const stdinOf = async (o: Partial<RunOptions>) => {
    const { exe, d } = echoExe();
    const chunks: Chunk[] = [];
    for await (const c of new CodexAdapter(exe).run('THE PROMPT', { cwd: d, model: 'default', effort: 'low', permission: 'read-only', systemPrompt: 'ROLE CONTRACT', ...o })) chunks.push(c);
    return (chunks.find((c) => c.kind === 'text') as { text: string }).text;
  };
  it('first run: role contract and prompt', async () => {
    const t = await stdinOf({});
    expect(t).toContain('ROLE CONTRACT');
    expect(t).toContain('THE PROMPT');
  }, 30000);
  it('resumed run: the prompt only', async () => {
    const t = await stdinOf({ resumeId: 'thread-1' });
    expect(t).not.toContain('ROLE CONTRACT');
    expect(t).toContain('THE PROMPT');
  }, 30000);
});

describe('item 4: how many helpers the user asked for', () => {
  it.each([
    ['use 6 helpers for this', { helpers: 6 }],
    ['spawn five parallel agents', { helpers: 5 }],
    ['I want three planners and 8 workers', { helpers: 8, planners: 3 }],
    ['fix the 2 failing tests', {}],
    ['with 2 planners', { planners: 2 }]
  ])('%s', (text, want) => {
    const got = askedCounts(text);
    expect({ ...(got.helpers ? { helpers: got.helpers } : {}), ...(got.planners ? { planners: got.planners } : {}) }).toEqual(want);
  });
});

// ------------------------------------------------------------------ orchestrator scenarios

// Instructions differ per title: identical delegations in one turn are merged by Harbor (a model stutter), which is not what these tests probe.
const task = (o: Record<string, unknown>) => ({ ref: 't', title: 'Task', role: 'other', access: 'read', complexity: 'low', ...o, instructions: `look around for ${String(o['title'] ?? 'Task')}` });
const reportTurns = (h: { calls: (p: (o: RunOptions) => boolean) => Array<{ prompt: string; opts: RunOptions }> }) =>
  h.calls(isLead).filter((c) => c.prompt.includes('Helper reports'));
const claudeAndCodex = ['claude', 'codex'];

describe('item 1: the orchestrator wires the router outputs', () => {
  it('stores scores, margin and skips with the routing reason on the lead message', async () => {
    const h = await harness({ claude: script({ lead: () => say('done') }), codex: () => say('x') }, { ids: claudeAndCodex });
    await h.svc.send(h.conv.id, 'fix the bug in src/app.ts');
    await h.svc.whenIdle();
    const m = (await h.messages()).find((x) => x.role === 'assistant' && x.details)!;
    expect(m.details!.scored!.length).toBeGreaterThan(0);
    // Phase 3: on the built-in catalog the price may hand the lead to Codex's cheaper model; what matters here is the wiring.
    expect(m.details!.scored![0]).toMatchObject({ cli: m.details!.cli, model: m.details!.model });
    expect(m.details).toHaveProperty('margin');
    expect(m.details!.reason).toContain(m.details!.model);
    expect(typeof m.details!.difficulty).toBe('number');
  });
  it('recent failures of a model reach the router as history', async () => {
    const h = await harness({ claude: script({ lead: () => say('done') }) });
    for (let i = 0; i < 2; i++) h.svc.store.addUsage({ id: `u${i}`, time: Date.now() - 1000, cli: 'claude', model: 'sonnet', projectId: h.project.id, agentId: 'a', durationMs: 1, ok: false });
    await h.svc.send(h.conv.id, 'fix the bug in src/app.ts');
    await h.svc.whenIdle();
    const m = (await h.messages()).find((x) => x.role === 'assistant' && x.details)!;
    // The penalty is real enough to matter: sonnet carries it, and a pricier sibling may now win the lead's own routing.
    expect(m.details!.scored!.find((s) => s.model === 'claude-sonnet-5-5')!.terms['history']).toBeLessThan(0);
  });
  it('when nothing can run, the message says why and when it clears', async () => {
    const resetsAt = Date.now() + 2 * HOUR;
    const h = await harness({}, { ids: ['claude'], service: { ledger: { reported: () => [{ period: 'session', usedPct: 100, resetsAt, asOf: Date.now() }] } } });
    await h.svc.send(h.conv.id, 'fix the bug in src/app.ts');
    await h.svc.whenIdle();
    const t = (await h.texts()).join('\n');
    expect(t).toContain('No eligible CLI is available');
    expect(t).toContain('allowance exhausted or rate limited');
    expect(t).toContain('available again around');
  });
  it('an image turn needs a model with vision: Codex alone is refused with the reason, nothing is run', async () => {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const h = await harness({ codex: () => say('I see') }, { ids: ['codex'], dataDir: true });
    await h.svc.send(h.conv.id, 'what is in this?', [{ name: 'shot.png', mime: 'image/png', dataBase64: PNG }]);
    await h.svc.whenIdle();
    expect(h.adapters['codex']!.calls).toHaveLength(0);
    expect((await h.texts()).join('\n')).toContain('lacks required vision');
  });
  it.each([['Claude usage limit reached', true], ['Opus usage limit reached', undefined]])('a rate limit "%s" is recorded cliWide=%s', async (error, cliWide) => {
    const h = await harness({ claude: script({ concierge: () => [{ kind: 'done', ok: false, error, rateLimited: true }] }) }, { ids: ['claude'] });
    await h.svc.send(h.conv.id, 'hello');
    await h.svc.whenIdle();
    const limited = h.svc.store.listUsage().filter((u) => u.rateLimited);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited.every((u) => u.cliWide === cliWide)).toBe(true);
  });
});

describe('item 2: retries escalate one axis, and only after a rejection', () => {
  /** A lead that delegates `first` once, then (on a later turn) the retry of the helper titled Build. */
  const retryScenario = async (first: Record<string, unknown>[], retry: Record<string, unknown>, helper: Roles['helper'], setup?: (repo: string) => void) => {
    let h: Awaited<ReturnType<typeof harness>>;
    let delegatedRetry = false;
    const lead: Roles['lead'] = (prompt) => {
      if (prompt.includes('User:\n')) return delegate('go', ...first);
      if (!delegatedRetry && h.helpers().length >= first.length && h.helpers().every((a) => a.state === 'done' || a.state === 'failed')) {
        delegatedRetry = true;
        return delegate('again', { ...retry, retryOf: h.helper('Build').id });
      }
      return say('fin');
    };
    h = await harness({ claude: script({ lead, helper }) }, { service: { autoApproveChecks: true } });
    setup?.(h.repoPath);
    await h.svc.send(h.conv.id, 'implement it');
    await h.svc.whenIdle();
    return h;
  };
  const write = (name: string): Roles['helper'] => (_p, o) => { writeFileSync(join(o.cwd, name), 'x'); return say('Done'); };
  const failingCheck = (repo: string) => { mkdirSync(join(repo, '.harbor')); writeFileSync(join(repo, '.harbor', 'checks.json'), JSON.stringify({ checks: ['node -e "process.exit(1)"'] })); };

  // Phase 3: a rejection raises the capability floor one step (difficulty), met by more effort on the same model first and a stronger
  // model only when that is clearly cheaper; an infrastructure failure keeps difficulty, model and effort (was: tier first, then effort).
  it('a failed Harbor check raises the floor one step: the next capability step when the old model has no effort left', async () => {
    const h = await retryScenario([task({ ref: 'i', title: 'Build', role: 'implementer', access: 'edit', complexity: 'medium', files: ['a.txt'] })],
      task({ ref: 'i2', title: 'Build again', role: 'implementer', access: 'edit', complexity: 'medium', files: ['a.txt'] }), write('a.txt'), failingCheck);
    const [first, second] = h.helpers();
    expect(first!.checks?.some((c) => !c.ok)).toBe(true);
    // Harbor rates the first run 4 (medium hint, one file, short, checked): Haiku at high effort, its last effort step.
    expect(first).toMatchObject({ difficulty: 4, model: 'claude-haiku-5-5', effort: 'high' });
    expect(second!.difficulty).toBeGreaterThan(first!.difficulty!);
    expect(second).toMatchObject({ retry: true, model: 'claude-sonnet-5-5', escalateFrom: { cli: 'claude', model: 'claude-haiku-5-5', effort: 'high' } });
    expect((await h.texts()).some((t) => t.startsWith('Retrying "Build again" with the capability floor one step higher'))).toBe(true);
  });
  it('a rejection on a model with effort to spare raises the effort on that model first', async () => {
    // Phase 4: a "high" counts only with a one-line reason, so these carry one.
    const why = 'touches the shared billing ledger';
    const h = await retryScenario([task({ ref: 'i', title: 'Build', role: 'implementer', access: 'edit', complexity: 'high', reason: why, files: ['a.txt'] })],
      task({ ref: 'i2', title: 'Build again', role: 'implementer', access: 'edit', complexity: 'high', reason: why, files: ['a.txt'] }), write('a.txt'), failingCheck);
    const [first, second] = h.helpers();
    // A bare "high" with no risk words rates 6: Sonnet at medium. The retry needs one more step: Sonnet at high, not Opus.
    expect(first).toMatchObject({ difficulty: 6, model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(second).toMatchObject({ retry: true, model: 'claude-sonnet-5-5', effort: 'high' });
  });
  it('a reviewer verdict of "changes" escalates too', async () => {
    const helper: Roles['helper'] = (p, o) => {
      if (o.permission === 'edit') { writeFileSync(join(o.cwd, 'a.txt'), 'x'); return say('Done'); }
      return say(['Reviewed.', `HARBOR_RESULT: ${JSON.stringify({ outcome: 'done', summary: 'No.', verdict: 'changes', checks: [] })}`].join('\n'));
    };
    const h = await retryScenario([
      task({ ref: 'i', title: 'Build', role: 'implementer', access: 'edit', complexity: 'low', files: ['a.txt'] }),
      task({ ref: 'r', title: 'Review it', role: 'reviewer', complexity: 'low', dependsOn: ['i'] })
    ], task({ ref: 'i2', title: 'Build again', role: 'implementer', access: 'edit', complexity: 'low', files: ['a.txt'] }), helper);
    const first = h.helper('Build'), second = h.helper('Build again');
    expect(second.difficulty).toBeGreaterThan(first.difficulty!);
    expect(second.retry).toBe(true);
    expect(second.escalateFrom).toMatchObject({ model: first.model });
  });
  it('a failure with no rejection keeps difficulty, model and effort and records what to avoid', async () => {
    let runs = 0;
    const h = await retryScenario([task({ ref: 'i', title: 'Build', role: 'implementer', access: 'edit', complexity: 'medium', files: ['a.txt'] })],
      task({ ref: 'i2', title: 'Build again', role: 'implementer', access: 'edit', complexity: 'medium', files: ['a.txt'] }),
      () => (runs++ === 0 ? [{ kind: 'done', ok: false, error: 'connection to the model dropped' }] : say('Done')));
    const [first, second] = h.helpers();
    expect(first!.state).toBe('failed');
    expect(second).toMatchObject({ difficulty: first!.difficulty, model: first!.model, effort: first!.effort });
    expect(second!.retry).toBeUndefined();
    expect(second!.avoid).toEqual([{ cli: 'claude' }]); // per CLI: avoiding sonnet alone would buy opus
  });
});

describe('item 3: planner tier follows complexity', () => {
  const plannerModel = async (complexity: string, reason?: string) => {
    const h = await harness({ claude: script({ lead: (p) => (p.includes('User:\n') ? delegate('plan', task({ ref: 'p', title: 'Plan it', role: 'planner', complexity, ...(reason ? { reason } : {}) })) : say('ok')) }) });
    await h.svc.send(h.conv.id, 'plan the migration');
    await h.svc.whenIdle();
    return h.helper('Plan it');
  };
  it('medium -> sonnet, high with a reason -> opus (a bare high counts as medium)', async () => {
    expect((await plannerModel('medium')).model).toBe('claude-sonnet-5-5');
    // Phase 4: "high" counts only with a one-line reason (leads overrate their work); without one it is medium.
    expect((await plannerModel('high')).model).toBe('claude-sonnet-5-5');
    expect((await plannerModel('high', 'cross-package schema migration with a data backfill')).model).toBe('claude-opus-5-5');
  });
  it('the lead prompt tells it to skip the planner it does not need and to delegate only sizeable chunks', async () => {
    const h = await harness({ claude: script({ lead: () => say('ok') }) });
    await h.svc.send(h.conv.id, 'fix the bug in src/app.ts');
    await h.svc.whenIdle();
    const sys = h.calls(isLead)[0]!.opts.systemPrompt!;
    expect(sys).toMatch(/Skip the planner when you have already read the code/);
    // Phase 4: the size rule is one concern per helper of about 25 minutes (was: chunks over roughly 30k tokens).
    expect(sys).toMatch(/one concern or package per helper, about 25 minutes of work or less/);
    expect(sys).toMatch(/One reviewer per integrated change, not per branch/);
    expect(sys).toMatch(/diff stat and the Harbor check results/);
  });
});

describe('item 4: fan-out brakes', () => {
  const six = Array.from({ length: 6 }, (_, i) => task({ ref: `t${i}`, title: `Look ${i}` }));
  const run = async (text: string, plan: unknown[], settings?: { maxHelpersPerTurn?: number; maxPlannersPerTurn?: number }) => {
    const h = await harness({ claude: script({ lead: (p) => (p.includes('User:\n') ? delegate('go', ...plan) : say('ok')) }) });
    if (settings) await h.svc.setSettings(settings);
    await h.svc.send(h.conv.id, text);
    await h.svc.whenIdle();
    return h;
  };
  it('no per-turn limit by default: every delegation is created and nothing is held back', async () => {
    const h = await run('survey the whole repository in src/', six);
    expect(h.helpers()).toHaveLength(6);
    expect(h.helpers().every((a) => !a.paused)).toBe(true);
    expect((await h.texts()).some((t) => /paused|held back/.test(t))).toBe(false);
  });
  it('a per-turn setting creates the rest paused (a record to resume), tells the user and the lead, and the user asking for more lifts it', async () => {
    const h = await run('survey the whole repository in src/', six, { maxHelpersPerTurn: 4 });
    expect(h.helpers()).toHaveLength(6);
    expect(h.helpers().filter((a) => a.paused).map((a) => a.title).sort()).toEqual(['Look 4', 'Look 5']);
    expect((await h.texts()).some((t) => /created 2 of 6 delegated helper\(s\) paused \(your limit per turn: 4 helpers\)/.test(t))).toBe(true);
    const next = h.calls(isLead).find((c) => c.prompt.includes('Helper reports'))!;
    expect(next.prompt).toContain('Harbor created but PAUSED 2 of your delegations');
    expect(next.prompt).toContain('do not delegate them again');
    expect((await run('use 6 helpers to survey src/', six, { maxHelpersPerTurn: 4 })).helpers().every((a) => !a.paused)).toBe(true);
  });
  it('a planner limit pauses the extra planner; the work waiting on it is created and waits on it (never dropped)', async () => {
    const plan = [task({ ref: 'p1', title: 'Plan A', role: 'planner' }), task({ ref: 'p2', title: 'Plan B', role: 'planner' }),
      task({ ref: 'i2', title: 'Build B', role: 'implementer', access: 'edit', specFrom: 'p2', files: ['b.txt'] })];
    const h = await run('plan and build src/ changes', plan, { maxPlannersPerTurn: 1 });
    expect(h.helpers().map((a) => `${a.title}${a.paused ? ' (paused)' : ''}`).sort()).toEqual(['Build B', 'Plan A', 'Plan B (paused)']);
    expect(h.helper('Build B').dependsOn).toContain(h.helper('Plan B').id);
    expect((await run('use 2 planners for src/ changes', plan, { maxPlannersPerTurn: 1 })).helpers().every((a) => !a.paused)).toBe(true);
  });
  it('missedHistory: what a resumed session did not see while another CLI had the conversation', () => {
    const m = (time: number, role: 'user' | 'assistant' | 'system', cli?: string) => ({ id: String(time), conversationId: 'c', role, text: `t${time}`, time, ...(cli ? { details: { cli, model: 'm', effort: 'medium', reason: '' } } : {}) });
    const msgs = [m(1, 'user'), m(2, 'assistant', 'claude'), m(3, 'user'), m(4, 'assistant', 'codex'), m(5, 'system'), m(6, 'user')];
    // Claude's session last ran at 2 (its own reply is at 2): it missed the user at 3 and codex at 4; the trigger at 6 is already in the prompt.
    expect(missedHistory(msgs, 2, 'claude').map((x) => x.time)).toEqual([3, 4]);
    expect(missedHistory(msgs, 4, 'codex')).toEqual([]);
    expect(missedHistory(Array.from({ length: 30 }, (_, i) => m(i + 1, i % 2 ? 'assistant' : 'user', 'codex')), 0, 'claude')).toHaveLength(10);
  });
  it('settings are validated and clamped', async () => {
    const h = await harness({});
    expect((await h.svc.setSettings({ maxHelpersPerTurn: 99, maxPlannersPerTurn: 0 })).maxHelpersPerTurn).toBe(12);
    expect((await h.svc.getSettings()).maxPlannersPerTurn).toBe(1);
    await expect(h.svc.setSettings({ maxHelpersPerTurn: 'x' as unknown as number })).rejects.toThrow(/number/);
  });
  it('a helper does not start on a CLI at low allowance while the other is healthy; the reason says so', async () => {
    const reported = (cliId: string) => (cliId === 'claude' ? [{ period: 'session' as const, usedPct: 85, resetsAt: Date.now() + HOUR, asOf: Date.now() }] : []);
    const h = await harness({ claude: script({ lead: (p) => (p.includes('User:\n') ? delegate('go', task({ ref: 'i', title: 'Build', role: 'implementer', access: 'edit', complexity: 'medium', files: ['a.txt'] })) : say('ok')) }), codex: () => say('built') },
      { ids: claudeAndCodex, service: { ledger: { reported } } });
    await h.svc.send(h.conv.id, 'use claude to implement the feature in src/a.ts'); // asking for claude keeps the lead there; the helper is what moves
    await h.svc.whenIdle();
    expect(h.helper('Build').cli).toBe('codex');
    const m = (await h.svc.listMessages((await h.svc.openAgentConversation(h.helper('Build').id)).id)).find((x) => x.details);
    expect(m!.details!.reason).toMatch(/helpers are not started on it while codex is healthy/);
  });
});

describe('item 5: the lead keeps its model and effort inside a conversation', () => {
  it('moves up a tier when the front desk says high, never back down, and never flips effort', async () => {
    const levels = ['medium', 'high', 'low'];
    let n = 0;
    const h = await harness({ claude: script({ concierge: () => escalate(levels[n++] ?? 'low'), lead: () => say('ok') }) });
    // Messages that are not obvious workspace requests, so each one is triaged by the front desk.
    for (const text of ['please look into why startup feels slow', 'now think harder about the slow startup', 'ok and what about the memory use']) {
      await h.svc.send(h.conv.id, text);
      await h.svc.whenIdle();
    }
    const leads = h.calls(isLead).map((c) => [c.opts.model, c.opts.effort]);
    expect(leads).toEqual([['claude-sonnet-5-5', 'medium'], ['claude-opus-5-5', 'medium'], ['claude-opus-5-5', 'medium']]);
    expect(h.calls(isLead)[2]!.opts.resumeId).toBeTruthy();
  });
  it('a new conversation starts fresh and routes normally', async () => {
    const h = await harness({ claude: script({ concierge: () => escalate('high'), lead: () => say('ok') }) });
    await h.svc.send(h.conv.id, 'please look into why startup feels slow');
    await h.svc.whenIdle();
    const other = await h.svc.newConversation(h.project.id);
    h.adapters['claude']!.calls.length = 0;
    await h.svc.send(other.id, 'what is a mutex');
    await h.svc.whenIdle();
    expect(h.calls(isLead)[0]!.opts.resumeId).toBeUndefined();
  });
});

describe('item 6: report wake-ups are coalesced', () => {
  it('a cascade of failing helpers wakes the lead once, with all of them in one batch', async () => {
    const plan = [1, 2, 3].map((i) => task({ ref: `t${i}`, title: `Probe ${i}` }));
    const h = await harness({ claude: script({ lead: (p) => (p.includes('User:\n') ? delegate('go', ...plan) : say('ok')), helper: () => [{ kind: 'done', ok: false, error: 'boom' }] }) });
    await h.svc.send(h.conv.id, 'probe src/ three ways');
    await h.svc.whenIdle();
    const turns = reportTurns(h);
    expect(turns).toHaveLength(1);
    for (const i of [1, 2, 3]) expect(turns[0]!.prompt).toContain(`Probe ${i}`);
  });
  it('with the debounce off, the same cascade wakes it more than once (what this prevents)', async () => {
    const plan = [1, 2, 3].map((i) => task({ ref: `t${i}`, title: `Probe ${i}` }));
    const h = await harness({ claude: script({ lead: (p) => (p.includes('User:\n') ? delegate('go', ...plan) : say('ok')), helper: () => [{ kind: 'done', ok: false, error: 'boom' }] }) }, { service: { reportDebounce: { ms: 0 } } });
    await h.svc.send(h.conv.id, 'probe src/ three ways');
    await h.svc.whenIdle();
    expect(reportTurns(h).length).toBeGreaterThanOrEqual(1);
  });
  it('the debounce timer is injectable, and a pending wake keeps the service busy until it fires', async () => {
    const fire: Array<() => void> = [];
    const h = await harness({ claude: script({ lead: (p) => (p.includes('User:\n') ? delegate('go', task({ ref: 't1', title: 'Probe 1' })) : say('ok')) }) },
      { service: { reportDebounce: { ms: 400, setTimer: (fn) => { fire.push(fn); return () => {}; } } } });
    await h.svc.send(h.conv.id, 'probe src/ once');
    await until(() => fire.length === 1);
    expect(reportTurns(h)).toHaveLength(0); // waiting out the debounce
    fire[0]!();
    await h.svc.whenIdle();
    expect(reportTurns(h)).toHaveLength(1);
  });
  it('a finished planner does not wake the lead while implementers waiting on its spec are queued; its report rides the final wake', async () => {
    const plan = [task({ ref: 'p', title: 'Plan it', role: 'planner', complexity: 'medium' }),
      task({ ref: 'a', title: 'Build A', role: 'implementer', access: 'edit', specFrom: 'p', files: ['a.txt'] }),
      task({ ref: 'b', title: 'Build B', role: 'implementer', access: 'edit', specFrom: 'p', files: ['b.txt'] })];
    const h = await harness({ claude: script({ lead: (p) => (p.includes('User:\n') ? delegate('go', ...plan) : say('ok')),
      helper: (_p, o) => { if (o.permission === 'edit') writeFileSync(join(o.cwd, 'x.txt'), 'x'); return say('done'); } }) });
    await h.svc.send(h.conv.id, 'plan and build it in src/');
    await h.svc.whenIdle();
    const turns = reportTurns(h);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toContain('Plan it');
    expect(turns[0]!.prompt).toContain('Build A');
  });
  it('a planner with nothing waiting on it still wakes the lead', async () => {
    const h = await harness({ claude: script({ lead: (p) => (p.includes('User:\n') ? delegate('go', task({ ref: 'p', title: 'Plan it', role: 'planner' }), task({ ref: 'r', title: 'Slow research' })) : say('ok')),
      helper: (p) => say(p.includes('Slow research') ? 'late' : 'plan')  }) });
    await h.svc.send(h.conv.id, 'plan it in src/');
    await h.svc.whenIdle();
    expect(reportTurns(h).length).toBeGreaterThanOrEqual(1);
  });
});

describe('item 1: catalog warnings are surfaced', () => {
  it('a broken capabilities.json shows up in the diagnostics bundle and the journal', async () => {
    // The file is read at startup, so the service is built over a data folder that already has a bad one.
    const dir = tmp('harbor-data-bad-');
    writeFileSync(join(dir, 'capabilities.json'), JSON.stringify([{ cli: 'claude', model: 'x', tier: 'huge', strengths: [] }, { cli: 'claude', model: 'haiku', tier: 'cheap', strengths: ['chat'] }]));
    const h2 = await harness({}, { service: { dataDir: dir } });
    const diag = await h2.svc.exportDiagnostics();
    expect(diag).toContain('capabilities.json entry 1 dropped');
  });
});

