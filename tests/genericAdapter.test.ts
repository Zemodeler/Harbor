import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CustomCliDescriptor } from '../src/shared/api';
import { GenericAdapter, genericArgs, parseGenericLine } from '../src/main/adapters/generic';
import type { Chunk, RunOptions } from '../src/main/adapters/types';

const dirs: string[] = [];
const tmp = (prefix = 'harbor-generic-') => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const SCRIPT = resolve(__dirname, 'fixtures', 'fakeCli.cjs');
const base: RunOptions = { cwd: process.cwd(), model: 'default', effort: 'low', permission: 'edit' };
const desc = (mode: string, over: Partial<CustomCliDescriptor['run']> = {}, extra: Partial<CustomCliDescriptor> = {}): CustomCliDescriptor =>
  ({ id: 'fake', name: 'Fake CLI', exe: process.execPath, run: { args: [SCRIPT, '--mode', mode], ...over }, ...extra });
const JSONL: CustomCliDescriptor['run']['output'] = { format: 'jsonl', map: { text: '$.text', session: '$.session_id', done: '$.type==result', error: '$.error', usage: { input: '$.usage.in', output: '$.usage.out' } } };

async function collect(a: GenericAdapter, prompt = 'THE PROMPT', o: Partial<RunOptions> = {}): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const c of a.run(prompt, { ...base, ...o })) chunks.push(c);
  return chunks;
}
const dones = (cs: Chunk[]) => cs.filter((c) => c.kind === 'done');
const done = (cs: Chunk[]) => { expect(dones(cs)).toHaveLength(1); expect(cs.at(-1)!.kind).toBe('done'); return cs.at(-1) as Extract<Chunk, { kind: 'done' }>; };
const echo = (cs: Chunk[]) => JSON.parse(done(cs).text!) as { argv: string[]; input: string; env: string[] };

describe('generic adapter: text output', () => {
  it('streams one text chunk per paragraph, then exactly one done with the whole answer', async () => {
    const cs = await collect(new GenericAdapter(desc('text')));
    expect(cs.map((c) => c.kind)).toEqual(['text', 'text', 'done']);
    expect(cs[0]).toEqual({ kind: 'text', text: 'para one\nline two' });
    expect(cs[1]).toEqual({ kind: 'text', text: `para two: ${'THE PROMPT'.length}` });
    expect(done(cs)).toMatchObject({ ok: true, text: `para one\nline two\n\npara two: ${'THE PROMPT'.length}` });
  });

  it('sends the prompt on stdin, never in argv, with the role prepended only on a first run', async () => {
    const first = echo(await collect(new GenericAdapter(desc('echo')), 'secret prompt', { systemPrompt: 'ROLE' }));
    expect(first.input).toBe('ROLE\n\n---\n\nsecret prompt');
    expect(first.argv.join(' ')).not.toContain('secret prompt');
    const resumed = echo(await collect(new GenericAdapter(desc('echo')), 'again', { systemPrompt: 'ROLE', resumeId: 's1' }));
    expect(resumed.input).toBe('again');
  });

  it('noisy stderr does not fail a run that exits 0', async () => {
    expect(done(await collect(new GenericAdapter(desc('noisy'))))).toMatchObject({ ok: true, text: 'OK' });
  });

  it('a non-zero exit fails with the stderr tail and flags a rate limit', async () => {
    expect(done(await collect(new GenericAdapter(desc('fail'))))).toMatchObject({ ok: false, error: 'boom: rate limit reached', rateLimited: true, exitCode: 1 });
  });

  it('a program that cannot start ends with one failed done', async () => {
    const cs = await collect(new GenericAdapter({ ...desc('text'), exe: join(tmp(), 'missing.exe') }));
    expect(done(cs)).toMatchObject({ ok: false, exitCode: null });
  });

  it('a slow CLI is waited for', async () => {
    expect(done(await collect(new GenericAdapter(desc('slow'))))).toMatchObject({ ok: true, text: 'late OK' });
  });

  it('abort kills the whole process tree and ends with one done', async () => {
    const ctl = new AbortController();
    const chunks: Chunk[] = [];
    let pids: number[] = [];
    // Text arrives per paragraph, so the pids line shows up only with the final flush: abort on a timer.
    setTimeout(() => ctl.abort(), 2000);
    for await (const c of new GenericAdapter(desc('forever')).run('x', { ...base, signal: ctl.signal })) {
      chunks.push(c);
      if (c.kind === 'text' && c.text.startsWith('pids')) pids = c.text.split(' ').slice(1).map(Number);
    }
    expect(done(chunks)).toMatchObject({ ok: false, error: 'stopped' });
    expect(pids).toHaveLength(2);
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 50 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 100));
    expect(pids.filter(alive)).toEqual([]);
  }, 20000);
});

