import { describe, expect, it } from 'vitest';
import { extractJson, parseMainOutput, parseProtocol, stripProtocol } from '../src/main/prompts';

describe('prompt parsing', () => {
  it('extracts JSON from fences and chatter, handling braces inside strings', () => {
    expect(extractJson('sure!\n```json\n{"a":"x}y"}\n```')).toEqual({ a: 'x}y' });
    expect(extractJson('blah {"a":1} trailing')).toEqual({ a: 1 });
    expect(extractJson('no json here')).toBeUndefined();
  });
  it('parses a plan, normalising bad roles/complexity and capping tasks', () => {
    const tasks = Array.from({ length: 12 }, (_, i) => ({ ref: `t${i}`, title: 'T', role: 'wizard', instructions: 'do', complexity: 'huge' }));
    const out = parseMainOutput(JSON.stringify({ reply: 'hi', tasks }));
    expect(out.parsed).toBe(true);
    expect(out.tasks).toHaveLength(8);
    expect(out.tasks[0]).toMatchObject({ role: 'other', complexity: 'medium' });
  });
  it('drops tasks without instructions and dedupes refs', () => {
    const out = parseMainOutput(JSON.stringify({ reply: '', tasks: [{ ref: 'a', instructions: '' }, { ref: 'b', instructions: 'x' }, { ref: 'b', instructions: 'y' }] }));
    expect(out.tasks.map((t) => t.ref)).toEqual(['b', 'b_']);
  });
  it('falls back to plain text when the main agent does not return JSON', () => {
    expect(parseMainOutput('Just chatting')).toEqual({ reply: 'Just chatting', tasks: [], parsed: false });
  });
  it('parses and strips protocol lines', () => {
    const t = 'text\nHARBOR_REQUEST_HELP: {"reason":"r","proposedRole":"planner","instructions":"i","blocked":false}\nHARBOR_PEER: {"to":"B","text":"hey"}\nHARBOR_PEER: not json';
    const p = parseProtocol(t);
    expect(p.help).toEqual([{ reason: 'r', proposedRole: 'planner', instructions: 'i', blocked: false }]);
    expect(p.peer).toEqual([{ to: 'B', text: 'hey' }]);
    expect(stripProtocol(t)).toBe('text\nHARBOR_PEER: not json');
  });
});
