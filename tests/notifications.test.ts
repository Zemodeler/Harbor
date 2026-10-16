import { describe, expect, it } from 'vitest';
import type { Conversation, HarborEvent } from '../src/shared/api';
import { NotificationGate } from '../src/main/notifications';

// Inspection 2026-10-16, P0 item 10: desktop notifications only on a real activity transition, never on rename, pin or deadline events.

const conv = (over: Partial<Conversation> = {}): Conversation => ({ id: 'c1', projectId: 'p', title: 'Task', updated: 1, agentId: 'main', ...over });
const ev = (c: Conversation): HarborEvent => ({ type: 'conversation', conversation: c });
const quiet = () => false;

describe('NotificationGate', () => {
  it('notifies once when a conversation becomes done or failed, and not for cosmetic re-emits of the same state', () => {
    const g = new NotificationGate();
    expect(g.check(ev(conv({ activity: { state: 'working', updated: 1 } })), quiet)).toBeUndefined();
    expect(g.check(ev(conv({ activity: { state: 'done', updated: 2 } })), quiet)).toBe('finished');
    // Rename, pin, deadline: the conversation is emitted again with the same activity.
    expect(g.check(ev(conv({ title: 'Renamed', activity: { state: 'done', updated: 2 } })), quiet)).toBeUndefined();
    expect(g.check(ev(conv({ pinned: true, activity: { state: 'done', updated: 2 } })), quiet)).toBeUndefined();
    expect(g.check(ev(conv({ deadline: 99, activity: { state: 'done', updated: 2 } })), quiet)).toBeUndefined();
    expect(g.check(ev(conv({ activity: { state: 'working', updated: 3 } })), quiet)).toBeUndefined();
    expect(g.check(ev(conv({ activity: { state: 'failed', updated: 4, detail: 'crashed' } })), quiet)).toBe('attention');
    expect(g.check(ev(conv({ title: 'Renamed again', activity: { state: 'failed', updated: 4, detail: 'crashed' } })), quiet)).toBeUndefined();
  });

  it('seeds known states, so the first cosmetic event of an already finished conversation is silent', () => {
    const g = new NotificationGate();
    g.seed([conv({ activity: { state: 'done', updated: 1 } }), conv({ id: 'c2' })]);
    expect(g.check(ev(conv({ title: 'Renamed', activity: { state: 'done', updated: 1 } })), quiet)).toBeUndefined();
    expect(g.check(ev(conv({ id: 'c2', activity: { state: 'done', updated: 2 } })), quiet)).toBe('finished');
    // Unseeded conversations (created after startup) notify on their first done too.
    expect(g.check(ev(conv({ id: 'c3', activity: { state: 'done', updated: 2 } })), quiet)).toBe('finished');
  });

  it('holds a done notification while helpers of the conversation are still busy, and keeps questions and permissions', () => {
    const g = new NotificationGate();
    expect(g.check(ev(conv({ activity: { state: 'done', updated: 1 } })), () => true)).toBeUndefined();
    expect(g.check({ type: 'question', requestId: 'q', conversationId: 'c1', prompt: 'Which one?' }, quiet)).toBe('attention');
    expect(g.check({ type: 'permission', requestId: 'r', kind: 'tool', prompt: 'Run npm test?' }, quiet)).toBe('attention');
    expect(g.check({ type: 'message', message: { id: 'm', conversationId: 'c1', role: 'assistant', text: 'hi', time: 1 } }, quiet)).toBeUndefined();
  });
});
