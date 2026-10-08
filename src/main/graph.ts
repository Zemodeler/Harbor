/**
 * Remove dependency edges that would close a cycle (depth-first, keeping earlier edges).
 * Mutates the map and returns the removed edges as [from, to] pairs, where `from` depended on `to`.
 */
export function breakCycles(deps: Map<string, Set<string>>): [string, string][] {
  const removed: [string, string][] = [];
  const state = new Map<string, 0 | 1 | 2>(); // 1 = on stack, 2 = done
  const visit = (n: string): void => {
    state.set(n, 1);
    for (const d of [...(deps.get(n) ?? [])]) {
      if (!deps.has(d)) continue; // dependency on an existing agent: cannot form a cycle with new tasks
      if (state.get(d) === 1) { deps.get(n)!.delete(d); removed.push([n, d]); continue; }
      if (!state.has(d)) visit(d);
    }
    state.set(n, 2);
  };
  for (const n of deps.keys()) if (!state.has(n)) visit(n);
  return removed;
}
