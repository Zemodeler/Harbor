import { describe, expect, it } from 'vitest';
import { GeminiAdapter, geminiArgs, geminiTerminalArgs, parseGeminiLine } from '../src/main/adapters/gemini';
import { TERMINAL_LIMITATIONS, TerminalAdapter } from '../src/main/adapters/terminal';
import type { Chunk, RunOptions } from '../src/main/adapters/types';
import { CLI_DEFINITIONS } from '../src/main/clis/registry';
import { DEFAULT_CATALOG } from '../src/main/clis/capabilities';
import { FakeLauncher, type FakeBehavior } from './conformance/fakeProcess';

const base: RunOptions = { cwd: process.cwd(), model: 'default', effort: 'low', permission: 'read-only' };
const collect = async (a: { run(p: string, o: RunOptions): AsyncIterable<Chunk> }, prompt = 'THE PROMPT', o: Partial<RunOptions> = {}) => {
  const out: Chunk[] = [];
  for await (const c of a.run(prompt, { ...base, ...o })) out.push(c);
  return out;
};
const done = (cs: Chunk[]) => {
  expect(cs.filter((c) => c.kind === 'done')).toHaveLength(1);
  expect(cs.at(-1)!.kind).toBe('done');
  return cs.at(-1) as Extract<Chunk, { kind: 'done' }>;
};
const ev = (o: object) => JSON.stringify(o);
const OK: FakeBehavior = (p) => {
  p.out(ev({ type: 'init', session_id: 'g-1', model: 'gemini-x' }));
  p.out(ev({ type: 'message', role: 'user', content: 'ignored' }));
  p.out(ev({ type: 'message', role: 'assistant', content: 'Hello ', delta: true }));
  p.out('not json at all');
  p.out(ev({ type: 'tool_use', tool_name: 'read_file' }));
  p.out(ev({ type: 'message', role: 'assistant', content: 'world', delta: true }));
  p.out(ev({ type: 'result', status: 'success', stats: { input_tokens: 10, output_tokens: 4 } }));
  p.exit(0);
};

