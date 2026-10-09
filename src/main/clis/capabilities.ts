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
  note?: string;
}

/**
 * Capability knowledge lives here, as data, and nowhere in routing code. Users can override the whole list with
 * `capabilities.json` in Harbor's data folder. Only Claude exposes model aliases we rely on; Codex entries use its
 * default model because model ids there are not verified (see adapters/codex.ts).
 */
export const DEFAULT_CATALOG: CatalogEntry[] = [
  { cli: 'claude', model: 'haiku', tier: 'cheap', strengths: ['chat', 'research', 'code'], note: 'fast and cheap: chat, lookups, small mechanical edits' },
  { cli: 'claude', model: 'sonnet', tier: 'standard', strengths: ['code', 'research', 'review', 'planning', 'long-context', 'vision', 'chat'], note: 'balanced everyday model' },
  { cli: 'claude', model: 'opus', tier: 'strong', strengths: ['planning', 'code', 'review', 'research', 'long-context', 'vision'], note: 'strongest reasoning for hard problems' },
  { cli: 'claude', model: 'claude-fable-5-1', tier: 'strong', strengths: ['planning', 'code', 'review', 'research', 'long-context', 'vision'], note: 'Fable 5.1 (full id; the alias is unverified). Has its own usage limit, tracked separately' },
  { cli: 'codex', model: 'default', tier: 'standard', strengths: ['code', 'review', 'research', 'planning', 'chat'], note: "Codex's default model" }
];

const isEntry = (e: unknown): e is CatalogEntry => {
  const r = e as Record<string, unknown> | null;
  return !!r && typeof r['cli'] === 'string' && typeof r['model'] === 'string' && TIERS.includes(r['tier'] as Tier)
    && Array.isArray(r['strengths']) && (r['strengths'] as unknown[]).every((s) => NEEDS.includes(s as Need))
    && (r['cost'] === undefined || (typeof r['cost'] === 'number' && Number.isFinite(r['cost'])));
};

/** Reads an optional override file. A missing or malformed file falls back to the defaults. */
export function loadCatalog(path?: string): CatalogEntry[] {
  if (!path || !existsSync(path)) return DEFAULT_CATALOG;
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const list = Array.isArray(j) ? j.filter(isEntry) : [];
    return list.length ? list : DEFAULT_CATALOG;
  } catch { return DEFAULT_CATALOG; }
}