describe('generic adapter: argument templates', () => {
  it('expands values into single argv elements, drops empty groups and fills slots', async () => {
    const d = desc('echo', {
      args: [SCRIPT, '--mode', 'echo', ['--model', '{model}'], '--cwd={cwd}', '{effortArgs}', '{permissionArgs}'],
      effort: { low: ['--effort', 'low'] }, permissions: { 'read-only': ['--read-only'], edit: ['--edit'] },
      resume: { args: ['--resume', '{sessionId}'] }, image: { args: ['--image', '{path}'] }
    });
    const cwd = tmp("harbor generic it's & (dir) ");
    const a = echo(await collect(new GenericAdapter(d), 'p', { cwd, model: 'my "model" & x', images: ['C:\\img one.png'], resumeId: 'sess 1' }));
    expect(a.argv).toEqual(['--mode', 'echo', '--model', 'my "model" & x', `--cwd=${cwd}`, '--effort', 'low', '--edit', '--resume', 'sess 1', '--image', 'C:\\img one.png']);
    const b = echo(await collect(new GenericAdapter(d), 'p', { permission: 'read-only' }));
    expect(b.argv).toEqual(['--mode', 'echo', `--cwd=${process.cwd()}`, '--effort', 'low', '--read-only']);
  });

  it('genericArgs is pure and appends unmentioned slots at the end in a fixed order', () => {
    const d = desc('x', { args: ['run', '{imageArgs}'], effort: { high: ['-e', 'hi'] }, resume: { args: [['--resume', '{sessionId}']] }, image: { args: ['-i', '{path}'] } });
    expect(genericArgs(d, { ...base, effort: 'high', images: ['a.png'], resumeId: 'r' })).toEqual(['run', '-i', 'a.png', '--resume', 'r', '-e', 'hi']);
    expect(genericArgs(d, { ...base, nativeEffort: 'xhigh', effort: 'high' })).toEqual(['run', '-e', 'hi']);
  });

  it('a prompt file is written for {promptFile}, passed as one argument and deleted afterwards', async () => {
    const d = desc('file', { args: [SCRIPT, '--mode', 'file', '--prompt-file', '{promptFile}'], prompt: 'file' });
    const r = JSON.parse(done(await collect(new GenericAdapter(d, { tmpDir: tmp() }), 'from a file')).text!) as { file: string; path: string; stdin: string };
    expect(r.file).toBe('from a file');
    expect(r.stdin).toBe('');
    expect(existsSync(r.path)).toBe(false);
  });

  it('passes only the allowlisted environment plus the descriptor values', async () => {
    const d = desc('echo', { env: { MYCLI_TOKEN_FILE: 'C:\\t.txt' } });
    const env = echo(await collect(new GenericAdapter(d, { env: { ...process.env, SECRET_API_KEY: 'x', GITHUB_TOKEN: 'y' } }))).env.map((k) => k.toUpperCase());
    expect(env).toContain('MYCLI_TOKEN_FILE');
    expect(env).toContain('PATH');
    expect(env).not.toContain('SECRET_API_KEY');
    expect(env).not.toContain('GITHUB_TOKEN');
  });
});

describe('generic adapter: jsonl output', () => {
  it('maps session, text and usage, ignores lines that are not JSON, and ends on the result event', async () => {
    const cs = await collect(new GenericAdapter(desc('jsonl', { output: JSONL })));
    expect(cs).toEqual([
      { kind: 'session', id: 'sess-42' }, { kind: 'text', text: 'Hello' }, { kind: 'text', text: 'OK' },
      { kind: 'usage', inputTokens: 120, outputTokens: 7 }, { kind: 'done', ok: true, text: 'Hello\n\nOK' }
    ]);
  });

  it('a mapped error fails the run', async () => {
    expect(done(await collect(new GenericAdapter(desc('jsonl-error', { output: JSONL }))))).toMatchObject({ ok: false, error: 'usage limit reached', rateLimited: true });
  });

  it('a run that exits 0 without the final event is reported with its exit code', async () => {
    expect(done(await collect(new GenericAdapter(desc('jsonl-cut', { output: JSONL }))))).toMatchObject({ ok: false, exitCode: 0, text: 'partial' });
  });

  it('parseGenericLine never reads inherited properties', () => {
    const d = desc('x', { output: { format: 'jsonl', map: { text: '$.constructor', done: '$.toString' } } });
    expect(parseGenericLine(d, '{"a":1}')).toEqual({ chunks: [] });
    expect(parseGenericLine(d, 'garbage')).toEqual({ chunks: [] });
  });
});

describe.skipIf(process.platform !== 'win32')('generic adapter through a .cmd shim', () => {
  function shim() {
    const d = tmp('harbor generic shim ');
    const p = join(d, 'fakecli.cmd');
    writeFileSync(p, `@echo off\r\n"${process.execPath}" "${SCRIPT}" %*\r\n`);
    return p;
  }
  it('keeps metacharacters literal and refuses values cmd.exe would expand', async () => {
    const d: CustomCliDescriptor = { id: 'fake', name: 'Fake', exe: shim(), run: { args: ['--mode', 'echo', ['--model', '{model}']] } };
    const ok = echo(await collect(new GenericAdapter(d), 'p', { model: 'a & b | c' }));
    expect(ok.argv).toEqual(['--mode', 'echo', '--model', 'a & b | c']);
    const bad = done(await collect(new GenericAdapter(d), 'p', { model: '%PATH%' }));
    expect(bad).toMatchObject({ ok: false });
    expect(bad.error).toMatch(/Unsafe argument/);
  });
});
