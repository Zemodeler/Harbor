import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk, RunOptions } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { createHarborService } from '../src/main/service';
import type { HarborEvent } from '../src/shared/api';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-tested-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const say = (text: string): Chunk[] => [{ kind: 'text', text }];
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();

it('records the commit a reviewer examined and flags it outdated when the branch moves', async () => {
  const repo = tmp();
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), 'hi'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');

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
    if (o.permission === 'edit') writeFileSync(join(o.cwd, `f${++edits}.ts`), `export const n = ${edits};`);
    return say(o.permission === 'edit' ? 'Implemented' : 'Looks fine. approve');
  };
  const adapter = new FakeAdapter('claude', script);
  const cli: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' };
  const svc = createHarborService({ discover: async () => [cli], adapterFor: () => adapter, worktreesRoot: join(tmp(), 'wt'), maxActivePerProject: 3 });
  const events: HarborEvent[] = [];
  svc.onEvent((e) => events.push(e));
  const project = (await svc.addProject(repo))!;
  const [conv] = await svc.listConversations(project.id);

  await svc.send(conv!.id, 'add login and review it');
  await svc.whenIdle();

  const find = (title: string) => svc.store.listAgentRecords(project.id).find((a) => a.title === title)!;
  const impl = find('Build login');
  const rev = find('Review login');
  expect(rev.state).toBe('done');
  expect(impl.branch).toMatch(/^harbor\//);
  const reviewedHead = git(impl.worktree!, 'rev-parse', 'HEAD');
  expect(rev.testedCommit).toBe(reviewedHead);
  expect(reviewedHead).not.toBe(impl.baseCommit);
  const view = (await svc.listAgents(project.id)).find((a) => a.id === rev.id)!;
  expect(view).toMatchObject({ testedCommit: reviewedHead, outdated: false });
  // Agents that tested nothing carry neither field.
  expect((await svc.listAgents(project.id)).find((a) => a.id === impl.id)!.testedCommit).toBeUndefined();

  // The branch moves: the implementer is sent back to work and adds a commit.
  const ic = await svc.openAgentConversation(impl.id);
  await svc.send(ic.id, 'also add another file');
  await svc.whenIdle();

  expect(git(impl.worktree!, 'rev-parse', 'HEAD')).not.toBe(reviewedHead);
  const after = (await svc.listAgents(project.id)).find((a) => a.id === rev.id)!;
  expect(after).toMatchObject({ testedCommit: reviewedHead, outdated: true });
  expect(events.some((e) => e.type === 'agent' && e.agent.id === rev.id && e.agent.outdated === true)).toBe(true);
});
