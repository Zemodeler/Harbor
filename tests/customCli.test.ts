import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CustomCliDescriptor } from '../src/shared/api';
import { INVOKE_METHODS } from '../src/shared/ipc';
import {
  CLI_TEMPLATES, catalogEntriesOf, customEnv, customStatus, definitionOf, expandArgs, featuresOf, loadCustomClis, parseDoneTest, parseJsonPath, readJsonPath, validateDescriptor
} from '../src/main/clis/custom';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { explainNoRoute, route, type RouterInput } from '../src/main/router';
import { createHarborService } from '../src/main/service';
import { Store } from '../src/main/store';
import { UsageLedger } from '../src/main/usage';
import { FakeAdapter } from '../src/main/adapters/fake';
import type { RunOptions } from '../src/main/adapters/types';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-custom-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const SCRIPT = resolve(__dirname, 'fixtures', 'fakeCli.cjs');
const EXE = 'C:\\tools\\mycli.exe';
const ctx = (files: string[] = [EXE], otherIds: string[] = [], dirsList: string[] = []) => ({ otherIds, isFile: (p: string) => files.includes(p), isDirectory: (p: string) => dirsList.includes(p) });
const minimal = (over: Record<string, unknown> = {}) => ({ id: 'mycli', name: 'My CLI', exe: EXE, run: { args: ['--print'] }, ...over });
const problems = (raw: unknown, c = ctx()) => validateDescriptor(raw, c).problems.join(' | ');

describe('descriptor validation', () => {
  it('accepts a minimal descriptor and drops unknown fields', () => {
    const v = validateDescriptor({ ...minimal(), extra: 1, approvedHash: 'forged' }, ctx());
    expect(v.problems).toEqual([]);
    expect(v.descriptor).toEqual({ id: 'mycli', name: 'My CLI', exe: EXE, run: { args: ['--print'] } });
  });
  it('refuses a built-in id, a duplicate id and a malformed id', () => {
    expect(problems(minimal({ id: 'claude' }))).toMatch(/taken by a built-in CLI/);
    expect(problems(minimal(), ctx([EXE], ['mycli']))).toMatch(/already used by another custom CLI/);
    expect(problems(minimal({ id: 'My CLI' }))).toMatch(/lowercase letters/);
  });
  it('refuses a folder, a missing file and a relative path as exe', () => {
    expect(problems(minimal({ exe: 'C:\\tools' }), ctx([], [], ['C:\\tools']))).toMatch(/is a folder/);
    expect(problems(minimal({ exe: 'C:\\nope.exe' }))).toMatch(/not an existing file/);
    expect(problems(minimal({ exe: 'mycli.exe' }))).toMatch(/absolute path/);
  });
  it('refuses bad JSON paths and a jsonl map without text', () => {
    expect(problems(minimal({ run: { args: [], output: { format: 'jsonl', map: { text: 'message.text' } } } }))).toMatch(/map.text must be a path/);
    expect(problems(minimal({ run: { args: [], output: { format: 'jsonl', map: { text: '$.a', done: '$.type==' } } } }))).toMatch(/map.done must be a path/);
    expect(problems(minimal({ run: { args: [], output: { format: 'jsonl', map: { session: '$.s' } } } }))).toMatch(/map.text is required/);
    expect(problems(minimal({ run: { args: [], output: { format: 'xml' } } }))).toMatch(/format must be/);
  });
  it('refuses unknown or misplaced placeholders and slots', () => {
    expect(problems(minimal({ run: { args: ['--x', '{token}'] } }))).toMatch(/unknown or misplaced placeholder \{token\}/);
    expect(problems(minimal({ run: { args: ['--resume', '{sessionId}'] } }))).toMatch(/\{sessionId\}/);
    expect(problems(minimal({ run: { args: [['{imageArgs}']] } }))).toMatch(/must be a whole argument/);
    expect(problems(minimal({ run: { args: ['{promptFile}'] } }))).toMatch(/\{promptFile\}/);
    expect(problems(minimal({ run: { args: ['--p'], prompt: 'file' } }))).toMatch(/must contain \{promptFile\}/);
    expect(problems(minimal({ run: { args: [], resume: { args: ['--continue'] } } }))).toMatch(/must contain \{sessionId\}/);
    expect(problems(minimal({ run: { args: [], image: { args: ['--image'] } } }))).toMatch(/must contain \{path\}/);
    expect(problems(minimal({ run: { args: ['a\nb'] } }))).toMatch(/text on one line/);
    expect(problems(minimal({ version: { args: ['{model}'] } }))).toMatch(/placeholder/);
  });
  it('refuses locked or malformed env and bad models', () => {
    expect(problems(minimal({ run: { args: [], env: { PATH: 'C:\\evil' } } }))).toMatch(/PATH cannot be changed/);
    expect(problems(minimal({ run: { args: [], env: { 'BAD-NAME': 'x' } } }))).toMatch(/not a valid variable name/);
    expect(problems(minimal({ models: [{ id: 'm', tier: 'huge' }] }))).toMatch(/tier must be one of/);
    expect(problems(minimal({ models: [{ id: 'm', strengths: ['magic'] }] }))).toMatch(/strengths must use/);
    expect(problems(minimal({ models: [{ id: 'm' }, { id: 'm' }] }))).toMatch(/listed twice/);
    expect(problems(minimal({ run: { args: [], effort: { extreme: ['-x'] } } }))).toMatch(/unknown key "extreme"/);
  });
  it('every shipped template becomes valid once a program is filled in', () => {
    for (const t of CLI_TEMPLATES) expect(validateDescriptor({ ...t.descriptor, exe: EXE }, ctx()).problems).toEqual([]);
  });
});

