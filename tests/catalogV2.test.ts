import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseClaudeLine } from '../src/main/adapters/claude';
import { codexArgs } from '../src/main/adapters/codex';
import type { Chunk, CliAdapter, RunOptions } from '../src/main/adapters/types';
import {
  DEFAULT_CATALOG, autoRoutable, costWeightOf, entryFor, loadCatalogWithWarnings, poolOf, strengthsFrom, type CatalogEntry
} from '../src/main/clis/capabilities';
import { mergeCodexModels, parseCodexModels, readCodexModels } from '../src/main/clis/codexModels';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { nativeEffort } from '../src/main/clis/effort';
import { route, type RouterInput } from '../src/main/router';
import { RunUsage } from '../src/main/runUsage';
import { Store } from '../src/main/store';
import { UsageLedger } from '../src/main/usage';
import { escalate, harness, isConcierge, until } from './hardeningHarness';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const cli = (id: string): ResolvedCli => ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'] });
const input = (extra: Partial<RouterInput> = {}, clis = [cli('claude'), cli('codex')]): RouterInput =>
  ({ clis, ledger: new UsageLedger(new Store(), { now: () => 1 }), enabled: () => true, hasAdapter: () => true, load: () => 0, ...extra });
const pick = (d: ReturnType<typeof route>) => (d ? `${d.cli}/${d.model}` : undefined);
const find = (model: string) => DEFAULT_CATALOG.find((e) => e.model === model)!;

