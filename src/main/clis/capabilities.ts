import { existsSync, readFileSync } from 'node:fs';
import type { CliId } from '../../shared/api';

/**
 * Capability catalog, v2. Every claim Harbor makes about a model (which work it suits, what it costs, which quota it draws
 * from) lives in this data and nowhere in routing code. Users override the whole list with `capabilities.json`.
 *
 * NOT VERIFIED: the full Claude model ids `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5` were not checked
 * against the real CLI when they were pinned here (`claude --model <id>`); check them with `npm run smoke -- claude`.
 * The old aliases (haiku/sonnet/opus) stay resolvable through `aliases`, so stored sessions, settings and usage keep working.
 * Codex ids come from the model list codex-cli 0.162 caches in ~/.codex/models_cache.json (see codexModels.ts), which also
 * corrects efforts and context windows at runtime.
 */

/** What a piece of work needs. The lead states needs; Harbor resolves them to a CLI and model. */
export type Need = 'chat' | 'code' | 'research' | 'planning' | 'review' | 'long-context' | 'vision';
export type Tier = 'cheap' | 'standard' | 'strong';

export const NEEDS: readonly Need[] = ['chat', 'code', 'research', 'planning', 'review', 'long-context', 'vision'];
export const TIERS: readonly Tier[] = ['cheap', 'standard', 'strong'];

/** Per-need score, 1 (poor fit) to 5 (best fit). Priors to be calibrated from measured runs, not benchmarks. */
export type CapabilityScores = Partial<Record<Need, number>>;

/** A capability score at or above this counts as a strength (what the current router reads). */
export const STRENGTH_MIN_SCORE = 3;

/**
 * Quota pools. A model draws from its CLI's account-wide pool (`<cli>:all`) and, when the provider caps it separately, from
 * its own pool too; `pool` names the most specific one. Phase 2 (the budget governor) keys remaining quota by these ids.
 */
export const POOLS = { claudeAll: 'claude:all', claudeOpus: 'claude:opus', claudeFable: 'claude:fable', codexAll: 'codex:all', geminiAll: 'gemini:all' } as const;

export interface CatalogEntry {
  cli: CliId;
  /** Model id passed to the CLI; 'default' lets the CLI choose. */
  model: string;
  tier: Tier;
  /** Needs this model is a good fit for. Derived from `capability` (score >= STRENGTH_MIN_SCORE) when that is given. */
  strengths: Need[];
  /** Optional extra cost in score points (default 0): makes a pricier model lose close calls. */
  cost?: number;
  /**
   * Relative quota weight of one typical run of this model, used to estimate allowance when a run reports no cost (haiku 1, sonnet 12,
   * opus 25, codex 10). Derived from the median $/run observed in real use (0.09 / 1.24 / 2.00); a data estimate, editable in
   * capabilities.json. Unrelated to `cost`, which only breaks routing ties.
   */
  costWeight?: number;
  note?: string;
  /** Other names that resolve to this entry (old short aliases kept in stored sessions, settings and usage). */
  aliases?: string[];
  /** Most specific quota pool this model draws from (see POOLS); default `<cli>:all`. */
  pool?: string;
  /** Per-need scores 1-5 (priors). */
  capability?: CapabilityScores;
  /** Prior: relative quota weight per 1k tokens (claude-sonnet-5-5 = 1). Calibrated later from measured runs. */
  costPerKTok?: number;
  /** Context window in tokens, when known. */
  contextWindow?: number;
  /** CLI-native effort values the model accepts (as the CLI names them). Absent = the CLI's usual low/medium/high. */
  efforts?: string[];
  /** false = used only when the user, settings or a resumed session names it. Default true. */
  autoRoute?: boolean;
  /** true = an older model kept resolvable for stored sessions and settings, never picked automatically. */
  legacy?: boolean;
}

/** Weight of a run of a model the catalog does not know (or knows without `costWeight`): the middle of the known models. */
export const FALLBACK_COST_WEIGHT = 10;
/** Dollars one weight point stands for when a run reports its real cost (a haiku run's median $0.09 is 1 point; sonnet and opus land near their table weights). */
export const USD_PER_WEIGHT = 0.1;

/** Whether `name` is this entry's model id or one of its aliases. */
export const modelMatches = (e: CatalogEntry, name: string): boolean => e.model === name || !!e.aliases?.includes(name);

