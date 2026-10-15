import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GIT_DESTRUCTIVE_DENY, HELPER_BASH_ALLOW, claudeArgs, claudeDenyRules, isGitDestructive } from '../src/main/adapters/claude';
import { CodexAdapter, codexArgs, codexErrorMessage, parseCodexLine } from '../src/main/adapters/codex';
import { MAX_PARTIAL_LINE, streamLines } from '../src/main/adapters/stream';
import type { RunOptions } from '../src/main/adapters/types';
import { redactSecrets } from '../src/main/checks';
import { Git, isInside, staleWorktrees, statusPaths } from '../src/main/git';
import { GitView, validRepoPath } from '../src/main/gitView';
import { buildHandoff } from '../src/main/handoff';
import { LockTable, needsLock, pathsOverlap } from '../src/main/locks';
import { CappedText, quoteWinArg, runProcess, type Runner } from '../src/main/proc';
import { REVIEW_FILE_LIMIT, reviewDirectory, reviewable, splitDiffByPath } from '../src/main/review';
import { REPORT_STORE_CHARS, Store } from '../src/main/store';
import type { AgentRecord, FileLock } from '../src/main/types';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-infra-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* Windows handle */ } } });
const base: RunOptions = { cwd: '.', model: 'sonnet', effort: 'medium', permission: 'edit' };
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();
function repo(): string {
  const d = tmp();
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't');
  writeFileSync(join(d, 'README.md'), 'hi'); git(d, 'add', '.'); git(d, 'commit', '-q', '-m', 'init');
  return d;
}

describe('B1 codex', () => {
  it('every permission produces arguments the .cmd shim quoting accepts', () => {
    for (const permission of ['read-only', 'edit', 'full'] as const) {
      const args = codexArgs({ ...base, permission, model: 'gpt-x', writableDirs: ['C:\\Repo\\.git\\worktrees\\a b', 'C:\\Repo\\.git'], images: ['C:\\img\\a.png'] });
      for (const a of args) expect(() => quoteWinArg(a), a).not.toThrow();
      expect(args.some((a) => a.includes('"'))).toBe(false);
    }
  });
  it('sets sandbox, approval and writable roots without double quotes', () => {
    expect(codexArgs({ ...base, permission: 'full' })).toEqual(expect.arrayContaining(['sandbox_mode=danger-full-access', 'approval_policy=never']));
    const a = codexArgs({ ...base, writableDirs: ['C:\\r\\.git\\worktrees\\w'] });
    expect(a).toContain("sandbox_workspace_write.writable_roots=['C:\\r\\.git\\worktrees\\w']");
    // read-only never gets writable roots; unsafe directory names are dropped
    expect(codexArgs({ ...base, permission: 'read-only', writableDirs: ['x'] }).join(' ')).not.toContain('writable_roots');
    expect(codexArgs({ ...base, writableDirs: ["a'b", 'c%d'] }).join(' ')).not.toContain('writable_roots');
  });
  it('a non-fatal error event does not end the run; turn.failed does', () => {
    expect(parseCodexLine('{"type":"error","message":"reconnecting 1/5"}')).toEqual([]);
    expect(codexErrorMessage('{"type":"error","message":"reconnecting 1/5"}')).toBe('reconnecting 1/5');
    expect(parseCodexLine('{"type":"turn.failed","error":{"message":"boom"}}')[0]).toMatchObject({ kind: 'done', ok: false, error: 'boom' });
  });
  it('emits exactly one done even when events follow the terminal one', async () => {
    const d = tmp();
    const js = join(d, 'fake.js');
    writeFileSync(js, [
      'for (const e of [{type:"thread.started",thread_id:"t"},{type:"error",message:"retry"},{type:"turn.completed",usage:{}},{type:"turn.failed",error:{message:"late"}}]) console.log(JSON.stringify(e));'
    ].join('\n'));
    const exe = process.platform === 'win32' ? join(d, 'codex.cmd') : join(d, 'codex');
    if (process.platform === 'win32') writeFileSync(exe, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
    else { writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 }); }
    const chunks = [];
    for await (const c of new CodexAdapter(exe).run('hi', { ...base, cwd: d })) chunks.push(c);
    expect(chunks.filter((c) => c.kind === 'done')).toHaveLength(1);
    expect(chunks.at(-1)).toMatchObject({ kind: 'done', ok: true });
  }, 30000);
});

