import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chatgptExportSource, claudeExportSource, parseChatgptConversation, parseClaudeExportConversation, readExportFile } from '../src/main/importers/accountExports';
import { claudeCodeSource, parseClaudeTranscript } from '../src/main/importers/claudeCode';
import { codexSource, parseCodexSession } from '../src/main/importers/codex';
import { CHAT_LIMITS, jsonLines, Skips } from '../src/main/importers/common';
import { IMPORT_SOURCES } from '../src/main/importers';
import { writeZip } from '../src/main/skills/zip';

// All fixtures are synthetic (tests/fixtures/chats, written for Harbor); no real transcript is used.
const FIX = join(__dirname, 'fixtures', 'chats');
const fixture = (n: string) => readFileSync(join(FIX, n));
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-imp-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const env = (o: { claudeHome?: string; codexHome?: string } = {}) => ({ ...o, home: undefined, now: () => 1_760_000_000_000 });

describe('ImportSource interface', () => {
  it('every source has detect, preview and read; account exports say they are unverified', () => {
    for (const s of IMPORT_SOURCES) { expect(typeof s.detect).toBe('function'); expect(typeof s.preview).toBe('function'); expect(typeof s.read).toBe('function'); }
    expect(IMPORT_SOURCES.map((s) => [s.id, s.verified])).toEqual([['claude-code', true], ['codex', true], ['claude-export', false], ['chatgpt-export', false]]);
  });
});

describe('Claude Code transcripts', () => {
  it('keeps user and assistant text; skips thinking, tools, meta, side chains, commands and bookkeeping, and says so', () => {
    const chat = parseClaudeTranscript(fixture('claude-code.jsonl'), false);
    expect(chat.title).toBe('Dark mode toggle');
    expect(chat.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Add a dark mode toggle to the settings page.'],
      ['assistant', 'I will look at the settings page first.\n\nDone: the toggle is in src/settings.tsx.'],
      ['user', 'Thanks. Also make it remember the choice.']
    ]);
    expect(chat.started).toBe(Date.parse('2026-10-01T09:00:00.000Z'));
    const skipped = chat.skipped.join(' | ');
    for (const s of ['thinking block', 'tool call', 'tool result', 'subagent entry', 'injected context entry', 'command or notification entry', 'attached image', 'bookkeeping entries']) expect(skipped).toContain(s);
    expect(JSON.stringify(chat.messages)).not.toMatch(/Injected context|Subagent text|private reasoning|file contents/);
  });

  it('a cut-off last line, garbage lines, an over-long line and bad UTF-8 are reported, not thrown', () => {
    const good = fixture('claude-code.jsonl').toString('utf8').trimEnd();
    const bad = Buffer.concat([
      Buffer.from('not json at all\n{"type":"user","message":{"role":"user","content":"ok é"}}\n'),
      Buffer.from([0x7b, 0x22, 0x74, 0x79, 0x70, 0x65, 0x22, 0x3a, 0x22, 0x75, 0x73, 0x65, 0x72, 0x22, 0x2c, 0x22, 0x6d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x22, 0x3a, 0x7b, 0x22, 0x72, 0x6f, 0x6c, 0x65, 0x22, 0x3a, 0x22, 0x75, 0x73, 0x65, 0x72, 0x22, 0x2c, 0x22, 0x63, 0x6f, 0x6e, 0x74, 0x65, 0x6e, 0x74, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d, 0x7d, 0x0a]),
      Buffer.from(`${good}\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"cut`)
    ]);
    const chat = parseClaudeTranscript(bad, false);
    expect(chat.messages[0]).toMatchObject({ role: 'user', text: 'ok é' });
    expect(chat.messages[1]!.text).toContain('�');
    const skipped = chat.skipped.join(' | ');
    expect(skipped).toContain('unreadable line');
    expect(skipped).toContain('invalid UTF-8');
    expect(skipped).toContain('cut-off line at the end (truncated file)');
    const skips = new Skips();
    const longLine = Buffer.from(`{"type":"user","message":{"role":"user","content":"${'x'.repeat(CHAT_LIMITS.maxLineBytes + 10)}"}}\n`);
    expect([...jsonLines(longLine, skips, false)]).toEqual([]);
    expect(skips.list()).toEqual(['1 over-long line']);
  });

  it('hostile input: deep nesting, huge messages, prototype keys and non-objects never throw', () => {
    const deep = `${'['.repeat(200_000)}${']'.repeat(200_000)}`;
    const huge = JSON.stringify({ type: 'user', message: { role: 'user', content: 'y'.repeat(CHAT_LIMITS.maxMessageChars + 50) } });
    const proto = '{"__proto__":{"polluted":1},"type":"user","message":{"role":"user","content":[{"type":"text","text":"proto ok"}]}}';
    const chat = parseClaudeTranscript(Buffer.from([deep, huge, proto, '42', 'null', '"str"', '{"type":"assistant","message":{"content":{"not":"an array"}}}'].join('\n')), false);
    expect(chat.messages.map((m) => m.text.length > CHAT_LIMITS.maxMessageChars ? 'long' : m.text)).toEqual(['long', 'proto ok']);
    expect(chat.messages[0]!.text).toContain('shortened by Harbor on import');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(chat.skipped.join(' | ')).toMatch(/unreadable line/);
  });

  it('lists session files without reading them, skips links and subfolders, reads only the chosen one', () => {
    const home = tmp();
    const proj = join(home, 'projects', 'C--Users-someone-Projects-demo');
    mkdirSync(join(proj, 'abc', 'subagents'), { recursive: true });
    writeFileSync(join(proj, 's1.jsonl'), fixture('claude-code.jsonl'));
    writeFileSync(join(proj, 'abc', 'subagents', 'agent.jsonl'), fixture('claude-code.jsonl'));
    writeFileSync(join(proj, 'notes.txt'), 'x');
    try { symlinkSync(join(proj, 's1.jsonl'), join(proj, 'link.jsonl')); } catch { /* no symlink right on this machine: the rest still runs */ }
    expect(claudeCodeSource.detect(env({ claudeHome: home })).available).toBe(true);
    expect(claudeCodeSource.detect(env({ claudeHome: tmp() })).available).toBe(false);
    const l = claudeCodeSource.preview(env({ claudeHome: home }), {});
    expect(l.entries.map((e) => e.id)).toEqual(['C--Users-someone-Projects-demo/s1.jsonl']);
    expect(l.entries[0]).toMatchObject({ detail: 's1', bytes: fixture('claude-code.jsonl').length });
    expect(claudeCodeSource.read(env(), l.entries[0]!).messages).toHaveLength(3);
  });
});

