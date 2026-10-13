import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Git } from '../src/main/git';
import type { ProcessKiller } from '../src/main/proc';
import { delegate, git, gitRepo, harness, isHelper, isLead, result, say, script, tmp, until } from './hardeningHarness';
import { calmReported } from './fixtures/calmReadings';

// Wave 2: locks, worktrees and git handling, retention, shutdown, checks trust.

const impl = (ref: string, over: Record<string, unknown> = {}) => ({ ref, title: `Write ${ref}`, role: 'implementer', instructions: `write ${ref}`, complexity: 'low', ...over });
const done = (summary = 'Done.') => `Done\n${result({ outcome: 'done', summary, checks: [] })}`;
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

describe('file locks', () => {
  it('give edit helpers with their own worktree no lock at all, even without a file list', async () => {
    const g = gate();
    let started = 0;
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('a'), impl('b')) : say('ok')),
      helper: async () => { started++; await g.p; return say(done()); }
    }) }, { service: { ledger: { reported: calmReported } } });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await until(() => started === 2); // both run at once although neither named files
    expect(h.svc.orchestrator.lockTable.list(h.project.id)).toEqual([]);
    g.open();
    await h.svc.whenIdle();
    expect(h.helpers().every((a) => a.state === 'done')).toBe(true);
  });

  it('keeps the whole-project lock for a folder without git, and releases it before the checks run', async () => {
    const g = gate();
    let started = 0;
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('a'), impl('b')) : say('ok')),
      helper: async () => { started++; await g.p; return say(done()); }
    }) }, { git: false });
    h.svc.onEvent((e) => { if (e.type === 'permission') void h.svc.answerPermission(e.requestId, false); }); // the conflict question: wait your turn
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await until(() => started === 1);
    expect(h.svc.orchestrator.lockTable.list(h.project.id).map((l) => l.file)).toEqual(['*']);
    await new Promise((r) => setTimeout(r, 100));
    expect(started).toBe(1); // the second one waits for the lock
    g.open();
    await h.svc.whenIdle();
    expect(h.helpers().every((a) => a.state === 'done')).toBe(true);
    expect(h.svc.orchestrator.lockTable.list(h.project.id)).toEqual([]);
  });
});

describe('edit helpers and git', () => {
  it('passes the worktree git directories as writable, and says which credential files were left out of the checkpoint', async () => {
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('a')) : say('ok')),
      helper: (_p, o) => { writeFileSync(join(o.cwd, 'a.txt'), 'A'); writeFileSync(join(o.cwd, '.env'), 'SECRET=1'); return say(done()); }
    }) });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    const [call] = h.calls(isHelper);
    expect(call!.opts.writableDirs?.length).toBeGreaterThan(0);
    expect(call!.opts.writableDirs!.some((d) => normalize(d).toLowerCase().includes('.git'))).toBe(true);
    const a = h.helper('Write a');
    expect(a.report).toMatch(/Credential-looking files were left out of the commit.*\.env/);
    expect(git(a.worktree!, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('.env');
    expect(git(a.worktree!, 'ls-tree', '-r', '--name-only', 'HEAD')).toContain('a.txt');
  });

  it('commits what a failed edit helper left, so nothing is lost with the run', async () => {
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('a')) : say('ok')),
      helper: (_p, o) => { writeFileSync(join(o.cwd, 'partial.txt'), 'half'); return [{ kind: 'done', ok: false, error: 'boom' }]; }
    }) });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    const a = h.helper('Write a');
    expect(a.state).toBe('failed');
    expect(git(a.worktree!, 'ls-tree', '-r', '--name-only', 'HEAD')).toContain('partial.txt');
    expect(a.report).toMatch(/committed its uncommitted work/);
  });

  // Phase 4: only a helper whose files do NOT overlap the uncommitted edits starts (with the note); one that overlaps them (here a
  // whole-project claim) is held and the lead decides (dirty-base tests in phase4Delegation.test.ts). Was: every helper started.
  it('warns when the project folder is dirty, in the chat and in the helper\'s assignment', async () => {
    const repo = gitRepo();
    writeFileSync(join(repo, 'README.md'), 'edited but not committed');
    const h = await harness({ claude: script({ lead: (p) => (p.includes('User:') ? delegate('go', impl('a', { files: ['src/a.ts'] })) : say('ok')), helper: () => say(done()) }) }, { git: repo });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    expect((await h.texts()).some((t) => t.startsWith('The project folder has uncommitted changes'))).toBe(true);
    expect(h.calls(isHelper)[0]!.prompt).toContain('had uncommitted changes when this was delegated');
    // A clean folder says nothing.
    const clean = await harness({ claude: script({ lead: (p) => (p.includes('User:') ? delegate('go', impl('a')) : say('ok')), helper: () => say(done()) }) });
    await clean.svc.send(clean.conv.id, 'implement the thing in src/a.ts');
    await clean.svc.whenIdle();
    expect((await clean.texts()).some((t) => t.startsWith('The project folder has uncommitted changes'))).toBe(false);
  });

  it('runs helpers in the project\'s own subfolder of the worktree when the project is a subfolder of a repository', async () => {
    const repo = gitRepo();
    mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'app', 'index.ts'), 'x');
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'app');
    const sub = join(repo, 'packages', 'app');
    let cwd = '';
    const h = await harness({ claude: script({ lead: (p) => (p.includes('User:') ? delegate('go', impl('a')) : say('ok')), helper: (_p, o) => { cwd = o.cwd; return say(done()); } }) }, { git: sub });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    const a = h.helper('Write a');
    expect(normalize(cwd)).toBe(normalize(join(a.worktree!, 'packages', 'app')));
    expect(existsSync(join(cwd, 'index.ts'))).toBe(true);
    expect(h.calls(isHelper)[0]!.prompt).toContain('packages/app');
  });

  it('flags changes under .harbor/ instead of letting them pass as ordinary code', async () => {
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('a')) : say('ok')),
      helper: (_p, o) => { mkdirSync(join(o.cwd, '.harbor'), { recursive: true }); writeFileSync(join(o.cwd, '.harbor', 'checks.json'), '{"checks":["echo hi"]}'); return say(done()); }
    }) });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    expect(h.helper('Write a').report).toMatch(/changes under \.harbor\/: \.harbor\/checks\.json/);
    expect((await h.texts()).some((t) => t.includes("changes Harbor's own configuration"))).toBe(true);
  });
});

