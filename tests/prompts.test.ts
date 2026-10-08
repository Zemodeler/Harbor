import { describe, expect, it } from 'vitest';
import { extractJson, imageBriefText, parseConcierge, parseProtocol, stripProtocol } from '../src/main/prompts';

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