/** The entry for `cli`/`model` (id or alias), if the catalog knows it. */
export function entryFor(catalog: readonly CatalogEntry[], cli: CliId, model: string): CatalogEntry | undefined {
  return catalog.find((e) => e.cli === cli && e.model === model) ?? catalog.find((e) => e.cli === cli && modelMatches(e, model));
}

/** Quota pool of an entry: its own `pool`, else the CLI's account-wide pool. */
export const poolOf = (e: Pick<CatalogEntry, 'cli' | 'pool'>): string => e.pool ?? `${e.cli}:all`;

/** Whether automatic routing may pick this entry without it being named. */
export const autoRoutable = (e: CatalogEntry): boolean => e.autoRoute !== false && e.legacy !== true;

/** Quota weight of one run of `cli`/`model`: the catalog's `costWeight`, else the same CLI's default entry, else FALLBACK_COST_WEIGHT. */
export function costWeightOf(catalog: readonly CatalogEntry[], cli: CliId, model: string): number {
  const hit = entryFor(catalog, cli, model) ?? catalog.find((e) => e.cli === cli && e.model === 'default');
  return hit?.costWeight ?? FALLBACK_COST_WEIGHT;
}

/** Needs scored at or above STRENGTH_MIN_SCORE, in NEEDS order. */
export function strengthsFrom(c: CapabilityScores): Need[] {
  return NEEDS.filter((n) => (c[n] ?? 0) >= STRENGTH_MIN_SCORE);
}

/** A catalog entry whose `strengths` follow its capability scores, so the two can never disagree. */
function model(e: Omit<CatalogEntry, 'strengths'> & { capability: CapabilityScores }): CatalogEntry {
  return { ...e, strengths: strengthsFrom(e.capability) };
}

const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/**
 * The built-in catalog. Capability scores, tiers and cost priors are JUDGMENTS (priors), to be calibrated from measured runs;
 * costWeight values for haiku/sonnet/opus are the measured ones above. Changing a strength here changes routing: the strengths of
 * the Claude and Codex-default entries are the same as in catalog v1.
 */
