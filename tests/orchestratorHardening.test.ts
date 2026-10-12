import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withCodeNeed } from '../src/main/orchestrator';
import { delegate, delegateLine, escalate, answer, harness, isConcierge, isHelper, isLead, result, say, script, until, work } from './hardeningHarness';

// Wave 2: protocol and delegation correctness (nonce, malformed lines, references, verdicts, dedupe, goal mode, front desk bypass).

const impl = (ref: string, over: Record<string, unknown> = {}) => ({ ref, title: `Write ${ref}`, role: 'implementer', instructions: `write ${ref}`, complexity: 'low', ...over });

describe('protocol tag (nonce)', () => {
  it('tells every lead turn and helper run its own tag, and acts on lines that use it', async () => {
    const h = await harness({ claude: script({ lead: (p) => (p.includes('User:') ? delegate('go', impl('a')) : say('ok')), helper: () => say('done') }) });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    const [lead] = h.calls(isLead);
    const tag = /HARBOR_DELEGATE\[([A-Za-z0-9_-]+)\]/.exec(lead!.prompt)?.[1];
    expect(tag).toBeTruthy();
    const [helper] = h.calls(isHelper);
    expect(/HARBOR_DELEGATE\[([A-Za-z0-9_-]+)\]/.exec(helper!.prompt)?.[1]).toBeTruthy();
    expect(/HARBOR_DELEGATE\[([A-Za-z0-9_-]+)\]/.exec(helper!.prompt)?.[1]).not.toBe(tag); // a fresh tag per run
    expect(h.helpers()).toHaveLength(1);
    expect((await h.texts()).join('\n')).not.toContain('HARBOR_DELEGATE'); // protocol lines stay out of the transcript
  });

  it('ignores lines without the tag, says so once, and resumes the lead once with the problem', async () => {
    const h = await harness({ claude: script({ lead: () => say(`on it\n${delegateLine(impl('a'))}`) }) }, { bare: true });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    expect(h.helpers()).toHaveLength(0); // nothing was started from an untagged line
    const texts = await h.texts();
    expect(texts.filter((t) => t.startsWith('Harbor ignored 1 protocol line(s)'))).toHaveLength(2); // the turn and its single resume
    const leads = h.calls(isLead);
    expect(leads).toHaveLength(2);
    expect(leads[1]!.prompt).toContain('Notice from Harbor');
    expect(leads[1]!.prompt).toContain('HARBOR_<KIND>[');
  });
});

describe('malformed protocol lines', () => {
  it('reports one system message and resumes the lead once, counted against the automatic turn cap', async () => {
    const h = await harness({ claude: script({ lead: (p) => (p.includes('Notice from Harbor') ? say('fixed') : say('hmm\nHARBOR_DELEGATE: {"title": oops')) }) });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    expect((await h.texts()).filter((t) => t.startsWith('Harbor ignored 1 protocol line(s): HARBOR_DELEGATE'))).toHaveLength(1);
    expect(h.calls(isLead)).toHaveLength(2);
    expect(h.calls(isLead)[1]!.prompt).toContain('HARBOR_DELEGATE');

    const capped = await harness({ claude: script({ lead: () => say('hmm\nHARBOR_DELEGATE: {"title": oops') }), }, { service: { maxAutoTurns: 0 } });
    await capped.svc.send(capped.conv.id, 'implement the thing in src/a.ts');
    await capped.svc.whenIdle();
    expect(capped.calls(isLead)).toHaveLength(1); // no budget left: reported, not resumed
    expect((await capped.texts()).some((t) => t.startsWith('Paused automatic coordination'))).toBe(true);
  });
});

