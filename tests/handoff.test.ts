import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { buildHandoff, evidenceLine } from '../src/main/handoff';
import { parseProtocol, stripProtocol } from '../src/main/prompts';
import { createHarborService } from '../src/main/service';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-handoff-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* Windows handle */ } } });
const say = (text: string): Chunk[] => [{ kind: 'text', text }];

describe('buildHandoff', () => {
  it('is empty when there is nothing to hand over', () => {
    expect(buildHandoff({ decisions: [], work: [], evidence: [], applied: [] })).toBe('');
  });

  it('states decisions, unfinished work and what verification still covers', () => {
    const text = buildHandoff({
      goal: 'ship the login fix', mode: 'goal',
      decisions: ['Use argon2, not bcrypt', 'Do not touch src/legacy'],
      work: [{ title: 'Fix login', role: 'implementer', state: 'done' }, { title: 'Add tests', role: 'implementer', state: 'failed', branch: 'harbor/add-tests', note: 'checks failed' }],
      evidence: [{ title: 'Fix login', branch: 'harbor/fix-login', verdict: 'approve', tested: 'aaaaaaa1111', head: 'bbbbbbb2222' }],
      applied: []
    });
    expect(text).toContain('Use argon2, not bcrypt');
    expect(text).toContain('do not ask the user again');
    expect(text).toContain('Add tests [implementer, failed] on harbor/add-tests: checks failed');
    expect(text).not.toContain('Fix login [implementer');
    expect(text).toContain('STALE');
    expect(text).toContain('bbbbbbb');
  });

  it('marks evidence current only when the tested commit is the head, and keeps the newest decisions within budget', () => {
    expect(evidenceLine({ title: 'x', verdict: 'approve', tested: 'abc1234', head: 'abc1234' })).toContain('current');
    expect(evidenceLine({ title: 'x', checks: [{ cmd: 'npm test', ok: false }], tested: 'abc1234', head: 'abc1234' })).toContain('checks failed (npm test)');
    expect(evidenceLine({ title: 'x', head: 'abc1234' })).toContain('no review or checks recorded');
    const many = Array.from({ length: 30 }, (_, n) => `decision ${n} ${'x'.repeat(200)}`);
    const text = buildHandoff({ decisions: many, work: [], evidence: [], applied: [] });
    expect(text.length).toBeLessThanOrEqual(3600);
    expect(text).not.toContain('decision 0 ');
  });
});

describe('HARBOR_DECISION', () => {
  it('parses at most three per turn and hides the lines from the transcript', () => {
    const t = ['ok', ...[1, 2, 3, 4].map((n) => `HARBOR_DECISION: {"text":"d${n}"}`), 'HARBOR_DECISION: {"text":""}'].join('\n');
    const p = parseProtocol(t);
    expect(p.decision).toEqual(['d1', 'd2', 'd3']);
    expect(p.malformed).toHaveLength(2);
    expect(stripProtocol(t)).toBe('ok');
  });
});

describe('handoff in a fresh session', () => {
  it('a recorded decision reaches a new conversation of the same project, and stale evidence is flagged', async () => {
    const repo = tmp();
    const g = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' }).stdout.trim();
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    writeFileSync(join(repo, 'README.md'), 'hi'); g('add', '.'); g('commit', '-q', '-m', 'init');
    const leadPrompts: string[] = [];
    const script: FakeScript = (prompt, o) => {
      const sys = o.systemPrompt ?? '';
      if (sys.includes('front desk')) return say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }));
      if (sys.includes('LEAD agent')) {
        leadPrompts.push(prompt);
        return say(prompt.includes('use argon2') ? 'Noted.\nHARBOR_DECISION: {"text":"Passwords are hashed with argon2, never bcrypt."}' : 'ok');
      }
      return say('x');
    };
    const adapter = new FakeAdapter('claude', script);
    const cli: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' };
    const svc = createHarborService({ discover: async () => [cli], adapterFor: () => adapter, worktreesRoot: join(tmp(), 'wt'), maxActivePerProject: 2 });
    const project = (await svc.addProject(repo))!;
    const [first] = await svc.listConversations(project.id);
    await svc.send(first!.id, 'use argon2 for passwords');
    await svc.whenIdle();
    expect(svc.store.listCoordination(project.id).filter((c) => c.kind === 'decision').map((c) => c.text)).toEqual(['Passwords are hashed with argon2, never bcrypt.']);

    // A brand-new conversation has no native session to resume: the lead is briefed from Harbor's record.
    const second = await svc.newConversation(project.id);
    await svc.send(second.id, 'now add a password reset');
    await svc.whenIdle();
    const fresh = leadPrompts.at(-1)!;
    expect(fresh).toContain('Project handoff');
    expect(fresh).toContain('never bcrypt');
    expect(fresh).toContain('now add a password reset');
  }, 60_000);
});
