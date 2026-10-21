import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { parseProtocol } from '../src/main/prompts';
import { createHarborService } from '../src/main/service';
import { calmReported } from './fixtures/calmReadings';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-grant-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* Windows */ } } });
const say = (text: string): Chunk[] => [{ kind: 'text', text }];
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();

describe('HARBOR_DELEGATE grant parsing', () => {
  const line = (g: unknown) => parseProtocol(`HARBOR_DELEGATE: ${JSON.stringify({ title: 't', instructions: 'do', grant: g })}`).delegate[0]!;
  it('needs a count and a scope, and caps the count', () => {
    expect(line({ helpers: 2, scope: 'docs lookups' }).grant).toEqual({ helpers: 2, scope: 'docs lookups' });
    expect(line({ helpers: 99, scope: 'x' }).grant).toEqual({ helpers: 3, scope: 'x' });
    expect(line({ helpers: 2 }).grant).toBeUndefined();
    expect(line({ helpers: 0, scope: 'x' }).grant).toBeUndefined();
    expect(line('yes').grant).toBeUndefined();
  });
});

describe('delegation grant in a run', () => {
  async function setup(grant: unknown) {
    const repo = tmp();
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'README.md'), 'hi'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
    const leadTurns: string[] = [];
    const helperPrompts: string[] = [];
    let asked = 0;
    const script: FakeScript = async (prompt, opts) => {
      const sys = opts.systemPrompt ?? '';
      if (sys.includes('front desk')) return say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }));
      if (sys.includes('LEAD agent')) {
        leadTurns.push(prompt);
        if (leadTurns.length === 1) return say(`go\nHARBOR_DELEGATE: ${JSON.stringify({ ref: 't1', title: 'Research', role: 'planner', access: 'read', instructions: 'research the thing', ...(grant ? { grant } : {}) })}`);
        return say('noted');
      }
      helperPrompts.push(prompt);
      const nonce = /HARBOR_[A-Z_]+\[([A-Za-z0-9_-]+)\]/.exec(prompt)?.[1];
      if (prompt.includes('Started by') ) return say('sub-helper findings');
      if (prompt.includes('Your requested helper')) return say('thanks, done');
      if (!asked++ && nonce) return say(`need a lookup\nHARBOR_REQUEST_HELP[${nonce}]: ${JSON.stringify({ reason: 'lookup', proposedRole: 'other', instructions: 'look up the API', blocked: true })}`);
      return say('done');
    };
    const cli: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' };
    const svc = createHarborService({ discover: async () => [cli], adapterFor: () => new FakeAdapter('claude', script), worktreesRoot: join(tmp(), 'wt'), maxActivePerProject: 3, ledger: { reported: calmReported } });
    const project = (await svc.addProject(repo))!;
    const [conv] = await svc.listConversations(project.id);
    return { svc, project, conv: conv!, leadTurns, helperPrompts };
  }

  it('with a grant the sub-helper starts without a lead turn and its report reaches the requester', async () => {
    const t = await setup({ helpers: 1, scope: 'API lookups' });
    await t.svc.send(t.conv.id, 'research it');
    await t.svc.whenIdle();
    expect(t.helperPrompts.some((p) => /start up to 1 read-only helper/.test(p) && p.includes('API lookups'))).toBe(true);
    expect(t.helperPrompts.some((p) => p.includes('Started by "Research" under the lead\'s grant'))).toBe(true);
    expect(t.helperPrompts.some((p) => p.includes('Your requested helper') && p.includes('sub-helper findings'))).toBe(true);
    // The lead was woken for the final reports only, never for the help request itself.
    expect(t.leadTurns.every((p) => !p.includes('look up the API') || p.includes('sub-helper'))).toBe(true);
    const agents = t.svc.store.listAgentRecords(t.project.id).filter((a) => a.role !== 'main');
    expect(agents).toHaveLength(2);
    expect(agents.find((a) => a.title.startsWith('Research'))!.grant).toEqual({ left: 0, scope: 'API lookups' });
    expect(agents.find((a) => a.title.startsWith('Help for'))!.readOnly).toBe(true);
  });

  it('without a grant the request goes to the lead as before', async () => {
    const t = await setup(undefined);
    await t.svc.send(t.conv.id, 'research it');
    await t.svc.whenIdle();
    expect(t.helperPrompts.some((p) => p.includes('Started by'))).toBe(false);
    expect(t.leadTurns.some((p) => p.includes('look up the API'))).toBe(true);
  });
});