describe('B2 output caps', () => {
  it('CappedText keeps head and tail and flags truncation', () => {
    const c = new CappedText(100);
    for (let i = 0; i < 50; i++) c.push(`line${i}-`.padEnd(20, '.'));
    expect(c.truncated).toBe(true);
    const t = c.toString();
    expect(t.length).toBeLessThan(300);
    expect(t.startsWith('line0-')).toBe(true);
    expect(t).toContain('truncated');
    expect(t.endsWith('.')).toBe(true);
    const small = new CappedText(100); small.push('ok');
    expect(small.truncated).toBe(false); expect(small.toString()).toBe('ok');
  });
  it('runProcess caps a flood and reports it', async () => {
    const r = await runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(200000))"], { maxOutput: 1000, timeoutMs: 20000 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThan(1500);
    expect(r.code).toBe(0);
  });
  it('streamLines splits a newline-free flood instead of buffering it', async () => {
    const gen = streamLines(process.execPath, ['-e', `process.stdout.write('y'.repeat(${MAX_PARTIAL_LINE * 2 + 5}))`], { cwd: process.cwd(), input: '' });
    let n = 0, r = await gen.next();
    while (!r.done) { expect(r.value.line.length).toBeLessThanOrEqual(MAX_PARTIAL_LINE); n++; r = await gen.next(); }
    expect(n).toBeGreaterThanOrEqual(3);
  }, 30000);
  it('diffBinaryCapped drops an oversized patch and lists the files', async () => {
    const d = repo();
    writeFileSync(join(d, 'big.txt'), 'z'.repeat(5000)); git(d, 'add', '.'); git(d, 'commit', '-q', '-m', 'big');
    const g = new Git();
    const small = await g.diffBinaryCapped(d, 'HEAD~1', 'HEAD', [], 100);
    expect(small).toMatchObject({ truncated: true, files: ['big.txt'] });
    expect(small.patch).toBeUndefined();
    expect(await g.diffBinary(d, 'HEAD~1', 'HEAD')).toContain('big.txt');
  }, 30000);
});

