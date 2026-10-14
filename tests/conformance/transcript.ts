import { readFileSync } from 'node:fs';
import { ClaudeAdapter, parseClaudeLine } from '../../src/main/adapters/claude';
import { CodexAdapter, parseCodexLine } from '../../src/main/adapters/codex';
import type { Chunk, CliAdapter, RunOptions } from '../../src/main/adapters/types';
import type { ProcessLauncher } from '../../src/main/adapters/stream';
import { FakeLauncher, type FakeBehavior } from './fakeProcess';

/**
 * CLI transcripts: what a CLI printed during one run, kept as a fixture and replayed through the parsers and the adapters.
 *
 * FORMAT (tests/fixtures/transcripts/<cli>-<source>-<scenario>.jsonl, UTF-8, one JSON object per line)
 *   line 1, header: {"harborTranscript":1, "cli":"claude"|"codex", "source":"recorded"|"synthetic", "scenario":"...",
 *                    "cliVersion"?:"2.1.295", "captured"?:"YYYY-MM-DD", "notes"?:"...", "expect"?:{...}}
 *   then one record per line read, in order:
 *     {"o":"<one stdout line exactly as printed, without its line ending>"}
 *     {"e":"<one stderr line>"}
 *     {"exit":0}   optional last record: the exit code (null = killed by a signal); absent means 0
 * Raw lines are JSON strings, so garbage, blank lines and stderr survive exactly.
 *
 * `source` is "recorded" only for output a real CLI printed (scripts/smoke.ts --record writes these). Anything written by hand or
 * adapted from documentation is "synthetic", and its `notes` say what its shapes are based on. Never relabel a synthetic file.
 *
 * `expect` (all optional) is what Harbor must make of the transcript when replayed through the adapter:
 *   done: {ok, rateLimited?, exitCode?, errorIncludes?, textIncludes?}   the one terminal chunk
 *   kinds: ["session","text",...,"done"]                                  the exact sequence of chunk kinds
 *   session: "<id>"                                                        the last session id reported
 *   text: ["..."]                                                          each must appear in some text chunk
 *   usage: {inputTokens?, outputTokens?, cacheReadTokens?, cacheWriteTokens?, costUsd?}   the final (non-partial) usage chunk
 *   limits: [{period, scope?}]                                             the last limits chunk, in order
 *
 * Recording real transcripts: `npm run smoke -- claude --record` (uses quota). The recorder replaces the home folder and user
 * name and empties Claude's lists of MCP servers, plugins, skills, agents and slash commands; review the file before committing it.
 */

export type TranscriptRecord = { o: string } | { e: string } | { exit: number | null };

export interface TranscriptExpect {
  done?: { ok: boolean; rateLimited?: boolean; exitCode?: number | null; errorIncludes?: string; textIncludes?: string };
  kinds?: Chunk['kind'][];
  session?: string;
  text?: string[];
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number };
  limits?: Array<{ period: 'session' | 'weekly'; scope?: string }>;
}

export interface TranscriptHeader {
  harborTranscript: 1;
  cli: 'claude' | 'codex';
  source: 'recorded' | 'synthetic';
  scenario: string;
  cliVersion?: string;
  captured?: string;
  notes?: string;
  expect?: TranscriptExpect;
}

export interface Transcript { header: TranscriptHeader; records: TranscriptRecord[] }