describe('integration target', () => {
  it('is pinned to the branch checked out when it was delegated, and refuses once the folder is on another branch', async () => {
    const g = gate();
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('a'), { ref: 'ra', title: 'Review a', role: 'reviewer', instructions: 'review', complexity: 'low', dependsOn: ['a'] }, { role: 'integrator', ref: 'i', sources: ['a'] }) : say('ok')),
      helper: async (_p, o) => (o.permission === 'edit' ? say(done()) : (await g.p, say(`ok\n${result({ outcome: 'done', summary: 'ok', verdict: 'approve', checks: [] })}`)))
    }) });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await until(() => h.helpers().some((a) => a.integration));
    const integ = h.helpers().find((a) => a.integration)!;
    expect(integ.integration!.target).toBe('main');
    expect(integ.pinnedCheckedOut).toBe('main');
    git(h.repoPath, 'checkout', '-q', '-b', 'dev');
    g.open();
    await h.svc.whenIdle();
    const after = h.svc.store.getAgent(integ.id)!;
    expect(after.state).toBe('failed');
    expect(after.error).toMatch(/queued for main.*now on dev/s);
  });

  it('integrateBranches pins the checked-out branch too', async () => {
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('a'), { ref: 'ra', title: 'Review a', role: 'reviewer', instructions: 'review', complexity: 'low', dependsOn: ['a'] }) : say('ok')),
      helper: (_p, o) => say(o.permission === 'edit' ? done() : `ok\n${result({ outcome: 'done', summary: 'ok', verdict: 'approve', checks: [] })}`)
    }) });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    const rec = await h.svc.integrateBranches(h.project.id, [h.helper('Write a').id]);
    expect(rec.integration!.target).toBe('main');
    await h.svc.whenIdle();
  });
});

