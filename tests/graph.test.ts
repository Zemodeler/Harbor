import { describe, expect, it } from 'vitest';
import { breakCycles } from '../src/main/graph';

const g = (o: Record<string, string[]>) => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));

describe('breakCycles', () => {
  it('leaves acyclic graphs alone', () => {
    const m = g({ a: [], b: ['a'], c: ['a', 'b'] });
    expect(breakCycles(m)).toEqual([]);
    expect([...m.get('c')!]).toEqual(['a', 'b']);
  });
  it('breaks a two-node cycle and a self-contained loop', () => {
    const m = g({ a: ['b'], b: ['a'] });
    expect(breakCycles(m)).toHaveLength(1);
    const m2 = g({ a: ['b'], b: ['c'], c: ['a'], d: ['a'] });
    expect(breakCycles(m2)).toHaveLength(1);
    // no cycle remains: every node can be ordered
    const order: string[] = [];
    const seen = new Set<string>();
    const visit = (n: string) => { if (seen.has(n)) return; seen.add(n); for (const d of m2.get(n) ?? []) visit(d); order.push(n); };
    for (const k of m2.keys()) visit(k);
    expect(order).toHaveLength(4);
  });
  it('ignores dependencies on agents outside the new plan', () => {
    const m = g({ a: ['existing'] });
    expect(breakCycles(m)).toEqual([]);
  });
});
