import { describe, expect, it } from 'vitest';
import { claudeArgs, parseClaudeLine } from '../src/main/adapters/claude';
import { codexArgs, parseCodexLine } from '../src/main/adapters/codex';
import { FakeAdapter } from '../src/main/adapters/fake';
import type { RunOptions } from '../src/main/adapters/types';

const base: RunOptions = { cwd: '.', model: 'sonnet', effort: 'medium', permission: 'edit' };

describe('claude adapter', () => {
  it('builds headless args and blocks native subagent tools', () => {
    const a = claudeArgs({ ...base, resumeId: 'abc', systemPrompt: 'role' }, 'sp.txt');
    expect(a).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--effort', 'medium', '--resume', 'abc']));
    expect(a.join(' ')).toMatch(/--disallowedTools Task Agent/);
    expect(a.join(' ')).toMatch(/--append-system-prompt-file sp\.txt/);
    expect(a).not.toContain('role'); // never on the command line
    expect(a).not.toContain('--prompt');
  });
  it('read-only uses plan mode', () => {
    expect(claudeArgs({ ...base, permission: 'read-only' }).join(' ')).toMatch(/--permission-mode plan/);
  });
  it('parses init, assistant, tool_use, and result events', () => {
    expect(parseClaudeLine('{"type":"system","subtype":"init","session_id":"s1"}')).toEqual([{ kind: 'session', id: 's1' }]);
    const a = parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } }] } }));
    expect(a).toEqual([{ kind: 'text', text: 'hi' }, { kind: 'tool', text: 'Edit a.ts' }]);
    const r = parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's1', total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 4 } }));
    expect(r.at(-1)).toMatchObject({ kind: 'done', ok: true, text: 'ok' });
    expect(r).toContainEqual({ kind: 'usage', inputTokens: 3, outputTokens: 4, costUsd: 0.01 });
  });
  it('flags rate limits on error results', () => {
    const r = parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude usage limit reached' }));
    expect(r.at(-1)).toMatchObject({ kind: 'done', ok: false, rateLimited: true });
  });
  it('ignores garbage', () => { expect(parseClaudeLine('not json')).toEqual([]); });
});

describe('codex adapter', () => {
  it('builds exec args with stdin prompt and effort', () => {
    const a = codexArgs({ ...base, model: 'default', effort: 'high', permission: 'read-only' });
    expect(a).toEqual(['exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'model_reasoning_effort=high', '-']);
  });
  it('resume puts session id after exec', () => {
    expect(codexArgs({ ...base, resumeId: 't1' }).slice(0, 3)).toEqual(['exec', 'resume', 't1']);
  });
  it('parses thread, message, and completion', () => {
    expect(parseCodexLine('{"type":"thread.started","thread_id":"t9"}')).toEqual([{ kind: 'session', id: 't9' }]);
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}')).toEqual([{ kind: 'text', text: 'done' }]);
    expect(parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}').at(-1)).toMatchObject({ kind: 'done', ok: true });
    expect(parseCodexLine('{"type":"turn.failed","error":{"message":"rate limit exceeded"}}')[0]).toMatchObject({ ok: false, rateLimited: true });
  });
});

describe('FakeAdapter', () => {
  it('records calls, emits session and a done chunk', async () => {
    const f = new FakeAdapter('fake');
    const chunks = [];
    for await (const c of f.run('hello', base)) chunks.push(c);
    expect(f.calls).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ kind: 'session' });
    expect(chunks.at(-1)).toMatchObject({ kind: 'done', ok: true });
  });
});