describe('references that name nothing', () => {
  it('fails the task with a clear message, tells the lead, and never starts it', async () => {
    const h = await harness({ claude: script({ lead: (p) => (p.includes('User:') ? delegate('go', impl('a', { dependsOn: ['ghost'] })) : say('noted')) }) });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    const a = h.helper('Write a');
    expect(a.state).toBe('failed');
    expect(a.error).toMatch(/Unresolvable reference.*"ghost"/);
    expect(h.calls(isHelper)).toHaveLength(0);
    expect((await h.texts()).some((t) => t.includes('Write a failed') && t.includes('Unresolvable'))).toBe(true);
    expect(h.calls(isLead)[1]!.prompt).toContain('Unresolvable'); // the lead hears about it in its report
  });

  it('refuses a reviewer with no upstream worktree to review', async () => {
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go',
        { ref: 'r1', title: 'Lonely reviewer', role: 'reviewer', instructions: 'review', complexity: 'low' },
        { ref: 'p', title: 'Plan', role: 'planner', instructions: 'plan', complexity: 'low' },
        { ref: 'r2', title: 'Reviewer of a plan', role: 'reviewer', instructions: 'review the plan', complexity: 'low', dependsOn: ['p'] }) : say('ok'))
    }) });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    expect(h.helper('Lonely reviewer').error).toMatch(/depends on no helper/);
    expect(h.helper('Reviewer of a plan').error).toMatch(/worktree to review/);
    expect(h.calls(isHelper).every((c) => !c.prompt.includes('Lonely reviewer') && !c.prompt.includes('Reviewer of a plan'))).toBe(true);
  });
});

describe('helpers that end without a result line', () => {
  const plan = (reviewerSays: string) => script({
    lead: (p) => (p.includes('User:') ? delegate('go', impl('a'), { ref: 'ra', title: 'Review a', role: 'reviewer', instructions: 'review it', complexity: 'low', dependsOn: ['a'] }, { role: 'integrator', ref: 'i', sources: ['a'] }) : say('ok')),
    helper: (p, o) => (o.permission === 'edit' ? say(`Done\n${result({ outcome: 'done', summary: 'Written.', checks: [] })}`) : say(reviewerSays))
  });

  it('marks the outcome partial; a reviewer without a verdict says NO VERDICT and never opens the integration gate', async () => {
    const h = await harness({ claude: plan('Looks fine to me.') });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    const review = h.helper('Review a');
    expect(review.state).toBe('done');
    expect(review.result).toMatchObject({ outcome: 'partial', summary: 'helper ended without a result line' });
    expect(review.result!.verdict).toBeUndefined();
    expect(review.report).toMatch(/^NO VERDICT/);
    expect(review.summary).toMatch(/^NO VERDICT/);
    const integ = h.helpers().find((a) => a.integration)!;
    expect(integ.state).toBe('failed');
    expect(integ.error).toMatch(/no approving review/);
  });

  it('a verdict that is not on the final line does not count either', async () => {
    const h = await harness({ claude: plan(`${result({ outcome: 'done', summary: 'ok', verdict: 'approve', checks: [] })}\nBut wait, one more thing.`) });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    expect(h.helper('Review a').report).toMatch(/^NO VERDICT/);
    expect(h.helpers().find((a) => a.integration)!.state).toBe('failed');
  });

  it('a helper that does print its result line keeps it unchanged', async () => {
    const h = await harness({ claude: plan(`Fine.\n${result({ outcome: 'done', summary: 'Approved.', verdict: 'approve', checks: [] })}`) });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    expect(h.helper('Review a').result).toMatchObject({ verdict: 'approve', summary: 'Approved.' });
    expect(h.helper('Write a').result).toMatchObject({ outcome: 'done' });
    expect(h.helpers().find((a) => a.integration)!.state).toBe('done');
  });
});