/** Parse and validate a transcript file's text. Throws with the line number on anything malformed: fixtures must be exact. */
export function parseTranscript(text: string, name = 'transcript'): Transcript {
  const lines = text.split(/\r?\n/);
  while (lines.length && lines.at(-1) === '') lines.pop();
  const header = JSON.parse(lines[0] ?? '') as TranscriptHeader;
  if (header?.harborTranscript !== 1) throw new Error(`${name}: line 1 is not a harborTranscript 1 header`);
  if (header.cli !== 'claude' && header.cli !== 'codex') throw new Error(`${name}: unknown cli ${String(header.cli)}`);
  if (header.source !== 'recorded' && header.source !== 'synthetic') throw new Error(`${name}: source must be recorded or synthetic`);
  if (typeof header.scenario !== 'string' || !header.scenario) throw new Error(`${name}: scenario is required`);
  const records = lines.slice(1).map((l, i): TranscriptRecord => {
    const r = JSON.parse(l) as Record<string, unknown>;
    const keys = Object.keys(r);
    const ok = keys.length === 1 && ((keys[0] === 'o' || keys[0] === 'e') ? typeof r[keys[0]] === 'string' : keys[0] === 'exit' && (r.exit === null || Number.isInteger(r.exit)));
    if (!ok) throw new Error(`${name}: line ${i + 2} is not {"o"}, {"e"} or {"exit"}`);
    return r as TranscriptRecord;
  });
  if (records.slice(0, -1).some((r) => 'exit' in r)) throw new Error(`${name}: {"exit"} may only be the last record`);
  return { header, records };
}

export const readTranscript = (file: string): Transcript => parseTranscript(readFileSync(file, 'utf8'), file);

export function serializeTranscript(t: Transcript): string {
  return [t.header, ...t.records].map((r) => JSON.stringify(r)).join('\n') + '\n';
}

export const PARSERS: Record<TranscriptHeader['cli'], (line: string) => Chunk[]> = { claude: parseClaudeLine, codex: parseCodexLine };

/** Pure replay: the stdout lines through the CLI's line parser, as the adapter would see them (no done is synthesized). */
export function parseTranscriptLines(t: Transcript): Chunk[] {
  const parse = PARSERS[t.header.cli];
  return t.records.flatMap((r) => ('o' in r ? parse(r.o) : []));
}

/** A fake-process behaviour that prints the transcript's records and exits with its code. */
export function playTranscript(t: Transcript): FakeBehavior {
  return (p) => {
    let code: number | null = 0;
    for (const r of t.records) {
      if ('o' in r) p.out(r.o);
      else if ('e' in r) p.err(`${r.e}\n`);
      else code = r.exit;
    }
    p.exit(code);
  };
}

export const ADAPTERS: Record<TranscriptHeader['cli'], (launcher: ProcessLauncher) => CliAdapter> = {
  claude: (launcher) => new ClaudeAdapter('claude', { launcher }),
  codex: (launcher) => new CodexAdapter('codex', { launcher })
};

/** Full replay: the transcript played by a fake process through the real adapter (stream splitting, done synthesis and all). */
export async function replayTranscript(t: Transcript, o: Partial<RunOptions> = {}): Promise<{ chunks: Chunk[]; launcher: FakeLauncher }> {
  const launcher = new FakeLauncher(playTranscript(t));
  const chunks: Chunk[] = [];
  for await (const c of ADAPTERS[t.header.cli](launcher).run('replayed prompt', { cwd: process.cwd(), model: 'default', effort: 'low', permission: 'read-only', ...o })) chunks.push(c);
  return { chunks, launcher };
}

const CLAUDE_PRIVATE_LISTS = ['mcp_servers', 'plugins', 'slash_commands', 'skills', 'agents'];

/**
 * Make a recorded line safe to keep: the home folder and user name become placeholders, and Claude's init event loses the lists
 * that describe the user's own setup. Pure; a line that is not JSON is only path-scrubbed.
 */
export function scrubTranscriptLine(line: string, who: { home: string; user: string }): string {
  let out = line;
  try {
    const j = JSON.parse(line) as Record<string, unknown> | null;
    if (j && typeof j === 'object' && j.type === 'system' && j.subtype === 'init') {
      for (const k of CLAUDE_PRIVATE_LISTS) if (k in j) j[k] = [];
      out = JSON.stringify(j);
    }
  } catch { /* not JSON: scrub as text */ }
  const variants = (s: string) => [...new Set([s, s.replace(/\\/g, '/'), s.replace(/\\/g, '\\\\'), JSON.stringify(s).slice(1, -1)])].filter((v) => v.length > 2);
  for (const v of variants(who.home).sort((a, b) => b.length - a.length)) out = out.split(v).join('~');
  if (who.user.length > 2) out = out.replace(new RegExp(who.user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'someone');
  return out;
}