export const DEFAULT_CATALOG: CatalogEntry[] = [
  model({
    cli: 'claude', model: 'claude-haiku-5-5', aliases: ['haiku'], tier: 'cheap', costWeight: 1, costPerKTok: 0.1, pool: POOLS.claudeAll,
    capability: { chat: 4, code: 3, research: 3, planning: 2, review: 2, 'long-context': 2, vision: 2 },
    note: 'fast and cheap: chat, lookups, small mechanical edits'
  }),
  model({
    cli: 'claude', model: 'claude-sonnet-5-5', aliases: ['sonnet'], tier: 'standard', costWeight: 12, costPerKTok: 1, pool: POOLS.claudeAll,
    capability: { chat: 4, code: 4, research: 4, planning: 4, review: 4, 'long-context': 4, vision: 3 },
    note: 'balanced everyday model'
  }),
  model({
    // chat 2: overkill for chat rather than poor at it; keeps it out of chat work as in catalog v1.
    cli: 'claude', model: 'claude-opus-5-5', aliases: ['opus'], tier: 'strong', costWeight: 25, costPerKTok: 2, pool: POOLS.claudeOpus,
    capability: { chat: 2, code: 5, research: 5, planning: 5, review: 5, 'long-context': 4, vision: 4 },
    note: 'strongest reasoning for hard problems'
  }),
  model({
    cli: 'claude', model: 'claude-fable-5-1', tier: 'strong', costWeight: 25, costPerKTok: 2, pool: POOLS.claudeFable, autoRoute: false,
    capability: { chat: 2, code: 5, research: 5, planning: 5, review: 5, 'long-context': 4, vision: 4 },
    note: 'Fable 5.1 (full id; the alias is unverified). Has its own usage limit, tracked separately. Used only when named'
  }),
  model({
    cli: 'codex', model: 'gpt-6.1-sol', tier: 'standard', costWeight: 10, costPerKTok: 0.8, pool: POOLS.codexAll, contextWindow: 500_000, efforts: CODEX_EFFORTS,
    capability: { chat: 4, code: 5, research: 4, planning: 4, review: 4, 'long-context': 5, vision: 2 },
    note: 'Codex workhorse; between standard and strong (tier standard, near-strong scores)'
  }),
  model({
    cli: 'codex', model: 'gpt-6-astra', tier: 'strong', costWeight: 25, costPerKTok: 2, pool: POOLS.codexAll, contextWindow: 272_000, efforts: CODEX_EFFORTS,
    capability: { chat: 3, code: 5, research: 5, planning: 5, review: 5, 'long-context': 4, vision: 2 },
    note: 'Codex frontier model for the most demanding work'
  }),
  model({
    cli: 'codex', model: 'gpt-6-sol', tier: 'standard', costWeight: 8, costPerKTok: 0.7, pool: POOLS.codexAll, contextWindow: 272_000, efforts: CODEX_EFFORTS,
    capability: { chat: 4, code: 4, research: 4, planning: 4, review: 4, 'long-context': 3, vision: 2 },
    note: 'previous Codex workhorse'
  }),
  model({
    cli: 'codex', model: 'gpt-6-luna', tier: 'cheap', costWeight: 3, costPerKTok: 0.25, pool: POOLS.codexAll, contextWindow: 272_000, efforts: CODEX_EFFORTS.filter((e) => e !== 'ultra'),
    capability: { chat: 4, code: 3, research: 3, planning: 2, review: 2, 'long-context': 2, vision: 2 },
    note: 'fast and affordable Codex model for easier tasks'
  }),
  model({
    cli: 'codex', model: 'gpt-5.6-sol', tier: 'standard', costWeight: 8, costPerKTok: 0.7, pool: POOLS.codexAll, contextWindow: 272_000, legacy: true,
    capability: { chat: 4, code: 4, research: 4, planning: 4, review: 4, 'long-context': 3, vision: 2 }, note: 'older Codex workhorse (legacy)'
  }),
  model({
    cli: 'codex', model: 'gpt-5.6-terra', tier: 'standard', costWeight: 6, costPerKTok: 0.5, pool: POOLS.codexAll, contextWindow: 272_000, legacy: true,
    capability: { chat: 4, code: 3, research: 3, planning: 3, review: 3, 'long-context': 3, vision: 2 }, note: 'older balanced Codex model (legacy)'
  }),
  model({
    cli: 'codex', model: 'gpt-5.6-luna', tier: 'cheap', costWeight: 3, costPerKTok: 0.25, pool: POOLS.codexAll, contextWindow: 272_000, legacy: true,
    capability: { chat: 4, code: 3, research: 3, planning: 2, review: 2, 'long-context': 2, vision: 2 }, note: 'older fast Codex model (legacy)'
  }),
  model({
    // Kept for stored sessions and settings that name it; the explicit models above are what automatic routing picks.
    cli: 'codex', model: 'default', tier: 'standard', costWeight: 10, costPerKTok: 0.8, pool: POOLS.codexAll, autoRoute: false,
    capability: { chat: 3, code: 4, research: 3, planning: 3, review: 3, 'long-context': 2, vision: 2 }, note: "Codex's configured default model"
  }),
  // Gemini: NOT VERIFIED. The model ids below come from the public Gemini CLI docs as remembered; none was checked with `gemini --help`
  // or a run (the CLI was not installed when these were added). Scores, tiers and weights are priors, to be calibrated from measured runs.
  model({
    cli: 'gemini', model: 'gemini-2.5-pro', tier: 'strong', costWeight: 15, costPerKTok: 1, pool: POOLS.geminiAll, contextWindow: 1_000_000,
    capability: { chat: 3, code: 4, research: 4, planning: 4, review: 4, 'long-context': 5, vision: 4 },
    note: 'UNVERIFIED model id. Gemini strongest tier; very long context'
  }),
  model({
    cli: 'gemini', model: 'gemini-2.5-flash', tier: 'standard', costWeight: 4, costPerKTok: 0.3, pool: POOLS.geminiAll, contextWindow: 1_000_000,
    capability: { chat: 4, code: 3, research: 3, planning: 3, review: 3, 'long-context': 4, vision: 3 },
    note: 'UNVERIFIED model id. Fast, inexpensive all-rounder'
  }),
  model({
    cli: 'gemini', model: 'gemini-2.5-flash-lite', tier: 'cheap', costWeight: 1.5, costPerKTok: 0.1, pool: POOLS.geminiAll, contextWindow: 1_000_000, autoRoute: false,
    capability: { chat: 3, code: 2, research: 2, planning: 2, review: 2, 'long-context': 3, vision: 2 },
    note: 'UNVERIFIED model id. Cheapest tier; used only when named'
  })
];

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');
const finitePositive = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Why an entry is unusable, or undefined when it is fine. */
function invalidReason(e: unknown): string | undefined {
  const r = e as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return 'not an object';
  if (typeof r['cli'] !== 'string' || !r['cli'].trim()) return 'cli must be a non-empty string';
  if (typeof r['model'] !== 'string' || !r['model'].trim()) return 'model must be a non-empty string';
  if (!TIERS.includes(r['tier'] as Tier)) return `tier must be one of ${TIERS.join(', ')}`;
  const cap = r['capability'];
  if (cap !== undefined) {
    if (!cap || typeof cap !== 'object' || Array.isArray(cap)) return 'capability must be an object of need: score';
    for (const [k, v] of Object.entries(cap)) {
      if (!NEEDS.includes(k as Need)) return `unknown capability ${JSON.stringify(k)}`;
      if (!(typeof v === 'number' && v >= 1 && v <= 5)) return `capability ${k} must be a number from 1 to 5`;
    }
  }
  if (r['strengths'] === undefined && cap === undefined) return 'strengths must be a list (or give capability scores)';
  if (r['strengths'] !== undefined) {
    if (!Array.isArray(r['strengths'])) return 'strengths must be a list';
    const bad = (r['strengths'] as unknown[]).find((s) => !NEEDS.includes(s as Need));
    if (bad !== undefined) return `unknown strength ${JSON.stringify(bad)}`;
  }
  if (r['cost'] !== undefined && !(typeof r['cost'] === 'number' && Number.isFinite(r['cost']))) return 'cost must be a finite number';
  if (r['costWeight'] !== undefined && !finitePositive(r['costWeight'])) return 'costWeight must be a positive number';
  if (r['costPerKTok'] !== undefined && !finitePositive(r['costPerKTok'])) return 'costPerKTok must be a positive number';
  if (r['contextWindow'] !== undefined && !finitePositive(r['contextWindow'])) return 'contextWindow must be a positive number';
  if (r['pool'] !== undefined && (typeof r['pool'] !== 'string' || !r['pool'].trim())) return 'pool must be a non-empty string';
  for (const k of ['aliases', 'efforts']) if (r[k] !== undefined && !isStringList(r[k])) return `${k} must be a list of strings`;
  for (const k of ['autoRoute', 'legacy']) if (r[k] !== undefined && typeof r[k] !== 'boolean') return `${k} must be true or false`;
  return undefined;
}

