import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeArgs } from '../src/main/adapters/claude';
import { codexArgs } from '../src/main/adapters/codex';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk, RunOptions } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { parseProtocol, stripProtocol } from '../src/main/prompts';
import { attachmentDir, createHarborService, saveAttachments } from '../src/main/service';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-modes-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const fakeCli = (id: string): ResolvedCli => ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: `/fake/${id}` });
const isConcierge = (o: RunOptions) => !!o.systemPrompt?.includes('front desk');
const isLead = (o: RunOptions) => !!o.systemPrompt?.includes('LEAD agent');
const say = (text: string): Chunk[] => [{ kind: 'text', text }];
// A turn that did something (a tool call) and then said something: a goal continuation that only talks counts as no progress.
const work = (text: string): Chunk[] => [{ kind: 'tool', text: 'Read src/x.ts' }, { kind: 'text', text }];
const escalate = (): Chunk[] => say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }));
const delegateLine = (t: unknown) => `HARBOR_DELEGATE: ${JSON.stringify(t)}`;
const PNG = Buffer.from('iVBORw0KGgo=', 'base64').toString('base64');

function gitRepo(): string {
  const d = tmp();
  const g = (...a: string[]) => spawnSync('git', a, { cwd: d });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(d, 'README.md'), 'hi'); g('add', '.'); g('commit', '-q', '-m', 'init');
  return d;
}

interface Roles { concierge?: FakeScript; lead?: FakeScript; helper?: FakeScript }
// The index passed to `lead` counts lead calls only (the adapter's own index also counts concierge and helper calls).
const script = (r: Roles): FakeScript => {
  let leadCalls = 0;
  return (p, o, i) => isConcierge(o) ? (r.concierge ?? escalate)(p, o, i) : isLead(o) ? (r.lead ?? (() => say('ok')))(p, o, leadCalls++) : (r.helper ?? (() => say('ok')))(p, o, i);
};

async function harness(scripts: Record<string, FakeScript>, ids = ['claude', 'codex']) {
  const adapters: Record<string, FakeAdapter> = {};
  for (const id of ids) adapters[id] = new FakeAdapter(id, scripts[id] ?? (() => say('ok')));
  const dataDir = tmp();
  const svc = createHarborService({ dataDir, discover: async () => ids.map(fakeCli), adapterFor: (id) => adapters[id], worktreesRoot: join(tmp(), 'wt'), maxActivePerProject: 3 });
  const project = (await svc.addProject(gitRepo()))!;
  const [conv] = await svc.listConversations(project.id);
  const texts = async () => (await svc.listMessages(conv!.id)).map((m) => m.text);
  const all = () => ids.flatMap((id) => adapters[id]!.calls);
  return { svc, adapters, project, conv: conv!, dataDir, texts, all };
}

describe('adapter flags', () => {
  const base: RunOptions = { cwd: '.', model: 'default', effort: 'low', permission: 'edit' };
  it('codex passes images and full permission', () => {
    const a = codexArgs({ ...base, permission: 'full', images: ['C:\\d\\a.png', 'C:\\d\\b.jpg'] });
    expect(a.filter((x) => x === '--image')).toHaveLength(2);
    expect(a).toContain('C:\\d\\a.png');
    expect(a).toContain('sandbox_mode=danger-full-access');
    expect(a).toContain('approval_policy=never');
    expect(a[a.length - 1]).toBe('-');
    // each --image value is followed by a flag, never by the `-` prompt argument
    expect(a[a.indexOf('C:\\d\\b.jpg') + 1]).toBe('--json');
    expect(codexArgs(base).join(' ')).not.toMatch(/approval_policy|--image/);
  });
  it('claude adds the attachment folder and bypasses permissions in full mode', () => {
    const a = claudeArgs({ ...base, permission: 'full', images: ['C:\\d\\a.png', 'C:\\d\\b.png'] });
    expect(a.join(' ')).toMatch(/--permission-mode bypassPermissions/);
    expect(a.filter((x) => x === '--add-dir')).toHaveLength(1);
    expect(a[a.indexOf('--add-dir') + 1]).toBe('C:\\d');
    expect(a[a.indexOf('--add-dir') + 2]).toBe('--disallowedTools');
    expect(claudeArgs(base).join(' ')).not.toMatch(/add-dir|bypassPermissions/);
  });
});