describe('gemini adapter', () => {
  it('maps stream-json events to chunks and ends with exactly one done', async () => {
    const launcher = new FakeLauncher(OK);
    const cs = await collect(new GeminiAdapter('gemini', { launcher }), 'secret prompt', { systemPrompt: 'ROLE' });
    expect(cs.map((c) => c.kind)).toEqual(['session', 'text', 'tool', 'text', 'usage', 'done']);
    expect(cs.find((c) => c.kind === 'usage')).toEqual({ kind: 'usage', inputTokens: 10, outputTokens: 4 });
    expect(done(cs)).toMatchObject({ ok: true, text: 'Hello world' });
    const p = launcher.last!;
    expect(await p.stdinEnded).toBe('ROLE\n\n---\n\nsecret prompt');
    expect(p.argv.join(' ')).not.toContain('secret prompt');
  });

  it('a non-zero exit fails with the stderr tail, and a rate limit is flagged', async () => {
    const cs = await collect(new GeminiAdapter('gemini', { launcher: new FakeLauncher((p) => { p.err('Error 429: quota exceeded\n'); p.exit(1); }) }));
    expect(done(cs)).toMatchObject({ ok: false, rateLimited: true, exitCode: 1 });
    expect(done(cs).error).toMatch(/quota exceeded/);
  });

  it('an error event or a failed result is a failure even with exit 0', async () => {
    const a = await collect(new GeminiAdapter('gemini', { launcher: new FakeLauncher((p) => { p.out(ev({ type: 'error', message: 'Please sign in: not logged in' })); p.exit(0); }) }));
    expect(done(a)).toMatchObject({ ok: false, error: 'Please sign in: not logged in' });
    const b = await collect(new GeminiAdapter('gemini', { launcher: new FakeLauncher((p) => { p.out(ev({ type: 'result', status: 'error', error: { message: 'boom' } })); p.exit(0); }) }));
    expect(done(b)).toMatchObject({ ok: false, error: 'boom' });
  });

  it('exit 0 without a final result event is reported, not trusted', async () => {
    const cs = await collect(new GeminiAdapter('gemini', { launcher: new FakeLauncher((p) => { p.out(ev({ type: 'message', role: 'assistant', content: 'partial' })); p.exit(0); }) }));
    expect(done(cs)).toMatchObject({ ok: false, text: 'partial', exitCode: 0 });
    expect(done(cs).error).toMatch(/without its final result/);
  });

  it('a spawn failure still yields one done', async () => {
    const cs = await collect(new GeminiAdapter('gemini', { launcher: new FakeLauncher(() => undefined, { spawnError: 'spawn gemini ENOENT' }) }));
    expect(done(cs)).toMatchObject({ ok: false });
  });

  it('aborting stops the process and ends with done "stopped"', async () => {
    const ac = new AbortController();
    const launcher = new FakeLauncher(() => undefined);
    const run = collect(new GeminiAdapter('gemini', { launcher, forceResolveMs: 50 }), 'x', { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    expect(done(await run)).toMatchObject({ ok: false, error: 'stopped' });
    expect(launcher.last!.wasKilled()).toBe(true);
  });

  it('maps permission, model and folders to arguments; unverified flags are never sent for resume or images', () => {
    expect(geminiArgs(base)).toEqual(['--output-format', 'stream-json', '--approval-mode', 'default']);
    expect(geminiArgs({ ...base, permission: 'edit', model: 'gemini-2.5-pro', writableDirs: ['C:\\g'], readableDirs: ['C:\\s', 'C:\\g'], resumeId: 'x', images: ['a.png'] }))
      .toEqual(['--output-format', 'stream-json', '--model', 'gemini-2.5-pro', '--approval-mode', 'auto_edit', '--include-directories', 'C:\\g,C:\\s']);
    expect(geminiArgs({ ...base, permission: 'full' })).toContain('yolo');
  });

  it('parses lines purely', () => {
    expect(parseGeminiLine('[1]')).toEqual({ chunks: [] });
    expect(parseGeminiLine(ev({ type: 'message', role: 'user', content: 'x' }))).toEqual({ chunks: [] });
    expect(parseGeminiLine(ev({ type: 'result', status: 'success' }))).toEqual({ chunks: [], done: true });
  });
});

describe('gemini registration', () => {
  const def = CLI_DEFINITIONS.find((d) => d.id === 'gemini')!;
  it('has structured output but no resume, images or enforceable read-only', () => {
    expect(def.features).toMatchObject({ structuredOutput: true, resume: false, images: false, readOnly: false, mcp: false });
    expect(def.noStatusNote).toMatch(/unverified/);
  });
  it('catalog entries are data in the gemini pool and every one says its model id is unverified', () => {
    const g = DEFAULT_CATALOG.filter((e) => e.cli === 'gemini');
    expect(g.length).toBeGreaterThanOrEqual(2);
    for (const e of g) { expect(e.pool).toBe('gemini:all'); expect(e.note).toMatch(/UNVERIFIED/); }
  });
});

describe('terminal adapter (baseline)', () => {
  it('sends the prompt on stdin, returns stdout as one text chunk, and ends with one done', async () => {
    const launcher = new FakeLauncher((p) => { p.out('line one'); p.out('line two'); p.exit(0); });
    const cs = await collect(new TerminalAdapter('gemini', 'gemini', { launcher, args: geminiTerminalArgs }), 'my prompt', { model: 'm1', systemPrompt: 'ROLE', resumeId: 'ignored', permission: 'edit' });
    expect(cs.map((c) => c.kind)).toEqual(['text', 'done']);
    expect(done(cs)).toMatchObject({ ok: true, text: 'line one\nline two' });
    expect(await launcher.last!.stdinEnded).toBe('ROLE\n\n---\n\nmy prompt');
    expect(launcher.last!.argv).toEqual(['--model', 'm1']); // no resume, no permission flags
  });
  it('fails on a non-zero exit with the stderr tail', async () => {
    const cs = await collect(new TerminalAdapter('x', 'x', { launcher: new FakeLauncher((p) => { p.err('rate limit reached'); p.exit(2); }) }));
    expect(done(cs)).toMatchObject({ ok: false, rateLimited: true, exitCode: 2, error: 'rate limit reached' });
  });
  it('labels its limitations', () => {
    expect(TERMINAL_LIMITATIONS.join(' ')).toMatch(/no resume.*no streaming.*no tool-permission/);
  });
});
