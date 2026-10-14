import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cliPathProblem, findExecutable, resolveCli, type DiscoveryDeps } from '../src/main/clis/discovery';
import { CLI_DEFINITIONS } from '../src/main/clis/registry';
import type { RunResult, Runner } from '../src/main/proc';
import { createHarborService } from '../src/main/service';
import { Store, normalizeSettingsPatch } from '../src/main/store';
import { INVOKE_METHODS } from '../src/shared/ipc';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-clipath-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const ok = (stdout: string, code = 0): RunResult => ({ code, stdout, stderr: '', timedOut: false });
const BIN = join('C:\\', 'bin');
const claude = CLI_DEFINITIONS.find((d) => d.id === 'claude')!;

function deps(files: string[], extra: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
  return {
    env: { PATH: BIN }, platform: 'win32', definitions: CLI_DEFINITIONS, isFile: (p) => files.includes(p),
    run: async (exe, args) => (args[0] === '--version' ? ok(`${exe === join(BIN, 'claude.exe') ? '1.0.0' : '2.0.0'} (Claude Code)`) : ok('{"loggedIn":true}')),
    ...extra
  };
}

describe('findExecutable precedence: Settings path > env var > PATH', () => {
  const onPath = join(BIN, 'claude.exe'), fromEnv = 'C:\\env\\claude.exe', chosen = 'C:\\chosen\\claude.cmd';
  it('the Settings path wins over the env var and PATH', () => {
    const d = deps([onPath, fromEnv, chosen], { env: { PATH: BIN, HARBOR_CLAUDE_PATH: fromEnv }, cliPaths: { claude: chosen } });
    expect(findExecutable(claude, d)).toBe(chosen);
  });
  it('the env var wins over PATH when no Settings path is set', () => {
    expect(findExecutable(claude, deps([onPath, fromEnv], { env: { PATH: [BIN].join(delimiter), HARBOR_CLAUDE_PATH: fromEnv } }))).toBe(fromEnv);
  });
  it('a Settings path for another CLI does not apply', () => {
    expect(findExecutable(claude, deps([onPath, chosen], { cliPaths: { codex: chosen } }))).toBe(onPath);
  });
  it('a Settings path that is gone falls back and says so in the note', async () => {
    const r = await resolveCli(claude, deps([onPath], { cliPaths: { claude: chosen } }));
    expect(r).toMatchObject({ installed: true, path: onPath, version: '1.0.0' });
    expect(r.note).toContain(`not an existing file: ${chosen}`);
    const none = await resolveCli(claude, deps([], { cliPaths: { claude: chosen } }));
    expect(none.installed).toBe(false);
    expect(none.note).toMatch(/^The path set in Settings is not an existing file/);
  });
});

describe('Settings.cliPaths validation and merge', () => {
  it('rejects relative paths, quotes, % and non-text', () => {
    expect(cliPathProblem('C:\\tools\\x.exe')).toBeUndefined();
    expect(cliPathProblem('tools\\x.exe')).toMatch(/absolute/);
    expect(cliPathProblem('C:\\"x".exe')).toMatch(/quote/);
    expect(cliPathProblem('C:\\%PATH%\\x.exe')).toMatch(/quote, %/);
    expect(() => normalizeSettingsPatch({ cliPaths: { claude: 'x.exe' } })).toThrow(/cliPaths.claude must be an absolute path/);
    expect(() => normalizeSettingsPatch({ cliPaths: 'C:\\x.exe' as never })).toThrow(/cliPaths must map/);
    expect(() => normalizeSettingsPatch({ cliPaths: { claude: 5 as never } })).toThrow(/must be text/);
  });
  it('merges per CLI; an empty value removes one; the last removal drops the field', () => {
    const s = new Store();
    s.setSettings({ cliPaths: { claude: ' C:\\a\\claude.exe ', codex: 'C:\\b\\codex.cmd' } });
    expect(s.getSettings().cliPaths).toEqual({ claude: 'C:\\a\\claude.exe', codex: 'C:\\b\\codex.cmd' });
    s.setSettings({ cliPaths: { claude: '' } });
    expect(s.getSettings().cliPaths).toEqual({ codex: 'C:\\b\\codex.cmd' });
    s.setSettings({ cliPaths: { codex: undefined as never } });
    expect('cliPaths' in s.getSettings()).toBe(false);
  });
});

