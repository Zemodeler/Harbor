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

describe('one editing lead per project (a folder without git)', () => {
  it('queues the second editing lead until the first ends, and warns once that two leads share the folder', async () => {
    const g = gate();
    const h = await harness({ claude: script({ lead: async (p) => { if (p.includes('AAA')) await g.p; return say('done'); } }) }, { git: false });
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
    const h = await harness({ claude: script({ lead: async (p) => { if (p.includes('AAA')) await g.p; return say('done'); } }) }, { git: false });
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

describe('parallel sessions in their own worktrees', () => {
  const sessionOf = async (h: Awaited<ReturnType<typeof harness>>, id: string) => (await h.svc.listConversations(h.project.id)).find((c) => c.id === id)!;

  it('moves a second editing session into its own worktree instead of queueing it, and keeps the project folder untouched', async () => {
    const g = gate();
    const h = await harness({ claude: script({ lead: async (p, o) => {
      if (p.includes('BBB')) writeFileSync(join(o.cwd, 'b.txt'), 'B');
      if (p.includes('AAA')) await g.p;
      return say('done');
    } }) });
    const second = await h.svc.newConversation(h.project.id);
    await h.svc.send(h.conv.id, 'AAA implement the thing in src/a.ts');
    await until(() => h.calls(isLead).length === 1);
    await h.svc.send(second.id, 'BBB implement the thing in src/b.ts');
    await until(() => h.calls(isLead).length === 2); // B started while A still holds the folder
    const ws = (await sessionOf(h, second.id)).workspace!;
    expect(ws.branch).toMatch(/^harbor\/session-/);
    expect(normalize(h.calls(isLead)[1]!.opts.cwd)).toBe(normalize(ws.worktree));
    expect(normalize(h.calls(isLead)[0]!.opts.cwd)).toBe(normalize(h.repoPath));
    expect((await sessionOf(h, h.conv.id)).workspace).toBeUndefined(); // the first session keeps the project folder
    g.open();
    await h.svc.whenIdle();
    expect(existsSync(join(h.repoPath, 'b.txt'))).toBe(false);
    // Harbor committed what the lead (which may not run git writes) left in the worktree.
    expect(git(h.repoPath, 'show', `${ws.branch}:b.txt`)).toBe('B');
    expect((await h.texts(second.id)).some((t) => t.includes('works in its own git worktree'))).toBe(true);
  });

  it('keeps the worktree for the session\'s later turns', async () => {
    const g = gate();
    const h = await harness({ claude: script({ lead: async (p) => { if (p.includes('AAA')) await g.p; return say('done'); } }) });
    const second = await h.svc.newConversation(h.project.id);
    await h.svc.send(h.conv.id, 'AAA implement the thing in src/a.ts');
    await until(() => h.calls(isLead).length === 1);
    await h.svc.send(second.id, 'BBB implement the thing in src/b.ts');
    await until(() => h.calls(isLead).length === 2);
    g.open();
    await h.svc.whenIdle();
    await h.svc.send(second.id, 'CCC implement the thing in src/c.ts');
    await h.svc.whenIdle();
    const leads = h.calls(isLead);
    expect(leads).toHaveLength(3);
    expect(normalize(leads[2]!.opts.cwd)).toBe(normalize(leads[1]!.opts.cwd));
  });

  it('merges a session into the checked-out branch: a merge of main first when it moved, then a fast-forward', async () => {
    const g = gate();
    const h = await harness({ claude: script({ lead: async (p, o) => {
      if (p.includes('BBB')) writeFileSync(join(o.cwd, 'b.txt'), 'B');
      if (p.includes('AAA')) await g.p;
      return say('done');
    } }) });
    const second = await h.svc.newConversation(h.project.id);
    await h.svc.send(h.conv.id, 'AAA implement the thing in src/a.ts');
    await until(() => h.calls(isLead).length === 1);
    await h.svc.send(second.id, 'BBB implement the thing in src/b.ts');
    await until(() => h.calls(isLead).length === 2);
    g.open();
    await h.svc.whenIdle();
    // main moves on while the session sits on its branch
    writeFileSync(join(h.repoPath, 'a.txt'), 'A'); git(h.repoPath, 'add', '.'); git(h.repoPath, 'commit', '-q', '-m', 'main moved');
    const r = await h.svc.mergeSession!(second.id);
    expect(r).toMatchObject({ merged: true, target: 'main' });
    expect(readFileSync(join(h.repoPath, 'b.txt'), 'utf8')).toBe('B');
    expect(readFileSync(join(h.repoPath, 'a.txt'), 'utf8')).toBe('A');
    expect(git(h.repoPath, 'rev-parse', 'main')).toBe(git(h.repoPath, 'rev-parse', (await sessionOf(h, second.id)).workspace!.branch));
    expect((await sessionOf(h, second.id)).workspace!.mergedHead).toBe(r.head);
    // merging again changes nothing
    expect(await h.svc.mergeSession!(second.id)).toMatchObject({ merged: true, message: expect.stringContaining('Nothing to merge') });
  });

  it('stops a conflicting merge before it touches the project folder', async () => {
    const g = gate();
    const h = await harness({ claude: script({ lead: async (p, o) => {
      if (p.includes('BBB')) writeFileSync(join(o.cwd, 'README.md'), 'session edit');
      if (p.includes('AAA')) await g.p;
      return say('done');
    } }) });
    const second = await h.svc.newConversation(h.project.id);
    await h.svc.send(h.conv.id, 'AAA implement the thing in src/a.ts');
    await until(() => h.calls(isLead).length === 1);
    await h.svc.send(second.id, 'BBB implement the thing in src/b.ts');
    await until(() => h.calls(isLead).length === 2);
    g.open();
    await h.svc.whenIdle();
    writeFileSync(join(h.repoPath, 'README.md'), 'main edit'); git(h.repoPath, 'add', '.'); git(h.repoPath, 'commit', '-q', '-m', 'main edit');
    const before = git(h.repoPath, 'rev-parse', 'main');
    const r = await h.svc.mergeSession!(second.id);
    expect(r).toMatchObject({ merged: false, conflicts: ['README.md'] });
    expect(git(h.repoPath, 'rev-parse', 'main')).toBe(before);
    expect(readFileSync(join(h.repoPath, 'README.md'), 'utf8')).toBe('main edit');
    expect(git((await sessionOf(h, second.id)).workspace!.worktree, 'status', '--porcelain')).toBe(''); // the aborted merge left no markers
  });

  it('refuses to merge while the lead works, with uncommitted changes in the project folder, or without a worktree', async () => {
    const g = gate();
    let n = 0; // a lead's prompt lists the other running sessions, so which lead it is comes from the call order, not from the prompt text
    const h = await harness({ claude: script({ lead: async (_p, o) => {
      const i = ++n;
      if (i === 2) writeFileSync(join(o.cwd, 'b.txt'), 'B');
      if (i === 1 || i === 3) await g.p;
      return say('done');
    } }) });
    const second = await h.svc.newConversation(h.project.id);
    await expect(h.svc.mergeSession!(second.id)).rejects.toThrow(/nothing to merge/);
    await h.svc.send(h.conv.id, 'AAA implement the thing in src/a.ts');
    await until(() => h.calls(isLead).length === 1);
    await h.svc.send(second.id, 'BBB implement the thing in src/b.ts');
    await until(() => h.calls(isLead).length === 2);
    await until(async () => !(h.svc.orchestrator as unknown as { leads: Map<string, unknown> }).leads.has(second.id));
    await h.svc.send(second.id, 'CCC implement the thing in src/c.ts');
    await until(() => h.calls(isLead).length === 3);
    await expect(h.svc.mergeSession!(second.id)).rejects.toThrow(/still working/);
    g.open();
    await h.svc.whenIdle();
    writeFileSync(join(h.repoPath, 'README.md'), 'dirty'); // tracked, uncommitted
    await expect(h.svc.mergeSession!(second.id)).rejects.toThrow(/uncommitted changes/);
    expect(git(h.repoPath, 'rev-parse', 'main')).not.toBe(git(h.repoPath, 'rev-parse', (await sessionOf(h, second.id)).workspace!.branch));
  });

  it('starts a worktree session\'s helpers from its branch, so they see the lead\'s work', async () => {
    const g = gate();
    let seen: string | undefined;
    let leads = 0;
    const h = await harness({ claude: script({
      lead: async (_p, o) => {
        if (++leads === 1) { await g.p; return say('done'); }
        if (leads === 2) { writeFileSync(join(o.cwd, 'lead.txt'), 'L'); return delegate('go', impl('h')); }
        return say('ok');
      },
      helper: (_p, o) => { seen = existsSync(join(o.cwd, 'lead.txt')) ? 'yes' : 'no'; writeFileSync(join(o.cwd, 'h.txt'), 'H'); return say(done()); }
    }) }, { service: { ledger: { reported: calmReported } } });
    const second = await h.svc.newConversation(h.project.id);
    await h.svc.send(h.conv.id, 'AAA implement the thing in src/a.ts');
    await until(() => h.calls(isLead).length === 1);
    await h.svc.send(second.id, 'BBB implement the thing in src/b.ts');
    await until(() => !!seen, 8000);
    expect(seen).toBe('yes');
    g.open();
    await h.svc.whenIdle();
  });

  it('integrates a session helper\'s branch into the session branch (applied inside the session worktree), then merges the session', async () => {
    const g = gate();
    let leads = 0;
    const h = await harness({ claude: script({
      lead: async () => {
        if (++leads === 1) { await g.p; return say('done'); }
        if (leads === 2) return delegate('go', impl('a', { files: ['a.txt'] }), { ref: 'ra', title: 'Review a', role: 'reviewer', instructions: 'Review it.', complexity: 'low', dependsOn: ['a'] }, { role: 'integrator', ref: 'i', sources: ['a'] });
        return say('ok');
      },
      helper: (_p, o) => {
        if (o.permission === 'edit') { writeFileSync(join(o.cwd, 'a.txt'), 'A'); return say(done()); }
        return say(`Reviewed.
${result({ outcome: 'done', summary: 'ok', verdict: 'approve', checks: [] })}`);
      }
    }) }, { service: { ledger: { reported: calmReported } } });
    const second = await h.svc.newConversation(h.project.id);
    await h.svc.send(h.conv.id, 'AAA implement the thing in src/a.ts');
    await until(() => h.calls(isLead).length === 1);
    await h.svc.send(second.id, 'BBB implement the thing in src/b.ts');
    await until(() => h.svc.store.listAgentRecords(h.project.id).some((a) => a.integration && a.state === 'done'), 12_000);
    const ws = (await sessionOf(h, second.id)).workspace!;
    const integrator = h.svc.store.listAgentRecords(h.project.id).find((a) => a.integration)!;
    expect(integrator.integration!.target).toBe(ws.branch); // not main: the helper belongs to the session
    const mainBefore = git(h.repoPath, 'rev-parse', 'main');
    await h.svc.applyIntegration(integrator.id);
    expect(git(h.repoPath, 'rev-parse', ws.branch)).toBe(integrator.integration!.head);
    expect(readFileSync(join(ws.worktree, 'a.txt'), 'utf8')).toBe('A'); // the session's checkout moved with its branch
    expect(git(h.repoPath, 'rev-parse', 'main')).toBe(mainBefore);
    expect(existsSync(join(h.repoPath, 'a.txt'))).toBe(false);
    g.open();
    await h.svc.whenIdle();
    await h.svc.mergeSession!(second.id);
    expect(readFileSync(join(h.repoPath, 'a.txt'), 'utf8')).toBe('A');
  }, 30_000);
});