describe('B3 git', () => {
  it('createWorktree failure leaves no branch behind and keeps a pre-existing directory', async () => {
    const d = repo(), root = tmp();
    const g = new Git();
    await expect(g.createWorktree(d, root, 'p', 'task', 'abcdef123', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).rejects.toThrow();
    expect(git(d, 'branch', '--list', 'harbor/*')).toBe('');
    const wt = await g.createWorktree(d, root, 'p', 'task', 'abcdef123');
    expect(existsSync(wt.path)).toBe(true);
    expect((await g.worktreeWritableDirs(wt.path)).length).toBe(2);
    await g.removeWorktree(d, root, wt.path, wt.branch);
  }, 60000);
  it('a timed-out worktree add is cleaned up', async () => {
    const d = repo(), root = tmp();
    const real = new Git();
    const run: Runner = async (exe, args, opts) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        await runProcess(exe, args, opts); // really creates the worktree and branch, then reports a timeout
        return { code: null, stdout: '', stderr: '', timedOut: true };
      }
      return runProcess(exe, args, opts);
    };
    await expect(new Git(run).createWorktree(d, root, 'p', 'slow', 'abcdef123')).rejects.toThrow(/timed out/);
    expect(git(d, 'branch', '--list', 'harbor/*')).toBe('');
    expect(readdirSync(join(root, 'p'))).toEqual([]);
    expect(await real.pruneWorktrees(d)).toBe(true);
  }, 60000);
  it('checkpoint commits work but leaves credential files out and says so', async () => {
    const d = repo(), root = tmp();
    const g = new Git();
    const wt = await g.createWorktree(d, root, 'p', 'cp', 'abcdef123');
    writeFileSync(join(wt.path, 'a.txt'), 'A');
    writeFileSync(join(wt.path, '.env'), 'SECRET=1');
    mkdirSync(join(wt.path, 'sub')); writeFileSync(join(wt.path, 'sub', 'id_rsa'), 'KEY'); writeFileSync(join(wt.path, 'sub', 'ok.ts'), '1');
    const cp = await g.checkpoint(wt.path, 'harbor: cp');
    expect(cp.committed).toBe(true);
    expect([...(cp.excluded ?? [])].sort()).toEqual(['.env', 'sub/id_rsa']);
    expect(git(wt.path, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort()).toEqual(['README.md', 'a.txt', 'sub/ok.ts']);
    await g.removeWorktree(d, root, wt.path, wt.branch);
  }, 60000);
  it('checkpoint reports a failed add instead of committing nothing silently', async () => {
    const run: Runner = async (_e, args) => {
      if (args[0] === 'status') return { code: 0, stdout: '?? a.txt\0', stderr: '', timedOut: false };
      if (args[0] === 'add') return { code: 128, stdout: '', stderr: 'fatal: boom', timedOut: false };
      return { code: 0, stdout: 'abc', stderr: '', timedOut: false };
    };
    expect(await new Git(run).checkpoint('/w', 'm')).toMatchObject({ committed: false, error: expect.stringContaining('boom') });
  });
  it('isDirtyDetailed tells a timeout from clean and from dirty', async () => {
    const mk = (r: Partial<{ code: number | null; stdout: string; timedOut: boolean }>): Runner => async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...r });
    expect(await new Git(mk({})).isDirtyDetailed('/x')).toEqual({ dirty: false, timedOut: false, failed: false });
    expect(await new Git(mk({ stdout: ' M a' })).isDirtyDetailed('/x')).toEqual({ dirty: true, timedOut: false, failed: false });
    expect(await new Git(mk({ code: null, timedOut: true })).isDirtyDetailed('/x')).toEqual({ dirty: true, timedOut: true, failed: false });
    expect(await new Git(mk({ code: 128 })).isDirtyDetailed('/x')).toEqual({ dirty: true, timedOut: false, failed: true });
    expect(await new Git(mk({ code: null, timedOut: true })).isDirty('/x')).toBe(true);
  });
  it('git commands carry long paths and the untracked cache through the environment, not the arguments or user config', async () => {
    let seen: { args: string[]; env?: NodeJS.ProcessEnv } | undefined;
    const run: Runner = async (_e, args, o) => { seen = { args, env: o?.env }; return { code: 0, stdout: 'abc\n', stderr: '', timedOut: false }; };
    await new Git(run).head('/x');
    expect(seen!.args).toEqual(['rev-parse', 'HEAD']);
    const env = seen!.env!;
    const keys = Object.entries(env).filter(([k]) => k.startsWith('GIT_CONFIG_KEY_')).map(([, v]) => v);
    expect(keys).toEqual(expect.arrayContaining(['core.longpaths', 'core.untrackedCache']));
  });
  it('statusPaths skips the old path of a rename', () => {
    expect(statusPaths('R  new.txt\0old.txt\0?? x.txt\0 M y.txt\0')).toEqual(['new.txt', 'x.txt', 'y.txt']);
  });
});

