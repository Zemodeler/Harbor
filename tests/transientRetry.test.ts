import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk, RunOptions } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { isTransientCliError, TRANSIENT_RETRY_DELAYS_MS } from '../src/main/orchestrator';
import { createHarborService } from '../src/main/service';

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const fakeCli = (id: string): ResolvedCli =>
  ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: `/fake/${id}` });
const isConcierge = (o: RunOptions) => !!o.systemPrompt?.includes('front desk');
const answer = (text: string): Chunk[] => [{ kind: 'text', text: JSON.stringify({ answer: text }) }];
const OAUTH = 'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute.';
const oauthFail: Chunk[] = [{ kind: 'done', ok: false, error: OAUTH }];

async function harness(scripts: Record<string, FakeScript>) {
  const adapters: Record<string, FakeAdapter> = {};
  for (const id of Object.keys(scripts)) adapters[id] = new FakeAdapter(id, scripts[id]);
  const waits: number[] = [];
  const svc = createHarborService({
    discover: async () => Object.keys(scripts).map(fakeCli),
    adapterFor: (id) => adapters[id],
    worktreesRoot: join(tmp('harbor-transient-'), 'wt'),
    // Fire every timer at once so the retry waits cost nothing; record what was asked for.
    setTimer: (fn, ms) => { waits.push(ms); queueMicrotask(fn); return () => {}; }
  });
  const project = (await svc.addProject(tmp('harbor-proj-')))!;
  const [conv] = await svc.listConversations(project.id);
  return { svc, adapters, waits, conv: conv! };
}

describe('isTransientCliError', () => {
  it('recognises the Claude OAuth refresh race and nothing else', () => {
    expect(isTransientCliError(OAUTH)).toBe(true);
    expect(isTransientCliError('Not logged in · Please run /login')).toBe(false);
    expect(isTransientCliError(undefined)).toBe(false);
  });
});

describe('transient CLI failures', () => {
  it('retries the same CLI after a wait instead of falling back', async () => {
    let concierge = 0;
    const h = await harness({
      claude: (_p, o) => (isConcierge(o) && concierge++ === 0 ? oauthFail : answer('from claude')),
      codex: () => answer('from codex')
    });
    await h.svc.send(h.conv.id, 'hello');
    await h.svc.whenIdle();
    const texts = (await h.svc.listMessages(h.conv.id)).map((m) => m.text);
    expect(texts.some((t) => t.includes('from claude'))).toBe(true);
    expect(texts.some((t) => t.includes('Falling back'))).toBe(false);
    expect(h.adapters.codex!.calls.length).toBe(0);
    expect(h.waits).toContain(TRANSIENT_RETRY_DELAYS_MS[0]);
  });

  it('falls back to another CLI once the retries are used up', async () => {
    const h = await harness({
      claude: () => oauthFail,
      codex: () => answer('from codex')
    });
    await h.svc.send(h.conv.id, 'hello');
    await h.svc.whenIdle();
    const texts = (await h.svc.listMessages(h.conv.id)).map((m) => m.text);
    expect(h.adapters.claude!.calls.length).toBe(TRANSIENT_RETRY_DELAYS_MS.length + 1);
    expect(texts.some((t) => t.includes('from codex'))).toBe(true);
  });
});
