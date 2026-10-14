import { describe, expect, it } from 'vitest';
import type { ProcessLauncher } from '../../src/main/adapters/stream';
import type { Chunk, CliAdapter, RunOptions } from '../../src/main/adapters/types';
import { FakeLauncher, hang, script, tick, type FakeBehavior, type FakeLauncherOptions } from './fakeProcess';

/**
 * The adapter conformance suite: behaviour every CliAdapter must show, whatever CLI it drives. See the authoring guide at the top
 * of adapters.conformance.test.ts for how a new adapter plugs in. Everything runs against fake child processes (fakeProcess.ts).
 */

/** How the suite drives one adapter. Everything CLI-specific lives here, so the checks below stay CLI-agnostic. */
export interface ConformanceSubject {
  name: string;
  /** Build the adapter under test around the injected launcher. */
  make(launcher: ProcessLauncher, o: { forceResolveMs?: number }): CliAdapter;
  /** Options merged into every run (e.g. a tool-permission handler for Claude's controlled mode). */
  baseOptions?: Partial<RunOptions>;
  /** Stdout lines the CLI prints for each part of a run. */
  lines: {
    /** Announces the native session id; [] when the CLI has none. */
    session(id: string): string[];
    /** One piece of assistant text. */
    text(text: string): string[];
    /** The terminal success event; [] when only the exit code ends a run. */
    success(text: string): string[];
    /** The terminal failure event; absent when the CLI has none. */
    failure?(message: string): string[];
  };
  /** The CLI ends a run with an event of its own, so exiting 0 without it is a cut-off, not a success. */
  terminalEvent: boolean;
  /** Absent when the adapter cannot resume a session. */
  resumes?(argv: string[], id: string): boolean;
  /** Arguments that grant writes, approvals or sandbox escape; the suite requires none in a read-only run and some in an edit run. */
  editGrants(argv: string[]): string[];
  /** Wait for the prompt line before printing (Claude's controlled mode keeps stdin open and reads the prompt first). */
  waitStdin?: boolean;
}

export type Done = Extract<Chunk, { kind: 'done' }>;

const BASE: RunOptions = { cwd: process.cwd(), model: 'default', effort: 'low', permission: 'edit' };

export interface RunResult { chunks: Chunk[]; done: Done; launcher: FakeLauncher }

/** Run the subject's adapter once against a fake process and collect every chunk. */
export async function runOnce(s: ConformanceSubject, behavior: FakeBehavior, o: Partial<RunOptions> = {}, lo: FakeLauncherOptions & { forceResolveMs?: number } = {}): Promise<RunResult> {
  const launcher = new FakeLauncher(behavior, lo);
  const adapter = s.make(launcher, { forceResolveMs: lo.forceResolveMs });
  const chunks: Chunk[] = [];
  for await (const c of adapter.run('Say OK.', { ...BASE, ...s.baseOptions, ...o })) chunks.push(c);
  assertChunkContract(chunks);
  return { chunks, done: chunks.at(-1) as Done, launcher };
}

/** Like runOnce, with a chosen prompt. */
export async function runPrompt(s: ConformanceSubject, prompt: string, behavior: FakeBehavior, o: Partial<RunOptions> = {}): Promise<RunResult> {
  const launcher = new FakeLauncher(behavior);
  const chunks: Chunk[] = [];
  for await (const c of s.make(launcher, {}).run(prompt, { ...BASE, ...s.baseOptions, ...o })) chunks.push(c);
  assertChunkContract(chunks);
  return { chunks, done: chunks.at(-1) as Done, launcher };
}

const finiteOrAbsent = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v));
const stringOrAbsent = (v: unknown) => v === undefined || typeof v === 'string';

/** The chunk stream contract (types.ts): exactly one done, last; every field has its declared type, whatever the CLI printed. */
export function assertChunkContract(chunks: Chunk[]): void {
  const dones = chunks.filter((c) => c.kind === 'done');
  expect(dones, 'exactly one done chunk').toHaveLength(1);
  expect(chunks.at(-1)?.kind, 'done is the last chunk').toBe('done');
  for (const c of chunks) {
    switch (c.kind) {
      case 'session': expect(typeof c.id === 'string' && c.id.trim() !== '', `session id ${JSON.stringify(c.id)}`).toBe(true); break;
      case 'text': case 'tool': expect(typeof c.text, `${c.kind} text`).toBe('string'); break;
      case 'usage':
        for (const k of ['inputTokens', 'outputTokens', 'costUsd', 'cacheReadTokens', 'cacheWriteTokens'] as const) expect(finiteOrAbsent(c[k]), `usage.${k} = ${JSON.stringify(c[k])}`).toBe(true);
        break;
      case 'limits':
        for (const l of c.limits) expect(Number.isFinite(l.usedPct) && Number.isFinite(l.resetsAt)).toBe(true);
        break;
      case 'done':
        expect(typeof c.ok).toBe('boolean');
        expect(stringOrAbsent(c.text) && stringOrAbsent(c.error), 'done text/error are strings').toBe(true);
        expect(c.rateLimited === undefined || typeof c.rateLimited === 'boolean', 'rateLimited is boolean').toBe(true);
        expect(c.exitCode === undefined || c.exitCode === null || Number.isInteger(c.exitCode), 'exitCode').toBe(true);
        if (!c.ok) expect(typeof c.error === 'string' && c.error.length > 0, 'a failed done says why').toBe(true);
        break;
    }
  }
}