describe('B3 gitView and review', () => {
  it('validates paths cheaply', () => {
    for (const bad of ['', '../x', 'a/../b', '/abs', 'C:\\x', '-rf', ':(top)x', 'a\0b']) expect(validRepoPath(bad), bad).toBe(false);
    expect(validRepoPath('src/a.ts')).toBe(true);
  });
  it('diff(path) works on a real repo for tracked, untracked and credential files and rejects unrelated paths', async () => {
    const d = repo();
    writeFileSync(join(d, 'README.md'), 'changed'); writeFileSync(join(d, 'new.txt'), 'n'); writeFileSync(join(d, '.env'), 'S=1');
    const v = (await GitView.open(d))!;
    expect(await v.diff('README.md')).toContain('+changed');
    expect(await v.diff('new.txt')).toContain('+n');
    expect(await v.diff('.env')).toMatch(/hidden/);
    await expect(v.diff('nothing.txt')).rejects.toThrow(/no changes/);
    await expect(v.diff('../README.md')).rejects.toThrow();
  }, 30000);
  it('log reports a timeout instead of an empty list, pages with skip, and git concurrency is bounded', async () => {
    const d = repo();
    for (let i = 0; i < 4; i++) { writeFileSync(join(d, `f${i}`), String(i)); git(d, 'add', '.'); git(d, 'commit', '-q', '-m', `c${i}`); }
    const real = (await GitView.open(d))!;
    const p1 = await real.logPage({ limit: 2 });
    expect(p1.commits).toHaveLength(2); expect(p1.hasMore).toBe(true);
    const p2 = await real.logPage({ limit: 2, skip: 2 });
    expect(p2.commits[0]!.hash).not.toBe(p1.commits[0]!.hash);
    expect((await real.log({ limit: 100 })).length).toBe(5);

    let timeout = false, active = 0, max = 0;
    const wts = Array.from({ length: 12 }, (_, i) => `worktree /w${i}\nHEAD abc\nbranch refs/heads/b${i}\n`).join('\n');
    const run: Runner = async (_e, args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: '/top\n', stderr: '', timedOut: false };
      if (args[0] === 'worktree') return { code: 0, stdout: wts, stderr: '', timedOut: false };
      active++; max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return args[0] === 'log' && timeout ? { code: null, stdout: '', stderr: '', timedOut: true } : { code: 0, stdout: '', stderr: '', timedOut: false };
    };
    const v = (await GitView.open('/top', run))!;
    await v.worktrees();
    expect(max).toBeLessThanOrEqual(4);
    expect(max).toBeGreaterThan(1);
    timeout = true;
    const slow = await v.logPage();
    expect(slow.commits).toEqual([]);
    expect(slow.note).toMatch(/timed out/);
  }, 30000);
  it('hides the extra credential names', () => {
    for (const p of ['id_rsa', 'a/id_rsa.pub.bak', 'id_ed25519', '.npmrc', 'x/.netrc', '.git-credentials', 'vault.kdbx', 'gcp-service-account-prod.json', 'infra/terraform.tfstate', 'x.tfstate.backup', '.env.local']) expect(reviewable(p), p).toBe(false);
    for (const p of ['src/a.ts', 'package.json', 'docs/rsa.md', 'service.json']) expect(reviewable(p), p).toBe(true);
  });
  it('splits one diff by path', () => {
    const diff = 'diff --git a/a b.txt b/a b.txt\n--- a/a b.txt\n+++ b/a b.txt\n@@\n+1\ndiff --git a/c.txt b/c.txt\n+2\n';
    const m = splitDiffByPath(diff);
    expect([...m.keys()]).toEqual(['a b.txt', 'c.txt']);
    expect(m.get('c.txt')).toContain('+2');
  });
  it('review past the limit returns the first files and a note, with tracked changes from one diff', async () => {
    const d = repo();
    writeFileSync(join(d, 'README.md'), 'edited');
    for (let i = 0; i < REVIEW_FILE_LIMIT + 5; i++) writeFileSync(join(d, `n${String(i).padStart(3, '0')}.txt`), 'x');
    const calls: string[][] = [];
    const run: Runner = (exe, args, o) => { calls.push(args); return runProcess(exe, args, o); };
    const files = await reviewDirectory(d, 'Project', undefined, run);
    expect(files).toHaveLength(REVIEW_FILE_LIMIT + 1);
    expect(files.at(-1)!.path).toMatch(/more changed files not shown/);
    expect(files.find((f) => f.path === 'README.md')!.patch).toContain('+edited');
    expect(calls.filter((a) => a.includes('diff') && !a.includes('--name-only'))).toHaveLength(1);
  }, 60000);
});

describe('B3/B6 worktree retention and guards', () => {
  const root = join(tmpdir(), 'harbor-wt-root');
  it('guards resolve paths first', () => {
    expect(isInside(join(root, 'p', 'w'), root)).toBe(true);
    expect(isInside(join(root, 'p', '..', '..', 'evil'), root)).toBe(false);
    expect(isInside(root, root)).toBe(false);
    expect(isInside(root + '-other', root)).toBe(false);
  });
  it('removeWorktree refuses a path that only looks like it is inside the root', async () => {
    await expect(new Git().removeWorktree('/r', root, join(root, '..', 'elsewhere'))).rejects.toThrow(/Refusing/);
    await expect(new Git().resetHarborWorktree(root, join(root, 'a', '..', '..', 'x'), 'harbor/x', 'HEAD')).rejects.toThrow(/Refusing/);
  });
  it('staleWorktrees only picks inactive harbor/* worktrees under the root that landed or aged out', () => {
    const now = Date.now(), day = 86_400_000;
    const e = (name: string, o: object = {}) => ({ path: join(root, 'p', name), branch: `harbor/${name}`, lastActivity: now, ...o });
    const out = staleWorktrees([
      e('fresh'), e('applied', { applied: true }), e('merged', { merged: true }), e('old', { lastActivity: now - 20 * day }),
      e('busy', { applied: true, active: true }), { path: join(root, 'p', 'user'), branch: 'feature/x', lastActivity: 0, applied: true },
      { path: join(tmpdir(), 'elsewhere'), branch: 'harbor/z', lastActivity: 0, applied: true }, { path: join(root, 'p', 'nobranch'), lastActivity: 0 }
    ], root, now);
    expect(out.map((x) => x.branch)).toEqual(['harbor/applied', 'harbor/merged', 'harbor/old']);
  });
});