describe('delegation idempotence', () => {
  it('starts identical (role, instructions) once, but not the same words for different subjects', async () => {
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('a'), impl('a2', { instructions: 'write a' }), impl('b', { instructions: 'write b' }), { ref: 'r1', title: 'Review a', role: 'reviewer', instructions: 'review', complexity: 'low', dependsOn: ['a'] }, { ref: 'r2', title: 'Review b', role: 'reviewer', instructions: 'review', complexity: 'low', dependsOn: ['b'] }) : say('ok'))
    }) });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    // 'a' and 'a2' are the same job; 'b' differs in its instructions; the two reviews differ in what they wait for.
    expect(h.helpers().map((a) => a.title).sort()).toEqual(['Review a', 'Review b', 'Write a', 'Write b']);
    expect((await h.texts()).some((t) => t.startsWith('Harbor started 1 identical delegation(s) once'))).toBe(true);
  });
});

describe('goal mode', () => {
  it('ignores GOAL_DONE while helpers are active, and accepts it once they have reported', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? say(`${delegateLine({ ref: 'x', title: 'Slow', role: 'other', access: 'read', instructions: 'slow research', complexity: 'low' })}\nHARBOR_GOAL_DONE: {"summary":"all done"}`) : p.includes('Helper reports') ? say('now truly\nHARBOR_GOAL_DONE: {"summary":"done after report"}') : work('x')),
      helper: async () => { await gate; return say('research'); }
    }) });
    await h.svc.setConversationMode(h.conv.id, 'goal', 'finish the research');
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await until(async () => (await h.texts()).some((t) => t.includes('ignored the goal-done line')));
    expect((await h.texts()).some((t) => t.startsWith('Goal reached'))).toBe(false);
    release();
    await h.svc.whenIdle();
    expect((await h.texts()).some((t) => t.startsWith('Goal reached: done after report'))).toBe(true);
  });

  it('stops after a continuation that made no tool calls and delegated nothing; prose never ends goal mode', async () => {
    const h = await harness({ claude: script({ lead: (_p, _o, i) => (i === 0 ? work('started') : say('The goal is reached, everything is done.')) }) });
    await h.svc.setConversationMode(h.conv.id, 'goal', 'make it so');
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    expect(h.calls(isLead)).toHaveLength(2); // the user turn and one continuation
    const texts = await h.texts();
    expect(texts.some((t) => t.includes('made no tool calls and delegated nothing'))).toBe(true);
    expect(texts.some((t) => t.startsWith('Goal reached'))).toBe(false);
    expect(h.svc.store.isGoalPaused(h.conv.id)).toBe(true);
  });
});

describe('help request loops', () => {
  it('count toward the automatic turn cap', async () => {
    const h = await harness({ claude: script({
      lead: (p) => delegate('again', { ref: 'h', title: 'Helper', role: 'other', access: 'read', instructions: `asks for help ${p.length}`, complexity: 'low' }),
      helper: () => say('stuck\nHARBOR_REQUEST_HELP: {"reason":"need more","proposedRole":"other","instructions":"do more","blocked":false}')
    }) }, { service: { maxAutoTurns: 2 } });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    expect((await h.texts()).some((t) => t.startsWith('Paused automatic coordination'))).toBe(true);
    expect(h.calls(isLead).length).toBeLessThanOrEqual(4);
  });
});

describe('lead needs', () => {
  it('always include code', () => {
    expect(withCodeNeed(['chat'])).toEqual(['chat', 'code']);
    expect(withCodeNeed([])).toEqual(['code']);
    expect(withCodeNeed(['code', 'review'])).toEqual(['code', 'review']);
  });
});

