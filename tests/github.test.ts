import { describe, expect, it } from 'vitest';
import { GitHub, plainGhMessage } from '../src/main/github';
import type { RunResult, Runner } from '../src/main/proc';

type Call = { exe: string; args: string[]; input?: string; cwd?: string };
const ok = (stdout = '', stderr = ''): RunResult => ({ code: 0, stdout, stderr, timedOut: false });
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: '', stderr, timedOut: false });
const missing: RunResult = { code: null, stdout: '', stderr: '', timedOut: false, error: 'Error: spawn gh ENOENT' };
const LOGGED_IN = ok('', 'github.com\n  ✓ Logged in to github.com account Zemodeler (keyring)\n  - Active account: true\n');

function fake(handler: (c: Call) => RunResult): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, run: async (exe, args, o) => { const c = { exe, args, ...(o?.input !== undefined ? { input: o.input } : {}), ...(o?.cwd ? { cwd: o.cwd } : {}) }; calls.push(c); return handler(c); } };
}
const authed = (extra: (c: Call) => RunResult) => fake((c) => (c.args[0] === 'auth' ? LOGGED_IN : extra(c)));

describe('gh status', () => {
  it('reports the account and never asks for a token', async () => {
    const f = fake(() => LOGGED_IN);
    expect(await new GitHub(f.run).status()).toEqual({ installed: true, loggedIn: true, account: 'Zemodeler' });
    expect(f.calls[0]!.args.join(' ')).not.toMatch(/token|-t\b/);
  });
  it('tells missing from signed out', async () => {
    expect(await new GitHub(fake(() => missing).run).status()).toEqual({ installed: false, loggedIn: false });
    expect(await new GitHub(fake(() => fail('You are not logged into any GitHub hosts. To log in, run: gh auth login')).run).status()).toEqual({ installed: true, loggedIn: false });
  });
});

describe('gh repo create', () => {
  const draft = { name: 'my-app', visibility: 'private' as const, sourcePath: 'C:\\p\\my-app' };
  it('creates a private repo from the folder with origin, and returns the URL', async () => {
    const f = authed(() => ok('https://github.com/Zemodeler/my-app\n'));
    const r = await new GitHub(f.run).createRepo(draft);
    expect(r).toEqual({ ok: true, value: { url: 'https://github.com/Zemodeler/my-app', slug: 'my-app' } });
    const c = f.calls.find((x) => x.args[0] === 'repo')!;
    expect(c.args).toEqual(['repo', 'create', 'my-app', '--private', '--source', 'C:\\p\\my-app', '--remote', 'origin']);
    expect(c.args).not.toContain('--push');
  });
  it('uses owner/name and the public flag when asked', async () => {
    const f = authed(() => ok('https://github.com/acme/x'));
    await new GitHub(f.run).createRepo({ ...draft, name: 'x', owner: 'acme', visibility: 'public' });
    expect(f.calls.find((x) => x.args[0] === 'repo')!.args.slice(0, 4)).toEqual(['repo', 'create', 'acme/x', '--public']);
  });
  it('gives a typed outcome and a one-line fix when gh is missing or signed out', async () => {
    const a = await new GitHub(fake(() => missing).run).createRepo(draft);
    expect(a).toMatchObject({ ok: false, kind: 'needs-gh' });
    expect((a as { message: string }).message).toMatch(/winget install GitHub\.cli/);
    const b = await new GitHub(fake(() => fail('not logged in')).run).createRepo(draft);
    expect(b).toMatchObject({ ok: false, kind: 'not-logged-in' });
    expect((b as { message: string }).message).toMatch(/gh auth login/);
  });
  it('reports a taken name, and refuses bad names before running anything', async () => {
    const f = authed(() => fail('GraphQL: Name already exists on this account (createRepository)'));
    expect(await new GitHub(f.run).createRepo(draft)).toMatchObject({ ok: false, kind: 'name-taken' });
    const g = authed(() => ok());
    for (const name of ['--bad', 'a b', '..', 'x/y', '']) expect(await new GitHub(g.run).createRepo({ ...draft, name })).toMatchObject({ ok: false, kind: 'error' });
    expect(await new GitHub(g.run).createRepo({ ...draft, owner: '-x' })).toMatchObject({ ok: false });
    expect(g.calls).toEqual([]);
  });
});

describe('gh pr create', () => {
  it('sends the body on stdin, never argv, and returns the URL', async () => {
    const f = authed(() => ok('Creating pull request\nhttps://github.com/o/n/pull/7\n'));
    const body = 'Line one\n\n- secret-looking "quotes" & pipes | here';
    const r = await new GitHub(f.run).createPr({ cwd: 'C:\\p', head: 'harbor/x', base: 'main', title: 'Add x', body, draft: true });
    expect(r).toEqual({ ok: true, value: { url: 'https://github.com/o/n/pull/7' } });
    const c = f.calls.find((x) => x.args[0] === 'pr')!;
    expect(c.args).toEqual(['pr', 'create', '--head', 'harbor/x', '--base', 'main', '--title', 'Add x', '--body-file', '-', '--draft']);
    expect(c.input).toBe(body);
    expect(c.args.join(' ')).not.toContain('quotes');
  });
  it('treats an existing pull request as success and refuses odd branches', async () => {
    const f = authed(() => fail('a pull request for branch "harbor/x" into branch "main" already exists:\nhttps://github.com/o/n/pull/3'));
    expect(await new GitHub(f.run).createPr({ cwd: 'C:\\p', head: 'harbor/x', base: 'main', title: 't' })).toEqual({ ok: true, value: { url: 'https://github.com/o/n/pull/3' } });
    expect(await new GitHub(f.run).createPr({ cwd: 'C:\\p', head: '--web', base: 'main', title: 't' })).toMatchObject({ ok: false });
    expect(await new GitHub(f.run).createPr({ cwd: 'C:\\p', head: 'a', base: 'main', title: 'two\nlines' })).toMatchObject({ ok: false });
  });
});

describe('error text', () => {
  it('drops lines that look like secrets', () => {
    const msg = plainGhMessage('failed to push\nGH_TOKEN=ghp_' + 'a'.repeat(36) + '\nsecond problem');
    expect(msg).toBe('failed to push second problem');
    expect(msg).not.toMatch(/ghp_/);
  });
});
