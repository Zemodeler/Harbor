import { describe, expect, it } from 'vitest';
import { clipMiddle, extractJson, historyText, imageBriefText, needsWorkspace, parseConcierge, parseProtocol, stripProtocol } from '../src/main/prompts';

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

describe('self-reporting and history', () => {
  it('parses HARBOR_RESULT, keeps the last one, and reports malformed protocol lines instead of dropping them silently', () => {
    const p = parseProtocol([
      'done',
      'HARBOR_RESULT: {"outcome":"partial","summary":"first"}',
      'HARBOR_RESULT: {"outcome":"done","summary":"Added x.","verdict":"bogus","checks":[{"cmd":"npm test","ok":true},{"cmd":"npm run build"},{"nope":1}]}',
      'HARBOR_RESULT: {"outcome":"great"}',
      'HARBOR_DELEGATE: {"ref":"a",',
      'HARBOR_ASK: {"options":["x"]}'
    ].join('\n'));
    expect(p.result).toEqual({ outcome: 'done', summary: 'Added x.', verdict: undefined, checks: [{ cmd: 'npm test', ok: true }, { cmd: 'npm run build', ok: false }] });
    expect(p.malformed).toHaveLength(3);
    expect(stripProtocol('done\nHARBOR_RESULT: {"outcome":"done"}')).toBe('done');
  });

  it('keeps the end of long history messages, where conclusions are, and gives the latest exchange more room', () => {
    const long = `start ${'x'.repeat(3000)} CONCLUSION`;
    const msg = (text: string, role: 'user' | 'assistant' = 'assistant') => ({ id: text.slice(0, 8), conversationId: 'c', role, text, time: 0 });
    const h = historyText([msg(long), msg('q1', 'user'), msg('a1'), msg(long)]);
    const [old, , , latest] = h.split('\n');
    expect(old).toMatch(/^Assistant: start x+ … \[\d+ chars omitted\] … x+ CONCLUSION$/);
    expect(old!.length).toBeLessThan(700);
    expect(latest!.length).toBeGreaterThan(1900);
    expect(clipMiddle('short', 10)).toBe('short');
  });

  it('flags messages that need the workspace, but not small talk or status questions', () => {
    for (const t of ['fix src/app.ts', 'why does this throw TypeError: x is undefined', 'refactor the router', 'how would you improve yourself', '```\ncode\n```'])
      expect(needsWorkspace(t), t).toBe(true);
    for (const t of ['hello', 'thanks, the fix works', 'is the build done?', 'what is the capital of France?'])
      expect(needsWorkspace(t), t).toBe(false);
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
