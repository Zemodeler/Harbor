import type { Chunk, CliAdapter, RunOptions } from './types';

export interface FakeCall { prompt: string; opts: RunOptions }
export type FakeScript = (prompt: string, opts: RunOptions, callIndex: number) => Chunk[] | Promise<Chunk[]>;

const NONCE_IN_PROMPT = /HARBOR_DELEGATE\[([A-Za-z0-9_-]{1,64})\]/;
const BARE_PROTOCOL = /^(\s*HARBOR_(?:REQUEST_HELP|ASK|DELEGATE|IMAGE_BRIEF|RESULT|GOAL_DONE|PEER|DECISION|REPLY)):/gm;

/**
 * Deterministic adapter for tests. `script` returns the chunks for each call;
 * a missing 'done' chunk is added as success. Honors abort.
 *
 * Like a model that follows the per-turn protocol tag in its prompt, it writes `HARBOR_X[tag]:` for every bare `HARBOR_X:` line a
 * script prints (the tag is read from the prompt). `bareProtocol: true` turns that off, to play a model that ignores the tag.
 */
export class FakeAdapter implements CliAdapter {
  calls: FakeCall[] = [];
  constructor(public id: string, private script: FakeScript = (p) => [{ kind: 'text', text: `echo: ${p.slice(0, 40)}` }], private opts: { bareProtocol?: boolean } = {}) {}

  private tag(prompt: string, c: Chunk): Chunk {
    const nonce = NONCE_IN_PROMPT.exec(prompt)?.[1];
    if (!nonce || this.opts.bareProtocol) return c;
    const fix = (t: string) => t.replace(BARE_PROTOCOL, `$1[${nonce}]:`);
    if (c.kind === 'text') return { ...c, text: fix(c.text) };
    if (c.kind === 'done' && c.text) return { ...c, text: fix(c.text) };
    return c;
  }

  async *run(prompt: string, opts: RunOptions): AsyncGenerator<Chunk> {
    const idx = this.calls.push({ prompt, opts }) - 1;
    const chunks = (await this.script(prompt, opts, idx)).map((c) => this.tag(prompt, c));
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