describe('descriptor helpers', () => {
  it('JSON paths read own properties and array items only', () => {
    expect(parseJsonPath('$.a.b[1].c')).toEqual(['a', 'b', 1, 'c']);
    expect(parseJsonPath('a.b')).toBeUndefined();
    expect(parseJsonPath('$.a..b')).toBeUndefined();
    expect(readJsonPath({ a: { b: [0, { c: 'x' }] } }, ['a', 'b', 1, 'c'])).toBe('x');
    expect(readJsonPath({}, ['constructor'])).toBeUndefined();
    expect(parseDoneTest('$.type==result')).toEqual({ path: ['type'], equals: 'result' });
    expect(parseDoneTest('$.code==0')).toEqual({ path: ['code'], equals: 0 });
    expect(parseDoneTest('$.final')).toEqual({ path: ['final'] });
  });
  it('expandArgs drops a lone empty placeholder argument but keeps literals', () => {
    expect(expandArgs(['-p', '--model={model}', '{effort}'], { model: '', effort: 'low', cwd: 'C:\\w' })).toEqual(['-p', 'low']);
  });
  it('sign-in status follows the signed-out text first, then the exit code', () => {
    const d = { ...minimal(), status: { args: ['auth'], signedInExit: 0, signedOutPattern: 'Not Logged In' } } as CustomCliDescriptor;
    expect(customStatus(d, { code: 0, stdout: 'ok', stderr: '' })).toBe('signedIn');
    expect(customStatus(d, { code: 1, stdout: '', stderr: 'error: not logged in' })).toBe('signedOut');
    expect(customStatus(d, { code: 3, stdout: '', stderr: '' })).toBe('unknown');
    expect(customStatus({ ...d, status: { args: ['auth'], signedInExit: 0 } }, { code: 3, stdout: '', stderr: '' })).toBe('signedOut');
  });
  it('features, definition and catalog entries come from the descriptor', () => {
    const d = { ...minimal(), run: { args: [], output: { format: 'jsonl', map: { text: '$.t', session: '$.s' } }, resume: { args: ['-r', '{sessionId}'] }, image: { args: ['-i', '{path}'] } }, models: [{ id: 'fast', tier: 'cheap', strengths: ['chat'] }] } as CustomCliDescriptor;
    expect(featuresOf(d)).toEqual({ images: true, resume: true, structuredOutput: true, permissionModes: false, readOnly: false, mcp: false, nativeSkills: false, usageReadings: false });
    expect(definitionOf(d)).toMatchObject({ id: 'mycli', exe: EXE, custom: true, versionArgs: ['--version'], models: ['fast'] });
    expect(catalogEntriesOf(d)).toEqual([{ cli: 'mycli', model: 'fast', tier: 'cheap', strengths: ['chat'], note: 'custom CLI My CLI' }]);
    expect(catalogEntriesOf(minimal() as CustomCliDescriptor)[0]).toMatchObject({ model: 'default', tier: 'standard', strengths: [] });
  });
  it('customEnv keeps the allowlist (any case) and the user values, never a locked variable', () => {
    const env = customEnv({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'k', AWS_SECRET: 's' }, { MYCLI_HOME: 'x', PATH: 'evil' });
    expect(env).toEqual({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows', MYCLI_HOME: 'x' });
  });
  it('loadCustomClis drops invalid and duplicate entries with warnings, keeps a missing exe and the approval fields', () => {
    const d = tmp(), f = join(d, 'custom-clis.json');
    writeFileSync(f, JSON.stringify({ clis: [{ ...minimal(), approvedHash: 'abc', approvedAt: 5 }, minimal(), { id: 'codex', name: 'x', exe: EXE, run: { args: [] } }] }));
    const r = loadCustomClis(f, { isFile: () => false });
    expect(r.clis).toEqual([{ ...minimal(), approvedHash: 'abc', approvedAt: 5 }]);
    expect(r.warnings).toHaveLength(2);
    writeFileSync(f, '{ broken');
    expect(loadCustomClis(f, { isFile: () => true }).warnings[0]).toMatch(/not valid JSON/);
  });
});

describe('routing with custom CLIs', () => {
  const cli = (id: string, over: Partial<ResolvedCli> = {}): ResolvedCli => ({ id, name: id, installed: true, signedIn: false, authState: 'unknown', models: ['default'], ...over });
  const input = (clis: ResolvedCli[], extra: Partial<RouterInput> = {}): RouterInput => ({
    clis, ledger: new UsageLedger(new Store()), enabled: () => true, hasAdapter: () => true, load: () => 0,
    catalog: [{ cli: 'mycli', model: 'default', tier: 'standard', strengths: ['code', 'chat', 'planning', 'review'] }], ...extra
  });
  it('a custom CLI without quota readings is routable (unknown usage is neutral)', () => {
    expect(route({ role: 'implementer', complexity: 'medium', needs: ['code'] }, input([cli('mycli')]))?.cli).toBe('mycli');
  });
  it('read-only work skips a CLI that cannot keep it read-only, and says why', () => {
    const inp = input([cli('mycli')], { readOnlySafe: () => false });
    expect(route({ role: 'planner', complexity: 'medium', needs: ['planning'], readOnly: true }, inp)).toBeUndefined();
    expect(explainNoRoute({ role: 'planner', complexity: 'medium', readOnly: true }, inp)).toMatch(/has no read-only mode/);
    expect(route({ role: 'implementer', complexity: 'medium', needs: ['code'] }, inp)?.cli).toBe('mycli');
    expect(route({ role: 'reviewer', complexity: 'medium', readOnly: true }, input([cli('mycli')], { readOnlySafe: () => true }))?.cli).toBe('mycli');
  });
  it('a blocked CLI is never routed', () => {
    expect(explainNoRoute({ role: 'implementer', complexity: 'medium' }, input([cli('mycli', { blocked: 'its file changed since you approved it' })]))).toMatch(/file changed/);
  });
});

describe('service: custom CLIs', () => {
  /** A private copy of node so each test can change "the binary" without touching the real one. */
  function setup() {
    const dataDir = tmp(), bin = tmp();
    const exe = join(bin, 'fakecli.exe');
    copyFileSync(process.execPath, exe);
    const svc = createHarborService({ dataDir, worktreesRoot: join(tmp(), 'wt'), isFile: (p) => p === exe || p.startsWith(bin) });
    const descriptor = (over: Partial<CustomCliDescriptor['run']> = {}, extra: Partial<CustomCliDescriptor> = {}): CustomCliDescriptor => ({
      id: 'fakecli', name: 'Fake CLI', exe, version: { args: [SCRIPT, '--mode', 'version'] },
      run: { args: [SCRIPT, '--mode', 'answer'], ...over }, models: [{ id: 'default', tier: 'standard', strengths: ['chat', 'code'] }], ...extra
    });
    return { svc, exe, dataDir, descriptor };
  }

  it('exposes the methods over IPC', () => {
    for (const m of ['listCustomClis', 'listCliTemplates', 'dryRunCustomCli', 'saveCustomCli', 'removeCustomCli']) expect(INVOKE_METHODS).toContain(m);
  });

  it('dry run lists problems without running anything, and needs the explicit OK for the path', async () => {
    const { svc, exe, descriptor } = setup();
    const bad = await svc.dryRunCustomCli!({ ...descriptor(), id: 'claude' }, { confirmExe: exe });
    expect(bad.ok).toBe(false);
    expect(bad.steps).toEqual([]);
    expect(bad.problems!.join(' ')).toMatch(/built-in/);
    await expect(svc.dryRunCustomCli!(descriptor(), { confirmExe: 'C:\\other.exe' })).rejects.toThrow(/Confirm that Harbor may run/);
    await svc.shutdown();
  });

  it('dry run shows version, raw output and what Harbor parsed; saves nothing', async () => {
    const { svc, exe, descriptor } = setup();
    const r = await svc.dryRunCustomCli!(descriptor({ args: [SCRIPT, '--mode', 'jsonl'], output: { format: 'jsonl', map: { text: '$.text', session: '$.session_id', done: '$.type==result', usage: { input: '$.usage.in', output: '$.usage.out' } } } }), { confirmExe: exe.toUpperCase() });
    expect(r).toMatchObject({ ok: true, version: '1.2.3', parsed: { text: 'Hello\n\nOK', sessionId: 'sess-42', inputTokens: 120, outputTokens: 7, ok: true } });
    expect(r.steps.map((s) => s.name)).toEqual(['version', 'prompt']);
    expect(r.steps[1]!.stdout).toContain('not json at all');
    expect(await svc.listCustomClis!()).toEqual([]);
    await svc.shutdown();
  });

  it('save approves the file by hash, persists it, joins discovery with features; a changed file is blocked and never run', async () => {
    const { svc, exe, dataDir, descriptor } = setup();
    await expect(svc.saveCustomCli!(descriptor(), { confirmExe: '' })).rejects.toThrow(/Confirm/);
    const saved = await svc.saveCustomCli!(descriptor(), { confirmExe: exe });
    expect(saved[0]!.approvedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(readFileSync(join(dataDir, 'custom-clis.json'), 'utf8')).clis[0].id).toBe('fakecli');
    const status = (await svc.listClis()).find((c) => c.id === 'fakecli');
    expect(status).toMatchObject({ installed: true, version: '1.2.3', custom: true, authState: 'unknown', features: { readOnly: false, resume: false } });
    await expect(svc.saveCustomCli!(descriptor(), { confirmExe: exe })).rejects.toThrow(/already used/);
    await expect(svc.setSettings({ cliPaths: { fakecli: exe } })).rejects.toThrow(/custom CLI/);

    appendFileSync(exe, 'tampered');
    const changed = (await svc.refreshClis()).find((c) => c.id === 'fakecli');
    expect(changed!.note).toMatch(/file changed since you approved it/);
    expect(changed!.version).toBeUndefined(); // not even asked for its version
    await expect(svc.openLogin('fakecli')).rejects.toThrow(/will not run/);

    await svc.saveCustomCli!(descriptor(), { confirmExe: exe, replace: true }); // approving again
    expect((await svc.listClis()).find((c) => c.id === 'fakecli')).toMatchObject({ version: '1.2.3' });
    expect(await svc.removeCustomCli!('fakecli')).toEqual([]);
    expect((await svc.listClis()).some((c) => c.id === 'fakecli')).toBe(false);
    await svc.shutdown();
  });

  it('a saved custom CLI answers through the generic adapter (the concierge runs in a neutral folder, so no read-only mode is needed)', async () => {
    const { svc, exe, descriptor } = setup();
    await svc.saveCustomCli!(descriptor(), { confirmExe: exe });
    const project = (await svc.addProject(tmp()))!;
    const [conv] = await svc.listConversations(project.id);
    await svc.send(conv!.id, 'hello there');
    await svc.whenIdle(15000);
    const msgs = await svc.listMessages(conv!.id);
    expect(msgs.some((m) => m.role === 'assistant' && m.text.includes('Hi from fakecli') && m.details?.cli === 'fakecli')).toBe(true);
    await svc.shutdown();
  }, 30000);

  it('plan mode (read-only lead) refuses a custom CLI without a read-only mode until the user accepts the risk', async () => {
    const dataDir = tmp(), bin = tmp(), exe = join(bin, 'fakecli.exe');
    copyFileSync(process.execPath, exe);
    const runs: RunOptions[] = [];
    const fake = new FakeAdapter('fakecli', (_p, o) => { runs.push(o); return o.lean ? [{ kind: 'text', text: JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }) }] : [{ kind: 'text', text: 'Plan: nothing to change.' }]; });
    const svc = createHarborService({ dataDir, worktreesRoot: join(tmp(), 'wt'), isFile: (p) => p === exe, adapterFor: (id) => (id === 'fakecli' ? fake : undefined) });
    const d: CustomCliDescriptor = { id: 'fakecli', name: 'Fake CLI', exe, version: { args: [SCRIPT, '--mode', 'version'] }, run: { args: [] }, models: [{ id: 'default', tier: 'standard', strengths: ['chat', 'code', 'planning'] }] };
    await svc.saveCustomCli!(d, { confirmExe: exe });
    const project = (await svc.addProject(tmp()))!;
    const [conv] = await svc.listConversations(project.id);
    await svc.setConversationMode(conv!.id, 'plan');
    await svc.send(conv!.id, 'plan the refactor of the parser module');
    await svc.whenIdle(15000);
    expect((await svc.listMessages(conv!.id)).map((m) => m.text).join('\n')).toMatch(/has no read-only mode/);
    expect(runs.some((o) => o.permission === 'read-only' && !o.lean)).toBe(false);

    await svc.saveCustomCli!({ ...d, acceptReadOnlyRisk: true }, { confirmExe: exe, replace: true });
    await svc.send(conv!.id, 'plan the refactor of the parser module');
    await svc.whenIdle(15000);
    expect(runs.some((o) => o.permission === 'read-only' && !o.lean)).toBe(true);
    await svc.shutdown();
  }, 30000);

  it('a project folder cannot add a CLI: only the data folder file is read', async () => {
    const { exe } = setup();
    const project = tmp();
    writeFileSync(join(project, 'custom-clis.json'), JSON.stringify({ clis: [{ id: 'evil', name: 'Evil', exe, run: { args: [] } }] }));
    const svc = createHarborService({ dataDir: tmp(), worktreesRoot: join(tmp(), 'wt'), isFile: (p) => p === exe });
    await svc.addProject(project);
    expect(await svc.listCustomClis!()).toEqual([]);
    expect((await svc.listClis()).some((c) => c.id === 'evil')).toBe(false);
    await svc.shutdown();
  });
});