/** Lines that are not valid events: every adapter must survive them without throwing or emitting malformed chunks. */
export const GARBAGE_LINES: string[] = [
  '', '   ', '\t', 'not json at all', '{', '}', '{"unterminated": "str', 'null', 'true', '42', '-1e309', '"a string"', '[]', '[1,2,3]', '{}',
  '\uFEFF{"type":"x"}', '\u0000\u0001\u0002', '{"type":null}', '{"type":42}', '{"type":{"nested":true}}', '{"type":"assistant"}',
  '{"type":"assistant","message":null}', '{"type":"assistant","message":{"content":"text not array"}}',
  '{"type":"assistant","message":{"content":[null,5,"x",{"type":"text","text":42},{"type":"tool_use","name":null,"input":null}],"usage":"lots"}}',
  '{"type":"system","subtype":"init","session_id":123}', '{"type":"system","subtype":"init","session_id":""}',
  '{"type":"rate_limit_event","rate_limit_info":null}', '{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":"x"}}',
  '{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":null,"seven_day":{"utilization":"high","resetsAt":1}}}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}',
  '{"type":"thread.started","thread_id":null}', '{"type":"thread.started","thread_id":7}', '{"type":"item.completed","item":null}',
  '{"type":"item.completed","item":"str"}', '{"type":"item.completed","item":{"type":"agent_message","text":["a"]}}',
  '{"type":"item.started","item":{"type":"command_execution","command":"ls"}}', '{"type":"error","message":{"code":1}}',
  '{"type":"control_cancel_request"}', '{"type":"control_request","request_id":5}',
  '{"session_id":{"a":1},"text":{"b":2},"usage":{"in":"many","out":-3}}',
  `{"deep":${'['.repeat(5000)}${']'.repeat(5000)}}`, '['.repeat(100_000),
  'Warning: something printed to stdout by a wrapper script', 'npm WARN deprecated foo@1.0.0', '\x1b[31mred ANSI\x1b[0m'
];

/** Text with multi-byte characters, to be split mid-character by the partial-line check. */
const UNICODE = 'héllo wörld · 世界 · 🚢⚓ · ZWJ 👩‍💻';

