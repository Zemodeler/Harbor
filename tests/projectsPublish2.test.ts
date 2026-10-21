import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pushTagArgs, tagNameProblem } from '../src/main/git';
import { failedRunIds, parsePrStatus, runIdOfLink } from '../src/main/github';
import { suggestNextTag } from '../src/main/pullRequests';
import { INVOKE_METHODS } from '../src/shared/ipc';
import { METHOD_SCOPE, scopeAllows } from '../src/main/remote/scopes';
import { validateInvoke } from '../src/main/ipcValidate';
import type { RunResult } from '../src/main/proc';
import { fakeGh, ok, setup, sh, temp } from './projects2Harness';

// B5: PR status, re-run failed checks, merge a PR, release tags (contract 0.1.56-0.1.59). gh is a recording fake; git is real with a local bare origin.
const PR_URL = 'https://github.com/Zemodeler/demo/pull/12';
const run = (id: number) => `https://github.com/Zemodeler/demo/actions/runs/${id}/job/9${id}`;
const view = (o: Record<string, unknown> = {}) => JSON.stringify({ number: 12, title: 'Add account page', url: PR_URL, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', baseRefName: 'main', headRefName: 'harbor/x', ...o });
const checks = (...c: Array<[string, string, string?]>) => JSON.stringify(c.map(([name, bucket, link]) => ({ name, bucket, workflow: 'CI', ...(link ? { link } : {}) })));
const GREEN = checks(['build', 'pass', run(100)], ['test', 'pass', run(100)]);
const FAILING = checks(['build', 'pass', run(100)], ['test', 'fail', run(100)], ['lint', 'fail', run(200)], ['deploy-check', 'fail', 'https://ci.example.com/job/1']);

/** A gh that answers pr view / pr checks / run rerun / pr merge from mutable state. */
function prGh(state: { view?: string; checks?: string; viewFails?: RunResult; mergeFails?: RunResult } = {}) {
  const st = { view: view(), checks: GREEN, ...state };
  const g = fakeGh({
    'pr view': () => st.viewFails ?? ok(st.view),
    'pr checks': () => ({ code: 1, stdout: st.checks, stderr: '', timedOut: false }), // gh exits non-zero while checks fail but still prints the JSON
    'run rerun': () => ok(''),
    'pr merge': () => st.mergeFails ?? ok(`Merged ${PR_URL}\n`)
  });
  return { ...g, st, count: (a: string, b: string) => g.calls.filter((c) => c.args[0] === a && c.args[1] === b) };
}
async function project(gh = prGh()) {
  const s = setup({}, gh);
  const r = await s.service.createProject({ name: 'Demo' });
  return { ...s, r, gh };
}

describe('B5 contract wiring', () => {
  it('lists the methods for IPC, never remotely, and validates the shapes', () => {
    for (const m of ['getPullRequestStatus', 'rerunFailedChecks', 'mergePullRequest', 'previewReleaseTag', 'createReleaseTag'] as const) {
      expect(INVOKE_METHODS).toContain(m); expect(METHOD_SCOPE[m]).toBe('never');
      for (const sc of ['read-only', 'answer-permissions', 'full'] as const) expect(scopeAllows(sc, m)).toBe(false);
    }
    expect(() => validateInvoke('getPullRequestStatus', ['p', 'harbor/x'])).not.toThrow();
    for (const bad of [['p'], ['p', '--help'], ['p', ''], ['', 'b']]) { expect(() => validateInvoke('getPullRequestStatus', bad), JSON.stringify(bad)).toThrow(); expect(() => validateInvoke('rerunFailedChecks', bad), JSON.stringify(bad)).toThrow(); }
    expect(() => validateInvoke('mergePullRequest', ['p', { branch: 'b', number: 12, confirmNumber: 12, method: 'squash', overrideChecks: false }])).not.toThrow();
    for (const bad of [['p', null], ['p', { branch: 'b', number: 12, confirmNumber: 12, method: 'force' }], ['p', { branch: 'b', number: 0, confirmNumber: 0, method: 'merge' }], ['p', { branch: 'b', number: 12, method: 'merge' }], ['p', { branch: '-x', number: 1, confirmNumber: 1, method: 'merge' }], ['p', { branch: 'b', number: 1, confirmNumber: 1, method: 'merge', overrideChecks: 'yes' }]]) expect(() => validateInvoke('mergePullRequest', bad), JSON.stringify(bad)).toThrow();
    expect(() => validateInvoke('createReleaseTag', ['p', { name: 'v1.0.0', message: 'x', ref: 'main', push: true }])).not.toThrow();
    for (const bad of [['p', { name: '-f' }], ['p', { name: 'a b' }], ['p', {}], ['p', { name: 'v1', push: 'yes' }], ['p', { name: 'v1', ref: '-x' }]]) expect(() => validateInvoke('createReleaseTag', bad), JSON.stringify(bad)).toThrow();
  });
});

describe('B5 parsePrStatus (pure)', () => {
  it('a green open pull request can be merged', () => {
    const s = parsePrStatus(view(), GREEN)!;
    expect(s).toMatchObject({ number: 12, state: 'open', mergeable: 'mergeable', canMerge: true, canRerun: false, blockers: [], checksOverridable: false });
    expect(s.checks).toMatchObject({ total: 2, passing: 2, failing: 0, pending: 0 });
  });
  it('failing and pending checks block but can be overridden; failed workflow runs can be re-run', () => {
    const s = parsePrStatus(view(), checks(['a', 'fail', run(1)], ['b', 'pending', run(2)], ['c', 'skipping']))!;
    expect(s).toMatchObject({ canMerge: false, checksOverridable: true, canRerun: true });
    expect(s.blockers.join(' ')).toMatch(/1 check is failing.*1 check is still running/);
    expect(s.checks).toMatchObject({ failing: 1, pending: 1, skipped: 1 });
  });
  it('conflicts, drafts, merged or closed, protection and reviews are never overridable', () => {
    const hard = (o: Record<string, unknown>) => parsePrStatus(view(o), checks(['t', 'fail', run(1)]))!;
    for (const o of [{ mergeable: 'CONFLICTING' }, { mergeStateStatus: 'DIRTY' }, { isDraft: true }, { state: 'MERGED' }, { state: 'CLOSED' }, { mergeStateStatus: 'BEHIND' }, { reviewDecision: 'CHANGES_REQUESTED' }, { reviewDecision: 'REVIEW_REQUIRED' }]) {
      const s = hard(o); expect(s.checksOverridable, JSON.stringify(o)).toBe(false); expect(s.canMerge).toBe(false);
    }
    expect(parsePrStatus(view({ mergeStateStatus: 'BLOCKED' }), GREEN)!.blockers.join(' ')).toMatch(/Branch protection/);
  });
  it('is defensive about odd output', () => {
    expect(parsePrStatus('not json', '[]')).toBeUndefined();
    expect(parsePrStatus('{}', '[]')).toBeUndefined();
    expect(parsePrStatus(view({ url: 'file:///C:/x' }), '[]')).toBeUndefined();
    expect(parsePrStatus(view(), "no checks reported on the 'x' branch")!.checks.total).toBe(0);
    expect(parsePrStatus(view(), checks(['a', 'weird-bucket']))!.checks.items[0]!.bucket).toBe('pending');
    expect(runIdOfLink('https://github.com/o/r/actions/runs/123/job/4')).toBe('123');
    expect(runIdOfLink('https://ci.example.com/job/1')).toBeUndefined();
    expect(failedRunIds([{ name: 'a', bucket: 'fail', link: run(5) }, { name: 'b', bucket: 'fail', link: run(5) }, { name: 'c', bucket: 'pass', link: run(6) }])).toEqual(['5']);
  });
});

describe('B5 pull request status and re-run', () => {
  it('reads the PR and its checks through gh, with the branch as its own argument', async () => {
    const { service, r, gh } = await project(prGh({ checks: FAILING }));
    const s = (await service.getPullRequestStatus(r.project.id, 'harbor/x'))!;
    expect(s).toMatchObject({ number: 12, canRerun: true, canMerge: false, checksOverridable: true });
    const v = gh.count('pr', 'view')[0]!.args;
    expect(v.slice(0, 3)).toEqual(['pr', 'view', 'harbor/x']);
    expect(v).toContain('--json');
    expect(gh.count('pr', 'checks')[0]!.args.slice(0, 3)).toEqual(['pr', 'checks', 'harbor/x']);
    expect(gh.calls.some((c) => c.args.includes('merge') || c.args.includes('rerun'))).toBe(false); // read-only
  });
  it('null when the branch has no pull request; the fix when gh is missing; no odd branch names', async () => {
    const { service, r, gh } = await project(prGh({ viewFails: { code: 1, stdout: '', stderr: 'no pull requests found for branch "harbor/y"', timedOut: false } }));
    expect(await service.getPullRequestStatus(r.project.id, 'harbor/y')).toBeNull();
    await expect(service.getPullRequestStatus(r.project.id, '--repo=evil')).rejects.toThrow(/Choose a branch/);
    expect(gh.count('pr', 'view')).toHaveLength(1);
    const missing = setup({}, fakeGh({}, { missing: true }));
    const m = await missing.service.createProject({ name: 'NoGh' });
    await expect(missing.service.getPullRequestStatus(m.project.id, 'b')).rejects.toThrow(/winget install GitHub.cli/);
  });
  it('re-runs each failed workflow run once, from ids GitHub reported', async () => {
    const { service, r, gh } = await project(prGh({ checks: FAILING }));
    expect(await service.rerunFailedChecks(r.project.id, 'harbor/x')).toEqual({ rerun: 2 });
    expect(gh.count('run', 'rerun').map((c) => c.args)).toEqual([['run', 'rerun', '100', '--failed'], ['run', 'rerun', '200', '--failed']]);
  });
  it('refuses to re-run when nothing failed, the failure has no run, or the PR is closed', async () => {
    const a = await project(prGh({ checks: GREEN }));
    await expect(a.service.rerunFailedChecks(a.r.project.id, 'harbor/x')).rejects.toThrow(/No failed check/);
    const b = await project(prGh({ checks: checks(['ext', 'fail', 'https://ci.example.com/1']) }));
    await expect(b.service.rerunFailedChecks(b.r.project.id, 'harbor/x')).rejects.toThrow(/No failed check/);
    const c = await project(prGh({ view: view({ state: 'CLOSED' }), checks: FAILING }));
    await expect(c.service.rerunFailedChecks(c.r.project.id, 'harbor/x')).rejects.toThrow(/already closed/);
    const d = await project(prGh({ view: view(), checks: FAILING, viewFails: { code: 1, stdout: '', stderr: 'no pull requests found', timedOut: false } }));
    await expect(d.service.rerunFailedChecks(d.r.project.id, 'harbor/x')).rejects.toThrow(/no pull request/);
    for (const x of [a, b, c, d]) expect(x.gh.count('run', 'rerun')).toHaveLength(0);
  });
});

describe('B5 merge a pull request', () => {
  const merge = (method: 'merge' | 'squash' | 'rebase' = 'squash', extra: Record<string, unknown> = {}) => ({ branch: 'harbor/x', number: 12, confirmNumber: 12, method, ...extra });
  it('merges a green PR with the chosen method, never --admin, --auto or --delete-branch, and records it', async () => {
    for (const [method, flag] of [['merge', '--merge'], ['squash', '--squash'], ['rebase', '--rebase']] as const) {
      const { service, r, gh } = await project();
      const out = await service.mergePullRequest(r.project.id, merge(method));
      expect(out).toMatchObject({ merged: true, url: PR_URL });
      expect(gh.count('pr', 'merge')[0]!.args).toEqual(['pr', 'merge', '12', flag]);
      expect(service.store.listCoordination(r.project.id).map((c) => c.text).join(' ')).toMatch(/Merged pull request #12 "Add account page" into main/);
    }
  });
  it('needs the number repeated, and the PR of this branch to be that number', async () => {
    const { service, r, gh } = await project();
    await expect(service.mergePullRequest(r.project.id, merge('squash', { confirmNumber: 13 }))).rejects.toThrow(/repeating the pull request number \(#12\)/);
    await expect(service.mergePullRequest(r.project.id, merge('squash', { number: 99, confirmNumber: 99 }))).rejects.toThrow(/is #12, not #99/);
    await expect(service.mergePullRequest(r.project.id, merge('force' as never))).rejects.toThrow(/merge, squash or rebase/);
    expect(gh.count('pr', 'merge')).toHaveLength(0);
  });
  it('refuses failing or pending checks without an explicit override, and merges with it', async () => {
    const { service, r, gh } = await project(prGh({ checks: FAILING }));
    await expect(service.mergePullRequest(r.project.id, merge())).rejects.toThrow(/not green.*explicit override/s);
    expect(gh.count('pr', 'merge')).toHaveLength(0);
    const out = await service.mergePullRequest(r.project.id, merge('merge', { overrideChecks: true }));
    expect(out.merged).toBe(true);
    expect(gh.count('pr', 'merge')).toHaveLength(1);
    expect(service.store.listCoordination(r.project.id).map((c) => c.text).join(' ')).toMatch(/checks overridden/);
  });
  it('the override never covers conflicts, drafts, closed PRs or branch protection', async () => {
    for (const o of [{ mergeable: 'CONFLICTING' }, { isDraft: true }, { state: 'MERGED' }, { reviewDecision: 'REVIEW_REQUIRED' }]) {
      const { service, r, gh } = await project(prGh({ view: view(o), checks: FAILING }));
      await expect(service.mergePullRequest(r.project.id, merge('squash', { overrideChecks: true })), JSON.stringify(o)).rejects.toThrow(/will not merge/);
      expect(gh.count('pr', 'merge')).toHaveLength(0);
    }
  });
  it('reports a gh failure and records nothing', async () => {
    const { service, r } = await project(prGh({ mergeFails: { code: 1, stdout: '', stderr: 'GraphQL: Pull request is not mergeable', timedOut: false } }));
    await expect(service.mergePullRequest(r.project.id, merge())).rejects.toThrow(/could not merge the pull request.*not mergeable/);
    expect(service.store.listCoordination(r.project.id)).toEqual([]);
  });
});

describe('B5 release tags', () => {
  it('tag names and the push argv are plain', () => {
    for (const n of ['v1.0.0', '1.2', 'release/2026-10', 'a_b-c.d']) expect(tagNameProblem(n), n).toBeUndefined();
    for (const n of ['', '-f', 'a b', '../x', 'a..b', 'x.lock', 'a/', '/a', 'a//b', '.hidden', 'a/.b', 'ev:il', 'v1.', 'x'.repeat(101), '--force']) expect(tagNameProblem(n), n).toBeDefined();
    expect(pushTagArgs('origin', 'v1.0.0')).toEqual(['push', '--', 'origin', 'refs/tags/v1.0.0:refs/tags/v1.0.0']);
    for (const bad of [['-f', 'v1'], ['origin', '--delete'], ['origin', ':v1'], ['or igin', 'v1'], ['origin', 'a..b']] as const) expect(() => pushTagArgs(bad[0], bad[1]), bad.join(' ')).toThrow();
    for (const a of pushTagArgs('origin', 'v1.0.0')) expect(a).not.toMatch(/^(--force|-f|--tags|--delete|--mirror|\+)/);
  });
  it('suggests the next patch version', () => {
    expect(suggestNextTag(['v0.9.0', 'v1.2.3', 'v1.10.0', 'nightly'])).toBe('v1.10.1');
    expect(suggestNextTag(['2.0.9'])).toBe('2.0.10');
    expect(suggestNextTag(['nightly'])).toBeUndefined();
  });

  async function withRemote() {
    const s = await project();
    const bare = temp('harbor-bare-'); sh(bare, 'init', '--bare', '-b', 'main');
    sh(s.r.path, 'remote', 'add', 'origin', bare);
    sh(s.r.path, 'push', '-u', 'origin', 'main');
    return { ...s, bare };
  }
  const localCommit = (path: string) => { writeFileSync(join(path, `f${Date.now()}.txt`), 'x'); sh(path, 'add', '-A'); sh(path, '-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'commit', '-m', 'local only'); };

  it('previews the default branch head, recent tags and whether the head is on the remote', async () => {
    const { service, r } = await withRemote();
    sh(r.path, '-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'tag', '-a', 'v1.2.3', '-m', 'old');
    const p = await service.previewReleaseTag(r.project.id);
    expect(p).toMatchObject({ remote: 'origin', defaultBranch: 'main', headSubject: 'Initial commit', headOnRemote: true, recent: ['v1.2.3'], suggested: 'v1.2.4' });
    localCommit(r.path);
    expect((await service.previewReleaseTag(r.project.id)).headOnRemote).toBe(false);
  });
  it('creates an annotated local tag without pushing', async () => {
    const { service, r, bare } = await withRemote();
    const t = await service.createReleaseTag(r.project.id, { name: 'v1.0.0', message: 'First release' });
    expect(t).toMatchObject({ name: 'v1.0.0', pushed: false });
    expect(sh(r.path, 'cat-file', '-t', 'refs/tags/v1.0.0').trim()).toBe('tag');
    expect(sh(r.path, 'tag', '-n1', '-l', 'v1.0.0')).toMatch(/First release/);
    expect(sh(r.path, 'rev-parse', 'v1.0.0^{commit}').trim()).toBe(t.commit);
    expect(sh(bare, 'tag', '-l').trim()).toBe('');
    expect(service.store.listCoordination(r.project.id).map((c) => c.text).join(' ')).toMatch(/Created tag v1.0.0/);
  });
  it('pushes exactly that tag when its commit is already on the remote', async () => {
    const { service, r, bare } = await withRemote();
    sh(r.path, '-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'tag', '-a', 'v0.0.1', '-m', 'local only tag');
    const t = await service.createReleaseTag(r.project.id, { name: 'v1.0.0', push: true });
    expect(t.pushed).toBe(true);
    expect(sh(bare, 'tag', '-l').trim()).toBe('v1.0.0'); // not v0.0.1
  });
  it('never moves or replaces a tag, and never deletes one', async () => {
    const { service, r } = await withRemote();
    const first = await service.createReleaseTag(r.project.id, { name: 'v1.0.0' });
    localCommit(r.path);
    await expect(service.createReleaseTag(r.project.id, { name: 'v1.0.0' })).rejects.toThrow(/already exists.*never moves/);
    expect(sh(r.path, 'rev-parse', 'v1.0.0^{commit}').trim()).toBe(first.commit);
    expect(sh(r.path, 'tag', '-l').trim()).toBe('v1.0.0');
  });
  it('a push the remote rejects (it has that tag already) is reported, the local tag stays', async () => {
    const { service, r, bare } = await withRemote();
    sh(bare, '-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'tag', '-a', 'v2.0.0', '-m', 'theirs', 'main');
    const t = await service.createReleaseTag(r.project.id, { name: 'v2.0.0', push: true });
    expect(t.pushed).toBe(false);
    expect(t.output).toMatch(/created here but not pushed.*already has a tag/s);
    expect(sh(r.path, 'tag', '-l').trim()).toBe('v2.0.0');
  });
  it('does not push a tag for a commit the remote lacks (the branch push and its secret scan come first), and creates nothing', async () => {
    const { service, r } = await withRemote();
    localCommit(r.path);
    await expect(service.createReleaseTag(r.project.id, { name: 'v3.0.0', push: true })).rejects.toThrow(/not on the remote yet.*Push its branch first/s);
    expect(sh(r.path, 'tag', '-l').trim()).toBe('');
    expect((await service.createReleaseTag(r.project.id, { name: 'v3.0.0' })).pushed).toBe(false); // a local tag is fine
  });
  it('refuses to push without a remote, bad names, and unknown refs', async () => {
    const { service, r } = await project();
    await expect(service.createReleaseTag(r.project.id, { name: 'v1.0.0', push: true })).rejects.toThrow(/no remote/);
    for (const name of ['-f', 'a b', 'x..y', 'x.lock', '--delete']) await expect(service.createReleaseTag(r.project.id, { name }), name).rejects.toThrow();
    await expect(service.createReleaseTag(r.project.id, { name: 'v9', ref: 'nope' })).rejects.toThrow(/does not name a commit/);
    await expect(service.createReleaseTag(r.project.id, { name: 'v9', ref: '--all' })).rejects.toThrow(/does not name a commit/);
    expect(sh(r.path, 'tag', '-l').trim()).toBe('');
  });
});
