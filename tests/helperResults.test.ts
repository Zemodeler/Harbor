import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk, RunOptions } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { createHarborService } from '../src/main/service';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-result-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const say = (text: string): Chunk[] => [{ kind: 'text', text }];
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();
const result = (r: object) => `HARBOR_RESULT: ${JSON.stringify(r)}`;

async function setup(checks?: string[]) {
  const repo = tmp();
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), 'hi'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  if (checks) { mkdirSync(join(repo, '.harbor')); writeFileSync(join(repo, '.harbor', 'checks.json'), JSON.stringify({ checks })); }

  let edits = 0;
  const script: FakeScript = (prompt, o: RunOptions) => {
    const sys = o.systemPrompt ?? '';
    if (sys.includes('front desk')) return say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }));
    if (sys.includes('LEAD agent')) {
      if (!prompt.includes('User:')) return say('ok');
      const tasks = [
        { ref: 'i', title: 'Build login', role: 'implementer', instructions: 'implement', complexity: 'low' },
        { ref: 'r', title: 'Review login', role: 'reviewer', instructions: 'review', complexity: 'low', dependsOn: ['i'] }
      ];
      return say(['go', ...tasks.map((t) => `HARBOR_DELEGATE: ${JSON.stringify(t)}`)].join('\n'));
    }
    if (o.permission === 'edit') {
      writeFileSync(join(o.cwd, `f${++edits}.ts`), `export const n = ${edits};`);
      return say(['Implemented', 'HARBOR_RESULT: {not json', result({ outcome: 'done', summary: 'Login built.', checks: [{ cmd: 'npm test', ok: true }] })].join('\n'));
    }
    return say(['Looks fine.', result({ outcome: 'done', summary: 'Approved.', verdict: 'approve', checks: [] })].join('\n'));
  };
  const adapter = new FakeAdapter('claude', script);
  const cli: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' };
  const svc = createHarborService({ discover: async () => [cli], adapterFor: () => adapter, worktreesRoot: join(tmp(), 'wt'), maxActivePerProject: 3 });
  const project = (await svc.addProject(repo))!;
  const [conv] = await svc.listConversations(project.id);
  await svc.send(conv!.id, 'add login and review it');
  await svc.whenIdle();
  const find = (title: string) => svc.store.listAgentRecords(project.id).find((a) => a.title === title)!;
  const view = async (id: string) => (await svc.listAgents(project.id)).find((a) => a.id === id)!;
  return { svc, project, find, view };
}

it('stores the helper and reviewer results, tied to the commit each examined', async () => {
  const { find, view } = await setup();
  const impl = find('Build login');
  const rev = find('Review login');
  const head = git(impl.worktree!, 'rev-parse', 'HEAD');

  expect(impl.result).toEqual({ outcome: 'done', summary: 'Login built.', checks: [{ cmd: 'npm test', ok: true }], commit: head });
  expect(rev.result).toEqual({ outcome: 'done', summary: 'Approved.', verdict: 'approve', checks: [], commit: head });
  expect(rev.testedCommit).toBe(head);
  expect(await view(rev.id)).toMatchObject({ result: { verdict: 'approve', commit: head }, testedCommit: head, outdated: false });
  // No checks file: nothing ran, so the implementer carries neither checks nor a tested commit (unchanged default).
  expect(impl.checks).toBeUndefined();
  expect((await view(impl.id)).testedCommit).toBeUndefined();
});

it('runs .harbor/checks.json on the helper head, stores the outcomes and journals failures', async () => {
  const pass = 'node -e "process.exit(0)"';
  const fail = 'node -e "process.exit(3)"';
  const { svc, project, find, view } = await setup([pass, fail]);
  const impl = find('Build login');
  const rev = find('Review login');
  const head = git(impl.worktree!, 'rev-parse', 'HEAD');

  expect(impl.checks).toHaveLength(2);
  expect(impl.checks![0]).toMatchObject({ cmd: pass, ok: true, exitCode: 0 });
  expect(impl.checks![1]).toMatchObject({ cmd: fail, ok: false, exitCode: 3 });
  expect(impl.testedCommit).toBe(head);
  expect(impl.report).toContain(`Checks Harbor ran on ${head.slice(0, 10)}`);
  // The contract view carries the outcomes without the output tail.
  const v = await view(impl.id);
  expect(v).toMatchObject({ testedCommit: head, outdated: false });
  expect(v.checks![1]).toEqual({ cmd: fail, ok: false, exitCode: 3, timedOut: undefined, durationMs: expect.any(Number) });
  expect(v.checks![1]).not.toHaveProperty('output');

  const kinds = svc.orchestrator.journal.list(project.id).map((e) => e.kind);
  expect(kinds).toContain('checks-failed');
  expect(kinds).toContain('protocol');

  // The implementer is sent back and commits again: checks re-run on the new head, the review is now outdated.
  const ic = await svc.openAgentConversation(impl.id);
  await svc.send(ic.id, 'also add another file');
  await svc.whenIdle();
  const next = git(impl.worktree!, 'rev-parse', 'HEAD');
  expect(next).not.toBe(head);
  expect(await view(impl.id)).toMatchObject({ testedCommit: next, outdated: false, result: { commit: next } });
  expect(await view(rev.id)).toMatchObject({ testedCommit: head, outdated: true, result: { verdict: 'approve', commit: head } });
});
