import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Chunk } from '../../src/main/adapters/types';
import { assertChunkContract, GARBAGE_LINES } from './harness';
import { PARSERS, parseTranscript, parseTranscriptLines, readTranscript, replayTranscript, scrubTranscriptLine, serializeTranscript, type Transcript } from './transcript';

/** Regression tests over every transcript in tests/fixtures/transcripts (format: transcript.ts). New files are picked up automatically. */
const DIR = resolve(__dirname, '..', 'fixtures', 'transcripts');
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).sort();

describe('transcript fixtures', () => {
  it('exist and every file is a valid, labelled transcript named after its cli and source', () => {
    expect(FILES.length).toBeGreaterThan(0);
    for (const f of FILES) {
      const t = readTranscript(join(DIR, f));
      expect(f.startsWith(`${t.header.cli}-${t.header.source}-`), `${f}: name must start with <cli>-<source>-`).toBe(true);
      if (t.header.source === 'synthetic') expect(t.header.notes, `${f}: a synthetic transcript says what it is based on`).toBeTruthy();
      else expect(t.header.cliVersion && t.header.captured, `${f}: a recorded transcript names the CLI version and date`).toBeTruthy();
    }
  });

  for (const f of FILES) {
    describe(f, () => {
      const t = readTranscript(join(DIR, f));
      const x = t.header.expect ?? {};

      it('every stdout line parses without throwing', () => {
        expect(() => parseTranscriptLines(t)).not.toThrow();
      });

      it('replays through the adapter as the header expects', async () => {
        const { chunks } = await replayTranscript(t);
        assertChunkContract(chunks);
        const done = chunks.at(-1) as Extract<Chunk, { kind: 'done' }>;
        if (x.done) {
          expect(done.ok).toBe(x.done.ok);
          if (x.done.rateLimited !== undefined) expect(done.rateLimited ?? false).toBe(x.done.rateLimited);
          if (x.done.exitCode !== undefined) expect(done.exitCode).toBe(x.done.exitCode);
          if (x.done.errorIncludes) expect(done.error).toContain(x.done.errorIncludes);
          if (x.done.textIncludes) expect(done.text).toContain(x.done.textIncludes);
        }
        if (x.kinds) expect(chunks.map((c) => c.kind)).toEqual(x.kinds);
        if (x.session) expect(chunks.filter((c) => c.kind === 'session').at(-1)).toEqual({ kind: 'session', id: x.session });
        for (const s of x.text ?? []) expect(chunks.some((c) => c.kind === 'text' && c.text.includes(s)), `text "${s}"`).toBe(true);
        if (x.usage) expect(chunks.filter((c) => c.kind === 'usage' && !c.partial).at(-1)).toMatchObject(x.usage);
        if (x.limits) {
          const l = chunks.filter((c) => c.kind === 'limits').at(-1) as Extract<Chunk, { kind: 'limits' }> | undefined;
          expect(l?.limits.map((w) => ({ period: w.period, ...(w.scope ? { scope: w.scope } : {}) }))).toEqual(x.limits);
        }
      });

      it('the pure parse and the adapter agree on everything before the terminal chunk', async () => {
        const pure = parseTranscriptLines(t);
        const cut = pure.findIndex((c) => c.kind === 'done');
        const strip = (cs: Chunk[]) => cs.map((c) => (c.kind === 'limits' ? { kind: 'limits' } : c));
        const { chunks } = await replayTranscript(t);
        expect(strip(chunks.slice(0, -1))).toEqual(strip(cut >= 0 ? pure.slice(0, cut) : pure));
      });

      it('replays the same when the transcript is cut anywhere: always exactly one done', async () => {
        const stdout = t.records.filter((r) => 'o' in r);
        for (let n = 0; n <= stdout.length; n++) {
          const cutT: Transcript = { header: t.header, records: [...stdout.slice(0, n), ...t.records.filter((r) => 'e' in r), { exit: 0 }] };
          assertChunkContract((await replayTranscript(cutT)).chunks);
        }
      });
    });
  }
});

describe('transcript format and helpers', () => {
  const header = { harborTranscript: 1 as const, cli: 'claude' as const, source: 'synthetic' as const, scenario: 's', notes: 'n' };

  it('round-trips through serialize and parse, keeping garbage and blank lines exactly', () => {
    const t: Transcript = { header, records: [...GARBAGE_LINES.slice(0, 12).map((o) => ({ o })), { e: 'warn' }, { exit: null }] };
    expect(parseTranscript(serializeTranscript(t))).toEqual(t);
  });

  it('rejects malformed transcripts', () => {
    expect(() => parseTranscript('{"cli":"claude"}')).toThrow(/header/);
    expect(() => parseTranscript(`${JSON.stringify({ ...header, cli: 'gemini' })}\n`)).toThrow(/cli/);
    expect(() => parseTranscript(`${JSON.stringify(header)}\n{"o":1}\n`)).toThrow(/line 2/);
    expect(() => parseTranscript(`${JSON.stringify(header)}\n{"exit":0}\n{"o":"x"}\n`)).toThrow(/last/);
    expect(() => parseTranscript(`${JSON.stringify({ ...header, source: 'real' })}\n`)).toThrow(/source/);
  });

  it('every parser survives the garbage corpus', () => {
    for (const parse of Object.values(PARSERS)) for (const g of GARBAGE_LINES) expect(() => parse(g), g.slice(0, 40)).not.toThrow();
  });

  it('scrubbing removes the home folder, user name and Claude setup lists', () => {
    const who = { home: 'C:\\Users\\jdoe', user: 'jdoe' };
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', cwd: 'C:\\Users\\jdoe\\repo', mcp_servers: [{ name: 'corp', status: 'ok' }], plugins: ['x'], slash_commands: ['/a'] });
    const s = scrubTranscriptLine(init, who);
    expect(s).not.toMatch(/jdoe|corp/i);
    expect(JSON.parse(s)).toMatchObject({ cwd: '~\\repo', mcp_servers: [], plugins: [], slash_commands: [], session_id: 's' });
    expect(scrubTranscriptLine('Error in C:/Users/jdoe/x and JDOE', who)).toBe('Error in ~/x and someone');
    expect(scrubTranscriptLine(JSON.stringify({ type: 'result', result: 'see C:\\Users\\jdoe\\a.ts' }), who)).toBe(JSON.stringify({ type: 'result', result: 'see ~\\a.ts' }));
  });
});