describe('worktree retention and reuse', () => {
  const oneEdit = () => script({ lead: (p) => (p.includes('User:') ? delegate('go', impl('a')) : say('ok')), helper: (_p, o) => { writeFileSync(join(o.cwd, 'a.txt'), 'A'); return say(done()); } });

  it('removes the folder of old idle work but never the branch, never active work, and re-attaches on a follow-up', async () => {
    const h = await harness({ claude: oneEdit() });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    const a = h.helper('Write a');
    const path = a.worktree!;
    expect(await h.svc.orchestrator.collectWorktrees()).toBe(0); // recent work stays
    expect(existsSync(path)).toBe(true);
    h.svc.store.patchAgent(a.id, { updated: Date.now() - 20 * 86_400_000 });
    expect(await h.svc.orchestrator.collectWorktrees()).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect(h.svc.store.getAgent(a.id)!.worktree).toBeUndefined();
    expect(git(h.repoPath, 'branch', '--list', a.branch!)).toContain(a.branch!); // the branch (and so the work) is kept
    // A follow-up gets its worktree back on the same branch instead of editing the user's folder.
    const c = await h.svc.openAgentConversation(a.id);
    await h.svc.send(c.id, 'also add b');
    await h.svc.whenIdle();
    const again = h.svc.store.getAgent(a.id)!;
    expect(again.worktree).toBe(path);
    expect(existsSync(join(path, 'a.txt'))).toBe(true);
    expect(h.calls(isHelper)[1]!.opts.cwd).toBe(path);
  });

  it('keeps the worktree of a source whose integration is not applied yet', async () => {
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('a'), { ref: 'ra', title: 'Review a', role: 'reviewer', instructions: 'review', complexity: 'low', dependsOn: ['a'] }, { role: 'integrator', ref: 'i', sources: ['a'] }) : say('ok')),
      helper: (_p, o) => say(o.permission === 'edit' ? done() : `ok\n${result({ outcome: 'done', summary: 'ok', verdict: 'approve', checks: [] })}`)
    }) });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    const a = h.helper('Write a');
    h.svc.store.patchAgent(a.id, { updated: Date.now() - 40 * 86_400_000 });
    // The integration is recent and unapplied, so its source is still needed.
    expect(await h.svc.orchestrator.collectWorktrees()).toBe(0);
    expect(existsSync(a.worktree!)).toBe(true);
  });

  it('Git.reuseWorktree finds or re-attaches the worktree of an existing harbor branch and never touches foreign folders', async () => {
    const repo = gitRepo();
    const root = join(tmp('harbor-wtroot-'), 'wt');
    const g = new Git();
    const wt = await g.createWorktree(repo, root, 'proj', 'Do thing', 'abcdef123');
    // Already checked out: found as is (a retry after an interrupted start).
    expect((await g.reuseWorktree(repo, root, 'proj', wt.branch))!.path).toBe(wt.path);
    // Folder gone, branch kept: attached again.
    await g.removeWorktree(repo, root, wt.path);
    expect(existsSync(wt.path)).toBe(false);
    const back = await g.reuseWorktree(repo, root, 'proj', wt.branch);
    expect(back!.path).toBe(wt.path);
    expect(existsSync(join(wt.path, 'README.md'))).toBe(true);
    // Not a harbor branch, or no such branch: nothing.
    expect(await g.reuseWorktree(repo, root, 'proj', 'main')).toBeUndefined();
    expect(await g.reuseWorktree(repo, root, 'proj', 'harbor/nope')).toBeUndefined();
    // A directory that is not a worktree of that branch is never reused.
    await g.removeWorktree(repo, root, wt.path);
    mkdirSync(wt.path, { recursive: true });
    writeFileSync(join(wt.path, 'mine.txt'), 'user data');
    expect(await g.reuseWorktree(repo, root, 'proj', wt.branch)).toBeUndefined();
    expect(readFileSync(join(wt.path, 'mine.txt'), 'utf8')).toBe('user data');
  });
});

describe('shutdown', () => {
  it('aborts running work, kills this instance\'s recorded processes through the killer, and saves state', async () => {
    const g = gate();
    let aborted = false, started = false;
    const killed: number[] = [];
    const killer: ProcessKiller = {
      inspect: async (pid) => (pid === 4242 ? { name: 'claude', started: 1_000_000 } : undefined),
      kill: async (pid) => { killed.push(pid); }
    };
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('a')) : say('ok')),
      helper: async (_p, o) => { o.signal?.addEventListener('abort', () => { aborted = true; }); started = true; await g.p; return say(done()); }
    }) }, { dataDir: true, service: { killer } });
    h.svc.store.trackProcess({ pid: 4242, name: 'claude', started: 1_000_000, owner: { pid: process.pid, started: 1 } });
    h.svc.store.trackProcess({ pid: 777, name: 'claude', started: 1_000_000, owner: { pid: process.pid + 1, started: 1 } }); // another Harbor's: left alone
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await until(() => started);
    expect(h.svc.activeRuns()).toBeGreaterThan(0);
    const done1 = h.svc.shutdown();
    expect(aborted).toBe(true); // before the first await
    expect(existsSync(join(h.dataDir!, 'state.json'))).toBe(true);
    await done1;
    expect(killed).toEqual([4242]);
    expect(h.svc.store.listTrackedProcesses().map((p) => p.pid)).toEqual([777]);
    g.open();
    await h.svc.whenIdle();
  });
});

