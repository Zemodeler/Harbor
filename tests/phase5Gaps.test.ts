import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeArgs, parseClaudeLine } from '../src/main/adapters/claude';
import { codexArgs, parseCodexLine } from '../src/main/adapters/codex';
import type { Chunk, RunOptions } from '../src/main/adapters/types';
import { billableKTok } from '../src/main/calibration';
import { DEFAULT_CATALOG, autoRoutable, entryFor, loadCatalogWithWarnings } from '../src/main/clis/capabilities';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { isEmittableEffort, nativeEffort } from '../src/main/clis/effort';
import { route } from '../src/main/router';
import { RunUsage, perRunUsage } from '../src/main/runUsage';
import { Store } from '../src/main/store';
import { UsageLedger } from '../src/main/usage';

/**
 * Phase 5, part C: gaps closed along the way. No CLI is run: the stream lines below are shaped like real Claude Code 2.1 stream-json
 * output (one `assistant` line per content block, each repeating the message's usage snapshot; a `rate_limit_event` whose window
 * keys match what Harbor recorded from the owner's account on 2026-10-12, overage key included; a final `result` with run totals).
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const line = (o: unknown) => JSON.stringify(o);
const RESET = 1_791_800_000; // epoch seconds
const STREAM = [
  line({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-5-5', tools: ['Read', 'Edit', 'Bash'] }),
  line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
    five_hour: { utilization: 0.1, resetsAt: RESET }, seven_day: { utilization: 0.09, resetsAt: RESET + 400_000 },
    seven_day_overage_included: { utilization: 0.13, resetsAt: RESET + 400_000 } } } }),
  line({ type: 'assistant', message: { id: 'msg_01', role: 'assistant', content: [{ type: 'text', text: 'Reading the store.' }],
    usage: { input_tokens: 3, cache_creation_input_tokens: 4_200, cache_read_input_tokens: 15_000, output_tokens: 8 } } }),
  line({ type: 'assistant', message: { id: 'msg_01', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'src/store.ts' } }],
    usage: { input_tokens: 3, cache_creation_input_tokens: 4_200, cache_read_input_tokens: 15_000, output_tokens: 160 } } }),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '...' }] } }),
  line({ type: 'assistant', message: { id: 'msg_02', role: 'assistant', content: [{ type: 'text', text: 'Done.' }],
    usage: { input_tokens: 2, cache_creation_input_tokens: 900, cache_read_input_tokens: 19_200, output_tokens: 420 } } }),
  line({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', result: 'Done.', total_cost_usd: 0.42,
    usage: { input_tokens: 5, cache_creation_input_tokens: 5_100, cache_read_input_tokens: 34_200, output_tokens: 580 } })
];
const chunks = (lines: string[]): Chunk[] => lines.flatMap(parseClaudeLine);
const usageOf = (cs: Chunk[], finished: boolean) => { const u = new RunUsage(); for (const c of cs) if (c.kind === 'usage') u.add(c); return u.result(finished); };

describe('Claude stream-json usage (fixture shaped like real output)', () => {
  it('the final result wins: run totals with cache reads and writes', () => {
    expect(usageOf(chunks(STREAM), true)).toEqual({ inputTokens: 5, outputTokens: 580, costUsd: 0.42, cacheReadTokens: 34_200, cacheWriteTokens: 5_100 });
  });
  it('a run stopped before its result sums each message once, at its latest snapshot (per-message usage, not per block)', () => {
    const cut = chunks(STREAM.slice(0, -1));
    expect(usageOf(cut, false)).toEqual({ partial: true, inputTokens: 5, outputTokens: 580, cacheReadTokens: 34_200, cacheWriteTokens: 5_100 });
    // Billable k-tokens as calibration weighs them: cache reads at a tenth.
    expect(billableKTok(usageOf(cut, false))).toBeCloseTo((5 + 580 + 5_100 + 0.1 * 34_200) / 1000);
  });
  it('reads the account windows; the overage key a real account sends is not taken for a model scope', () => {
    const limits = chunks(STREAM).find((c) => c.kind === 'limits');
    expect(limits && limits.kind === 'limits' ? limits.limits.map((l) => [l.period, l.scope, Math.round(l.usedPct)]) : []).toEqual([['session', undefined, 10], ['weekly', undefined, 9]]);
  });
});

describe('per-run usage of resumed sessions', () => {
  it('Codex: thread totals become per-run counts; its cached input is split off as cache reads', () => {
    const turn = (input: number, cached: number, output: number) =>
      parseCodexLine(line({ type: 'turn.completed', usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } }))[0]!;
    const first = turn(3_017_738, 2_900_000, 8_246);
    expect(first).toMatchObject({ kind: 'usage', inputTokens: 117_738, cacheReadTokens: 2_900_000, outputTokens: 8_246 });
    const u1 = usageOf([first], true);
    const r1 = perRunUsage('codex', u1);
    expect(r1.tokens).toEqual(u1);
    const u2 = usageOf([turn(3_603_272, 3_450_000, 12_245)], true);
    const r2 = perRunUsage('codex', u2, r1.totals);
    expect(r2.tokens).toMatchObject({ inputTokens: 153_272 - 117_738, cacheReadTokens: 550_000, outputTokens: 3_999 });
    // A new thread (lower totals) is taken as it is.
    expect(perRunUsage('codex', { inputTokens: 10, outputTokens: 1 }, r2.totals).tokens).toEqual({ inputTokens: 10, outputTokens: 1 });
  });
  it('Claude: tokens are per run, the cost is the session total', () => {
    const r1 = perRunUsage('claude', { inputTokens: 4, outputTokens: 1_093, costUsd: 1.24 });
    const r2 = perRunUsage('claude', { inputTokens: 2, outputTokens: 2_717, costUsd: 1.46 }, r1.totals);
    expect(r2.tokens.costUsd).toBeCloseTo(0.22);
    expect(r2.tokens.outputTokens).toBe(2_717);
    // A run cut short keeps the earlier totals.
    expect(perRunUsage('claude', { partial: true, outputTokens: 10 }, r2.totals)).toEqual({ tokens: { partial: true, outputTokens: 10 }, totals: r2.totals });
  });
});

describe('model ids: what routing picks is what the adapters pass', () => {
  const cli = (id: string): ResolvedCli => ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'] }) as ResolvedCli;
  const ledger = () => new UsageLedger(new Store(), { now: () => 1 });
  const opts = (model: string, effort: 'low' | 'medium' | 'high'): RunOptions => ({ cwd: '.', model, effort, permission: 'edit' });

  it('every auto-routable model reaches its CLI as its full id, with an effort the CLI accepts', () => {
    for (const e of DEFAULT_CATALOG.filter(autoRoutable)) {
      for (const effort of ['low', 'medium', 'high'] as const) {
        const native = nativeEffort(e, effort);
        expect(isEmittableEffort(native), `${e.model} ${effort}`).toBe(true);
        expect(['xhigh', 'max', 'ultra']).not.toContain(native);
        if (e.cli === 'claude') {
          const a = claudeArgs(opts(e.model, effort));
          expect(a[a.indexOf('--model') + 1]).toBe(e.model);
          expect(a[a.indexOf('--effort') + 1]).toBe(effort);
        } else {
          const a = codexArgs({ ...opts(e.model, effort), nativeEffort: native });
          expect(a[a.indexOf('-m') + 1]).toBe(e.model);
          expect(a).toContain(`model_reasoning_effort=${native}`);
        }
      }
    }
  });
  it('a session stored under an old alias resumes on the full id (route returns the catalog id, never the alias)', () => {
    const d = route({ role: 'main', complexity: 'medium', interactive: true, keep: { cli: 'claude', model: 'opus', effort: 'low' }, continuity: 'claude' }, { clis: [cli('claude')], ledger: ledger(), enabled: () => true, hasAdapter: () => true, load: () => 0 })!;
    expect(d.model).toBe('claude-opus-5-5');
    expect(entryFor(DEFAULT_CATALOG, 'claude', 'opus')).toBe(entryFor(DEFAULT_CATALOG, 'claude', d.model));
    const a = claudeArgs(opts(d.model, d.effort));
    expect(a[a.indexOf('--model') + 1]).toBe('claude-opus-5-5');
  });
  it("Codex's catch-all 'default' entry passes no -m (the CLI's configured model)", () => {
    expect(codexArgs(opts('default', 'medium'))).not.toContain('-m');
  });
});

describe('capabilities.json override (catalog v2)', () => {
  const file = (content: unknown) => { const d = mkdtempSync(join(tmpdir(), 'harbor-p5cat-')); dirs.push(d); const f = join(d, 'capabilities.json'); writeFileSync(f, JSON.stringify(content)); return f; };
  it('the built-in catalog written out as an override loads back unchanged, with no warnings', () => {
    expect(loadCatalogWithWarnings(file(DEFAULT_CATALOG))).toEqual({ catalog: JSON.parse(JSON.stringify(DEFAULT_CATALOG)), warnings: [] });
  });
  it('v2 fields are validated: a bad pool, cost per token or efforts list drops only that entry', () => {
    const good = DEFAULT_CATALOG.find((e) => e.model === 'claude-sonnet-5-5')!;
    const r = loadCatalogWithWarnings(file([good, { ...good, model: 'x1', pool: 7 }, { ...good, model: 'x2', costPerKTok: -1 }, { ...good, model: 'x3', efforts: ['low', ''] }]));
    expect(r.catalog.map((e) => e.model)).toEqual(['claude-sonnet-5-5']);
    expect(r.warnings).toEqual([
      'capabilities.json entry 2 dropped: pool must be a non-empty string',
      'capabilities.json entry 3 dropped: costPerKTok must be a positive number',
      'capabilities.json entry 4 dropped: efforts must be a list of strings'
    ]);
  });
});