describe('service: testCliPath, browseCliPath and saving a path', () => {
  const runner = (calls: string[]): Runner => async (exe, args) => {
    calls.push(`${exe} ${args.join(' ')}`);
    return args[0] === '--version' ? ok('3.1.4 (Claude Code)') : ok('{"loggedIn":false}');
  };

  it('is exposed over IPC', () => {
    expect(INVOKE_METHODS).toContain('testCliPath');
    expect(INVOKE_METHODS).toContain('browseCliPath');
  });

  it('testCliPath runs version and status on the given file without saving it', async () => {
    const exe = join(tmp(), 'claude.cmd'); writeFileSync(exe, '@echo off\r\n');
    const calls: string[] = [];
    const svc = createHarborService({ discover: async () => [], cliRunner: runner(calls) });
    const r = await svc.testCliPath!('claude', exe);
    expect(r).toMatchObject({ id: 'claude', installed: true, version: '3.1.4', authState: 'signedOut' });
    expect(calls).toEqual([`${exe} --version`, `${exe} auth status --json`]);
    expect((await svc.getSettings()).cliPaths).toBeUndefined();
  });

  it('testCliPath refuses a missing file, a directory, a relative path and an unknown CLI', async () => {
    const calls: string[] = [];
    const svc = createHarborService({ discover: async () => [], cliRunner: runner(calls) });
    const dir = tmp();
    await expect(svc.testCliPath!('claude', join(dir, 'nope.exe'))).rejects.toThrow(/not an existing file/);
    await expect(svc.testCliPath!('claude', dir)).rejects.toThrow(/not an existing file/);
    await expect(svc.testCliPath!('claude', 'claude.exe')).rejects.toThrow(/absolute path/);
    await expect(svc.testCliPath!('mystery', join(dir, 'x.exe'))).rejects.toThrow(/Unknown CLI/);
    expect(calls).toEqual([]);
  });

  it('setSettings rejects a path that is not a file and re-runs discovery when a path is saved', async () => {
    const exe = join(tmp(), 'codex.exe'); writeFileSync(exe, '');
    let discovered = 0;
    const svc = createHarborService({ discover: async () => { discovered++; return []; } });
    await svc.listClis();
    const before = discovered;
    await expect(svc.setSettings({ cliPaths: { codex: join(tmp(), 'missing.exe') } })).rejects.toThrow(/not an existing file/);
    expect((await svc.getSettings()).cliPaths).toBeUndefined();
    expect(discovered).toBe(before);
    expect((await svc.setSettings({ cliPaths: { codex: exe } })).cliPaths).toEqual({ codex: exe });
    expect(discovered).toBe(before + 1);
    expect('cliPaths' in await svc.setSettings({ cliPaths: { codex: '' } })).toBe(false);
  });

  it('default discovery reads the saved path', async () => {
    const dir = tmp(), exe = join(dir, 'gemini.exe'); writeFileSync(exe, '');
    const calls: string[] = [];
    const svc = createHarborService({ dataDir: dir, cliRunner: runner(calls), isFile: (p) => p === exe });
    await svc.setSettings({ cliPaths: { gemini: exe } });
    const gemini = (await svc.listClis()).find((c) => c.id === 'gemini');
    expect(gemini).toMatchObject({ installed: true, version: '3.1.4' });
    expect(calls).toContain(`${exe} --version`);
    await svc.shutdown();
  });

  it('browseCliPath uses the injected picker and returns null when cancelled', async () => {
    const picks = ['C:\\tools\\x.exe', undefined];
    const svc = createHarborService({ discover: async () => [], pickFile: async () => picks.shift() });
    expect(await svc.browseCliPath!()).toBe('C:\\tools\\x.exe');
    expect(await svc.browseCliPath!()).toBeNull();
    await expect(createHarborService({ discover: async () => [] }).browseCliPath!()).rejects.toThrow(/desktop app/);
  });
});
