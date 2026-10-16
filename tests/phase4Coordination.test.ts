import { describe, expect, it } from 'vitest';
import type { HarborEvent } from '../src/shared/api';
import { delegate, harness, isHelper, isLead, result, say, script } from './hardeningHarness';

// Phase 4 item 4: a helper's coordination questions go to the lead first; only the user's own questions reach the user, with a safe
// default after a timeout.

const done = (summary = 'Done.') => `Done\n${result({ outcome: 'done', summary, checks: [] })}`;
const planner = { ref: 'a', title: 'Port the ai package', role: 'implementer', instructions: 'port packages/ai', files: ['packages/ai'] };
const questions = (h: { events: HarborEvent[] }) => h.events.filter((e): e is Extract<HarborEvent, { type: 'question' }> => e.type === 'question');
const askLine = (q: string) => `Stopping here.\nHARBOR_ASK: ${JSON.stringify({ question: q, options: ['Yes', 'No'] })}`;
const idIn = (p: string) => /Question from helper "[^"]+" \(id=([^)]+)\)/.exec(p)?.[1] ?? '';

describe('helper questions', () => {
  it('a file-claim question is answered by the lead with HARBOR_REPLY; the user is never asked', async () => {
    const q = 'May I include the four packages/ai files from c8afb84 unchanged?';
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', planner)
        : p.includes('Question from helper') ? say(`Yes: they are in scope.\nHARBOR_REPLY: ${JSON.stringify({ to: idIn(p), text: 'Yes, include them unchanged.' })}`) : say('ok')),
      helper: (p) => (p.includes('Message from the lead: Yes, include them unchanged.') ? say(done()) : say(askLine(q)))
    }) });
    await h.svc.send(h.conv.id, 'port the ai package');
    await h.svc.whenIdle();
    expect(questions(h)).toHaveLength(0);
    const calls = h.calls(isHelper);
    expect(calls).toHaveLength(2); // the reply is delivered once (the prose is not forwarded on top of it)
    expect(h.helper('Port the ai package').state).toBe('done');
    expect((await h.texts()).some((t) => t.startsWith('The lead replied to "Port the ai package"'))).toBe(true);
  });

  it('a question the lead marks as the user\'s goes to the user on the helper\'s behalf, and the answer goes back to the helper', async () => {
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', planner)
        : p.includes('Question from helper') ? say('This is a product decision.\nHARBOR_ASK: {"question":"Should the AI package keep the legacy prompt format?","options":["Keep","Drop"]}') : say('ok')),
      helper: (p) => (p.includes('Keep') ? say(done()) : say(askLine('Keep the legacy prompt format?')))
    }) });
    await h.svc.send(h.conv.id, 'port the ai package');
    await h.svc.whenIdle();
    const [q] = questions(h);
    const helperId = h.helper('Port the ai package').id;
    expect(q).toMatchObject({ prompt: 'Should the AI package keep the legacy prompt format?', agentId: helperId });
    expect(h.helper('Port the ai package').state).toBe('waiting');
    await h.svc.answerQuestion(q!.requestId, 'Keep');
    await h.svc.whenIdle();
    expect(h.helper('Port the ai package').state).toBe('done');
    expect(h.calls(isLead)).toHaveLength(3); // user turn, the question, the final report: the user's answer went to the helper directly
  });

  it('a destructive question goes straight to the user and gets the safe default ("no") after the timeout', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', planner) : say('ok')),
      helper: (p) => (p.includes('Harbor applies the safe default') ? say(done('kept the table')) : say(askLine('Can I drop the database table and recreate it?')))
    }) }, { service: { questionTimeoutMs: 600_000, setTimer: (fn, ms) => { timers.push({ fn, ms }); return () => {}; } } });
    await h.svc.send(h.conv.id, 'port the ai package');
    await h.svc.whenIdle();
    expect(questions(h)).toHaveLength(1);
    expect(h.calls(isLead)).toHaveLength(1); // the lead was not asked
    expect((await h.texts()).some((t) => t.includes('is waiting for your answer') && t.includes('within 10 minutes'))).toBe(true);
    for (const t of timers.filter((x) => x.ms === 600_000)) t.fn();
    await h.svc.whenIdle();
    const second = h.calls(isHelper)[1]!.prompt;
    expect(second).toMatch(/NO\. Do not delete, discard, reset/);
    expect(h.helper('Port the ai package').state).toBe('done');
    expect(h.svc.orchestrator.journal.list(h.project.id).some((e) => e.kind === 'question' && /safe default applied \(destructive\)/.test(e.text))).toBe(true);
  });

  // Review finding: a question routed to the lead armed no safe default, so a failed (or dropped) help turn left the helper waiting forever.
  it('a question sent to the lead gets the safe default when the lead turn fails without answering', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', planner)
        : p.includes('Question from helper') ? [{ kind: 'done', ok: false, error: 'boom' }] : say('ok')),
      helper: (p) => (p.includes('Harbor applies the safe default') ? say(done('assumed the conservative option')) : say(askLine('May I include the four packages/ai files?')))
    }) }, { service: { questionTimeoutMs: 600_000, setTimer: (fn, ms) => { timers.push({ fn, ms }); return () => {}; } } });
    await h.svc.send(h.conv.id, 'port the ai package');
    await h.svc.whenIdle();
    expect(h.helper('Port the ai package').state).toBe('waiting');
    for (const t of timers.filter((x) => x.ms === 600_000)) t.fn();
    await h.svc.whenIdle();
    expect(h.calls(isHelper)[1]!.prompt).toMatch(/Harbor applies the safe default/);
    expect(h.helper('Port the ai package').state).toBe('done');
  });

  it('a lead reply continues a stopped helper in its own session', async () => {
    let n = 0, stoppedId = '';
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:\nport') ? delegate('go', planner)
        : p.includes('User:\ncontinue') ? say(`Continuing it.\nHARBOR_REPLY: ${JSON.stringify({ to: stoppedId, text: 'Finish the index exports.' })}`) : say('ok')),
      helper: () => (n++ === 0 ? say(done('first pass')) : say(done('second pass')))
    }) });
    await h.svc.send(h.conv.id, 'port the ai package');
    await h.svc.whenIdle();
    const a = h.helper('Port the ai package');
    stoppedId = a.id;
    h.svc.store.patchAgent(a.id, { state: 'stopped', stopKind: 'cap', error: 'stopped at its limit' });
    await h.svc.send(h.conv.id, 'continue the port');
    await h.svc.whenIdle();
    const last = h.calls(isHelper).at(-1)!;
    expect(last.prompt).toContain('Message from the lead: Finish the index exports.');
    expect(last.opts.resumeId).toBeTruthy();
    expect(h.helper('Port the ai package').state).toBe('done');
  });

  it('a lead reply to a finished helper resumes its saved session; without a session it is refused', async () => {
    let n = 0, targetId = '';
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:\nport') ? delegate('go', planner)
        : p.includes('User:\ncontinue') ? say(`Following up.\nHARBOR_REPLY: ${JSON.stringify({ to: targetId, text: 'The secret-scan finding is a fixture; keep it.' })}`) : say('ok')),
      helper: () => (n++ === 0 ? say(done('first pass')) : say(done('second pass')))
    }) });
    await h.svc.send(h.conv.id, 'port the ai package');
    await h.svc.whenIdle();
    const a = h.helper('Port the ai package');
    targetId = a.id;
    expect(a.state).toBe('done');
    await h.svc.send(h.conv.id, 'continue the port');
    await h.svc.whenIdle();
    const last = h.calls(isHelper).at(-1)!;
    expect(h.calls(isHelper)).toHaveLength(2);
    expect(last.prompt).toContain('Message from the lead: The secret-scan finding is a fixture; keep it.');
    expect(last.opts.resumeId).toBeTruthy();
    expect(h.helper('Port the ai package').state).toBe('done');
    const texts = await h.texts();
    expect(texts.some((t) => t.includes('had finished; it continues from its saved session'))).toBe(true);
    expect(texts.some((t) => t.startsWith('Harbor did not deliver'))).toBe(false);

    // The same reply to a finished helper whose session is gone: refused, with the reason.
    h.svc.store.clearSession(a.id);
    await h.svc.send(h.conv.id, 'continue the port');
    await h.svc.whenIdle();
    expect(h.calls(isHelper)).toHaveLength(2);
    expect((await h.texts()).some((t) => t.startsWith('Harbor did not deliver the lead\'s reply') && t.includes('has no saved session to resume'))).toBe(true);
  });
});