describe('B4 locks', () => {
  const table = () => { let l: FileLock[] = []; return new LockTable(() => l, (x) => { l = x; }); };
  it('prefix claims conflict both ways, on path boundaries only', () => {
    expect(pathsOverlap('src/', 'src/a.ts')).toBe(true);
    expect(pathsOverlap('src/a.ts', 'src')).toBe(true);
    expect(pathsOverlap('src', 'src2/a.ts')).toBe(false);
    expect(pathsOverlap('SRC\\Lib', 'src/lib/x.ts')).toBe(true);
    expect(pathsOverlap('.', 'anything')).toBe(true);
    const t = table();
    expect(t.acquire('p', 'a1', ['src/']).ok).toBe(true);
    expect(t.acquire('p', 'a2', ['src/a.ts']).conflicts).toEqual([{ file: 'src/a.ts', holder: 'a1' }]);
    expect(t.acquire('p', 'a2', ['srcx/a.ts']).ok).toBe(true);
    expect(t.acquire('p2', 'a3', ['src/a.ts']).ok).toBe(true);
    const u = table();
    u.acquire('p', 'a1', ['src/a.ts']);
    expect(u.check('p', 'a2', ['src']).length).toBe(1);
  });
  it('needsLock is false for worktree helpers and read-only runs', () => {
    expect(needsLock({ canEdit: true, worktree: '/w' })).toBe(false);
    expect(needsLock({ canEdit: true })).toBe(true);
    expect(needsLock({ canEdit: false })).toBe(false);
  });
});

