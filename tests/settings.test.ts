import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Settings } from '../src/shared/api';
import { FakeAdapter } from '../src/main/adapters/fake';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { applyEffortPolicy, route, type RouteRequest, type RoutingPolicy } from '../src/main/router';
import { createHarborService } from '../src/main/service';
import { DEFAULT_SETTINGS, Store, effectiveSettings, normalizeSettingsPatch } from '../src/main/store';
import type { AgentRecord } from '../src/main/types';
import { UsageLedger } from '../src/main/usage';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-settings-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const cli = (id: string, over: Partial<ResolvedCli> = {}): ResolvedCli =>
  ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: `/fake/${id}`, ...over });

function ledgerWith(runs: Record<string, number> = {}, budget = 10) {
  const ledger = new UsageLedger(new Store(), { now: () => 1, runsPerWindow: { default: budget } });
  for (const [c, n] of Object.entries(runs)) for (let i = 0; i < n; i++) ledger.record({ cli: c, model: 'm', projectId: 'p', agentId: 'a', durationMs: 1, ok: true });
  return ledger;
}
const input = (ledger: UsageLedger, policy?: RoutingPolicy, clis = [cli('claude'), cli('codex')]) =>
  ({ clis, ledger, enabled: () => true, hasAdapter: () => true, load: () => 0, policy });
/** What the orchestrator passes for a role, built from settings the same way. */
const policyFor = (s: Settings, role: RouteRequest['role'], projectId?: string): RoutingPolicy => {
  const e = effectiveSettings(s, projectId);
  return { allowedModels: e.allowedModels, effortPolicy: e.effortPolicy, lowAllowance: e.lowAllowancePolicy, reserve: e.subscriptionReserve, preference: role === 'main' ? undefined : e.rolePreferences[role] };
};

describe('settings validation', () => {
  it('clamps and rounds numbers into range', () => {
    expect(normalizeSettingsPatch({ concurrencyLimit: 0 }).concurrencyLimit).toBe(1);
    expect(normalizeSettingsPatch({ concurrencyLimit: 20 }).concurrencyLimit).toBe(8);
    expect(normalizeSettingsPatch({ concurrencyLimit: 2.6 }).concurrencyLimit).toBe(3);
    expect(normalizeSettingsPatch({ subscriptionReserve: -5 }).subscriptionReserve).toBe(0);
    expect(normalizeSettingsPatch({ subscriptionReserve: 90 }).subscriptionReserve).toBe(50);
  });

  it('rejects values it cannot interpret', () => {
    expect(() => normalizeSettingsPatch({ concurrencyLimit: Number.NaN })).toThrow(/concurrencyLimit/);
    expect(() => normalizeSettingsPatch({ concurrencyLimit: '3' as unknown as number })).toThrow(/concurrencyLimit/);
    expect(() => normalizeSettingsPatch({ effortPolicy: 'max' as never })).toThrow(/effortPolicy/);
    expect(() => normalizeSettingsPatch({ lowAllowancePolicy: 'defer' as never })).toThrow(/lowAllowancePolicy/);
    expect(() => normalizeSettingsPatch({ allowedModels: { claude: 'opus' as unknown as string[] } })).toThrow(/allowedModels/);
    expect(() => normalizeSettingsPatch({ projectOverrides: { p1: { effortPolicy: 'x' as never } } })).toThrow(/effortPolicy/);
  });

  it('drops blank model names, empty lists and unknown roles', () => {
    const p = normalizeSettingsPatch({
      allowedModels: { claude: [' sonnet ', '', 'sonnet', 'haiku'], codex: [] },
      rolePreferences: { implementer: { cli: 'codex' }, reviewer: { cli: ' ', model: '' }, main: { cli: 'claude' } } as Settings['rolePreferences']
    });
    expect(p.allowedModels).toEqual({ claude: ['sonnet', 'haiku'] });
    expect(p.rolePreferences).toEqual({ implementer: { cli: 'codex' } });
  });

  it('a failed validation changes nothing', () => {
    const s = new Store();
    s.setSettings({ concurrencyLimit: 2 });
    expect(() => s.setSettings({ concurrencyLimit: 3, effortPolicy: 'bogus' as never })).toThrow();
    expect(s.getSettings().concurrencyLimit).toBe(2);
  });

  it('undefined resets a field; project entries replace per project and {} removes one', () => {
    const s = new Store();
    s.setSettings({ concurrencyLimit: 2, effortPolicy: 'conserve', projectOverrides: { p1: { concurrencyLimit: 1 }, p2: { effortPolicy: 'quality' } } });
    s.setSettings({ concurrencyLimit: undefined, projectOverrides: { p1: { subscriptionReserve: 10 }, p2: {} } });
    expect(s.getSettings()).toEqual({ ...DEFAULT_SETTINGS, effortPolicy: 'conserve', projectOverrides: { p1: { subscriptionReserve: 10 } } });
    expect('concurrencyLimit' in s.getSettings()).toBe(false);
    s.setSettings({ projectOverrides: { p1: {} } });
    expect('projectOverrides' in s.getSettings()).toBe(false);
  });

  it('new routing settings persist across a reload', () => {
    const dir = tmp();
    const s = new Store(dir);
    s.setSettings({ allowedModels: { claude: ['sonnet'] }, projectOverrides: { p1: { lowAllowancePolicy: 'switch' } } });
    s.flush();
    expect(new Store(dir).getSettings()).toMatchObject({ allowedModels: { claude: ['sonnet'] }, projectOverrides: { p1: { lowAllowancePolicy: 'switch' } } });
  });
});