describe('protocol', () => {
  it('parses HARBOR_GOAL_DONE, strips it, and reads a known "cli" on delegations only', () => {
    const t = ['done', 'HARBOR_GOAL_DONE: {"summary":"all green"}', delegateLine({ instructions: 'x', cli: 'codex' }), delegateLine({ instructions: 'y', cli: 'nope' })].join('\n');
    const p = parseProtocol(t);
    expect(p.goalDone?.summary).toBe('all green');
    expect(p.delegate.map((d) => d.cli)).toEqual(['codex', undefined]);
    expect(stripProtocol(t)).toBe('done');
  });
});

describe('attachments', () => {
  it('validates type, size and count, and writes nothing when one is rejected', () => {
    const dir = join(tmp(), 'att');
    const ok = { name: 'a.png', mime: 'image/png', dataBase64: PNG };
    expect(() => saveAttachments(dir, [ok, { name: 'x.svg', mime: 'image/svg+xml', dataBase64: PNG }])).toThrow(/supported image/);
    expect(existsSync(dir)).toBe(false);
    expect(() => saveAttachments(dir, Array(7).fill(ok))).toThrow(/at most 6/);
    expect(() => saveAttachments(dir, [{ ...ok, dataBase64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') }])).toThrow(/10 MB/);
    const [saved] = saveAttachments(dir, [{ ...ok, name: '..\\..\\evil.png' }]);
    expect(saved!.name).toBe('evil.png');
    expect(saved!.path!.startsWith(dir)).toBe(true);
    expect(saved!.path).toMatch(/\.png$/);
    expect(readFileSync(saved!.path!).length).toBeGreaterThan(0);
  });

  it('skips the concierge, escalates with vision, stores paths on the message and gives them to the adapter for this turn only', async () => {
    const h = await harness({ claude: script({ lead: () => say('I see it') }) });
    await h.svc.send(h.conv.id, 'what is in this?', [{ name: 'shot.png', mime: 'image/png', dataBase64: PNG }]);
    await h.svc.whenIdle();
    const calls = h.all();
    expect(calls.some((c) => isConcierge(c.opts))).toBe(false);
    const lead = calls.find((c) => isLead(c.opts))!;
    expect(lead.opts.images).toHaveLength(1);
    expect(lead.opts.images![0]).toContain(join(h.dataDir, 'attachments', h.conv.id));
    expect(existsSync(lead.opts.images![0]!)).toBe(true);
    expect(lead.prompt).toContain(lead.opts.images![0]!);
    const msgs = await h.svc.listMessages(h.conv.id);
    const user = msgs.find((m) => m.role === 'user')!;
    expect(user.attachments?.[0]).toMatchObject({ name: 'shot.png', mime: 'image/png', path: lead.opts.images![0] });
    // routing saw the vision need
    expect(msgs.find((m) => m.details)?.details?.reason).toContain('vision');
    // next message has no images
    await h.svc.send(h.conv.id, 'thanks, now run the build');
    await h.svc.whenIdle();
    const leads = h.all().filter((c) => isLead(c.opts));
    expect(leads[leads.length - 1]!.opts.images).toBeUndefined();
  });

  it('rejects a bad attachment through send()', async () => {
    const h = await harness({});
    await expect(h.svc.send(h.conv.id, 'x', [{ name: 'a.bmp', mime: 'image/bmp', dataBase64: PNG }])).rejects.toThrow(/supported image/);
    expect(await h.svc.listMessages(h.conv.id)).toHaveLength(0);
  });
});

describe('conversation modes', () => {
  it('setConversationMode validates, persists, and goal mode needs a goal', async () => {
    const h = await harness({});
    await expect(h.svc.setConversationMode(h.conv.id, 'goal')).rejects.toThrow(/needs a goal/);
    const c = await h.svc.setConversationMode(h.conv.id, 'goal', ' ship it ');
    expect(c).toMatchObject({ mode: 'goal', goal: 'ship it' });
    expect((await h.svc.setConversationMode(h.conv.id, 'auto')).goal).toBeUndefined();
  });

  it('auto: lead and edit helpers run with full permission, reviewers stay read-only', async () => {
    const h = await harness({
      claude: script({
        lead: (_p, _o, i) => say(i === 0 ? [delegateLine({ ref: 'a', title: 'build', role: 'implementer', access: 'edit', instructions: 'edit' }), delegateLine({ ref: 'b', title: 'check', role: 'reviewer', access: 'read', dependsOn: ['a'], instructions: 'review' })].join('\n') : 'all done')
      })
    }, ['claude']);
    await h.svc.setConversationMode(h.conv.id, 'auto');
    await h.svc.send(h.conv.id, 'do it');
    await h.svc.whenIdle();
    const calls = h.all();
    expect(calls.find((c) => isLead(c.opts))!.opts.permission).toBe('full');
    const helperCalls = calls.filter((c) => !isLead(c.opts) && !isConcierge(c.opts));
    expect(helperCalls.find((c) => c.prompt.includes('build'))!.opts.permission).toBe('full');
    expect(helperCalls.find((c) => c.prompt.includes('review'))!.opts.permission).toBe('read-only');
  });

  it('plan: lead is read-only, edit delegations are ignored, and a go-ahead returns to default', async () => {
    const h = await harness({
      claude: script({
        lead: (p, _o, i) => say(i === 0 ? ['1. do a', delegateLine({ title: 'build', role: 'implementer', access: 'edit', instructions: 'edit' }), delegateLine({ title: 'look', role: 'other', access: 'read', instructions: 'research' })].join('\n') : 'executing')
      })
    }, ['claude']);
    await h.svc.setConversationMode(h.conv.id, 'plan');
    await h.svc.send(h.conv.id, 'sketch an approach for making startup faster');
    await h.svc.whenIdle();
    const first = h.all().find((c) => isLead(c.opts))!;
    expect(first.opts.permission).toBe('read-only');
    expect(first.prompt).toContain('PLAN MODE');
    const agents = h.svc.store.listAgentRecords(h.project.id).filter((a) => a.role !== 'main');
    expect(agents.map((a) => a.title)).toEqual(['look']);
    expect((await h.texts()).some((t) => t.includes('Plan mode: ignored 1 edit helper'))).toBe(true);

    await h.svc.send(h.conv.id, 'yes, go ahead');
    await h.svc.whenIdle();
    expect((await h.svc.listConversations(h.project.id))[0]!.mode).toBe('default');
    expect((await h.texts()).some((t) => /Plan approved/.test(t))).toBe(true);
    const leads = h.all().filter((c) => isLead(c.opts));
    expect(leads[leads.length - 1]!.opts.permission).toBe('edit');
    expect(leads[leads.length - 1]!.prompt).not.toContain('PLAN MODE');
    // the go-ahead continues the plan without a fresh front-desk call
    expect(h.all().filter((c) => isConcierge(c.opts))).toHaveLength(1);
  });

  it('goal: continues until HARBOR_GOAL_DONE and includes the goal in every lead prompt', async () => {
    const h = await harness({ claude: script({ lead: (_p, _o, i) => (i < 2 ? work(`step ${i}`) : say('finished\nHARBOR_GOAL_DONE: {"summary":"goal met"}')) }) }, ['claude']);
    await h.svc.setConversationMode(h.conv.id, 'goal', 'make tests pass');
    await h.svc.send(h.conv.id, 'start');
    await h.svc.whenIdle();
    const leads = h.all().filter((c) => isLead(c.opts));
    expect(leads).toHaveLength(3);
    expect(leads.every((c) => c.prompt.includes('make tests pass'))).toBe(true);
    expect(leads[1]!.prompt).toContain('continue toward the goal');
    const texts = await h.texts();
    expect(texts.some((t) => t.includes('HARBOR_GOAL_DONE'))).toBe(false);
    expect(texts.some((t) => t.includes('Goal reached: goal met'))).toBe(true);
  });

  it('goal: stops at the cap of 8 automatic continuations, and when the lead asks', async () => {
    const h = await harness({ claude: script({ lead: () => work('still going') }) }, ['claude']);
    await h.svc.setConversationMode(h.conv.id, 'goal', 'never ends');
    await h.svc.send(h.conv.id, 'start');
    await h.svc.whenIdle();
    expect(h.all().filter((c) => isLead(c.opts))).toHaveLength(9);
    expect((await h.texts()).some((t) => t.includes('paused after 8 automatic continuations'))).toBe(true);

    const h2 = await harness({ claude: script({ lead: () => say('need input\nHARBOR_ASK: {"question":"which one?","options":["a","b"]}') }) }, ['claude']);
    await h2.svc.setConversationMode(h2.conv.id, 'goal', 'g');
    await h2.svc.send(h2.conv.id, 'start');
    await h2.svc.whenIdle();
    expect(h2.all().filter((c) => isLead(c.opts))).toHaveLength(1);
    expect((await h2.texts()).some((t) => t.includes('waiting for your answer'))).toBe(true);
  });

  it('goal: a failed turn stops the loop with a note', async () => {
    const h = await harness({ claude: script({ lead: () => [{ kind: 'done', ok: false, error: 'boom' }] }) }, ['claude']);
    await h.svc.setConversationMode(h.conv.id, 'goal', 'g');
    await h.svc.send(h.conv.id, 'start');
    await h.svc.whenIdle();
    expect(h.all().filter((c) => isLead(c.opts))).toHaveLength(1);
    expect((await h.texts()).some((t) => t.includes('Goal mode paused: the lead'))).toBe(true);
  });
});

describe('session activity and CLI pinning', () => {
  it('activity carries complexity and effort of the routed lead turn', async () => {
    const h = await harness({ claude: script({ concierge: () => say(JSON.stringify({ escalate: { complexity: 'high', needs: ['code'], ack: '' } })), lead: () => say('ok') }) }, ['claude']);
    await h.svc.send(h.conv.id, 'make the whole thing much better, think it through');
    await h.svc.whenIdle();
    const a = (await h.svc.listConversations(h.project.id))[0]!.activity!;
    expect(a.complexity).toBe('high');
    expect(a.effort).toBe('medium');
    expect(a.cli).toBe('claude');
  });

  const delegateOnce = (cli: string): Roles => ({ lead: (_p, _o, i) => say(i === 0 ? delegateLine({ title: 'pinned', role: 'other', access: 'read', instructions: 'look', cli }) : 'done') });

  it('a pinned CLI is honoured', async () => {
    const h = await harness({ claude: script(delegateOnce('codex')), codex: script({ helper: () => say('from codex') }) });
    await h.svc.send(h.conv.id, 'go');
    await h.svc.whenIdle();
    const rec = h.svc.store.listAgentRecords(h.project.id).find((a) => a.title === 'pinned')!;
    expect(rec.pinnedCli).toBe('codex');
    expect(rec.cli).toBe('codex');
    expect(h.adapters['claude']!.calls.some((c) => !isLead(c.opts) && !isConcierge(c.opts))).toBe(false);
  });

  it('falls back to normal routing with a note when the pinned CLI is unavailable', async () => {
    const h = await harness({ claude: script(delegateOnce('codex')) }, ['claude']);
    await h.svc.send(h.conv.id, 'go');
    await h.svc.whenIdle();
    const rec = h.svc.store.listAgentRecords(h.project.id).find((a) => a.title === 'pinned')!;
    expect(rec.cli).toBe('claude');
    expect(rec.state).toBe('done');
    const conv = h.svc.store.findConversationByAgent(rec.id)!;
    expect((await h.svc.listMessages(conv.id)).some((m) => m.text.includes('pinned CLI codex is unavailable'))).toBe(true);
  });
});

// ---------------------------------------------------------------- review fixes

const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const until = async (cond: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('until timed out'); await new Promise((r) => setTimeout(r, 15)); } };
const settle = () => new Promise((r) => setTimeout(r, 150));

describe('plan mode constrains helpers at execution time', () => {
  it('holds queued edit helpers in plan mode with a note, notes that running ones continue, and releases them on leaving plan', async () => {
    const g = gate();
    const h = await harness({
      claude: script({
        lead: (_p, _o, i) => say(i === 0 ? [delegateLine({ ref: 'look', title: 'look', role: 'other', access: 'read', instructions: 'research' }), delegateLine({ ref: 'b', title: 'build', role: 'implementer', access: 'edit', instructions: 'edit things', dependsOn: ['look'] })].join('\n') : 'all done'),
        helper: async (p) => { if (p.includes('research')) await g.p; return say('ok'); }
      })
    }, ['claude']);
    await h.svc.send(h.conv.id, 'go');
    await until(() => h.all().some((c) => c.prompt.includes('research')));
    await h.svc.setConversationMode(h.conv.id, 'plan');
    expect((await h.texts()).some((t) => /1 running helper\(s\) continue/.test(t))).toBe(true);
    g.open();
    await until(() => h.svc.store.listAgentRecords(h.project.id).find((a) => a.title === 'look')?.state === 'done');
    await settle();
    const build = () => h.svc.store.listAgentRecords(h.project.id).find((a) => a.title === 'build')!;
    expect(build().state).toBe('queued');
    expect(h.all().some((c) => c.prompt.includes('edit things'))).toBe(false);
    expect((await h.texts()).some((t) => t.includes('"build" stays queued until you leave plan mode'))).toBe(true);
    await h.svc.setConversationMode(h.conv.id, 'default');
    await h.svc.whenIdle();
    expect(build().state).toBe('done');
    expect(h.all().find((c) => c.prompt.includes('edit things'))!.opts.permission).toBe('edit');
  });

  it('a helper that runs in a plan-mode conversation (a follow-up here) is read-only; auto only affects later runs', async () => {
    const h = await harness({
      claude: script({ lead: (_p, _o, i) => say(i === 0 ? delegateLine({ title: 'build', role: 'implementer', access: 'edit', instructions: 'edit things' }) : 'done') })
    }, ['claude']);
    await h.svc.send(h.conv.id, 'go');
    await h.svc.whenIdle();
    const rec = h.svc.store.listAgentRecords(h.project.id).find((a) => a.title === 'build')!;
    expect(h.all().find((c) => c.prompt.includes('edit things'))!.opts.permission).toBe('edit');
    await h.svc.setConversationMode(h.conv.id, 'auto');
    expect((await h.texts()).some((t) => /Auto mode applies to runs that start from now on/.test(t))).toBe(true);
    await h.svc.setConversationMode(h.conv.id, 'plan');
    const direct = await h.svc.openAgentConversation(rec.id);
    const before = h.all().length;
    await h.svc.send(direct.id, 'also tweak the footer');
    await h.svc.whenIdle();
    const follow = h.all().slice(before).find((c) => c.prompt.includes('footer'))!;
    expect(follow.opts.permission).toBe('read-only');
  });
});

describe('goal loop and helpers', () => {
  it('does not continue while any helper of the conversation is still active, even after a planner-triggered lead turn', async () => {
    const g = gate();
    const h = await harness({
      claude: script({
        lead: (_p, _o, i) => say(i === 0 ? [delegateLine({ title: 'plan it', role: 'planner', access: 'read', instructions: 'make a plan' }), delegateLine({ title: 'slow', role: 'other', access: 'read', instructions: 'slow research' })].join('\n')
          : i === 1 ? 'reviewing the plan' : 'finished\nHARBOR_GOAL_DONE: {"summary":"ok"}'),
        helper: async (p) => { if (p.includes('slow research')) await g.p; return say('report'); }
      })
    }, ['claude']);
    await h.svc.setConversationMode(h.conv.id, 'goal', 'g');
    await h.svc.send(h.conv.id, 'start');
    const leads = () => h.all().filter((c) => isLead(c.opts)).length;
    await until(() => leads() === 2);
    await settle();
    expect(leads()).toBe(2); // the planner's report resumed the lead once; no automatic continuation while "slow" runs
    g.open();
    await h.svc.whenIdle();
    expect(leads()).toBe(3);
    expect((await h.texts()).some((t) => t.includes('Goal reached'))).toBe(true);
  });

  it('pauses on a helper failure: the report resumes the lead once without the auto-continue loop, and a new message clears the pause', async () => {
    const h = await harness({
      claude: script({
        lead: (_p, _o, i) => (i === 0 ? say(delegateLine({ title: 'flaky', role: 'other', access: 'read', instructions: 'explode' })) : work('still going')),
        helper: () => [{ kind: 'done', ok: false, error: 'boom' }]
      })
    }, ['claude']);
    await h.svc.setConversationMode(h.conv.id, 'goal', 'g');
    await h.svc.send(h.conv.id, 'start');
    await h.svc.whenIdle();
    await settle();
    const leads = () => h.all().filter((c) => isLead(c.opts)).length;
    expect(leads()).toBe(2);
    expect(h.svc.store.isGoalPaused(h.conv.id)).toBe(true);
    await h.svc.send(h.conv.id, 'carry on');
    expect(h.svc.store.isGoalPaused(h.conv.id)).toBe(false);
    await h.svc.whenIdle();
    expect(leads()).toBeGreaterThan(4); // the loop runs again after the user's message
  });

  it('persists the pause when the lead asks, and a user message clears it', async () => {
    const h = await harness({ claude: script({ lead: () => say('need input\nHARBOR_ASK: {"question":"which one?"}') }) }, ['claude']);
    await h.svc.setConversationMode(h.conv.id, 'goal', 'g');
    await h.svc.send(h.conv.id, 'start');
    await h.svc.whenIdle();
    expect(h.svc.store.isGoalPaused(h.conv.id)).toBe(true);
    h.svc.store.flush();
    expect(JSON.parse(readFileSync(join(h.dataDir, 'state.json'), 'utf8')).conversations.find((c: { id: string }) => c.id === h.conv.id).goalPaused).toBe(true);
    await h.svc.send(h.conv.id, 'the first');
    expect(h.svc.store.isGoalPaused(h.conv.id)).toBe(false);
    await h.svc.whenIdle();
  });
});

describe('attachment hardening', () => {
  const ok = { name: 'a.png', mime: 'image/png', dataBase64: PNG };
  it('rejects non-canonical base64', () => {
    const dir = join(tmp(), 'att');
    for (const bad of ['iVBORw0KGgo', 'iVBO*w0KGgo=', 'iVBORw0KGgp=', 'iVBORw0K Ggo=', 'iVBORw0KGgo===', 'iV=ORw0K', 'iVBORw0KGgo=\n']) {
      expect(() => saveAttachments(dir, [{ ...ok, dataBase64: bad }]), bad).toThrow(/valid image data|empty/);
    }
    expect(existsSync(dir)).toBe(false);
    expect(saveAttachments(dir, [ok])).toHaveLength(1);
  });
  it('only accepts own-property mime types', () => {
    const dir = join(tmp(), 'att');
    for (const mime of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'image/svg+xml']) {
      expect(() => saveAttachments(dir, [{ ...ok, mime }]), mime).toThrow(/supported image/);
    }
  });
  it('validates conversation ids and keeps attachment paths inside <data>/attachments', () => {
    const root = tmp();
    for (const id of ['..', '../x', 'a/b', 'a\\b', '', 'x'.repeat(65), '.', 'C:\\evil', 'a b']) expect(() => attachmentDir(root, id), id).toThrow(/Invalid conversation id/);
    const good = attachmentDir(root, '3f2a-b_9');
    expect(relative(join(root, 'attachments'), good)).toBe('3f2a-b_9');
  });
  it('send() and deleteConversation never touch paths outside the attachments folder', async () => {
    const h = await harness({});
    const victim = join(h.dataDir, 'keep.txt');
    writeFileSync(victim, 'x');
    h.svc.store.addConversation({ id: '..', projectId: h.project.id, title: 'evil', updated: 0, agentId: h.conv.agentId });
    await expect(h.svc.send('..', 'hi', [ok])).rejects.toThrow(/Invalid conversation id/);
    await h.svc.deleteConversation('..');
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(h.dataDir)).toBe(true);
  });
});