/** A trimmed copy of the real ~/.codex/models_cache.json shape (codex-cli 0.162), instructions omitted. */
const levels = (...e: string[]) => e.map((effort) => ({ effort, description: effort }));
const CACHE = JSON.stringify({
  fetched_at: '2026-10-12T17:37:36Z', client_version: '0.162.0',
  models: [
    { slug: 'gpt-6.1-sol', visibility: 'list', context_window: 500000, supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh', 'max', 'ultra') },
    { slug: 'gpt-6-astra', visibility: 'list', context_window: 272000, supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh', 'max', 'ultra') },
    { slug: 'gpt-6-luna', visibility: 'list', context_window: 272000, supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh', 'max') },
    { slug: 'gpt-reserve', visibility: 'hide', context_window: 272000, supported_reasoning_levels: levels('low', 'medium') },
    { slug: 'gpt-5.6-sol', visibility: 'list', context_window: 272000, supported_reasoning_levels: levels('low', 'medium', 'high') },
    { slug: 'gpt-7-nova', visibility: 'list', context_window: 400000, supported_reasoning_levels: levels('low', 'medium', 'high') },
    { slug: 'codex-auto-review', visibility: 'hide', supported_reasoning_levels: levels('low') }
  ]
});

describe('catalog v2: data', () => {
  it('derives strengths from capability scores and keeps the v1 strengths of the Claude and Codex-default entries', () => {
    for (const e of DEFAULT_CATALOG) expect(e.strengths).toEqual(strengthsFrom(e.capability!));
    const set = (m: string) => [...find(m).strengths].sort();
    expect(set('claude-haiku-5-5')).toEqual(['chat', 'code', 'research']);
    expect(set('claude-sonnet-5-5')).toEqual(['chat', 'code', 'long-context', 'planning', 'research', 'review', 'vision']);
    expect(set('claude-opus-5-5')).toEqual(['code', 'long-context', 'planning', 'research', 'review', 'vision']);
    expect(set('default')).toEqual(['chat', 'code', 'planning', 'research', 'review']);
  });
  it('resolves the old Claude aliases to the full ids, for cost weights too', () => {
    expect(entryFor(DEFAULT_CATALOG, 'claude', 'sonnet')!.model).toBe('claude-sonnet-5-5');
    expect(entryFor(DEFAULT_CATALOG, 'claude', 'opus')!.model).toBe('claude-opus-5-5');
    expect(entryFor(DEFAULT_CATALOG, 'claude', 'haiku')!.model).toBe('claude-haiku-5-5');
    expect(costWeightOf(DEFAULT_CATALOG, 'claude', 'haiku')).toBe(1);
    expect(entryFor(DEFAULT_CATALOG, 'codex', 'sonnet')).toBeUndefined();
  });
  it('names a quota pool per model, defaulting to the CLI-wide one', () => {
    expect(poolOf(find('claude-sonnet-5-5'))).toBe('claude:all');
    expect(poolOf(find('claude-opus-5-5'))).toBe('claude:opus');
    expect(poolOf(find('claude-fable-5-1'))).toBe('claude:fable');
    expect(poolOf(find('gpt-6.1-sol'))).toBe('codex:all');
    expect(poolOf({ cli: 'gemini' })).toBe('gemini:all');
  });
  it('keeps Fable, the Codex default and the gpt-5.6 models out of automatic routing', () => {
    expect(DEFAULT_CATALOG.filter((e) => !autoRoutable(e)).map((e) => e.model))
      .toEqual(['claude-fable-5-1', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'default', 'gemini-2.5-flash-lite']);
    expect(find('gpt-5.6-terra').legacy).toBe(true);
    expect(find('claude-fable-5-1').autoRoute).toBe(false);
  });
});

describe('catalog v2: capabilities.json override', () => {
  const file = (content: unknown) => { const d = mkdtempSync(join(tmpdir(), 'harbor-cat2-')); dirs.push(d); const f = join(d, 'capabilities.json'); writeFileSync(f, JSON.stringify(content)); return f; };
  it('accepts the new fields, derives strengths from capability scores, and drops bad values with a reason', () => {
    const r = loadCatalogWithWarnings(file([
      { cli: 'claude', model: 'm1', tier: 'standard', capability: { code: 5, chat: 2 }, pool: 'claude:all', costPerKTok: 1, contextWindow: 1000, efforts: ['low'], autoRoute: false, aliases: ['one'] },
      { cli: 'claude', model: 'm2', tier: 'standard', capability: { code: 9 } },
      { cli: 'claude', model: 'm3', tier: 'standard', strengths: ['code'], autoRoute: 'yes' },
      { cli: 'claude', model: 'm4', tier: 'standard' },
      { cli: 'claude', model: 'm5', tier: 'cheap', strengths: ['chat'], legacy: true }
    ]));
    expect(r.catalog.map((e) => e.model)).toEqual(['m1', 'm5']);
    expect(r.catalog[0]).toMatchObject({ strengths: ['code'], autoRoute: false, aliases: ['one'], contextWindow: 1000 });
    expect(r.warnings.join('\n')).toMatch(/entry 2 dropped: capability code must be a number from 1 to 5/);
    expect(r.warnings.join('\n')).toMatch(/entry 3 dropped: autoRoute must be true or false/);
    expect(r.warnings.join('\n')).toMatch(/entry 4 dropped: strengths must be a list \(or give capability scores\)/);
  });
  it('a v1 file (tier and strengths only) still loads unchanged', () => {
    const v1 = [{ cli: 'claude', model: 'sonnet', tier: 'standard', strengths: ['code'], costWeight: 12 }];
    expect(loadCatalogWithWarnings(file(v1))).toEqual({ catalog: v1, warnings: [] });
  });
});

describe('Codex model discovery', () => {
  it('parses visible models with their efforts and context window; hidden ones are ignored', () => {
    const m = parseCodexModels(CACHE)!;
    expect(m.map((x) => x.slug)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-7-nova']);
    expect(m[0]).toEqual({ slug: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], contextWindow: 500000 });
  });
  it('an invalid or unrecognised file is unknown, not an empty list', () => {
    expect(parseCodexModels('not json')).toBeUndefined();
    expect(parseCodexModels('{"other":1}')).toBeUndefined();
    expect(parseCodexModels('{"models":[{"visibility":"list"}]}')).toEqual([]);
  });
  it('reads only models_cache.json under the given Codex home, and a missing file is unknown', () => {
    const read: string[] = [];
    expect(readCodexModels((p) => { read.push(p); return CACHE; }, join('H', '.codex'))!.length).toBe(5);
    expect(read).toEqual([join('H', '.codex', 'models_cache.json')]);
    expect(readCodexModels(() => { throw new Error('ENOENT'); }, 'nowhere')).toBeUndefined();
  });
  it('merges into the catalog: listed models keep their priors with live efforts, unlisted ones drop, unknown ones join with middle priors', () => {
    const merged = mergeCodexModels(DEFAULT_CATALOG, parseCodexModels(CACHE));
    const codex = merged.filter((e) => e.cli === 'codex').map((e) => e.model);
    // gpt-6-sol, gpt-5.6-terra and gpt-5.6-luna are no longer listed in this fixture; 'default' is not a model id and stays.
    expect(codex).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol', 'default', 'gpt-7-nova']);
    expect(merged.filter((e) => e.cli === 'claude')).toEqual(DEFAULT_CATALOG.filter((e) => e.cli === 'claude'));
    expect(entryFor(merged, 'codex', 'gpt-6-luna')).toMatchObject({ tier: 'cheap', costWeight: 3, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
    expect(entryFor(merged, 'codex', 'gpt-5.6-sol')!.legacy).toBe(true);
    const nova = entryFor(merged, 'codex', 'gpt-7-nova')!;
    expect(nova).toMatchObject({ tier: 'standard', costWeight: 10, autoRoute: true, pool: 'codex:all', contextWindow: 400000 });
    expect(nova.strengths).toEqual(['chat', 'code', 'research', 'planning', 'review', 'long-context']);
    expect(entryFor(merged, 'codex', 'gpt-reserve')).toBeUndefined();
  });
  // Review finding: a model the user's settings or a resumed session name must survive Codex dropping it from its list.
  it('keeps an unlisted catalog model that a setting or session names; drops the unnamed ones', () => {
    const merged = mergeCodexModels(DEFAULT_CATALOG, parseCodexModels(CACHE), ['gpt-5.6-terra']);
    const codex = merged.filter((e) => e.cli === 'codex').map((e) => e.model);
    expect(codex).toContain('gpt-5.6-terra');
    expect(codex).not.toContain('gpt-5.6-luna');
    expect(entryFor(merged, 'codex', 'gpt-5.6-terra')).toEqual(entryFor(DEFAULT_CATALOG, 'codex', 'gpt-5.6-terra'));
  });
  it('without a list (missing file) the catalog is used as it is', () => {
    expect(mergeCodexModels(DEFAULT_CATALOG, undefined)).toEqual(DEFAULT_CATALOG);
    expect(mergeCodexModels(DEFAULT_CATALOG, [])).toEqual(DEFAULT_CATALOG);
  });
  it('the service applies the discovered list to routing', async () => {
    const h = await harness({}, { ids: ['codex'], git: false, service: { codexModels: () => parseCodexModels(CACHE) } });
    await h.svc.send(h.conv.id, 'hello');
    await h.svc.whenIdle();
    const models = h.adapters.codex!.calls.map((c) => c.opts.model);
    expect(models.length).toBeGreaterThan(0);
    // gpt-6-sol is in the built-in catalog but not in this list, so it is never picked; every run gets a native effort.
    expect(models).not.toContain('gpt-6-sol');
    for (const c of h.adapters.codex!.calls) expect(['low', 'medium', 'high']).toContain(c.opts.nativeEffort);
    h.svc.shutdown();
  });
});

describe('effort mapping', () => {
  it('passes Harbor effort through when the model lists no efforts or supports it', () => {
    for (const e of ['low', 'medium', 'high'] as const) {
      expect(nativeEffort(undefined, e)).toBe(e);
      expect(nativeEffort(find('gpt-6.1-sol'), e)).toBe(e);
      expect(nativeEffort(find('claude-opus-5-5'), e)).toBe(e);
    }
  });
  it('never emits xhigh, max or ultra, and steps down to what the model supports', () => {
    const all: CatalogEntry['efforts'][] = [['ultra'], ['xhigh', 'max', 'ultra'], ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], ['medium', 'ultra'], ['minimal', 'low']];
    for (const efforts of all) for (const e of ['low', 'medium', 'high'] as const) expect(['minimal', 'low', 'medium', 'high']).toContain(nativeEffort({ efforts }, e));
    expect(nativeEffort({ efforts: ['low', 'medium'] }, 'high')).toBe('medium');
    expect(nativeEffort({ efforts: ['medium', 'high'] }, 'low')).toBe('medium');
    expect(nativeEffort({ efforts: ['minimal', 'low'] }, 'high')).toBe('low');
    expect(nativeEffort({ efforts: ['ultra'] }, 'high')).toBe('high'); // nothing emittable listed: Harbor's own value
  });
  it('the Codex adapter uses the native effort, and refuses ultra/xhigh even if one were passed', () => {
    const base: RunOptions = { cwd: '.', model: 'gpt-6.1-sol', effort: 'high', permission: 'read-only' };
    expect(codexArgs({ ...base, nativeEffort: 'medium' })).toContain('model_reasoning_effort=medium');
    for (const bad of ['ultra', 'xhigh', 'max']) {
      const a = codexArgs({ ...base, nativeEffort: bad });
      expect(a).toContain('model_reasoning_effort=high');
      expect(a.join(' ')).not.toContain(bad);
    }
    expect(codexArgs(base)).toContain('model_reasoning_effort=high');
  });
});

describe('automatic routing skips autoRoute:false and legacy entries unless named', () => {
  it('Fable is never picked automatically, and the reason says why', () => {
    const d = route({ role: 'implementer', complexity: 'high', needs: ['code'] }, input({}, [cli('claude')]))!;
    expect(pick(d)).toBe('claude/claude-opus-5-5');
    expect(d.skipped).toContainEqual({ cli: 'claude', model: 'claude-fable-5-1', why: 'not auto-routed' });
    expect(d.reason).toContain('claude/claude-fable-5-1 skipped: not auto-routed');
  });
  it('legacy Codex models and the Codex default are skipped with their reasons', () => {
    const d = route({ role: 'implementer', complexity: 'medium', needs: ['code'], requireCli: 'codex' }, input())!;
    expect(pick(d)).toBe('codex/gpt-6.1-sol');
    expect(d.reason).toContain('codex/gpt-5.6-sol skipped: legacy model');
    expect(d.reason).toContain('codex/default skipped: not auto-routed');
  });
  it('a settings preference naming the model brings it back', () => {
    const fable = route({ role: 'implementer', complexity: 'high' }, input({ policy: { preference: { cli: 'claude', model: 'claude-fable-5-1' } } }, [cli('claude')]))!;
    expect(pick(fable)).toBe('claude/claude-fable-5-1');
    const legacy = route({ role: 'implementer', complexity: 'medium' }, input({ policy: { preference: { cli: 'codex', model: 'gpt-5.6-sol' } } }, [cli('codex')]))!;
    expect(pick(legacy)).toBe('codex/gpt-5.6-sol');
  });
  it('an allowed-models list naming it brings it back; aliases in that list resolve to the full ids', () => {
    const d = route({ role: 'implementer', complexity: 'medium' }, input({ policy: { allowedModels: { codex: ['default'] } } }, [cli('codex')]))!;
    expect(pick(d)).toBe('codex/default');
    const s = route({ role: 'planner', complexity: 'high' }, input({ policy: { allowedModels: { claude: ['sonnet', 'haiku'] } } }, [cli('claude')]))!;
    expect(pick(s)).toBe('claude/claude-sonnet-5-5');
  });
  it('a resumed session on such a model keeps it, also under an old alias', () => {
    const d = route({ role: 'main', complexity: 'medium', keep: { cli: 'codex', model: 'default', effort: 'medium' } }, input({}, [cli('codex')]))!;
    expect(pick(d)).toBe('codex/default');
    expect(d.reason).toContain('keeps the session model');
    const s = route({ role: 'main', complexity: 'low', keep: { cli: 'claude', model: 'sonnet', effort: 'medium' } }, input({}, [cli('claude')]))!;
    expect(pick(s)).toBe('claude/claude-sonnet-5-5');
    expect(s.reason).toContain('keeps the session model');
  });
  it('a rate limit recorded under an old alias still cools the same model', () => {
    const ledger = new UsageLedger(new Store(), { now: () => 1 });
    ledger.record({ cli: 'claude', model: 'opus', projectId: 'p', agentId: 'a', durationMs: 1, ok: false, rateLimited: true });
    expect(ledger.pressure('claude', 'claude-opus-5-5').level).toBe('exhausted');
    expect(ledger.pressure('claude', 'claude-sonnet-5-5').level).toBe('plenty');
  });
});

describe('usage of runs that end early', () => {
  const part = (messageId: string | undefined, inputTokens: number, outputTokens: number): Extract<Chunk, { kind: 'usage' }> =>
    ({ kind: 'usage', partial: true, ...(messageId ? { messageId } : {}), inputTokens, outputTokens });
  it('sums per-message counts once per message (latest wins) and marks them partial', () => {
    const u = new RunUsage();
    u.add(part('m1', 100, 20)); u.add(part('m1', 100, 50)); u.add(part('m2', 30, 10)); u.add(part(undefined, 1, 1));
    expect(u.result(false)).toEqual({ partial: true, inputTokens: 131, outputTokens: 61 });
  });
  it('the final report wins over partial counts', () => {
    const u = new RunUsage();
    u.add(part('m1', 100, 20));
    u.add({ kind: 'usage', inputTokens: 500, outputTokens: 70, costUsd: 0.4 });
    expect(u.result(true)).toEqual({ inputTokens: 500, outputTokens: 70, costUsd: 0.4 });
  });
  it('an unfinished run with no counts is still marked partial; a finished one that reported nothing records nothing', () => {
    expect(new RunUsage().result(false)).toEqual({ partial: true });
    expect(new RunUsage().result(true)).toEqual({});
  });
  it('the Claude parser emits per-message usage as partial', () => {
    const line = JSON.stringify({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 900 } } });
    expect(parseClaudeLine(line)).toEqual([
      { kind: 'text', text: 'hi' },
      { kind: 'usage', partial: true, messageId: 'msg_1', inputTokens: 5, outputTokens: 7, cacheReadTokens: 900 }
    ]);
  });
  it('a run the user stops records its duration, model and the tokens streamed so far, marked partial', async () => {
    let leadStarted = false;
    const adapter: CliAdapter = {
      id: 'claude',
      async *run(_p, o) {
        yield { kind: 'session', id: 's1' };
        if (isConcierge(o)) { for (const c of escalate('medium')) yield c; yield { kind: 'done', ok: true }; return; }
        yield { kind: 'text', text: 'working' };
        yield part('m1', 1000, 40);
        yield part('m1', 1000, 90);
        yield part('m2', 200, 30);
        leadStarted = true;
        await new Promise<void>((r) => (o.signal?.aborted ? r() : o.signal?.addEventListener('abort', () => r(), { once: true })));
        yield { kind: 'done', ok: false, error: 'stopped' };
      }
    };
    const h = await harness({}, { git: false, service: { adapterFor: () => adapter } });
    await h.svc.send(h.conv.id, 'fix the bug in src/app.ts');
    await until(() => leadStarted);
    await h.svc.stopConversation(h.conv.id);
    await h.svc.whenIdle();
    const lead = h.svc.store.listUsage().find((u) => u.partial);
    expect(lead).toMatchObject({ cli: 'claude', ok: false, partial: true, inputTokens: 1200, outputTokens: 120 });
    expect(lead!.model).toMatch(/^claude-/);
    expect(lead!.durationMs).toBeGreaterThanOrEqual(0);
    h.svc.shutdown();
  });
});
