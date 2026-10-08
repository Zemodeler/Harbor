import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverClis, findExecutable, resolveCli, type DiscoveryDeps } from '../src/main/clis/discovery';
import { CLI_DEFINITIONS } from '../src/main/clis/registry';
import type { RunResult } from '../src/main/proc';

const ok = (stdout: string, code = 0): RunResult => ({ code, stdout, stderr: '', timedOut: false });
const BIN = join('/opt', 'bin'), TOOLS = join('/opt', 'tools');

function deps(files: string[], responses: Record<string, RunResult>): DiscoveryDeps {
  return {
    env: { PATH: [BIN, TOOLS].join(delimiter) }, platform: 'win32', definitions: CLI_DEFINITIONS,
    isFile: (p) => files.includes(p),
    run: async (exe, args) => responses[`${exe} ${args.join(' ')}`] ?? { code: 1, stdout: '', stderr: 'unexpected', timedOut: false }
  };
}

describe('CLI discovery', () => {
  const [claude, codex, gemini] = CLI_DEFINITIONS;

  it('prefers .exe over .cmd and honours PATH order', () => {
    const d = deps([join(TOOLS, 'claude.cmd'), join(BIN, 'claude.cmd'), join(BIN, 'claude.exe')], {});
    expect(findExecutable(claude, d)).toBe(join(BIN, 'claude.exe'));
  });

  it('env override wins', () => {
    const custom = join('/custom', 'claude.exe');
    const d = deps([custom, join(BIN, 'claude.exe')], {});
    d.env = { ...d.env, HARBOR_CLAUDE_PATH: custom };
    expect(findExecutable(claude, d)).toBe(custom);
  });

  it('reports not installed', async () => {
    const r = await resolveCli(claude, deps([], {}));
    expect(r).toMatchObject({ installed: false, signedIn: false });
  });

  it('claude signed in via auth status json', async () => {
    const p = join(BIN, 'claude.exe');
    const r = await resolveCli(claude, deps([p], {
      [`${p} --version`]: ok('2.1.293 (Claude Code)'),
      [`${p} auth status --json`]: ok('{"loggedIn":true}')
    }));
    expect(r).toMatchObject({ installed: true, version: '2.1.293', signedIn: true, authState: 'signedIn' });
  });

  it('claude logged out is distinct from unknown', async () => {
    const p = join(BIN, 'claude.exe');
    const out = await resolveCli(claude, deps([p], { [`${p} --version`]: ok('2.1.0'), [`${p} auth status --json`]: ok('{"loggedIn":false}') }));
    expect(out.authState).toBe('signedOut');
    const unk = await resolveCli(claude, deps([p], { [`${p} --version`]: ok('2.1.0'), [`${p} auth status --json`]: ok('garbage') }));
    expect(unk.authState).toBe('unknown');
    expect(unk.note).toMatch(/could not be determined/);
  });

  it('codex login status parsing', async () => {
    const p = join(BIN, 'codex.exe');
    const base = { [`${p} --version`]: ok('codex-cli 0.5.0') };
    expect((await resolveCli(codex, deps([p], { ...base, [`${p} login status`]: ok('Logged in using ChatGPT') }))).authState).toBe('signedIn');
    expect((await resolveCli(codex, deps([p], { ...base, [`${p} login status`]: { code: 1, stdout: '', stderr: 'Not logged in', timedOut: false } }))).authState).toBe('signedOut');
  });

  it('gemini has no status check: unknown with a note', async () => {
    const p = join(BIN, 'gemini.cmd');
    const r = await resolveCli(gemini, deps([p], { [`${p} --version`]: ok('0.9.1') }));
    expect(r).toMatchObject({ installed: true, signedIn: false, authState: 'unknown' });
    expect(r.note).toMatch(/no non-interactive/i);
  });

  it('discoverClis covers every definition', async () => {
    expect(await discoverClis(deps([], {}))).toHaveLength(CLI_DEFINITIONS.length);
  });
});