describe('front desk bypass', () => {
  it('skips the front desk for obvious work, including after a polite opener', async () => {
    const h = await harness({ claude: script({ concierge: () => answer('SHOULD NOT BE ASKED'), lead: () => say('on it') }) });
    for (const text of ['fix the failing test in src/app.ts', 'ok thanks, now fix the parser']) {
      await h.svc.send(h.conv.id, text);
      await h.svc.whenIdle();
    }
    expect(h.calls(isConcierge)).toHaveLength(0);
    expect(h.calls(isLead)).toHaveLength(2);
  });

  it('sends a reply to the lead question straight to the lead', async () => {
    let leadCalls = 0;
    const h = await harness({ claude: script({ concierge: () => escalate('medium', 'On it.'), lead: () => say(++leadCalls === 1 ? 'Should I start with the database layer or the API?' : 'Starting with the API.') }) });
    await h.svc.send(h.conv.id, 'please look into why startup feels slow');
    await h.svc.whenIdle();
    expect(h.calls(isConcierge)).toHaveLength(1);
    await h.svc.send(h.conv.id, 'the api one');
    await h.svc.whenIdle();
    expect(h.calls(isConcierge)).toHaveLength(1); // the answer was not triaged
    expect(h.calls(isLead)).toHaveLength(2);
  });

  it('still lets the front desk handle real small talk', async () => {
    const h = await harness({ claude: script({ concierge: () => answer('You are welcome.'), lead: () => say('SHOULD NOT RUN') }) });
    await h.svc.send(h.conv.id, 'thanks, that is great');
    await h.svc.whenIdle();
    expect(h.calls(isConcierge)).toHaveLength(1);
    expect(h.calls(isLead)).toHaveLength(0);
  });

  it('tells the next lead turn what the front desk answered meanwhile', async () => {
    const h = await harness({ claude: script({ concierge: () => answer('Hi, I am Harbor.'), lead: () => say('ok') }) });
    await h.svc.send(h.conv.id, 'hello there');
    await h.svc.whenIdle();
    await h.svc.send(h.conv.id, 'add a retry to fetchUser in client.ts');
    await h.svc.whenIdle();
    const [lead] = h.calls(isLead);
    expect(lead!.prompt).toContain('The front desk answered these without you');
    expect(lead!.prompt).toContain('hello there');
    expect(lead!.prompt).toContain('Hi, I am Harbor.');
    await h.svc.send(h.conv.id, 'now fix it in client.ts again');
    await h.svc.whenIdle();
    expect(h.calls(isLead)[1]!.prompt).not.toContain('The front desk answered'); // told once
  });
});

describe('what helpers and the lead are told about verification', () => {
  it('passes the check commands as a hint, the base commit to reviewers and the commands as allowed prefixes', async () => {
    const repo = (await import('./hardeningHarness')).gitRepo();
    mkdirSync(join(repo, '.harbor'));
    writeFileSync(join(repo, '.harbor', 'checks.json'), JSON.stringify({ checks: ['npm test', 'npm run lint && echo done'] }));
    const h = await harness({ claude: script({
      lead: (p) => (p.includes('User:') ? delegate('go', impl('a'), { ref: 'ra', title: 'Review a', role: 'reviewer', instructions: 'review', complexity: 'low', dependsOn: ['a'] }) : say('ok')),
      helper: (_p, o) => say(o.permission === 'edit' ? `done\n${result({ outcome: 'done', summary: 'x', checks: [] })}` : `ok\n${result({ outcome: 'done', summary: 'x', verdict: 'approve', checks: [] })}`)
    }) }, { git: repo, service: { autoApproveChecks: true } });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    const [lead] = h.calls(isLead);
    expect(lead!.prompt).not.toContain('No Harbor checks are configured');
    expect(lead!.opts.allowedCommands).toEqual(['npm test']); // the chained command is not a prefix anyone should allow
    const implementer = h.calls(isHelper).find((c) => c.prompt.includes('write a'))!;
    expect(implementer.prompt).toContain('Verify with: npm test; npm run lint && echo done');
    expect(implementer.opts.allowedCommands).toEqual(['npm test']);
    const reviewer = h.calls(isHelper).find((c) => c.prompt.includes('Review a'))!;
    const base = h.helper('Write a').baseCommit!;
    expect(reviewer.prompt).toContain(`Base commit: ${base}`);
  });

  it('tells the lead when no checks exist', async () => {
    const h = await harness({ claude: script({ lead: () => say('ok') }) });
    await h.svc.send(h.conv.id, 'implement the thing in src/a.ts');
    await h.svc.whenIdle();
    expect(h.calls(isLead)[0]!.prompt).toContain('No Harbor checks are configured');
  });
});
