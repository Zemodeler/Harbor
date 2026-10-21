import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarborEvent } from '../src/shared/api';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk, RunOptions, ToolPermissionDecision, ToolPermissionRequest } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { denyingEntry, loadProjectPermissions } from '../src/main/permissionsFile';
import { isGitDestructive } from '../src/main/gitRisk';
import { createHarborService } from '../src/main/service';
import { calmReported } from './fixtures/calmReadings';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-pf-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* Windows may still hold a handle */ } } });

const say = (text: string): Chunk[] => [{ kind: 'text', text }];
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();
const bash = (command: string): ToolPermissionRequest => ({ tool: 'Bash', input: { command } });

describe('.harbor/permissions.json', () => {
  it('keeps deny entries, and drops allow entries that a stored always-allow rule could not cover either', () => {
    const repo = tmp();
    mkdirSync(join(repo, '.harbor'));
    writeFileSync(join(repo, '.harbor', 'permissions.json'), JSON.stringify({ allow: ['npm run lint', 'rm -rf build', 'npm test && curl x', 'git push'], deny: ['git push', 'npm publish', 7] }));
    const p = loadProjectPermissions(repo);
    expect(p.allow).toEqual(['npm run lint']);
    expect(p.deny).toEqual(['git push', 'npm publish']);
    expect(p.hash).toHaveLength(64);
    expect(loadProjectPermissions(tmp())).toEqual({ allow: [], deny: [], hash: '' });
  });

  it('a deny entry covers the command and chained parts of it, but not a longer word', () => {
    expect(denyingEntry(['git push'], 'Bash', { command: 'git push origin main' })).toBe('git push');
    expect(denyingEntry(['git push'], 'Bash', { command: 'npm test && git push' })).toBe('git push');
    expect(denyingEntry(['git push'], 'Bash', { command: 'git pushy' })).toBeUndefined();
    expect(denyingEntry(['git push'], 'Edit', { command: 'git push' })).toBeUndefined();
  });

  it('classifies history-losing git so the prompt can say so', () => {
    for (const c of ['git reset --hard HEAD~1', 'git clean -fd', 'git push --force origin main', 'git branch -D x']) expect(isGitDestructive('Bash', { command: c }), c).toBe(true);
    for (const c of ['git status', 'git commit -m "restore config"', 'git push', 'git merge x']) expect(isGitDestructive('Bash', { command: c }), c).toBe(false);
  });
});

describe('git and the permissions file in a lead run', () => {
  async function setup(permissions: object | undefined, tool: () => ToolPermissionRequest, yes = false) {
    const repo = tmp();
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'README.md'), 'hi');
    if (permissions) { mkdirSync(join(repo, '.harbor')); writeFileSync(join(repo, '.harbor', 'permissions.json'), JSON.stringify(permissions)); }
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
    const decisions: ToolPermissionDecision[] = [];
    const leadOpts: RunOptions[] = [];
    const script: FakeScript = async (prompt, opts) => {
      const sys = opts.systemPrompt ?? '';
      if (sys.includes('front desk')) return say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }));
      if (!sys.includes('LEAD agent') || !prompt.includes('User:') || !opts.onToolPermission) return say('ok');
      leadOpts.push(opts);
      const d = await opts.onToolPermission(tool(), opts.signal ?? new AbortController().signal);
      decisions.push(d);
      return say(d.allow ? 'ran it' : 'denied');
    };
    const cli: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' };
    const svc = createHarborService({ discover: async () => [cli], adapterFor: () => new FakeAdapter('claude', script), worktreesRoot: join(tmp(), 'wt'), maxActivePerProject: 3, ledger: { reported: calmReported } });
    const project = (await svc.addProject(repo))!;
    const [conv] = await svc.listConversations(project.id);
    const events: Extract<HarborEvent, { type: 'permission' }>[] = [];
    svc.onEvent((e) => { if (e.type === 'permission' && e.kind === 'tool') { events.push(e); void svc.answerPermission(e.requestId, yes); } });
    return { svc, conv: conv!, decisions, leadOpts, events };
  }

  it('a destructive git command is not denied outright: the user is asked, with a warning and no always-allow', async () => {
    const t = await setup(undefined, () => bash('git reset --hard HEAD~1'));
    await t.svc.send(t.conv.id, 'undo the last commit');
    await t.svc.whenIdle();
    expect(t.events).toHaveLength(1);
    expect(t.events[0]!.prompt).toMatch(/^This can lose work or rewrite history\./);
    expect(t.events[0]!.alwaysAllow).toBe(false);
    expect(t.decisions[0]).toMatchObject({ allow: false, message: expect.stringContaining('The user denied') });
  });

  it('a lead hitting a deny entry gets an "Are you sure?" question (the user has the final say), without always-allow', async () => {
    const t = await setup({ deny: ['git push'] }, () => bash('git push origin main'));
    await t.svc.send(t.conv.id, 'publish');
    await t.svc.whenIdle();
    expect(t.events).toHaveLength(1);
    expect(t.events[0]!.prompt).toMatch(/^Are you sure\? The project's permissions file \(\.harbor\/permissions\.json\) denies "git push"/);
    expect(t.events[0]!.alwaysAllow).toBe(false);
    expect(t.decisions[0]).toMatchObject({ allow: false });
    // Claude is not given the deny as a hard rule on a controlled lead run, so the question can reach the user.
    expect(t.leadOpts[0]!.deniedCommands).toBeUndefined();
    expect(t.leadOpts[0]!.leadAllowlist).toBe(true);
  });

  it('a yes answers the question and the command is allowed', async () => {
    const t = await setup({ deny: ['git push'] }, () => bash('git push'), true);
    await t.svc.send(t.conv.id, 'publish');
    await t.svc.whenIdle();
    expect(t.decisions[0]).toEqual({ allow: true });
  });
});