describe('the project checks file', () => {
  const marker = "node -e \"require('fs').writeFileSync('ran.txt','1')\"";
  const planWith = (title: string) => script({
    lead: (p) => (p.includes('User:') ? delegate('go', impl(title)) : say('ok')),
    helper: (_p, o) => { writeFileSync(join(o.cwd, `${title}.txt`), title); return say(done()); }
  });
  const repoWithChecks = (checks: string[]) => {
    const repo = gitRepo();
    mkdirSync(join(repo, '.harbor'));
    writeFileSync(join(repo, '.harbor', 'checks.json'), JSON.stringify({ checks }));
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'checks');
    return repo;
  };

  it('asks before the first run, runs nothing until allowed, and remembers the answer by content', async () => {
    const repo = repoWithChecks([marker]);
    const h = await harness({ claude: planWith('a') }, { git: repo });
    let prompts = 0;
    let answerWith: boolean | undefined;
    h.svc.onEvent((e) => { if (e.type === 'permission' && e.tool === 'Harbor checks') { prompts++; if (answerWith !== undefined) void h.svc.answerPermission(e.requestId, answerWith); } });

    // Denied: the commands never run, the report says so.
    answerWith = false;
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    const a = h.helper('Write a');
    expect(prompts).toBe(1);
    expect(existsSync(join(a.worktree!, 'ran.txt'))).toBe(false);
    expect(a.checks).toBeUndefined();
    expect(a.report).toMatch(/did NOT run the project checks/);
    expect(h.svc.store.getChecksApproval(h.project.id)).toBeUndefined();
    const prompt = h.events.find((e) => e.type === 'permission' && e.tool === 'Harbor checks') as { prompt: string; alwaysAllow?: boolean };
    expect(prompt.prompt).toContain(marker); // the user sees the commands
    expect(prompt.alwaysAllow).toBe(false);

    // Allowed: runs, approval stored for exactly these commands.
    answerWith = true;
    const [, second] = [0, await h.svc.newConversation(h.project.id)];
    await h.svc.send(second.id, 'implement the thing in src/b.ts');
    await h.svc.whenIdle();
    expect(prompts).toBe(2);
    const secondHelper = h.helpers().find((x) => x.checks)!;
    expect(secondHelper.checks![0]).toMatchObject({ ok: true });
    expect(existsSync(join(secondHelper.worktree!, 'ran.txt'))).toBe(true);
    expect(h.svc.store.getChecksApproval(h.project.id)).toBeTruthy();

    // Same content: no new question. Changed content: asked again.
    const third = await h.svc.newConversation(h.project.id);
    await h.svc.send(third.id, 'implement the thing in src/c.ts');
    await h.svc.whenIdle();
    expect(prompts).toBe(2);
    writeFileSync(join(repo, '.harbor', 'checks.json'), JSON.stringify({ checks: [marker, 'echo extra'] }));
    const fourth = await h.svc.newConversation(h.project.id);
    answerWith = false;
    await h.svc.send(fourth.id, 'implement the thing in src/d.ts');
    await h.svc.whenIdle();
    expect(prompts).toBe(3);
  }, 60_000);
});

describe('one editing lead per project', () => {
  it('queues the second editing lead until the first ends, and warns once that two leads share the folder', async () => {
    const g = gate();
    const h = await harness({ claude: script({ lead: async (p) => { if (p.includes('AAA')) await g.p; return say('done'); } }) });
    const second = await h.svc.newConversation(h.project.id);
    await h.svc.send(h.conv.id, 'AAA implement the thing in src/a.ts');
    await until(() => h.calls(isLead).length === 1);
    await h.svc.send(second.id, 'BBB implement the thing in src/b.ts');
    await until(async () => (await h.svc.listConversations(h.project.id)).find((c) => c.id === second.id)?.activity?.state === 'queued');
    const c = (await h.svc.listConversations(h.project.id)).find((x) => x.id === second.id)!;
    expect(c.activity!.detail).toMatch(/Only one session edits the project folder at a time/);
    expect(h.calls(isLead)).toHaveLength(1); // B has not started
    expect((await h.texts(second.id)).filter((t) => t.startsWith('Another session of this project has a running lead'))).toHaveLength(1);
    g.open();
    await h.svc.whenIdle();
    expect(h.calls(isLead)).toHaveLength(2);
    expect((await h.texts(second.id)).filter((t) => t.startsWith('Another session of this project has a running lead'))).toHaveLength(1);
  });

  it('does not make a stopped session hold its place', async () => {
    const g = gate();
    const h = await harness({ claude: script({ lead: async (p) => { if (p.includes('AAA')) await g.p; return say('done'); } }) });
    const second = await h.svc.newConversation(h.project.id);
    await h.svc.send(h.conv.id, 'AAA implement the thing in src/a.ts');
    await until(() => h.calls(isLead).length === 1);
    await h.svc.send(second.id, 'BBB implement the thing in src/b.ts');
    await until(async () => (await h.svc.listConversations(h.project.id)).find((c) => c.id === second.id)?.activity?.state === 'queued');
    await h.svc.stopConversation(second.id);
    g.open();
    await h.svc.whenIdle();
    expect(h.calls(isLead)).toHaveLength(1); // B never ran
  });
});
