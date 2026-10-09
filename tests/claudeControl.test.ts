import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ClaudeAdapter, claudeArgs, controlError, controlResponse, isGitWrite, parseControlCancel, parseControlRequest, userMessageLine
} from '../src/main/adapters/claude';
import { streamLines } from '../src/main/adapters/stream';
import type { Chunk, RunOptions, ToolPermissionDecision, ToolPermissionRequest } from '../src/main/adapters/types';

const base: RunOptions = { cwd: '.', model: 'sonnet', effort: 'medium', permission: 'edit' };
const allow = async (): Promise<ToolPermissionDecision> => ({ allow: true });

describe('control protocol helpers', () => {
  it('parses can_use_tool requests', () => {
    const line = JSON.stringify({ type: 'control_request', request_id: 'r1', request: {
      subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu1',
      description: 'list', blocked_path: 'C:\\x', decision_reason: 'not allowed', permission_suggestions: []
    } });
    expect(parseControlRequest(line)).toEqual({ requestId: 'r1', subtype: 'can_use_tool', permission: {
      tool: 'Bash', input: { command: 'ls' }, toolUseId: 'tu1', description: 'list', blockedPath: 'C:\\x', reason: 'not allowed'
    } });
  });
  it('leaves optional fields out and reports other subtypes without a permission', () => {
    const p = parseControlRequest('{"type":"control_request","request_id":"r2","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"a"}}}');
    expect(p).toEqual({ requestId: 'r2', subtype: 'can_use_tool', permission: { tool: 'Write', input: { file_path: 'a' } } });
    expect(parseControlRequest('{"type":"control_request","request_id":"r3","request":{"subtype":"hook_callback"}}')).toEqual({ requestId: 'r3', subtype: 'hook_callback' });
  });
  it('ignores non-control lines', () => {
    expect(parseControlRequest('{"type":"assistant","message":{}}')).toBeUndefined();
    expect(parseControlRequest('garbage')).toBeUndefined();
    expect(parseControlCancel('{"type":"control_request","request_id":"r"}')).toBeUndefined();
    expect(parseControlCancel('nope')).toBeUndefined();
  });
  it('parses cancels', () => {
    expect(parseControlCancel('{"type":"control_cancel_request","request_id":"r9"}')).toBe('r9');
  });
  it('builds user lines and responses (allow echoes the original input)', () => {
    expect(JSON.parse(userMessageLine('hi\nthere'))).toEqual({ type: 'user', message: { role: 'user', content: 'hi\nthere' } });
    expect(userMessageLine('x').endsWith('\n')).toBe(true);
    const input = { command: 'rm x' };
    expect(JSON.parse(controlResponse('r1', { allow: true }, input))).toEqual(
      { type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: input } } });
    expect(JSON.parse(controlResponse('r1', { allow: false, message: 'no' }, input))).toEqual(
      { type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'deny', message: 'no' } } });
    expect(JSON.parse(controlError('r2', 'bad'))).toEqual({ type: 'control_response', response: { subtype: 'error', request_id: 'r2', error: 'bad' } });
  });
  it('recognises git writes in Bash commands only', () => {
    for (const c of ['git merge harbor/x', 'git push', 'git -C ../x rebase main', 'cd x && git reset --hard', 'git cherry-pick abc'])
      expect(isGitWrite('Bash', { command: c })).toBe(true);
    for (const c of ['git status', 'git merge-base a b', 'git log --grep=merge', 'npm push'])
      expect(isGitWrite('Bash', { command: c })).toBe(false);
    expect(isGitWrite('Write', { command: 'git push' })).toBe(false);
  });
});

describe('controlled-mode args', () => {
  const h = { onToolPermission: allow };
  it('default args are unchanged without a handler, in read-only and in auto mode', () => {
    for (const p of ['edit', 'read-only', 'full'] as const) {
      const plain = claudeArgs({ ...base, permission: p }, 'sp.txt');
      expect(plain).not.toContain('--input-format');
      expect(plain).not.toContain('--permission-prompt-tool');
      if (p !== 'edit') expect(claudeArgs({ ...base, permission: p, ...h }, 'sp.txt')).toEqual(plain);
    }
    expect(claudeArgs(base)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--effort', 'medium',
      '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(git *)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)',
      '--disallowedTools', 'Task', 'Agent']);
  });
  it('edit + handler adds stream-json input and keeps the deny rules', () => {
    const a = claudeArgs({ ...base, ...h, denyGitWrites: true });
    expect(a.slice(-4)).toEqual(['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio']);
    expect(a).toContain('Bash(git push *)');
    expect(a.slice(0, -4)).toEqual(claudeArgs({ ...base, denyGitWrites: true }));
  });
});