describe('the user has the final say over the mode', () => {
  async function planSetup(yes: boolean) {
    const repo = tmp();
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'README.md'), 'hi'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
    const turns: string[] = [];
    const script: FakeScript = async (prompt, opts) => {
      const sys = opts.systemPrompt ?? '';
      if (sys.includes('front desk')) return say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }));
      if (!sys.includes('LEAD agent')) return say('ok');
      turns.push(prompt);
      const nonce = /HARBOR_[A-Z_]+\[([A-Za-z0-9_-]+)\]/.exec(prompt)?.[1];
      if (turns.length === 1 && nonce) return say(`Plan mode blocks edits, so I need your say.
HARBOR_MODE[${nonce}]: {"to":"default","why":"you asked me to edit README.md now"}`);
      return say('done');
    };
    const cli: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' };
    const svc = createHarborService({ discover: async () => [cli], adapterFor: () => new FakeAdapter('claude', script), worktreesRoot: join(tmp(), 'wt'), maxActivePerProject: 3, ledger: { reported: calmReported } });
    const project = (await svc.addProject(repo))!;
    const [conv] = await svc.listConversations(project.id);
    await svc.setConversationMode(conv!.id, 'plan');
    const events: Extract<HarborEvent, { type: 'permission' }>[] = [];
    svc.onEvent((e) => { if (e.type === 'permission' && e.kind === 'tool') { events.push(e); void svc.answerPermission(e.requestId, yes); } });
    return { svc, conv: conv!, events, turns };
  }

  it('a lead blocked by plan mode asks "Are you sure?"; a yes switches the mode and resumes the lead', async () => {
    const t = await planSetup(true);
    await t.svc.send(t.conv.id, 'edit README.md now, I know we are planning');
    await t.svc.whenIdle();
    expect(t.events).toHaveLength(1);
    expect(t.events[0]!.prompt).toMatch(/^Are you sure\? The lead wants to switch this conversation from plan to default mode because: you asked me to edit/);
    expect((await t.svc.listConversations((await t.svc.listProjects())[0]!.id))[0]!.mode).toBe('default');
    expect(t.turns.length).toBeGreaterThan(1);
    expect(t.turns.at(-1)).toContain('confirmed the switch to default mode');
  });

  it('a no leaves the mode alone', async () => {
    const t = await planSetup(false);
    await t.svc.send(t.conv.id, 'edit README.md now');
    await t.svc.whenIdle();
    expect(t.events).toHaveLength(1);
    expect((await t.svc.listConversations((await t.svc.listProjects())[0]!.id))[0]!.mode).toBe('plan');
    expect(t.turns).toHaveLength(1);
  });
});
