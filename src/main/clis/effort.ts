import type { Effort } from '../adapters/types';
import type { CatalogEntry } from './capabilities';

/**
 * CLI-native effort values Harbor may emit. Deliberately excludes Codex's `xhigh` and `max` (a later phase may allow them through an
 * explicit, budgeted choice; `codex exec` support for them is unverified) and `ultra` forever: ultra means "maximum reasoning with
 * automatic task delegation", and helpers never spawn agents (the lead decides delegation).
 */
const EMITTABLE = ['minimal', 'low', 'medium', 'high'] as const;
export type NativeEffort = (typeof EMITTABLE)[number];

export const isEmittableEffort = (v: string | undefined): v is NativeEffort => !!v && (EMITTABLE as readonly string[]).includes(v);

/**
 * The CLI-native effort for one run of `entry` at Harbor effort `effort`. Pure. Without an `efforts` list the CLI's usual
 * low/medium/high is assumed and the value passes through. With one, the highest supported value not above the requested level
 * wins (a model without `high` runs at its best lower level), else the lowest supported one; never xhigh/max/ultra.
 */
export function nativeEffort(entry: Pick<CatalogEntry, 'efforts'> | undefined, effort: Effort): NativeEffort {
  const supported = entry?.efforts?.filter(isEmittableEffort);
  if (!supported?.length) return effort;
  if (supported.includes(effort)) return effort;
  const rank = (e: NativeEffort) => EMITTABLE.indexOf(e);
  const below = supported.filter((e) => rank(e) <= rank(effort)).sort((a, b) => rank(b) - rank(a));
  return below[0] ?? supported.sort((a, b) => rank(a) - rank(b))[0]!;
}