/** An override entry as used: strengths derived from capability scores when the file gives only those. */
function normalize(e: CatalogEntry): CatalogEntry {
  return e.strengths === undefined && e.capability ? { ...e, strengths: strengthsFrom(e.capability) } : e;
}

export interface LoadedCatalog { catalog: CatalogEntry[]; warnings: string[] }

/**
 * Reads an optional override file and says what it dropped: invalid entries and later duplicates of the same
 * cli/model are removed (the first wins). A missing file is normal and silent; a malformed or empty one falls back
 * to the defaults with a warning.
 */
export function loadCatalogWithWarnings(path?: string): LoadedCatalog {
  if (!path || !existsSync(path)) return { catalog: DEFAULT_CATALOG, warnings: [] };
  let j: unknown;
  try { j = JSON.parse(readFileSync(path, 'utf8')); } catch (e) {
    return { catalog: DEFAULT_CATALOG, warnings: [`capabilities.json is not valid JSON (${e instanceof Error ? e.message : String(e)}); using the built-in catalog`] };
  }
  return parseCatalog(j);
}

/** Validates capabilities.json content already parsed from JSON (the file, or a what-if catalog from replayRouting). Same rules as the file. */
export function parseCatalog(j: unknown): LoadedCatalog {
  if (!Array.isArray(j)) return { catalog: DEFAULT_CATALOG, warnings: ['capabilities.json must be a list of entries; using the built-in catalog'] };
  const warnings: string[] = [];
  const seen = new Set<string>();
  const list: CatalogEntry[] = [];
  j.forEach((e, i) => {
    const why = invalidReason(e);
    if (why) { warnings.push(`capabilities.json entry ${i + 1} dropped: ${why}`); return; }
    const entry = normalize(e as CatalogEntry), key = `${entry.cli}/${entry.model}`;
    if (seen.has(key)) { warnings.push(`capabilities.json entry ${i + 1} dropped: duplicate ${key} (the first one is used)`); return; }
    seen.add(key);
    list.push(entry);
  });
  if (!list.length) return { catalog: DEFAULT_CATALOG, warnings: [...warnings, 'capabilities.json has no usable entry; using the built-in catalog'] };
  return { catalog: list, warnings };
}

/** Reads an optional override file. A missing or malformed file falls back to the defaults. */
export function loadCatalog(path?: string): CatalogEntry[] {
  return loadCatalogWithWarnings(path).catalog;
}