describe('B5 store', () => {
  const agent = (over: Partial<AgentRecord> = {}): AgentRecord => ({
    id: 'a1', projectId: 'p1', role: 'implementer', title: 't', state: 'done', cli: 'claude', model: 'm', effort: 'low', task: 't',
    dependsOn: [], revision: 1, parentConversationId: 'c1', attempts: 0, created: 1, ...over
  });
  it('restores from the rolling backup when state.json is corrupt, keeps the quarantined file and says so', () => {
    const dir = tmp();
    const s = new Store(dir, { bakIntervalMs: 0 });
    s.upsertProject({ id: 'p1', name: 'P', path: '/p', lastOpened: 1 });
    s.flush();
    s.upsertProject({ id: 'p2', name: 'Q', path: '/q', lastOpened: 2 });
    s.flush(); // the backup now holds the state of the first flush
    writeFileSync(join(dir, 'state.json'), '{truncated');
    const r = new Store(dir);
    expect(r.listProjects().map((p) => p.id)).toContain('p1');
    expect(readdirSync(dir).some((f) => f.includes('corrupt'))).toBe(true);
    expect(r.startupNotices.join(' ')).toMatch(/restored its last backup/);
  });
  it('starts empty with a notice when state and backup are both unreadable', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'state.json'), 'x'); writeFileSync(join(dir, 'state.json.bak'), 'y');
    const r = new Store(dir);
    expect(r.listProjects()).toEqual([]);
    expect(r.startupNotices.join(' ')).toMatch(/no usable backup/);
  });
  it('a failing rename is recorded, never thrown, and recovers on the next flush', () => {
    const dir = tmp();
    const s = new Store(dir, { bakIntervalMs: 0 });
    let seen: string | undefined;
    s.onFlushError = (e) => { seen = e.message; };
    s.upsertProject({ id: 'p1', name: 'P', path: '/p', lastOpened: 1 });
    mkdirSync(join(dir, 'state.json')); // a directory in the way makes renameSync fail
    expect(() => s.flush()).not.toThrow();
    expect(s.lastFlushError?.message).toBeTruthy();
    expect(seen).toBeTruthy();
    rmSync(join(dir, 'state.json'), { recursive: true });
    s.flush();
    expect(s.lastFlushError).toBeUndefined();
    expect(new Store(dir).listProjects()).toHaveLength(1);
  });
  it('indexes messages by conversation and pages them', () => {
    const s = new Store();
    s.addConversation({ id: 'c1', projectId: 'p', title: 'T', updated: 1, agentId: 'a' });
    s.addConversation({ id: 'c2', projectId: 'p', title: 'T', updated: 1, agentId: 'a' });
    for (let i = 0; i < 10; i++) s.addMessage({ id: `m${i}`, conversationId: 'c1', role: 'user', text: `t${i}`, time: 100 + i });
    s.addMessage({ id: 'x', conversationId: 'c2', role: 'user', text: 'other', time: 1 });
    expect(s.listMessages('c1')).toHaveLength(10);
    expect(s.listMessages('c1', { limit: 3 }).map((m) => m.id)).toEqual(['m7', 'm8', 'm9']);
    expect(s.listMessages('c1', { before: 'm7', limit: 3 }).map((m) => m.id)).toEqual(['m4', 'm5', 'm6']);
    expect(s.listMessages('c1', { before: 103, limit: 10 }).map((m) => m.id)).toEqual(['m0', 'm1', 'm2']);
    expect(s.getMessage('m3')?.text).toBe('t3');
    s.removeConversation('c1');
    expect(s.listMessages('c1')).toEqual([]);
    expect(s.getMessage('m3')).toBeUndefined();
    expect(s.listMessages('c2')).toHaveLength(1);
  });
  it('prunes old usage events into an archive that keeps the totals', () => {
    const now = Date.now(), day = 86_400_000;
    const s = new Store(undefined, { now: () => now });
    const ev = (id: string, age: number) => ({ id, time: now - age * day, cli: 'claude', model: 'm', projectId: 'p1', agentId: 'a', durationMs: 1, ok: true, inputTokens: 10, outputTokens: 5, costUsd: 0.5 });
    s.addUsage(ev('old', 30)); s.addUsage(ev('new', 1));
    s.pruneUsage();
    expect(s.listUsage().map((u) => u.id)).toEqual(['new']);
    expect(s.usageArchive()).toEqual({ runs: 1, inputTokens: 10, outputTokens: 5, costUsd: 0.5 });
    expect(s.usageArchive('p1').runs).toBe(1);
    expect(s.usageArchive('other').runs).toBe(0);
  });
  it('clips long reports and moves snapshot file lists to side files, restoring them on load', () => {
    const dir = tmp();
    const s = new Store(dir);
    const long = 'R'.repeat(REPORT_STORE_CHARS * 2);
    s.upsertAgent(agent({ report: long, snapshots: [{ revision: 1, base: 'b', head: 'h', time: 1, files: [{ path: 'a.ts', status: 'added' }, { path: 'b.ts', status: 'modified' }] }] }));
    s.flush();
    const disk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    expect(disk.agents[0].report.length).toBeLessThan(REPORT_STORE_CHARS + 200);
    expect(disk.agents[0].snapshots[0].files).toEqual([]);
    expect(disk.agents[0].snapshots[0].fileCount).toBe(2);
    expect(s.getAgent('a1')!.report).toBe(long); // memory is untouched
    const r = new Store(dir);
    expect(r.getAgent('a1')!.report).toBe(long);
    expect(r.getAgent('a1')!.snapshots![0]!.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect('fileCount' in r.getAgent('a1')!.snapshots![0]!).toBe(false);
  });
  it('counts working agents per CLI', () => {
    const s = new Store();
    s.upsertAgent(agent({ id: '1', state: 'working' })); s.upsertAgent(agent({ id: '2', state: 'working', cli: 'codex' })); s.upsertAgent(agent({ id: '3', state: 'done' }));
    expect(s.runningByCli()).toEqual({ claude: 1, codex: 1 });
  });
});