describe('effectiveSettings', () => {
  it('defaults when nothing is set', () => {
    expect(effectiveSettings(DEFAULT_SETTINGS, 'p1')).toEqual({
      concurrencyLimit: undefined, allowedModels: {}, rolePreferences: {}, effortPolicy: 'adaptive', lowAllowancePolicy: 'reduceEffort', subscriptionReserve: 0
    });
  });

  it('project values win per field, per CLI and per role; other projects see the global values', () => {
    const s: Settings = {
      ...DEFAULT_SETTINGS, concurrencyLimit: 3, effortPolicy: 'conserve', subscriptionReserve: 20,
      allowedModels: { claude: ['sonnet'], codex: ['default'] },
      rolePreferences: { implementer: { cli: 'codex' }, reviewer: { cli: 'claude' } },
      projectOverrides: { p1: { concurrencyLimit: 1, allowedModels: { claude: ['opus'] }, rolePreferences: { reviewer: { cli: 'codex', model: 'default' } } } }
    };
    expect(effectiveSettings(s, 'p1')).toEqual({
      concurrencyLimit: 1, effortPolicy: 'conserve', lowAllowancePolicy: 'reduceEffort', subscriptionReserve: 20,
      allowedModels: { claude: ['opus'], codex: ['default'] },
      rolePreferences: { implementer: { cli: 'codex' }, reviewer: { cli: 'codex', model: 'default' } }
    });
    expect(effectiveSettings(s, 'p2').concurrencyLimit).toBe(3);
    expect(effectiveSettings(s).allowedModels).toEqual({ claude: ['sonnet'], codex: ['default'] });
  });
});

describe('router with settings', () => {
  it('default settings route exactly like no policy at all', () => {
    const reqs: RouteRequest[] = [
      { role: 'implementer', complexity: 'low' }, { role: 'implementer', complexity: 'medium', needs: ['code'] },
      { role: 'planner', complexity: 'high' }, { role: 'reviewer', complexity: 'medium', retry: true },
      { role: 'main', complexity: 'low', tier: 'cheap', effort: 'low', fixedEffort: true, needs: ['chat'] },
      { role: 'main', complexity: 'high', tier: 'strong', effort: 'high', fixedEffort: true }, { role: 'other', complexity: 'low', continuity: 'codex' }
    ];
    for (const ledger of [ledgerWith(), ledgerWith({ claude: 6 }), ledgerWith({ claude: 9, codex: 8 })]) {
      for (const r of reqs) expect(route(r, input(ledger, policyFor(DEFAULT_SETTINGS, r.role, 'p1')))).toEqual(route(r, input(ledger)));
    }
  });

  it('allowed models narrow the catalog; a CLI with no allowed model is skipped', () => {
    const ledger = ledgerWith();
    const strong = route({ role: 'planner', complexity: 'high' }, input(ledger, { allowedModels: { claude: ['sonnet', 'haiku'] } }, [cli('claude')]))!;
    expect(strong.model).toBe('sonnet');
    const d = route({ role: 'implementer', complexity: 'medium' }, input(ledger, { allowedModels: { claude: ['no-such-model'] } }))!;
    expect(d.cli).toBe('codex');
    expect(d.reason).toMatch(/claude skipped: no allowed model/);
  });

  it('a role preference picks its CLI and model but never a skipped one', () => {
    const ledger = ledgerWith();
    const base = route({ role: 'implementer', complexity: 'medium', needs: ['code'] }, input(ledger))!;
    expect(base.cli).toBe('claude');
    const d = route({ role: 'implementer', complexity: 'medium', needs: ['code'] }, input(ledger, { preference: { cli: 'codex' } }))!;
    expect(d.cli).toBe('codex');
    expect(d.reason).toMatch(/preferred for implementer/);
    expect(route({ role: 'implementer', complexity: 'low' }, input(ledger, { preference: { cli: 'claude', model: 'opus' } }))!.model).toBe('opus');
    expect(route({ role: 'implementer', complexity: 'medium' }, input(ledger, { preference: { cli: 'codex' } }, [cli('claude'), cli('codex', { authState: 'signedOut', signedIn: false })]))!.cli).toBe('claude');
  });

  it('effort policy shifts effort, keeps retries under conserve and leaves fixed effort alone', () => {
    expect(applyEffortPolicy('medium', 'conserve')).toBe('low');
    expect(applyEffortPolicy('high', 'conserve', true)).toBe('high');
    expect(applyEffortPolicy('medium', 'quality')).toBe('high');
    expect(applyEffortPolicy('medium', 'adaptive')).toBe('medium');
    const ledger = ledgerWith();
    const c = route({ role: 'implementer', complexity: 'medium' }, input(ledger, { effortPolicy: 'conserve' }))!;
    expect(c.effort).toBe('low');
    expect(c.reason).toMatch(/effort medium → low: conserve policy/);
    expect(route({ role: 'implementer', complexity: 'low' }, input(ledger, { effortPolicy: 'quality' }))!.effort).toBe('medium');
    expect(route({ role: 'main', complexity: 'low', tier: 'cheap', effort: 'low', fixedEffort: true }, input(ledger, { effortPolicy: 'quality' }))!.effort).toBe('low');
  });

  it("low-allowance 'switch' prefers a healthy CLI that 'reduceEffort' would not", () => {
    const ledger = ledgerWith({ claude: 8 }); // claude at 80%: low
    const req: RouteRequest = { role: 'planner', complexity: 'high', continuity: 'claude' };
    const reduce = route(req, input(ledger))!;
    expect(reduce).toMatchObject({ cli: 'claude', effort: 'medium' });
    expect(reduce.reason).toMatch(/effort lowered: allowance low/);
    expect(route(req, input(ledger, { lowAllowance: 'switch' }))!.cli).toBe('codex');
    const alone = route(req, input(ledger, { lowAllowance: 'switch' }, [cli('claude')]))!;
    expect(alone.cli).toBe('claude');
    expect(alone.reason).toMatch(/no healthier option/);
  });

  it('subscription reserve skips models inside the reserve', () => {
    const ledger = ledgerWith({ claude: 7 }); // 70%
    expect(route({ role: 'implementer', complexity: 'medium' }, input(ledger, { reserve: 20 }, [cli('claude')]))!.cli).toBe('claude');
    const d = route({ role: 'implementer', complexity: 'medium' }, input(ledger, { reserve: 30 }))!;
    expect(d.cli).toBe('codex');
    expect(d.reason).toMatch(/inside the 30% subscription reserve/);
    expect(route({ role: 'implementer', complexity: 'medium' }, input(ledger, { reserve: 30 }, [cli('claude')]))).toBeUndefined();
  });
});

