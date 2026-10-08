import { describe, expect, it } from 'vitest';
import { streamLines } from '../src/main/adapters/stream';

async function collect(gen: ReturnType<typeof streamLines>) {
  const lines: string[] = [];
  let r = await gen.next();
  while (!r.done) { lines.push(r.value.line); r = await gen.next(); }
  return { lines, result: r.value };
}

describe('streamLines', () => {
  it('echoes stdin back line by line and reports exit code', async () => {
    const script = "process.stdin.on('data',d=>process.stdout.write(d)); process.stdin.on('end',()=>process.exit(3))";
    const { lines, result } = await collect(streamLines(process.execPath, ['-e', script], { cwd: process.cwd(), input: 'a\nb\n' }));
    expect(lines).toEqual(['a', 'b']);
    expect(result.code).toBe(3);
  });
  it('abort kills the process', async () => {
    const ac = new AbortController();
    const gen = streamLines(process.execPath, ['-e', "console.log('start'); setInterval(()=>{},1000)"], { cwd: process.cwd(), input: '', signal: ac.signal });
    const first = await gen.next();
    expect((first.value as any).line).toBe('start');
    ac.abort();
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    expect(r.value.aborted).toBe(true);
  });
  it('reports spawn failure without throwing', async () => {
    const { result } = await collect(streamLines('definitely-not-a-binary-xyz', [], { cwd: process.cwd(), input: '' }));
    expect(result.spawnError ?? result.code).toBeTruthy();
  });
});
