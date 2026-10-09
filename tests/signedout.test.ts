import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseClaudeLine } from '../src/main/adapters/claude';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk, RunOptions } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { createHarborService } from '../src/main/service';
import type { HarborEvent } from '../src/shared/api';

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const fakeCli = (id: string): ResolvedCli =>
  ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: `/fake/${id}` });

const isConcierge = (o: RunOptions) => !!o.systemPrompt?.includes('front desk');
const answer = (text: string): Chunk[] => [{ kind: 'text', text: JSON.stringify({ answer: text }) }];
const signedOut: Chunk[] = [{ kind: 'done', ok: false, error: 'Not logged in · Please run /login' }];

describe('parseClaudeLine: login failure', () => {
  it('reports "Not logged in" from the result line as a failed run with that text', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', usage: {} });
    const done = parseClaudeLine(line).find((c) => c.kind === 'done');
    expect(done).toMatchObject({ kind: 'done', ok: false, error: 'Not logged in · Please run /login' });
  });
});

async function harness(scripts: Record<string, FakeScript>) {
  const adapters: Record<string, FakeAdapter> = {};
  for (const id of Object.keys(scripts)) adapters[id] = new FakeAdapter(id, scripts[id]);
  let discovered: ResolvedCli[] = Object.keys(scripts).map(fakeCli);
  const events: HarborEvent[] = [];
  const svc = createHarborService({
    discover: async () => discovered,
    adapterFor: (id) => adapters[id],
    worktreesRoot: join(tmp('harbor-signedout-'), 'wt'),
    maxActivePerProject: 3
  });
  svc.onEvent((e) => events.push(e));
  const project = (await svc.addProject(tmp('harbor-proj-')))!;
  const [conv] = await svc.listConversations(project.id);
  return {
    svc, adapters, events, conv: conv!,
    setDiscovered: (list: ResolvedCli[]) => { discovered = list; }
  };
}

describe('signed-out CLIs leave routing', () => {
  it('marks the CLI signedOut, emits a cli event, and stops routing to it until refreshClis()', async () => {
    const h = await harness({
      // Claude's concierge run fails with a login message; codex answers.
      claude: (_p, o) => (isConcierge(o) ? signedOut : answer('from claude')),
      codex: (_p, o) => answer(isConcierge(o) ? 'from codex' : 'x')
    });
    await h.svc.send(h.conv.id, 'hello');
    await h.svc.whenIdle();

    const claudeCalls = () => h.adapters.claude!.calls.length;
    const before = claudeCalls();
    expect(before).toBeGreaterThan(0);

    const claude = (await h.svc.listClis()).find((c) => c.id === 'claude')!;
    expect(claude).toMatchObject({ installed: true, signedIn: false, authState: 'signedOut' });
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'cli', cli: expect.objectContaining({ id: 'claude', authState: 'signedOut' }) }));

    // Routing skips the signed-out CLI now, so a new message does not reach claude again.
    await h.svc.send(h.conv.id, 'again');
    await h.svc.whenIdle();
    expect(claudeCalls()).toBe(before);

    // refreshClis() re-reads sign-in state; once discovery says signed in, claude is routable again.
    const refreshed = await h.svc.refreshClis();
    expect(refreshed.find((c) => c.id === 'claude')!.authState).toBe('signedIn');
    await h.svc.send(h.conv.id, 'after refresh');
    await h.svc.whenIdle();
    expect(claudeCalls()).toBeGreaterThan(before);
    h.svc.shutdown();
  });

  it('does not mark a CLI signed out for ordinary failures', async () => {
    const h = await harness({
      claude: (_p, o) => (isConcierge(o) ? [{ kind: 'done', ok: false, error: 'overloaded, try later' }] : answer('x')),
      codex: (_p, o) => answer(isConcierge(o) ? 'ok' : 'x')
    });
    await h.svc.send(h.conv.id, 'hello');
    await h.svc.whenIdle();
    const claude = (await h.svc.listClis()).find((c) => c.id === 'claude')!;
    expect(claude.authState).toBe('signedIn');
    expect(h.events.some((e) => e.type === 'cli' && e.cli.authState === 'signedOut')).toBe(false);
    h.svc.shutdown();
  });
});