describe('concurrency limit', () => {
  /** Helpers block until released, so the number started equals the number of free slots. */
  async function harness(svcOpts: { maxActivePerProject?: number } = {}) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = 0;
    const adapter = new FakeAdapter('claude', async (prompt) => {
      if (/TASK-/.test(prompt)) { started++; await gate; }
      return [{ kind: 'text', text: 'ok' }];
    });
    const svc = createHarborService({ discover: async () => [cli('claude')], adapterFor: () => adapter, worktreesRoot: join(tmp(), 'wt'), ...svcOpts });
    const project = (await svc.addProject(tmp()))!;
    const [conv] = await svc.listConversations(project.id);
    const addMany = (n: number) => {
      for (let i = 0; i < n; i++) svc.store.upsertAgent({
        id: `agent-${i}`, projectId: project.id, role: 'other', readOnly: true, title: `T${i}`, state: 'queued', cli: 'auto', model: 'auto', effort: 'low',
        task: `TASK-${i}`, dependsOn: [], revision: 1, parentConversationId: conv!.id, attempts: 0, created: 1000 + i
      } satisfies AgentRecord);
      svc.orchestrator.pump(project.id);
    };
    const running = async () => (await svc.listAgents(project.id)).filter((a) => a.role !== 'main' && a.state === 'working').length;
    const settle = () => new Promise((r) => setTimeout(r, 50));
    return { svc, project, addMany, running, settle, started: () => started, release };
  }

  it('unset keeps the built-in default of 4', async () => {
    const h = await harness();
    h.addMany(6);
    await h.settle();
    expect(h.started()).toBe(4);
    h.release(); await h.svc.whenIdle();
    expect(h.started()).toBe(6);
  });

  it('the setting overrides the default, a project override wins, and raising it starts waiting work', async () => {
    const h = await harness({ maxActivePerProject: 3 });
    await h.svc.setSettings({ concurrencyLimit: 5, projectOverrides: { [h.project.id]: { concurrencyLimit: 1 } } });
    h.addMany(4);
    await h.settle();
    expect(h.started()).toBe(1);
    await h.svc.setSettings({ projectOverrides: { [h.project.id]: {} } });
    await h.settle();
    expect(h.started()).toBe(4); // global 5 now applies
    h.release(); await h.svc.whenIdle();
  });

  it('setSettings clamps through the service', async () => {
    const h = await harness();
    expect((await h.svc.setSettings({ concurrencyLimit: 99 })).concurrencyLimit).toBe(8);
    await expect(h.svc.setSettings({ effortPolicy: 'nope' as never })).rejects.toThrow(/effortPolicy/);
  });
});
