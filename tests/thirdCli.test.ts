import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter } from '../src/main/adapters/fake';
import type { ReportedLimit } from '../src/main/codexLimits';
import { createHarborService } from '../src/main/service';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '../src/main/clis/capabilities';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { route, type RouterInput } from '../src/main/router';
import { Store } from '../src/main/store';
import { UsageLedger } from '../src/main/usage';
import { EQUAL_POOLS } from './fixtures/catalogs';

// G3: a third CLI takes work when the first two are exhausted, and the decision's reason says so (the orchestrator stores
// `decision.reason` in Message.details.reason; see tests/orchestrator for that hand-off).
const NOW = 50_000_000_000;
const HOUR = 3_600_000;
const cli = (id: string, over: Partial<ResolvedCli> = {}): ResolvedCli =>
  ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'], ...over });

function ledgerWith(exhausted: string[]) {
  const ledger = new UsageLedger(new Store(), { now: () => NOW, runsPerWindow: { default: 10 } });
  for (const c of exhausted) {
    ledger.record({ cli: c, model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true,
      limits: [{ period: 'session', usedPct: 100, resetsAt: NOW + 4 * HOUR, asOf: NOW }] });
  }
  return ledger;
}
const input = (ledger: UsageLedger, extra: Partial<RouterInput> = {}): RouterInput =>
  ({ clis: [cli('claude'), cli('codex'), cli('gemini')], ledger, enabled: () => true, hasAdapter: () => true, load: () => 0, calibration: EQUAL_POOLS, catalog: DEFAULT_CATALOG, ...extra });

describe('a third CLI takes work when two are exhausted', () => {
  it('routes to gemini and the reason names both exhausted CLIs', () => {
    const d = route({ role: 'implementer', complexity: 'medium', needs: ['code'] }, input(ledgerWith(['claude', 'codex'])))!;
    expect(d.cli).toBe('gemini');
    expect(d.model).toMatch(/^gemini-/);
    expect(d.reason).toMatch(/claude/);
    expect(d.reason).toMatch(/codex/);
    expect(d.reason).toMatch(/gemini/);
    expect(d.skipped?.some((s) => s.cli === 'claude' && /exhausted|limit|used up|window/i.test(s.why))).toBe(true);
  });

  it('with only one exhausted, the third CLI is not forced in', () => {
    const d = route({ role: 'implementer', complexity: 'medium', needs: ['code'] }, input(ledgerWith(['claude'])))!;
    expect(d.cli).not.toBe('claude');
  });

  it('does not take work when it has no adapter or the owner turned it off', () => {
    const l = ledgerWith(['claude', 'codex']);
    expect(route({ role: 'implementer', complexity: 'medium' }, input(l, { hasAdapter: (c) => c !== 'gemini' }))).toBeUndefined();
    expect(route({ role: 'implementer', complexity: 'medium' }, input(l, { enabled: (c) => c !== 'gemini' }))).toBeUndefined();
  });

  it('a signed-out gemini is skipped with its reason', () => {
    const l = ledgerWith(['claude', 'codex']);
    const d = route({ role: 'implementer', complexity: 'medium' }, input(l, { clis: [cli('claude'), cli('codex'), cli('gemini', { authState: 'signedOut', signedIn: false })] }));
    expect(d).toBeUndefined();
  });
});

describe('through the service: the reason lands in Message.details.reason', () => {
  it('claude and codex report a full window; gemini answers and the stored reason says why it was chosen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor-third-'));
    try {
      const adapters = {
        claude: new FakeAdapter('claude', () => [{ kind: 'text', text: 'SHOULD NOT RUN' }]),
        codex: new FakeAdapter('codex', () => [{ kind: 'text', text: 'SHOULD NOT RUN' }]),
        gemini: new FakeAdapter('gemini', () => [{ kind: 'text', text: JSON.stringify({ answer: 'Hello from Gemini' }) }])
      };
      const full = (cli: string): ReportedLimit[] => {
        const now = Date.now();
        return cli === 'gemini' ? [] : [
          { period: 'weekly', usedPct: 100, resetsAt: now + 4 * 24 * HOUR, asOf: now - 60_000 },
          { period: 'session', usedPct: 100, resetsAt: now + 4 * HOUR, asOf: now - 60_000 }
        ];
      };
      const svc = createHarborService({
        discover: async () => Object.keys(adapters).map((id) => ({ ...cli(id), path: `/fake/${id}` })),
        adapterFor: (id) => adapters[id as keyof typeof adapters],
        worktreesRoot: join(dir, 'wt'), ledger: { reported: full }
      });
      const project = (await svc.addProject(dir))!;
      const [conv] = await svc.listConversations(project.id);
      await svc.send(conv!.id, 'hello');
      await svc.whenIdle();
      expect(adapters.claude.calls).toHaveLength(0);
      expect(adapters.codex.calls).toHaveLength(0);
      expect(adapters.gemini.calls.length).toBeGreaterThan(0);
      const reply = (await svc.listMessages(conv!.id)).find((m) => m.role === 'assistant')!;
      expect(reply.details).toMatchObject({ cli: 'gemini' });
      expect(reply.details!.reason).toMatch(/claude/);
      expect(reply.details!.reason).toMatch(/codex/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