describe('Codex sessions', () => {
  it('keeps user and assistant text; skips developer instructions, injected context, reasoning and tool calls', () => {
    const chat = parseCodexSession(fixture('codex.jsonl'), false);
    expect(chat.title).toBe('Write a unit test for the parser.');
    expect(chat.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Write a unit test for the parser.'],
      ['assistant', 'Reading the parser now.\n\nAdded tests/parser.test.ts with three cases.']
    ]);
    expect(chat.started).toBe(Date.parse('2026-10-02T10:00:00.000Z'));
    const skipped = chat.skipped.join(' | ');
    for (const s of ['instruction message from Codex', 'Codex context block', 'reasoning entry', 'tool call', 'tool result', 'bookkeeping entries']) expect(skipped).toContain(s);
  });

  it('reads the older unwrapped message lines too, and a truncated file', () => {
    const old = [JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old style' }] }), JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'still read' }] }), '{"type":"response_item","payload":{"type":"mess'].join('\n');
    const chat = parseCodexSession(Buffer.from(old), true);
    expect(chat.messages.map((m) => m.text)).toEqual(['old style', 'still read']);
    expect(chat.skipped.join(' ')).toContain('the file was larger than Harbor reads');
  });

  it('lists rollout files with thread names from the session index, newest first', () => {
    const home = tmp();
    const day = join(home, 'sessions', '2026', '10', '02');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-2026-10-02T10-00-00-01a10000-aaaa-7bbb-8ccc-dddddddddddd.jsonl'), fixture('codex.jsonl'));
    writeFileSync(join(day, 'other.jsonl'), 'x');
    writeFileSync(join(home, 'session_index.jsonl'), `${JSON.stringify({ id: '01a10000-aaaa-7bbb-8ccc-dddddddddddd', thread_name: 'Parser tests', updated_at: '2026-10-02T10:00:09Z' })}\nnot json\n`);
    const l = codexSource.preview(env({ codexHome: home }), {});
    expect(l.entries.map((e) => [e.id, e.title])).toEqual([['2026/10/02/rollout-2026-10-02T10-00-00-01a10000-aaaa-7bbb-8ccc-dddddddddddd.jsonl', 'Parser tests']]);
    expect(codexSource.read(env(), l.entries[0]!).title).toBe('Parser tests');
    expect(codexSource.preview(env({ codexHome: tmp() }), {}).problems[0]).toMatch(/No Codex sessions folder/);
  });
});

describe('account exports (unverified shapes)', () => {
  it('claude.ai: text blocks, attachments and thinking counted as skipped, unknown senders and fields tolerated', () => {
    const items = JSON.parse(fixture('claude-export.json').toString('utf8')) as unknown[];
    const chat = parseClaudeExportConversation(items[0]);
    expect(chat.title).toBe('Trip planning');
    expect(chat.messages.map((m) => [m.role, m.text])).toEqual([['user', 'Plan a weekend in Lisbon.'], ['assistant', 'Day 1: Alfama. Day 2: Belem.']]);
    expect(chat.skipped.join(' | ')).toMatch(/1 attached file.*1 thinking block.*1 message from another sender|1 thinking block/);
    expect(parseClaudeExportConversation(items[1]).title).toBe('Untitled question here');
    expect(parseClaudeExportConversation('garbage').messages).toEqual([]);
  });

  it('ChatGPT: follows current_node to the root, skips hidden, system, tool and tool-call messages and other branches; survives cycles', () => {
    const items = JSON.parse(fixture('chatgpt-export.json').toString('utf8')) as unknown[];
    const chat = parseChatgptConversation(items[0]);
    expect(chat.title).toBe('Regex help');
    expect(chat.messages.map((m) => [m.role, m.text])).toEqual([['user', 'How do I match an email?'], ['assistant', 'Use a simple pattern and confirm by sending a mail.']]);
    expect(chat.started).toBe(1759300000500);
    const skipped = chat.skipped.join(' | ');
    for (const s of ['hidden message', 'tool call', 'tool message', 'message on an edited or regenerated branch']) expect(skipped).toContain(s);
    const loop = parseChatgptConversation(items[1]);
    expect(loop.messages.map((m) => m.text)).toEqual(['loop', 'back']);
  });

  it('preview reads the picked file (or the conversations.json inside an export .zip), refuses the other kind, links and garbage', () => {
    const d = tmp();
    const gpt = join(d, 'conversations.json');
    writeFileSync(gpt, fixture('chatgpt-export.json'));
    const l = chatgptExportSource.preview(env(), { path: gpt });
    expect(l.problems).toEqual([]);
    expect(l.entries.map((e) => [e.id, e.title, e.messages])).toEqual([['0', 'Regex help', 7], ['1', 'Cyclic mapping', 2]]);
    expect(chatgptExportSource.read(env(), l.entries[0]!).messages).toHaveLength(2);
    expect(claudeExportSource.preview(env(), { path: gpt }).problems[0]).toMatch(/looks like a ChatGPT export/);
    const zip = join(d, 'export.zip');
    writeFileSync(zip, writeZip([{ path: 'chat.html', data: Buffer.from('<html>') }, { path: 'conversations.json', data: fixture('claude-export.json') }, { path: 'files/image.png', data: Buffer.alloc(10) }]));
    const z = claudeExportSource.preview(env(), { path: zip });
    expect(z.entries.map((e) => e.title)).toEqual(['Trip planning', 'Untitled conversation 2']);
    writeFileSync(join(d, 'bad.json'), '[{"title": "cut');
    expect(readExportFile(join(d, 'bad.json')).problems[0]).toMatch(/not valid JSON/);
    writeFileSync(join(d, 'deep.json'), `${'['.repeat(300_000)}${']'.repeat(300_000)}`);
    // Deeply nested arrays: never thrown; parsed or refused, they hold no conversation Harbor knows.
    expect(chatgptExportSource.preview(env(), { path: join(d, 'deep.json') }).problems[0]).toMatch(/known shape|nested too deeply/);
    writeFileSync(join(d, 'obj.json'), '{"hello": 1}');
    expect(readExportFile(join(d, 'obj.json')).problems[0]).toMatch(/does not hold a list/);
    expect(readExportFile('relative.json').problems[0]).toMatch(/full path/);
    writeFileSync(join(d, 'latin1.json'), Buffer.concat([Buffer.from('[{"title":"caf'), Buffer.from([0xe9]), Buffer.from('","mapping":{}}]')]));
    const lat = readExportFile(join(d, 'latin1.json'));
    expect(lat.items).toHaveLength(1);
    expect(lat.skipped.join(' ')).toMatch(/invalid UTF-8/);
    const evil = join(d, 'evil.zip');
    // Same-length rename inside the archive bytes: offsets and checksums stay valid, the name now climbs out of the archive.
    writeFileSync(evil, Buffer.from(writeZip([{ path: 'ok.txt', data: Buffer.from('x') }]).toString('latin1').split('ok.txt').join('..\\a.t'), 'latin1'));
    expect(claudeExportSource.preview(env(), { path: evil }).problems[0]).toMatch(/leaves the archive/);
  });
});
