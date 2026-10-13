import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FALLBACK_COST_WEIGHT, POOLS, strengthsFrom, type CapabilityScores, type CatalogEntry } from './capabilities';

/**
 * Runtime Codex model discovery. codex-cli (verified shape: 0.162) caches the account's model list in ~/.codex/models_cache.json:
 * `{ models: [{ slug, visibility: 'list' | 'hide', supported_reasoning_levels: [{ effort }], context_window, ... }] }`.
 * Harbor only READS that one file (never auth.json or anything else in ~/.codex); a missing or malformed file means "unknown",
 * and the catalog's priors are used unchanged.
 */
export interface CodexModel { slug: string; efforts: string[]; contextWindow?: number }

/** Visible models in the order Codex lists them; hidden ones (internal, retired) are left out. Pure; undefined when the shape is not recognised. */
export function parseCodexModels(json: string): CodexModel[] | undefined {
  let j: any;
  try { j = JSON.parse(json); } catch { return undefined; }
  const list = Array.isArray(j?.models) ? j.models : undefined;
  if (!list) return undefined;
  const out: CodexModel[] = [];
  for (const m of list) {
    if (!m || typeof m.slug !== 'string' || !m.slug.trim() || m.visibility !== 'list') continue;
    const efforts = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels.map((l: any) => (typeof l === 'string' ? l : l?.effort)).filter((e: unknown): e is string => typeof e === 'string' && !!e)
      : [];
    const cw = m.context_window;
    out.push({ slug: m.slug, efforts, ...(typeof cw === 'number' && cw > 0 ? { contextWindow: cw } : {}) });
  }
  return out;
}

export const defaultCodexHome = (): string => join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', '.codex');

/** Reads the cache through `read` (injected for tests). Any read or parse failure is "unknown" (undefined), never an error. */
export function readCodexModels(read: (path: string) => string = (p) => readFileSync(p, 'utf8'), codexHome = defaultCodexHome()): CodexModel[] | undefined {
  try { return parseCodexModels(read(join(codexHome, 'models_cache.json'))); } catch { return undefined; }
}

/** Middle prior for a model Codex lists that the catalog does not know yet: standard tier, mid capability, mid cost. */
const UNKNOWN_CAPABILITY: CapabilityScores = { chat: 3, code: 3, research: 3, planning: 3, review: 3, 'long-context': 3, vision: 2 };

/**
 * The catalog with Codex's live model list applied. Pure. Without a list (or with an empty one) the catalog is returned as is.
 * With one: listed models keep their priors but take Codex's efforts and context window (facts beat priors); catalog models
 * Codex no longer lists are dropped (except 'default', which is not a model id, and any model `named` by a setting or a resumed
 * session: dropping it would silently ignore the user's choice or lose the session's model); listed models the catalog does not know are
 * added with middle priors and auto-routing on, after the known Codex entries.
 */
export function mergeCodexModels(catalog: readonly CatalogEntry[], models: readonly CodexModel[] | undefined, named: readonly string[] = []): CatalogEntry[] {
  if (!models?.length) return [...catalog];
  const bySlug = new Map(models.map((m) => [m.slug, m]));
  const isNamed = (model: string) => named.some((n) => n.trim().toLowerCase() === model.toLowerCase());
  const out: CatalogEntry[] = [];
  let lastCodex = -1;
  for (const e of catalog) {
    if (e.cli !== 'codex') { out.push(e); continue; }
    if (e.model === 'default') { out.push(e); lastCodex = out.length - 1; continue; }
    const m = bySlug.get(e.model);
    if (!m) {
      if (isNamed(e.model)) { out.push(e); lastCodex = out.length - 1; }
      continue;
    }
    out.push({ ...e, ...(m.efforts.length ? { efforts: m.efforts } : {}), ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) });
    lastCodex = out.length - 1;
  }
  const known = new Set(catalog.filter((e) => e.cli === 'codex').map((e) => e.model));
  const added: CatalogEntry[] = models.filter((m) => !known.has(m.slug)).map((m) => ({
    cli: 'codex', model: m.slug, tier: 'standard', capability: UNKNOWN_CAPABILITY, strengths: strengthsFrom(UNKNOWN_CAPABILITY),
    costWeight: FALLBACK_COST_WEIGHT, costPerKTok: 1, pool: POOLS.codexAll, autoRoute: true,
    ...(m.efforts.length ? { efforts: m.efforts } : {}), ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    note: 'listed by Codex but unknown to the catalog: middle priors until calibrated'
  }));
  out.splice(lastCodex + 1 > 0 ? lastCodex + 1 : out.length, 0, ...added);
  return out;
}
