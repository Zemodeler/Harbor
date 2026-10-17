import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { claudeArgs, NO_ATTRIBUTION_SETTINGS } from '../src/main/adapters/claude';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk, RunOptions } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { LEAD_SYSTEM } from '../src/main/prompts';
import { createHarborService } from '../src/main/service';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-leadmerge-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const say = (text: string): Chunk[] => [{ kind: 'text', text }];
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();

/** Lead turn 1 delegates one edit helper; the lead turn that follows its report runs `afterReport(cwd, branch)` in the project. */
async function setup(afterReport: (cwd: string, branch: string) => void) {
  const repo = tmp();
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), 'hi'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  const seen: RunOptions[] = [];
  let delegated = false;
  const script: FakeScript = (_prompt, o) => {
    const sys = o.systemPrompt ?? '';
    if (sys.includes('front desk')) return say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }));
    if (sys.includes('LEAD agent')) {
      seen.push(o);
      if (!delegated) {
        delegated = true;
        return say(`go\nHARBOR_DELEGATE: ${JSON.stringify({ ref: 'a', title: 'Write a', role: 'implementer', instructions: 'write', complexity: 'low', files: ['a.txt'] })}`);
      }
      afterReport(o.cwd, git(o.cwd, 'branch', '--list', 'harbor/*', '--format=%(refname:short)').split(/\r?\n/).find((b) => !b.startsWith('harbor/integrate'))!);
      return say('applied');
    }
    writeFileSync(join(o.cwd, 'a.txt'), 'A');
    return say('Done\nHARBOR_RESULT: {"outcome":"done","summary":"Written.","checks":[]}');
  };
  const adapter = new FakeAdapter('claude', script);
  const cli: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' };
  const svc = createHarborService({ discover: async () => [cli], adapterFor: () => adapter, worktreesRoot: join(tmp(), 'wt'), maxActivePerProject: 4 });
  const project = (await svc.addProject(repo))!;
  const [conv] = await svc.listConversations(project.id);
  await svc.send(conv!.id, 'do the work');
  await svc.whenIdle();
  const warnings = async () => (await svc.listMessages(conv!.id)).filter((m) => m.role === 'system' && m.text.startsWith('Warning: the lead merged'));
  return { svc, project, seen, warnings };
}

it('lets the lead merge a harbor/* branch into the project without a warning or a journal entry', async () => {
  const { svc, project, warnings } = await setup((cwd, branch) => { git(cwd, 'merge', '--no-ff', '-q', '-m', 'merge helper', branch); });
  expect(await warnings()).toHaveLength(0);
  expect(svc.orchestrator.journal.list(project.id).filter((e) => e.text.includes('Lead merged'))).toHaveLength(0);
});

it('asks the adapter to deny git writes on lead runs only', async () => {
  const { seen } = await setup(() => {});
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((o) => o.denyGitWrites === true)).toBe(true);
});

it('claude denies git reset on lead runs only, and never merge, rebase, cherry-pick or plain push', () => {
  const base: RunOptions = { cwd: '.', model: 'sonnet', effort: 'medium', permission: 'edit' };
  const on = claudeArgs({ ...base, denyGitWrites: true }).join('|');
  expect(on).toContain('Bash(git reset *)');
  for (const c of ['merge', 'rebase', 'cherry-pick']) expect(on).not.toContain(`Bash(git ${c} *)`);
  expect(on).not.toContain('Bash(git push *)');
  expect(on).toContain('Bash(git push --force *)');
  expect(on).toMatch(/--disallowedTools\|Task\|Agent\|Bash\(git reset \*\)/);
  expect(claudeArgs(base).join('|')).not.toContain('Bash(git reset *)'); // helpers only get the destructive `git reset --hard`
});

it('claude gets a settings file that switches off the Co-Authored-By trailer', () => {
  const base: RunOptions = { cwd: '.', model: 'sonnet', effort: 'medium', permission: 'edit' };
  const a = claudeArgs(base, undefined, undefined, 'settings.json');
  expect(a.slice(a.indexOf('--settings'), a.indexOf('--settings') + 2)).toEqual(['--settings', 'settings.json']);
  expect(JSON.parse(NO_ATTRIBUTION_SETTINGS)).toEqual({ includeCoAuthoredBy: false, attribution: { commit: '', pr: '' } });
  expect(claudeArgs(base)).not.toContain('--settings');
});

it('tells the lead it may merge itself, but never reset, and still offers the integrator', () => {
  expect(LEAD_SYSTEM).toMatch(/Never reset or force-push/);
  expect(LEAD_SYSTEM).toMatch(/Merging into the project's branch is allowed/);
  expect(LEAD_SYSTEM).toContain('"role":"integrator"');
  expect(LEAD_SYSTEM).not.toMatch(/merge finished harbor/);
});
