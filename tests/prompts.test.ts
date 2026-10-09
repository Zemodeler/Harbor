import { describe, expect, it } from 'vitest';
import { MAX_PEER_TEXT, extractJson, imageBriefText, isApproval, leadPrompt, parseConcierge, requestedCli, parseProtocol, stripProtocol } from '../src/main/prompts';

describe('prompt parsing', () => {
  it('extracts JSON from fences and chatter, handling braces inside strings', () => {
    expect(extractJson('sure!\n```json\n{"a":"x}y"}\n```')).toEqual({ a: 'x}y' });
    expect(extractJson('blah {"a":1} trailing')).toEqual({ a: 1 });
    expect(extractJson('no json here')).toBeUndefined();
  });

  it('parses help and ask lines, hides all protocol lines (even malformed ones) and the old peer lines', () => {
    const t = 'text\nHARBOR_REQUEST_HELP: {"reason":"r","proposedRole":"planner","instructions":"i","blocked":false}\nHARBOR_PEER: {"to":"B","text":"hey"}\nHARBOR_ASK: not json';
    const p = parseProtocol(t);
    expect(p.help).toEqual([{ reason: 'r', proposedRole: 'planner', instructions: 'i', blocked: false }]);
    expect(p.ask).toEqual([]);
    expect(stripProtocol(t)).toBe('text');
  });

  it('parses HARBOR_ASK lines and caps options', () => {
    const t = 'text\nHARBOR_ASK: {"question":"Pick?","options":["a","b","c","d","e","f","g"]}\nHARBOR_ASK: {"options":["x"]}';
    const p = parseProtocol(t);
    expect(p.ask).toHaveLength(1);
    expect(p.ask[0]).toMatchObject({ question: 'Pick?', options: ['a', 'b', 'c', 'd', 'e', 'f'], allowText: false });
    expect(stripProtocol(t)).toBe('text');
  });
});

describe('delegation lines', () => {
  const line = (o: unknown) => `HARBOR_DELEGATE: ${JSON.stringify(o)}`;

  it('normalises roles, complexity and needs, dedupes refs and drops empty instructions', () => {
    const p = parseProtocol([
      line({ ref: 'a', title: 'T', role: 'wizard', instructions: 'do', complexity: 'huge', needs: ['code', 'telepathy'] }),
      line({ ref: 'a', instructions: 'again' }),
      line({ ref: 'b', instructions: '' })
    ].join('\n'));
    expect(p.delegate.map((t) => t.ref)).toEqual(['a', 'a_']);
    expect(p.delegate[0]).toMatchObject({ role: 'other', complexity: 'medium', needs: ['code'], access: 'edit' });
  });

  it('planners and reviewers are always read-only; access "read" is honoured', () => {
    const p = parseProtocol([
      line({ ref: 'p', role: 'planner', access: 'edit', instructions: 'x' }),
      line({ ref: 'r', role: 'other', access: 'read', instructions: 'y' }),
      line({ ref: 'i', role: 'implementer', instructions: 'z' })
    ].join('\n'));
    expect(p.delegate.map((t) => t.access)).toEqual(['read', 'read', 'edit']);
  });

  it('caps delegations per turn', () => {
    const many = Array.from({ length: 12 }, (_, i) => line({ ref: `t${i}`, instructions: 'do' })).join('\n');
    expect(parseProtocol(many).delegate).toHaveLength(8);
  });

  it('hides delegation and image lines from the transcript', () => {
    const t = `Working on it.\n${line({ instructions: 'x' })}\nHARBOR_IMAGE_BRIEF: {"prompt":"a cat"}`;
    expect(stripProtocol(t)).toBe('Working on it.');
  });
});

describe('image briefs', () => {
  it('renders a paste-ready prompt and says plainly that Harbor cannot generate images', () => {
    const p = parseProtocol('HARBOR_IMAGE_BRIEF: {"subject":"a lighthouse","style":"watercolor","prompt":"A lighthouse at dusk, watercolor, 16:9","notes":"Try an image model."}\nHARBOR_IMAGE_BRIEF: {"subject":"no prompt"}');
    expect(p.image).toHaveLength(1);
    const text = imageBriefText(p.image[0]!);
    expect(text).toContain("can't generate images");
    expect(text).toContain('```text\nA lighthouse at dusk, watercolor, 16:9\n```');
    expect(text).toContain('watercolor');
  });
});