describe('streamLines interactive', () => {
  it('keeps stdin open until the caller ends it', async () => {
    let sink: { write(d: string): void; end(): void } | undefined;
    const script = "process.stdin.setEncoding('utf8'); process.stdin.on('data',d=>process.stdout.write(d)); process.stdin.on('end',()=>{console.log('END');process.exit(0)})";
    const gen = streamLines(process.execPath, ['-e', script], { cwd: process.cwd(), input: 'first\n', interactive: (s) => { sink = s; } });
    const lines: string[] = [];
    let r = await gen.next();
    while (!r.done) {
      lines.push(r.value.line);
      if (r.value.line === 'first') sink!.write('second\n');
      if (r.value.line === 'second') { sink!.end(); sink!.write('dropped\n'); }
      r = await gen.next();
    }
    expect(lines).toEqual(['first', 'second', 'END']);
    expect(r.value.code).toBe(0);
  });
});

// The real adapter code path against a fake `claude` that speaks the control protocol over stdin/stdout.
describe('ClaudeAdapter controlled mode (fake CLI)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harbor fakeclaude '));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const script = resolve(__dirname, 'fixtures', 'fakeClaude.cjs');
  let exe: string;
  if (process.platform === 'win32') {
    exe = join(dir, 'claude.cmd');
    writeFileSync(exe, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    exe = join(dir, 'claude');
    writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(exe, 0o755);
  }
  const adapter = new ClaudeAdapter(exe);

  async function run(scenario: string, opts: Partial<RunOptions>) {
    const chunks: Chunk[] = [];
    for await (const c of adapter.run(scenario, { ...base, cwd: dir, ...opts })) chunks.push(c);
    const dones = chunks.filter((c) => c.kind === 'done');
    expect(dones).toHaveLength(1);
    expect(chunks.at(-1)).toBe(dones[0]);
    const done = dones[0] as Extract<Chunk, { kind: 'done' }>;
    return { chunks, done, report: done.ok && done.text ? JSON.parse(done.text) as { argv: string[]; responses: any[] } : undefined };
  }

  it('allow: asks the host and returns the original input; prompt never on argv', async () => {
    const seen: ToolPermissionRequest[] = [];
    const { report, done } = await run('allow', { onToolPermission: async (req) => { seen.push(req); return { allow: true }; } });
    expect(done.ok).toBe(true);
    expect(seen).toEqual([{ tool: 'Bash', input: { command: 'rm -rf build' }, toolUseId: 'tu_req_1', description: 'run it' }]);
    expect(report!.responses).toEqual([{ subtype: 'success', request_id: 'req_1', response: { behavior: 'allow', updatedInput: { command: 'rm -rf build' } } }]);
    expect(report!.argv).toContain('--input-format');
    expect(report!.argv).not.toContain('allow');
  });

  it('deny, and a throwing handler, answer deny with a message', async () => {
    const d = await run('deny', { onToolPermission: async () => ({ allow: false, message: 'not now' }) });
    expect(d.report!.responses[0].response).toEqual({ behavior: 'deny', message: 'not now' });
    const t = await run('throw', { onToolPermission: async () => { throw new Error('boom'); } });
    expect(t.report!.responses[0].response).toMatchObject({ behavior: 'deny', message: expect.stringContaining('boom') });
  });

  it('lead runs auto-deny git writes without asking the host', async () => {
    let asked = false;
    const { report } = await run('git', { denyGitWrites: true, onToolPermission: async () => { asked = true; return { allow: true }; } });
    expect(asked).toBe(false);
    expect(report!.responses[0]).toMatchObject({ request_id: 'req_g', response: { behavior: 'deny' } });
  });

  it('unknown control subtypes get an error response', async () => {
    const { report } = await run('unknown', { onToolPermission: allow });
    expect(report!.responses).toEqual([{ subtype: 'error', request_id: 'req_u', error: expect.stringContaining('mystery') }]);
  });

  it('cancel aborts the handler signal and sends no answer', async () => {
    let aborted = false;
    const { report } = await run('cancel', {
      onToolPermission: (_req, signal) => new Promise((res) => signal.addEventListener('abort', () => { aborted = true; res({ allow: true }); }))
    });
    expect(aborted).toBe(true);
    expect(report!.responses).toEqual([]);
  });

  it('a run timeout aborts a pending question and still ends with one done', async () => {
    let aborted = false;
    const run$ = new AbortController();
    const { done } = await run('hang', {
      signal: run$.signal,
      // The "timeout" starts once the question is pending, so a slow process start cannot race it.
      onToolPermission: (_req, signal) => new Promise(() => {
        signal.addEventListener('abort', () => { aborted = true; });
        setTimeout(() => run$.abort(), 100);
      })
    });
    expect(aborted).toBe(true);
    expect(done).toMatchObject({ ok: false, error: 'stopped' });
  });

  it('a CLI exit without a result still yields exactly one done', async () => {
    const { done } = await run('noresult', { onToolPermission: allow });
    expect(done.ok).toBe(false);
  });
});
