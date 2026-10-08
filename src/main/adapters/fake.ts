import type { Chunk, CliAdapter, RunOptions } from './types';

export interface FakeCall { prompt: string; opts: RunOptions }
export type FakeScript = (prompt: string, opts: RunOptions, callIndex: number) => Chunk[] | Promise<Chunk[]>;

/**
 * Deterministic adapter for tests. `script` returns the chunks for each call;
 * a missing 'done' chunk is added as success. Honors abort.
 */
export class FakeAdapter implements CliAdapter {
  calls: FakeCall[] = [];
  constructor(public id: string, private script: FakeScript = (p) => [{ kind: 'text', text: `echo: ${p.slice(0, 40)}` }]) {}

  async *run(prompt: string, opts: RunOptions): AsyncGenerator<Chunk> {
    const idx = this.calls.push({ prompt, opts }) - 1;
    const chunks = await this.script(prompt, opts, idx);
    yield { kind: 'session', id: opts.resumeId ?? `${this.id}-session-${idx}` };
    let done = false;
    for (const c of chunks) {
      if (opts.signal?.aborted) { yield { kind: 'done', ok: false, error: 'stopped' }; return; }
      if (c.kind === 'done') done = true;
      yield c;
      await Promise.resolve();
    }
    if (!done) yield { kind: 'done', ok: true, text: chunks.filter((c) => c.kind === 'text').map((c) => (c as any).text).join('\n') };
  }
}
