import { describe, expect, it } from 'vitest';
import type { Chunk } from '../src/main/adapters/types';
import { claudeArgs, parseClaudeLine } from '../src/main/adapters/claude';
import { harness, isLead, say } from './hardeningHarness';

const ev = (delta: unknown, extra: object = {}) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta }, session_id: 's', ...extra });

describe('Claude partial messages', () => {
  it('asks for them only on request, never for the concierge', () => {
    const base = { cwd: '.', model: 'default', effort: 'low' as const, permission: 'edit' as const };
    expect(claudeArgs({ ...base, partial: true })).toContain('--include-partial-messages');
    expect(claudeArgs(base)).not.toContain('--include-partial-messages');
    expect(claudeArgs({ ...base, partial: true, lean: true })).not.toContain('--include-partial-messages');
  });
  it('parses text deltas and ignores everything else of a stream_event', () => {
    expect(parseClaudeLine(ev({ type: 'text_delta', text: 'Hel' }))).toEqual([{ kind: 'delta', text: 'Hel' }]);
    expect(parseClaudeLine(ev({ type: 'input_json_delta', partial_json: '{' }))).toEqual([]);
    expect(parseClaudeLine(ev({ type: 'text_delta', text: 'x' }, { parent_tool_use_id: 'toolu_1' }))).toEqual([]);
    expect(parseClaudeLine(JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } }))).toEqual([]);
    expect(parseClaudeLine(JSON.stringify({ type: 'stream_event' }))).toEqual([]);
  });
});

describe('streamed lead messages', () => {
  const turn = (deltas: string[], whole: string): Chunk[] => [...deltas.map((text) => ({ kind: 'delta', text }) as Chunk), { kind: 'text', text: whole }];
  const esc = JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } });

  it('shows complete lines as they arrive and the whole message adds only the rest, without duplicating', async () => {
    const h = await harness({ claude: (_p, o) => (isLead(o) ? turn(['First line\nSec', 'ond line\nthi', 'rd'], 'First line\nSecond line\nthird') : say(esc)) });
    const deltas: string[] = [];
    h.svc.onEvent((e) => { if (e.type === 'messageDelta') deltas.push(e.text); });
    await h.svc.send(h.conv.id, 'do something');
    await h.svc.whenIdle();
    const lead = h.calls(isLead)[0]!;
    expect(lead.opts.partial).toBe(true);
    const msg = (await h.svc.listMessages(h.conv.id)).filter((m) => m.role === 'assistant').at(-1)!;
    expect(msg.text).toBe('First line\nSecond line\nthird');
    expect(deltas.join('')).toContain('Second line');
  });

  it('never shows half a protocol line and falls back to whole messages when there are no deltas', async () => {
    const h = await harness({ claude: (_p, o) => (isLead(o) ? turn(['Working on it\nHARBOR_NOTE: {"te'], 'Working on it') : say(esc)) });
    await h.svc.send(h.conv.id, 'do something');
    await h.svc.whenIdle();
    const texts = (await h.svc.listMessages(h.conv.id)).map((m) => m.text);
    expect(texts.some((t) => t.includes('HARBOR_NOTE'))).toBe(false);
    expect(texts).toContain('Working on it');
    const h2 = await harness({ claude: (_p, o) => (isLead(o) ? say('plain answer') : say(esc)) });
    await h2.svc.send(h2.conv.id, 'do something');
    await h2.svc.whenIdle();
    expect((await h2.svc.listMessages(h2.conv.id)).map((m) => m.text)).toContain('plain answer');
  });
});