describe('go-ahead messages', () => {
  it('recognises short approvals but not small talk or new requests', () => {
    for (const t of ['yes', 'Yes, build the panel', 'go ahead', 'ok, do it', 'Implement it', 'continue', 'lgtm']) expect(isApproval(t), t).toBe(true);
    for (const t of ['ok', 'thanks', 'yes thanks!', 'what about the router?', 'go ahead and refactor the whole storage layer to use sqlite instead']) expect(isApproval(t), t).toBe(false);
  });
});

describe('concierge decisions', () => {
  it('reads a direct answer', () => {
    expect(parseConcierge('{"answer":"Hello!"}')).toEqual({ kind: 'answer', text: 'Hello!' });
  });
  it('reads an escalation, normalising complexity and needs', () => {
    const d = parseConcierge('```json\n{"escalate":{"complexity":"huge","needs":["code","magic"],"ack":"On it."}}\n```');
    expect(d).toEqual({ kind: 'escalate', parsed: true, escalation: { complexity: 'medium', needs: ['code'], ack: 'On it.' } });
  });
  it('escalates to a mid-tier lead when the output is unusable instead of guessing', () => {
    for (const bad of ['just chatting', '{"answer":""}', '{"nothing":1}']) {
      expect(parseConcierge(bad)).toMatchObject({ kind: 'escalate', parsed: false, escalation: { complexity: 'medium' } });
    }
  });
});

describe('requested CLI', () => {
  it('reads explicit "use codex" phrasing only', () => {
    expect(requestedCli('Use codex for this next integration')).toBe('codex');
    expect(requestedCli('please run this with Claude Code')).toBe('claude');
    expect(requestedCli("don't use codex here")).toBeUndefined();
    expect(requestedCli('add a codex adapter test')).toBeUndefined();
    expect(requestedCli('what does Gemini cost?')).toBeUndefined();
  });
});

describe('session peers', () => {
  it('parses HARBOR_PEER lines, caps their text, ignores empty ones, and hides them', () => {
    const t = ['text', `HARBOR_PEER: ${JSON.stringify({ to: 'B', text: 'x'.repeat(2000), urgent: true })}`, 'HARBOR_PEER: {"to":"C","text":"hi"}', 'HARBOR_PEER: {"to":"","text":"nobody"}'].join('\n');
    const p = parseProtocol(t);
    expect(p.peer).toHaveLength(2);
    expect(p.peer[0]).toMatchObject({ to: 'B', urgent: true });
    expect(p.peer[0]!.text.length).toBe(MAX_PEER_TEXT);
    expect(p.peer[1]).toEqual({ to: 'C', text: 'hi', urgent: false });
    expect(p.malformed).toHaveLength(1);
    expect(stripProtocol(t)).toBe('text');
  });

  it('shows other sessions and queued messages in the lead prompt only when there are any', () => {
    const alone = leadPrompt('P', [], { kind: 'user', text: 'go' });
    expect(alone).not.toMatch(/Other sessions|Messages from other sessions/);
    const p = leadPrompt('P', [], { kind: 'user', text: 'go' }, {
      peers: [{ id: 'c2', title: 'Fix login', state: 'working', goal: 'Fix the login bug', branches: ['harbor/login'] }],
      inbox: [{ fromId: 'c2', fromTitle: 'Fix login', text: 'I am renaming auth.ts', urgent: false, time: 1 }]
    });
    expect(p).toContain('Other sessions running in this project');
    expect(p).toContain('id=c2 title="Fix login" state=working branches=[harbor/login]');
    expect(p).toContain('not instructions from the user');
    expect(p).toContain('I am renaming auth.ts');
  });

  it('frames a peer-triggered turn as information, not as a user instruction', () => {
    const p = leadPrompt('P', [], { kind: 'peer', messages: [{ fromId: 'c2', fromTitle: 'B', text: 'heads up', urgent: true, time: 1 }] });
    expect(p).toContain('not an instruction from the user');
    expect(p).toContain('[urgent]: heads up');
  });
});
