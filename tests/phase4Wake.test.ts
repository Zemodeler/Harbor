import { describe, expect, it } from 'vitest';
import { delegate, harness, isHelper, isLead, result, say, script, until } from './hardeningHarness';

// Phase 4 items 2, 3 and 6b: soft/hard run limits with one automatic resume, the lead woken by Harbor's own stops, and dependents of a
// stopped helper.

const impl = (ref: string, over: Record<string, unknown> = {}) => ({ ref, title: `Write ${ref}`, role: 'implementer', instructions: `write ${ref}`, files: [`src/${ref}.ts`], ...over });
const done = (summary = 'Done.') => `Done\n${result({ outcome: 'done', summary, checks: [] })}`;
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const manualTimers = () => {
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  let now = 1_000_000;
  return { timers, now: () => now, advance: (ms: number) => { now += ms; }, setTimer: (fn: () => void, ms: number) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; } };
};
const SOFT = 2_100_000, HARD = 4_200_000, WINDOW = 300_000;
const fire = (m: ReturnType<typeof manualTimers>, ms: number) => { for (const t of m.timers.filter((x) => !x.cancelled && x.ms === ms)) { t.cancelled = true; t.fn(); } };

describe('the lead is woken when Harbor stops a helper (the 14:38 run)', () => {
  it('a helper capped twice ends stopped with its branch and wakes the lead at once; a user stop still does not', async () => {
    const m = manualTimers();
    const gates = [gate(), gate()];
    let calls = 0;
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('ledger', { title: 'Repair the ledger diff' })) : say('noted')),
      helper: async () => { const g = gates[calls++]; if (g) await g.p; return say(done()); }
    }) }, { service: { stall: { stallMs: 10 * 3_600_000, helperSoftCapMs: SOFT, helperCapMs: HARD, activeWindowMs: WINDOW, setTimer: m.setTimer, now: m.now } } });
    await h.svc.send(h.conv.id, 'repair the ledger');
    await until(() => calls === 1);
    fire(m, HARD); gates[0]!.open();
    await until(() => calls === 2);
    fire(m, HARD); gates[1]!.open();
    await h.svc.whenIdle();
    const a = h.helper('Repair the ledger diff');
    expect(a.state).toBe('stopped');
    expect(a.stopKind).toBe('cap');
    expect(a.capResumes).toBe(1);
    expect(a.error).toMatch(/hard limit of 70 minutes \(after one automatic resume\)\. Its work so far is committed on harbor\//);
    // The lead got a report turn for it without the user typing (in the real run nobody woke it for 28 minutes).
    const leads = h.calls(isLead);
    expect(leads).toHaveLength(2);
    expect(leads[1]!.prompt).toContain('Helper reports');
    expect(leads[1]!.prompt).toContain('Repair the ledger diff');
    expect(a.reportDelivery).toMatchObject({ status: 'confirmed', state: 'stopped' });
  });

  it('stops an idle run at the soft limit; an active one continues to the hard limit', async () => {
    const m = manualTimers();
    const g = gate();
    let calls = 0;
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('a')) : say('ok')),
      helper: async () => { calls++; if (calls === 1) await g.p; return say(done()); }
    }) }, { service: { stall: { stallMs: 10 * 3_600_000, helperSoftCapMs: SOFT, helperCapMs: HARD, activeWindowMs: WINDOW, setTimer: m.setTimer, now: m.now } } });
    await h.svc.send(h.conv.id, 'write a');
    await until(() => calls === 1);
    // Active: its last output (the run start) is recent, so the soft limit only schedules another look.
    fire(m, SOFT);
    expect(m.timers.some((t) => !t.cancelled && t.ms === WINDOW)).toBe(true);
    // Quiet for longer than the window: the next look stops it.
    m.advance(WINDOW + 1);
    fire(m, WINDOW);
    g.open();
    await h.svc.whenIdle();
    expect(calls).toBe(2); // stopped, then resumed once to finish
    expect(h.helper('Write a').state).toBe('done');
    expect((await h.texts()).some((t) => t.includes('with no output for 5 minutes') && t.includes('resumes it once'))).toBe(true);
  });
});

describe('dependents of a stopped or failed helper', () => {
  it('a task that builds on a helper Harbor stopped resumes that helper first instead of failing', async () => {
    const m = manualTimers();
    const gates = [gate(), gate()];
    let calls = 0, followUpDelegated = false;
    let firstId = '';
    const h = await harness({ claude: script({
      lead: (p) => {
        if (p.includes('User:')) return delegate('go', impl('a'));
        if (!followUpDelegated && firstId && p.includes('Helper reports')) { followUpDelegated = true; return delegate('next', impl('b', { dependsOn: [firstId] })); }
        return say('ok');
      },
      helper: async (p) => { const g = gates[calls++]; if (g) await g.p; return say(p.includes('Write b') ? done('b done') : done('a done')); }
    }) }, { service: { stall: { stallMs: 10 * 3_600_000, helperSoftCapMs: SOFT, helperCapMs: HARD, activeWindowMs: WINDOW, setTimer: m.setTimer, now: m.now } } });
    await h.svc.send(h.conv.id, 'write a then b');
    await until(() => calls === 1);
    firstId = h.helper('Write a').id;
    fire(m, HARD); gates[0]!.open();
    await until(() => calls === 2);
    fire(m, HARD); gates[1]!.open();
    await h.svc.whenIdle();
    expect(h.helper('Write a').state).toBe('done'); // resumed for its dependent and finished
    expect(h.helper('Write a').depResumed).toBe(true);
    expect(h.helper('Write b').state).toBe('done');
    expect((await h.texts()).some((t) => t.includes('"Write b" builds on "Write a"') && t.includes('Harbor resumes "Write a"'))).toBe(true);
  });

  it('a task whose dependency failed fails with the options and wakes the lead', async () => {
    let failedOnce = false;
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('a'), impl('b', { dependsOn: ['a'] })) : say('ok')),
      helper: () => { if (!failedOnce) { failedOnce = true; return [{ kind: 'done', ok: false, error: 'compiler crashed' }]; } return say(done()); }
    }) });
    await h.svc.send(h.conv.id, 'write a then b');
    await h.svc.whenIdle();
    const b = h.helper('Write b');
    expect(b.state).toBe('failed');
    expect(b.error).toMatch(/Blocked: dependency "Write a" failed\. Nothing was run\. Options: continue it with HARBOR_REPLY to id=.* re-plan without it/);
    expect(h.calls(isHelper)).toHaveLength(1);
    expect(h.calls(isLead)[1]!.prompt).toContain('Write b');
  });
});