/** Register the whole suite for one subject. */
export function conformance(s: ConformanceSubject): void {
  const L = s.lines;
  const normal = (text = 'Hello from the CLI', id = 'sess-1') => [...L.session(id), ...L.text(text), ...L.success(text)];
  const behave = (lines: string[], o: Parameters<typeof script>[1] = {}) => script(lines, { waitStdin: s.waitStdin, ...o });

  describe(`adapter conformance: ${s.name}`, () => {
    it('a normal run streams its output and ends with exactly one successful done', async () => {
      const { chunks, done } = await runOnce(s, behave(normal()));
      expect(done.ok).toBe(true);
      expect(chunks.some((c) => c.kind === 'text' && c.text.includes('Hello from the CLI'))).toBe(true);
      if (L.session('x').length) expect(chunks.find((c) => c.kind === 'session')).toEqual({ kind: 'session', id: 'sess-1' });
    });

    it('sends the prompt (and role text) on stdin, never in argv', async () => {
      const marker = `PROMPT-${Math.random().toString(36).slice(2)}`;
      const prompt = `${marker} with "quotes", %PATH%, & | < > ^ and\nmore lines\r\nend`;
      const role = `ROLE-${Math.random().toString(36).slice(2)}`;
      for (const permission of ['read-only', 'edit', 'full'] as const) {
        const { launcher } = await runPrompt(s, prompt, behave(normal()), { permission, systemPrompt: `${role}\nbe careful` });
        const p = launcher.last!;
        const argv = p.argv.join('\u0000');
        expect(argv, `${permission}: prompt in argv`).not.toContain(marker);
        expect(argv, `${permission}: role text in argv`).not.toContain(role);
        expect(p.stdin(), `${permission}: prompt on stdin`).toContain(marker);
      }
    });

    it('never passes edit or approval grants to a read-only run', async () => {
      const risky: Partial<RunOptions> = {
        writableDirs: ['C:\\repo\\.git\\worktrees\\x'], allowedCommands: ['pnpm test'], readableDirs: ['C:\\skills\\a'],
        onToolPermission: async () => ({ allow: true }), images: []
      };
      const ro = await runOnce(s, behave(normal()), { permission: 'read-only', ...risky });
      expect(s.editGrants(ro.launcher.last!.argv), 'grants in a read-only argv').toEqual([]);
      // The check is not vacuous: the same subject does recognise grants in an edit run.
      const ed = await runOnce(s, behave(normal()), { permission: 'edit', ...risky });
      expect(s.editGrants(ed.launcher.last!.argv).length, 'an edit run carries grants').toBeGreaterThan(0);
    });

    if (s.resumes) {
      const resumes = s.resumes;
      it('the session id it reports resumes that session on the next run', async () => {
        const id = 'sess-0f3c-RESUME-42';
        const first = await runOnce(s, behave(normal('one', id)));
        const got = first.chunks.find((c) => c.kind === 'session') as { id: string } | undefined;
        expect(got?.id).toBe(id);
        expect(resumes(first.launcher.last!.argv, id), 'first run must not resume').toBe(false);
        const second = await runOnce(s, behave(normal('two', id)), { resumeId: got!.id });
        expect(resumes(second.launcher.last!.argv, id)).toBe(true);
        expect(second.done.ok).toBe(true);
      });
    }

    it('survives garbage lines without throwing or emitting malformed chunks', async () => {
      const lines = [...L.session('sess-g'), ...GARBAGE_LINES, ...L.text('still here'), ...GARBAGE_LINES.slice(0, 10), ...L.success('still here')];
      const { chunks, done } = await runOnce(s, behave(lines));
      expect(done.ok).toBe(true);
      expect(chunks.some((c) => c.kind === 'text' && c.text.includes('still here'))).toBe(true);
    });

    it('exit code 0 without a terminal event ends with one done that says so', async () => {
      const { done } = await runOnce(s, behave([...L.session('sess-z'), ...L.text('cut off')], { exit: 0 }));
      if (s.terminalEvent) {
        expect(done.ok).toBe(false);
        expect(done.exitCode).toBe(0);
      } else expect(done.ok).toBe(true);
    });

    it('a non-zero exit without a terminal event fails with the exit code and the stderr tail', async () => {
      const { done } = await runOnce(s, behave(L.text('partial'), { stderr: ['debug: starting', 'fatal: config file is broken'], exit: 3 }));
      expect(done.ok).toBe(false);
      expect(done.exitCode).toBe(3);
      expect(done.error).toContain('fatal: config file is broken');
      expect(done.rateLimited ?? false).toBe(false);
    });

    it('a rate-limit message on stderr of a failed run is reported as rate limited', async () => {
      const { done } = await runOnce(s, behave([], { stderr: ['Error: 429 Too Many Requests: usage limit reached'], exit: 1 }));
      expect(done).toMatchObject({ ok: false, rateLimited: true });
    });

    if (L.failure) {
      const failure = L.failure;
      it('the terminal failure event fails the run with its message', async () => {
        const { done } = await runOnce(s, behave([...L.session('sess-f'), ...failure('You have hit your usage limit')]));
        expect(done.ok).toBe(false);
        expect(done.error).toContain('usage limit');
        expect(done.rateLimited).toBe(true);
      });
    }

    it('stderr noise never becomes output and never fails a successful run', async () => {
      const noise = Array.from({ length: 3000 }, (_, i) => `warn ${i}: rate limit nearly reached, 429 retry, quota`);
      // Event-shaped text on stderr must not be parsed as events.
      const fake = [...L.text('FROM-STDERR'), ...(L.failure?.('FROM-STDERR failure') ?? []), ...L.session('sess-stderr')];
      const { chunks, done } = await runOnce(s, behave(normal('real answer'), { stderr: [...noise, ...fake] }));
      expect(done.ok).toBe(true);
      expect(done.rateLimited ?? false).toBe(false);
      expect(JSON.stringify(chunks)).not.toContain('FROM-STDERR');
      expect(chunks.some((c) => c.kind === 'session' && c.id === 'sess-stderr')).toBe(false);
    });

    it('aborting mid-run kills the process and still ends with exactly one done', async () => {
      const ac = new AbortController();
      const launcher = new FakeLauncher(hang([...L.session('sess-a'), ...L.text('working')]));
      const chunks: Chunk[] = [];
      for await (const c of s.make(launcher, {}).run('go', { ...BASE, ...s.baseOptions, signal: ac.signal })) {
        chunks.push(c);
        if (chunks.length === 1) ac.abort();
      }
      assertChunkContract(chunks);
      expect(launcher.last!.wasKilled()).toBe(true);
      expect(chunks.at(-1)).toMatchObject({ kind: 'done', ok: false, error: 'stopped', exitCode: null });
    });

    it('a signal aborted before the run starts still ends with exactly one failed done', async () => {
      const ac = new AbortController();
      ac.abort();
      const { done } = await runOnce(s, hang(normal()), { signal: ac.signal });
      expect(done.ok).toBe(false);
    });

    it('a process that ignores the kill is abandoned after the grace period', async () => {
      const ac = new AbortController();
      const launcher = new FakeLauncher(hang(L.text('stubborn')), { ignoreKill: true });
      const chunks: Chunk[] = [];
      setTimeout(() => ac.abort(), 20);
      const t0 = Date.now();
      for await (const c of s.make(launcher, { forceResolveMs: 50 }).run('go', { ...BASE, ...s.baseOptions, signal: ac.signal })) chunks.push(c);
      assertChunkContract(chunks);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(launcher.last!.wasKilled()).toBe(true);
      expect(chunks.at(-1)).toMatchObject({ ok: false });
    });

    it('a consumer that stops iterating early kills the process', async () => {
      const launcher = new FakeLauncher(hang([...L.session('sess-b'), ...L.text('first'), ...L.text('second')]));
      for await (const c of s.make(launcher, {}).run('go', { ...BASE, ...s.baseOptions })) { void c; break; }
      await tick();
      expect(launcher.last!.wasKilled()).toBe(true);
    });

    it('a spawn that throws ends with one failed done and no exit code', async () => {
      const { done } = await runOnce(s, behave(normal()), {}, { spawnThrows: 'Unsafe argument for shell launch' });
      expect(done).toMatchObject({ ok: false, exitCode: null });
      expect(done.error).toContain('Unsafe argument');
    });

    it('a spawn error (missing executable) ends with one failed done and no exit code', async () => {
      const { done } = await runOnce(s, behave(normal()), {}, { spawnError: 'spawn fakecli ENOENT' });
      expect(done).toMatchObject({ ok: false, exitCode: null });
      expect(done.error).toContain('ENOENT');
    });

    it('a line far longer than a pipe buffer arrives whole', async () => {
      const big = `BIG:${'x'.repeat(3 * 1024 * 1024)}:END`;
      const { chunks, done } = await runOnce(s, behave([...L.session('sess-h'), ...L.text(big), ...L.success(big)]));
      expect(done.ok).toBe(true);
      expect(chunks.some((c) => c.kind === 'text' && c.text === big)).toBe(true);
    });

    it('a newline-free flood is bounded and still ends with exactly one done', async () => {
      const flood = 'y'.repeat(17 * 1024 * 1024);
      const { done } = await runOnce(s, async (p) => {
        if (s.waitStdin) await p.firstStdinLine;
        for (let i = 0; i < flood.length; i += 1024 * 1024) p.write(flood.slice(i, i + 1024 * 1024));
        p.exit(0);
      });
      expect(typeof done.ok).toBe('boolean');
    });

    it('lines split across reads (mid UTF-8 character), CRLF endings and a final line without newline parse the same', async () => {
      const lines = normal(UNICODE, 'sess-u');
      const { chunks, done } = await runOnce(s, async (p) => {
        if (s.waitStdin) await p.firstStdinLine;
        const bytes = Buffer.from(lines.join('\r\n'), 'utf8'); // no trailing newline
        for (let i = 0; i < bytes.length; i += 5) { p.write(bytes.subarray(i, i + 5)); if (i % 50 === 0) await tick(); }
        p.exit(0);
      });
      expect(done.ok).toBe(true);
      expect(chunks.some((c) => c.kind === 'text' && c.text === UNICODE)).toBe(true);
      if (L.session('x').length) expect(chunks.find((c) => c.kind === 'session')).toEqual({ kind: 'session', id: 'sess-u' });
    });

    if (s.terminalEvent) {
      it('a second terminal event (or one after a failure event) never yields a second done', async () => {
        const lines = [...normal('first answer'), ...L.success('second answer'), ...(L.failure?.('late failure') ?? []), ...L.text('after the end')];
        const { chunks, done } = await runOnce(s, behave(lines));
        expect(done.ok).toBe(true);
        expect(chunks.filter((c) => c.kind === 'text' && c.text === 'first answer').length).toBeGreaterThan(0);
      });
    }
  });
}
