import { describe, expect, it } from 'vitest';
import type { Chunk, RunOptions } from '../src/main/adapters/types';
import { delegate, harness, isHelper, isLead, result, say } from './hardeningHarness';

// Phase 6: the loop guard wired into helper runs: stop, one automatic resume with a different instruction, then the lead decides.

const impl = (ref: string) => ({ ref, title: `Write ${ref}`, role: 'implementer', instructions: `write ${ref}`, files: [`src/${ref}.ts`] });
const done = (summary = 'Done.') => `Done\n${result({ outcome: 'done', summary, checks: [] })}`;
const looping = (): Chunk[] => Array.from({ length: 8 }, () => ({ kind: 'tool', text: 'Bash npm test' }) as Chunk);
/** No clock needed: the repeats count without a minimum span; the probe never fires (default interval, real timers). */
const guard = (over: Record<string, unknown> = {}) => ({ stall: { loopGuard: { limits: { repeatMinSpanMs: 0 }, ...over } } });

describe('loop guard in the orchestrator', () => {
  it('first loop: stopped and resumed once with what looped; the resumed run finishes', async () => {
    let calls = 0;
    const h = await harness({ claude: (p, o) => {
      if (isHelper(o)) { calls++; return calls === 1 ? looping() : say(done()); }
      return isLead(o) ? (p.includes('User:') ? delegate('go', impl('a')) : say('ok')) : say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }));
    } }, { service: guard() });
    await h.svc.send(h.conv.id, 'write a');
    await h.svc.whenIdle();
    const helpers = h.calls(isHelper);
    expect(helpers).toHaveLength(2);
    expect(helpers[1]!.prompt).toMatch(/going in circles: it ran `bash npm test` 6 times/);
    expect(helpers[1]!.prompt).toContain('Do not repeat it; take a different approach');
    expect(helpers[1]!.prompt).toMatch(/committed on branch harbor\//);
    const a = h.helper('Write a');
    expect(a.state).toBe('done');
    expect(a.loopResumes).toBe(1);
    expect((await h.texts()).some((t) => t.startsWith('Stopped "Write a": it ran `bash npm test` 6 times') && t.includes('resuming it once with a different instruction'))).toBe(true);
    expect(h.svc.orchestrator.journal.list(h.project.id).filter((e) => e.kind === 'loop').map((e) => e.text)).toEqual([expect.stringMatching(/implementer "Write a": it ran .* \(repeat\); resumed once/)]);
  });

  it('second loop: stays stopped with the evidence and wakes the lead', async () => {
    const h = await harness({ claude: (p, o) => {
      if (isHelper(o)) return looping();
      return isLead(o) ? (p.includes('User:') ? delegate('go', impl('a')) : say('ok')) : say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }));
    } }, { service: guard() });
    await h.svc.send(h.conv.id, 'write a');
    await h.svc.whenIdle();
    const a = h.helper('Write a');
    expect(h.calls(isHelper)).toHaveLength(2);
    expect(a.state).toBe('stopped');
    expect(a.stopKind).toBe('loop');
    expect(a.error).toMatch(/going in circles: it ran `bash npm test` 6 times.*after one automatic resume.*The lead decides/);
    const leads = h.calls(isLead);
    expect(leads).toHaveLength(2);
    expect(leads[1]!.prompt).toContain('Helper reports');
    expect(leads[1]!.prompt).toContain('Write a');
  });

  it('a user stop is never a loop, and enabled: false turns the guard off', async () => {
    // User stop: the stop arrives while the run repeats itself; the run ends as a user stop and nothing resumes it.
    const h = await harness({ claude: (p, o) => (isLead(o) ? (p.includes('User:') ? delegate('go', impl('a')) : say('ok')) : isHelper(o) ? say(done()) : say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }))) }, { service: guard() });
    const fake = h.adapters.claude!;
    const orig = fake.run.bind(fake);
    fake.run = async function* (prompt: string, opts: RunOptions) {
      if (!isHelper(opts)) { yield* orig(prompt, opts); return; }
      fake.calls.push({ prompt, opts });
      yield { kind: 'session', id: 'helper-session' } as Chunk;
      for (let i = 0; i < 5; i++) yield { kind: 'tool', text: 'Bash npm test' } as Chunk;
      await h.svc.stopAgent(h.helper('Write a').id);
      yield { kind: 'tool', text: 'Bash npm test' } as Chunk;
      yield { kind: 'done', ok: false, error: 'stopped' } as Chunk;
    };
    await h.svc.send(h.conv.id, 'write a');
    await h.svc.whenIdle();
    const a = h.helper('Write a');
    expect(a.state).toBe('stopped');
    expect(a.stopKind).toBe('user');
    expect(a.loopResumes).toBeUndefined();
    expect(h.calls(isHelper)).toHaveLength(1);

    const off = await harness({ claude: (p, o) => {
      if (isHelper(o)) return [...looping(), { kind: 'text', text: done() }];
      return isLead(o) ? (p.includes('User:') ? delegate('go', impl('a')) : say('ok')) : say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }));
    } }, { service: guard({ enabled: false }) });
    await off.svc.send(off.conv.id, 'write a');
    await off.svc.whenIdle();
    expect(off.helper('Write a').state).toBe('done');
    expect(off.calls(isHelper)).toHaveLength(1);
  });

  it('the lead only gets a notice: it is never stopped by the guard', async () => {
    const h = await harness({ claude: (p, o) => {
      if (isLead(o)) return [...looping(), { kind: 'text', text: 'All done.' }];
      return say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }));
    } }, { service: guard() });
    await h.svc.send(h.conv.id, 'fix the tests');
    await h.svc.whenIdle();
    const texts = await h.texts();
    expect(texts.some((t) => t.startsWith('The lead may be going in circles: it ran `bash npm test` 6 times') && t.includes('Use Stop'))).toBe(true);
    expect(texts).toContain('All done.');
  });
});