describe('B6 claude helper safety', () => {
  it('helpers get the narrowed allowlist and the destructive git deny set; the lead keeps its broad allowlist', () => {
    const helper = claudeArgs(base);
    expect(helper).toContain('Bash(git status *)');
    expect(helper).toContain('Bash(npm test *)');
    for (const broad of ['Bash(git *)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)']) expect(helper).not.toContain(broad);
    const denies = helper.slice(helper.indexOf('--disallowedTools'));
    for (const rule of ['Bash(git clean *)', 'Bash(git restore *)', 'Bash(git checkout -- *)', 'Bash(git branch -D *)', 'Bash(git update-ref *)', 'Bash(git worktree *)',
      'Bash(git stash drop *)', 'Bash(git stash clear *)', 'Bash(git config *)', 'Bash(git remote *)', 'Bash(git push --force *)', 'Bash(git push -f *)', 'Bash(git -C *)']) expect(denies, rule).toContain(rule);
    expect(denies).not.toContain('Bash(git push *)');
    expect(denies).not.toContain('Bash(git merge *)'); // integrator helpers merge inside their worktree
    const lead = claudeArgs({ ...base, denyGitWrites: true });
    expect(lead).toContain('Bash(git *)');
    expect(lead).toContain('Bash(git merge *)');
    expect(lead).toContain('Bash(git clean *)');
    expect(claudeArgs({ ...base, permission: 'read-only' })).not.toContain('Bash(git clean *)');
    expect(claudeDenyRules({ ...base, permission: 'read-only' })).toEqual([]);
    expect(GIT_DESTRUCTIVE_DENY.length).toBeGreaterThan(20);
    expect(HELPER_BASH_ALLOW).toContain('Bash(git commit *)');
  });
  it('project test commands and writable dirs are opt-in extras', () => {
    const a = claudeArgs({ ...base, allowedCommands: ['pnpm test'], writableDirs: ['/repo/.git'] });
    expect(a).toContain('Bash(pnpm test *)');
    expect(a.slice(a.indexOf('--add-dir'), a.indexOf('--add-dir') + 3)).toEqual(['--add-dir', '/repo/.git', '--disallowedTools']);
  });
  it('recognises destructive git in a command line', () => {
    for (const c of ['git clean -fdx', 'cd x && git restore .', 'git checkout -- src', 'git checkout .', 'git branch -D harbor/a', 'git -C ../other status', 'git stash drop',
      'git update-ref -d refs/heads/x', 'git worktree remove x', 'git config user.name x', 'git remote add o u', 'git push --force origin main', 'git push origin main -f', 'git push origin +main', 'git push origin --delete x', 'git reset --hard HEAD~1']) expect(isGitDestructive('Bash', { command: c }), c).toBe(true);
    for (const c of ['git status', 'git diff --stat', 'git commit -m "x"', 'git log --oneline', 'git checkout -b feature', 'git branch --show-current', 'npm test', 'git push', 'git push origin main', 'git push -u origin feature', 'git push --follow-tags origin main']) expect(isGitDestructive('Bash', { command: c }), c).toBe(false);
    expect(isGitDestructive('Write', { command: 'git clean' })).toBe(false);
  });
});

describe('B6 checks output redaction', () => {
  it('redacts tokens, keys and secret assignments but keeps ordinary output', () => {
    const out = redactSecrets([
      'PASS src/a.test.ts', 'token=abc123supersecret', 'API_KEY: "sk-ABCDEFGHIJKLMNOPQRSTUV"', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'AKIAABCDEFGHIJKLMNOP', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', '3 tests passed'
    ].join('\n'));
    for (const leaked of ['abc123supersecret', 'sk-ABCDEF', 'abcdefghijklmnopqrstuvwxyz123456', 'ghp_abc', 'AKIAABCDEF', 'MIIEow']) expect(out).not.toContain(leaked);
    expect(out).toContain('PASS src/a.test.ts');
    expect(out).toContain('3 tests passed');
    expect(out).toContain('token=[redacted]');
  });
});

