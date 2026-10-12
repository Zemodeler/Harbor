import { existsSync, readFileSync } from 'node:fs';
import type { CliId } from '../../shared/api';

/** What a piece of work needs. The lead states needs; Harbor resolves them to a CLI and model. */
export type Need = 'chat' | 'code' | 'research' | 'planning' | 'review' | 'long-context' | 'vision';
export type Tier = 'cheap' | 'standard' | 'strong';

export const NEEDS: readonly Need[] = ['chat', 'code', 'research', 'planning', 'review', 'long-context', 'vision'];
export const TIERS: readonly Tier[] = ['cheap', 'standard', 'strong'];

export interface CatalogEntry {
  cli: CliId;
  /** Model alias passed to the CLI; 'default' lets the CLI choose. */
  model: string;
  tier: Tier;
  /** Needs this model is a good fit for. These are editable defaults, not benchmarks: change them in capabilities.json. */
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
}

/** Weight of a run of a model the catalog does not know (or knows without `costWeight`): the middle of the known models. */
export const FALLBACK_COST_WEIGHT = 10;
/** Dollars one weight point stands for when a run reports its real cost (a haiku run's median $0.09 is 1 point; sonnet and opus land near their table weights). */
export const USD_PER_WEIGHT = 0.1;

/** Quota weight of one run of `cli`/`model`: the catalog's `costWeight`, else the same CLI's default entry, else FALLBACK_COST_WEIGHT. */
export function costWeightOf(catalog: readonly CatalogEntry[], cli: CliId, model: string): number {
  const hit = catalog.find((e) => e.cli === cli && e.model === model) ?? catalog.find((e) => e.cli === cli && e.model === 'default');
  return hit?.costWeight ?? FALLBACK_COST_WEIGHT;
}

/**
 * Capability knowledge lives here, as data, and nowhere in routing code. Users can override the whole list with
 * `capabilities.json` in Harbor's data folder. Only Claude exposes model aliases we rely on; Codex entries use its
 * default model because model ids there are not verified (see adapters/codex.ts).
 */
export const DEFAULT_CATALOG: CatalogEntry[] = [
  { cli: 'claude', model: 'haiku', costWeight: 1, tier: 'cheap', strengths: ['chat', 'research', 'code'], note: 'fast and cheap: chat, lookups, small mechanical edits' },
  { cli: 'claude', model: 'sonnet', costWeight: 12, tier: 'standard', strengths: ['code', 'research', 'review', 'planning', 'long-context', 'vision', 'chat'], note: 'balanced everyday model' },
  { cli: 'claude', model: 'opus', costWeight: 25, tier: 'strong', strengths: ['planning', 'code', 'review', 'research', 'long-context', 'vision'], note: 'strongest reasoning for hard problems' },
  { cli: 'claude', model: 'claude-fable-5-1', costWeight: 25, tier: 'strong', strengths: ['planning', 'code', 'review', 'research', 'long-context', 'vision'], note: 'Fable 5.1 (full id; the alias is unverified). Has its own usage limit, tracked separately' },
  { cli: 'codex', model: 'default', costWeight: 10, tier: 'standard', strengths: ['code', 'review', 'research', 'planning', 'chat'], note: "Codex's default model" }
];

/** Why an entry is unusable, or undefined when it is fine. */
function invalidReason(e: unknown): string | undefined {
  const r = e as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return 'not an object';
  if (typeof r['cli'] !== 'string' || !r['cli'].trim()) return 'cli must be a non-empty string';
  if (typeof r['model'] !== 'string' || !r['model'].trim()) return 'model must be a non-empty string';
  if (!TIERS.includes(r['tier'] as Tier)) return `tier must be one of ${TIERS.join(', ')}`;
  if (!Array.isArray(r['strengths'])) return 'strengths must be a list';
  const bad = (r['strengths'] as unknown[]).find((s) => !NEEDS.includes(s as Need));
  if (bad !== undefined) return `unknown strength ${JSON.stringify(bad)}`;
  if (r['cost'] !== undefined && !(typeof r['cost'] === 'number' && Number.isFinite(r['cost']))) return 'cost must be a finite number';
  if (r['costWeight'] !== undefined && !(typeof r['costWeight'] === 'number' && Number.isFinite(r['costWeight']) && r['costWeight'] > 0)) return 'costWeight must be a positive number';
  return undefined;
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
  if (!Array.isArray(j)) return { catalog: DEFAULT_CATALOG, warnings: ['capabilities.json must be a list of entries; using the built-in catalog'] };
  const warnings: string[] = [];
  const seen = new Set<string>();
  const list: CatalogEntry[] = [];
  j.forEach((e, i) => {
    const why = invalidReason(e);
    if (why) { warnings.push(`capabilities.json entry ${i + 1} dropped: ${why}`); return; }
    const entry = e as CatalogEntry, key = `${entry.cli}/${entry.model}`;
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