describe('B7 handoff budgets', () => {
  const stale = { title: 'Fix login', branch: 'harbor/fix', verdict: 'approve' as const, tested: 'aaaaaaa1111', head: 'bbbbbbb2222' };
  it('never truncates stale evidence or applied work, whatever else is long', () => {
    const text = buildHandoff({
      goal: 'g'.repeat(1000),
      decisions: Array.from({ length: 30 }, (_, n) => `decision ${n} ${'x'.repeat(300)}`),
      work: Array.from({ length: 40 }, (_, n) => ({ title: `job ${n}`, role: 'implementer', state: 'working', note: 'n'.repeat(300) })),
      evidence: [...Array.from({ length: 80 }, (_, n) => ({ title: `ok ${n}`, verdict: 'approve' as const, tested: 'c1', head: 'c1' })), stale],
      applied: ['Integrate A → main']
    });
    expect(text).toContain('STALE');
    expect(text).toContain('Fix login');
    expect(text).toContain('Integrate A → main');
    expect(text).toMatch(/more entries not shown/);
    expect(text.indexOf('Fix login')).toBeLessThan(text.indexOf('ok 0'));
    expect(text.length).toBeLessThan(6000);
  });
  it('scopes decisions to the conversation when they carry one', () => {
    const text = buildHandoff({
      conversationId: 'c1',
      decisions: ['project-wide', { text: 'mine', conversationId: 'c1' }, { text: 'theirs', conversationId: 'c2' }, { text: 'untagged ok' }],
      work: [], evidence: [], applied: []
    });
    expect(text).toContain('project-wide'); expect(text).toContain('mine'); expect(text).toContain('untagged ok');
    expect(text).not.toContain('theirs');
    expect(buildHandoff({ decisions: [{ text: 'theirs', conversationId: 'c2' }], work: [], evidence: [], applied: [] })).toContain('theirs');
  });
  it('drops old failed work but keeps recent failures and unfinished work', () => {
    const now = Date.now(), day = 86_400_000;
    const text = buildHandoff({
      now, decisions: [], evidence: [], applied: [],
      work: [
        { title: 'old failure', role: 'implementer', state: 'failed', updated: now - 3 * day },
        { title: 'fresh failure', role: 'implementer', state: 'failed', updated: now - 1000 },
        { title: 'still going', role: 'implementer', state: 'working', updated: now - 5 * day },
        { title: 'no timestamp', role: 'implementer', state: 'failed' }
      ]
    });
    expect(text).not.toContain('old failure');
    for (const t of ['fresh failure', 'still going', 'no timestamp']) expect(text).toContain(t);
  });
});

describe.skipIf(process.platform !== 'win32')('B1 codex through a real .cmd shim', () => {
  it('launches with every permission and passes the config values through intact', async () => {
    const d = tmp();
    writeFileSync(join(d, 'echo.js'), "process.stdout.write(process.argv.slice(2).join('|') + '\\n');");
    const shim = join(d, 'codex.cmd');
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0echo.js" %*\r\n`);
    for (const permission of ['read-only', 'edit', 'full'] as const) {
      const args = codexArgs({ ...base, permission, writableDirs: [join(d, 'wt dir')] });
      const r = await runProcess(shim, args, { timeoutMs: 20000 });
      expect(r.error).toBeUndefined();
      expect(r.stdout).toContain(`sandbox_mode=${permission === 'full' ? 'danger-full-access' : permission === 'edit' ? 'workspace-write' : 'read-only'}`);
      if (permission === 'edit') expect(r.stdout).toContain(`writable_roots=['${join(d, 'wt dir')}']`);
    }
  }, 60000);
});

import { spawnErrorMessage as _spawnErrorMessage } from '../src/main/proc';
describe('spawnErrorMessage', () => {
  it('names a missing working folder instead of the executable', () => {
    const m = _spawnErrorMessage({ message: 'spawn C:/x/claude.exe ENOENT', code: 'ENOENT' }, 'C:/x/claude.exe', 'C:/definitely/missing/folder');
    expect(m).toMatch(/working folder no longer exists/);
    expect(m).not.toMatch(/ENOENT/);
  });
  it('keeps the original text when the folder exists or the error differs', () => {
    expect(_spawnErrorMessage({ message: 'spawn x ENOENT', code: 'ENOENT' }, 'x', process.cwd())).toBe('spawn x ENOENT');
    expect(_spawnErrorMessage({ message: 'boom', code: 'EACCES' }, 'x', 'C:/missing')).toBe('boom');
  });
});
