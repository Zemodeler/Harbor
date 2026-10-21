import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Conversation as ConversationData, GitCommit, HarborApi, HarborEvent, Message } from '../../shared/api';
import App from '../App';
import { Clipped, clipLines, CLIP_LINES } from '../components/Clipped';
import { Conversation, DRAFT_PUSH_MS, MESSAGE_WINDOW } from '../components/Conversation';
import { Markdown, splitFences } from '../components/Markdown';
import { ToolActivity } from '../components/ToolActivity';
import { useHarbor, type HarborState } from '../hooks/useHarbor';
import type { WorkspaceState, QueuedPrompt } from '../hooks/useWorkspace';
import { mergeFetched, mergeMessages, upsertById, upsertByTime } from '../listOps';
import { createMockApi } from '../mock/mockApi';

type Listener = (e: HarborEvent) => void;
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
/** A mock API whose events can also be pushed by the test. */
function harness(delay = 0) {
  const api = createMockApi({ delay });
  const listeners: Listener[] = [];
  const subscribe = api.onEvent;
  api.onEvent = cb => { listeners.push(cb); return subscribe(cb); };
  const push = (e: HarborEvent) => act(() => listeners.forEach(cb => cb(e)));
  window.harbor = api;
  return { api, push };
}
const message = (id: string, time: number, text = id, extra: Partial<Message> = {}): Message => ({ id, conversationId: 'account', role: 'assistant', text, time, ...extra });
beforeEach(() => { localStorage.clear(); window.harbor = createMockApi({ delay: 0 }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('list helpers', () => {
  it('replaces in place and otherwise inserts by time', () => {
    const list = [message('a', 1), message('b', 2), message('d', 4)];
    expect(upsertByTime(list, message('b', 9, 'edited')).map(m => m.id + ':' + m.text)).toEqual(['a:a', 'b:edited', 'd:d']);
    expect(upsertByTime(list, message('c', 3)).map(m => m.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(upsertByTime(list, message('z', 9)).map(m => m.id)).toEqual(['a', 'b', 'd', 'z']);
    expect(upsertById([{ id: 'x', v: 1 }, { id: 'y', v: 1 }], { id: 'x', v: 2 })).toEqual([{ id: 'x', v: 2 }, { id: 'y', v: 1 }]);
  });
  it('lets events seen during a fetch win over the fetched snapshot', () => {
    expect(mergeFetched([{ id: 'a', v: 1 }, { id: 'b', v: 1 }], [{ id: 'b', v: 2 }, { id: 'c', v: 2 }])).toEqual([{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'c', v: 2 }]);
  });
  it('prefers the fetched message unless the cached text is strictly longer', () => {
    const merged = mergeMessages([message('a', 1, 'fresh text'), message('b', 2, 'same')], [message('a', 1, 'old'), message('b', 2, 'same'), message('c', 3, 'streamed')]);
    expect(merged.map(m => m.text)).toEqual(['fresh text', 'same', 'streamed']);
    expect(mergeMessages([message('a', 1, 'short')], [message('a', 1, 'short and more')])[0].text).toBe('short and more');
  });
});

describe('Markdown parsing', () => {
  it('only treats a fence at the start of a line as a fence', () => {
    expect(splitFences('Use ```code``` inline and ``` again\nnext')).toEqual([{ kind: 'text', text: 'Use ```code``` inline and ``` again\nnext' }]);
    expect(splitFences('```ts\nconst a = 1;\n```\nafter').map(p => p.kind)).toEqual(['code', 'text']);
    // Indented four or more spaces is not a fence, and a shorter closing run does not close a longer fence.
    expect(splitFences('    ```\nnot a fence')).toHaveLength(1);
    expect(splitFences('````\n```\nstill code\n````').map(p => p.kind)).toEqual(['code']);
    expect(splitFences('~~~\n```\n~~~')).toEqual([{ kind: 'code', language: '', text: '```' }]);
  });
  it('keeps an unclosed fence readable while a reply streams in', () => {
    const { container } = render(<Markdown text={'Here is the fix:\n```ts\nconst a = 1;\nconst b'}/>);
    expect(container.querySelector('pre code')?.textContent).toBe('const a = 1;\nconst b');
    expect(screen.getByText('Here is the fix:')).toBeInTheDocument();
  });
  it('does not split on backticks inside inline code', () => {
    const { container } = render(<Markdown text={'Type ```` ```ts ```` to start a block.'}/>);
    expect(container.querySelector('pre')).toBeNull();
    expect(container.textContent).toContain('to start a block.');
  });
  it('renders italic, block quotes and nested lists, with everything else inert', () => {
    const { container } = render(<Markdown text={'*slanted* and _also_ but snake_case_name stays\n\n> quoted **bold**\n> second line\n\n- parent\n  - child one\n  - child two\n- sibling\n\n[link](javascript:alert(1)) <b>x</b>'}/>);
    expect([...container.querySelectorAll('em')].map(e => e.textContent)).toEqual(['slanted', 'also']);
    expect(container.textContent).toContain('snake_case_name');
    expect(container.querySelector('blockquote strong')?.textContent).toBe('bold');
    const outer = container.querySelector('ul')!;
    expect([...outer.children].map(li => li.firstChild?.textContent)).toEqual(['parent', 'sibling']);
    expect(outer.querySelectorAll(':scope > li > ul > li')).toHaveLength(2);
    expect(container.querySelector('a, b')).toBeNull();
  });
  it('keeps continuation lines in the item text', () => {
    const { container } = render(<Markdown text={'1. First\n   continues here\n2. Second'}/>);
    expect(container.querySelectorAll('li')[0].textContent).toBe('First\ncontinues here');
  });
});

describe('Clipped output', () => {
  it('clips long text and reveals everything on request', async () => {
    const text = Array.from({ length: CLIP_LINES + 50 }, (_, i) => `line ${i}`).join('\n');
    expect(clipLines(text).lines).toHaveLength(CLIP_LINES);
    expect(clipLines('short').clipped).toBe(false);
    expect(clipLines('x'.repeat(5000)).lines[0].length).toBeLessThan(2100);
    const { container } = render(<Clipped text={text}>{lines => <pre>{lines.join('\n')}</pre>}</Clipped>);
    expect(container.querySelector('pre')!.textContent!.split('\n')).toHaveLength(CLIP_LINES);
    await userEvent.click(screen.getByRole('button', { name: `Show all ${CLIP_LINES + 50} lines` }));
    expect(container.querySelector('pre')!.textContent!.split('\n')).toHaveLength(CLIP_LINES + 50);
  });
  it('renders a tool output body only once its details are open', () => {
    const big = Array.from({ length: 1000 }, (_, i) => `out ${i}`).join('\n');
    const messages: Message[] = [{ ...message('t1', 1, `Bash npm test\n${big}`), role: 'tool' }];
    const { container } = render(<ToolActivity messages={messages}/>);
    expect(container.querySelector('pre')).toBeNull();
    const group = container.querySelector('details')!;
    group.open = true; fireEvent(group, new Event('toggle'));
    const item = container.querySelector('details details')!;
    expect(item.querySelector('pre')).toBeNull();
    item.setAttribute('open', ''); fireEvent(item, new Event('toggle'));
    expect(container.querySelector('pre')!.textContent!.split('\n')).toHaveLength(CLIP_LINES);
  });
});

// ---- Conversation with a hand-built state -------------------------------------------------------------

const conv = (extra: Partial<ConversationData> = {}): ConversationData => ({ id: 'A', projectId: 'p', title: 'A', updated: 0, agentId: 'main', ...extra });
const mainAgent: Agent = { id: 'main', projectId: 'p', role: 'main', title: 'Harbor', state: 'waiting', cli: 'codex', model: 'default', effort: 'medium' };
function fakeState(over: Record<string, unknown> = {}) {
  return { conversation: conv(), agents: [mainAgent], projects: [{ id: 'p', name: 'Project' }], projectId: 'p', messages: [] as Message[], messagesLoading: false, messagesError: '',
    permissions: [], sending: new Set<string>(), lastActivity: {}, send: vi.fn(async () => true), setConversationMode: vi.fn(), run: vi.fn(), openAgent: vi.fn(), refreshClis: vi.fn(), updateConversation: vi.fn(),
    stopConversation: vi.fn(), retryMessages: vi.fn(), newConversation: vi.fn(), api: {}, ...over } as unknown as HarborState;
}
function fakeWorkspace(drafts: Record<string, string> = {}, queue: Record<string, QueuedPrompt[]> = {}) {
  const setDraft = vi.fn(), setQueue = vi.fn();
  return { setDraft, setQueue, ws: { preferences: { drafts, queue, templates: [] }, setDraft, setQueue, saveError: '' } as unknown as WorkspaceState };
}
const view = (state: HarborState, ws: WorkspaceState) => <Conversation state={state} workspace={ws} openProject={() => {}} review={() => {}}/>;
const many = (n: number, role: Message['role'] = 'assistant', start = Date.now() - n * 1000) => Array.from({ length: n }, (_, i) => message(`m${i}`, start + i * 1000, `message ${i}`, { role, conversationId: 'A' }));

describe('Conversation rendering', () => {
  it('windows long conversations and keeps the newest messages with a Show earlier control', async () => {
    render(view(fakeState({ messages: many(400) }), fakeWorkspace().ws));
    expect(screen.getAllByRole('article')).toHaveLength(MESSAGE_WINDOW);
    expect(screen.getByText('message 399')).toBeInTheDocument();
    expect(screen.queryByText('message 0')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: `Show earlier messages (${400 - MESSAGE_WINDOW} more)` }));
    expect(screen.getAllByRole('article')).toHaveLength(MESSAGE_WINDOW * 2);
  });
  it('shows Working only while the session is busy', () => {
    const empty = [message('e', Date.now(), '', { conversationId: 'A' })];
    const { rerender } = render(view(fakeState({ messages: empty }), fakeWorkspace().ws));
    expect(screen.queryByText('Working…')).not.toBeInTheDocument();
    rerender(view(fakeState({ messages: empty, conversation: conv({ activity: { state: 'working', updated: 1 } }) }), fakeWorkspace().ws));
    expect(screen.getByText('Working…')).toBeInTheDocument();
  });
  it('marks messages between sessions distinctly', () => {
    const peer = message('p1', Date.now(), 'You told session "Other": please rebase', { role: 'system', conversationId: 'A' });
    const plain = message('p2', Date.now() + 1, 'Delegated: something', { role: 'system', conversationId: 'A' });
    const { container } = render(view(fakeState({ messages: [peer, plain] }), fakeWorkspace().ws));
    expect(container.querySelectorAll('[data-peer]')).toHaveLength(1);
    expect(screen.getByText('Between sessions')).toBeInTheDocument();
  });
  it('separates days', () => {
    const day = 86400000, base = new Date('2026-03-10T10:00:00').getTime();
    const { container } = render(view(fakeState({ messages: [message('d1', base, 'one', { conversationId: 'A' }), message('d2', base + 1000, 'two', { conversationId: 'A' }), message('d3', base + 3 * day, 'three', { conversationId: 'A' })] }), fakeWorkspace().ws));
    expect(container.querySelectorAll('p > time')).toHaveLength(2);
  });
  it('shows a load failure with Retry instead of the first-run prompt', async () => {
    const state = fakeState({ messagesError: 'disk unreadable' });
    render(view(state, fakeWorkspace().ws));
    expect(screen.getByRole('alert')).toHaveTextContent('disk unreadable');
    expect(screen.queryByText('What shall we work on?')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(state.retryMessages).toHaveBeenCalled();
  });
  it('does not send while messages are loading, not even with Enter', async () => {
    const state = fakeState({ messagesLoading: true });
    render(view(state, fakeWorkspace().ws));
    await userEvent.type(screen.getByLabelText('Message Harbor'), 'too early{enter}');
    expect(state.send).not.toHaveBeenCalled();
  });
  it('lists attached images with their names', () => {
    const m = message('i1', Date.now(), 'see', { role: 'user', conversationId: 'A', attachments: [{ name: 'shot.png', mime: 'image/png' }] });
    render(view(fakeState({ messages: [m] }), fakeWorkspace().ws));
    expect(screen.getByRole('list', { name: 'Attached images' })).toHaveTextContent('shot.png');
  });
});

describe('Composer drafts', () => {
  it('keeps typing local and pushes the draft once after a pause', async () => {
    const { setDraft, ws } = fakeWorkspace();
    render(view(fakeState(), ws));
    await userEvent.type(screen.getByLabelText('Message Harbor'), 'hello there');
    expect(screen.getByLabelText('Message Harbor')).toHaveValue('hello there');
    expect(setDraft).not.toHaveBeenCalled();
    await waitFor(() => expect(setDraft).toHaveBeenCalledWith('A', 'hello there'), { timeout: DRAFT_PUSH_MS * 4 });
    expect(setDraft).toHaveBeenCalledTimes(1);
  });
  it('flushes an unsent draft when the conversation changes', async () => {
    const { setDraft, ws } = fakeWorkspace();
    const { rerender } = render(view(fakeState(), ws));
    await userEvent.type(screen.getByLabelText('Message Harbor'), 'half written');
    rerender(view(fakeState({ conversation: conv({ id: 'B', title: 'B' }) }), ws));
    expect(setDraft).toHaveBeenCalledWith('A', 'half written');
  });
});

describe('Queued follow-ups', () => {
  /** Holds the queue in state like useWorkspace does, with a fixed fake session state. */
  function Harness({ state, initial }: { state: HarborState; initial: QueuedPrompt[] }) {
    const [queue, setQueue] = useState(initial);
    const ws = { preferences: { drafts: {}, queue: { A: queue }, templates: [] }, setDraft: vi.fn(), setQueue: (_: string, f: QueuedPrompt[] | ((q: QueuedPrompt[]) => QueuedPrompt[])) => setQueue(q => typeof f === 'function' ? f(q) : f), saveError: '' } as unknown as WorkspaceState;
    return view(state, ws);
  }
  it('sends one follow-up, then waits for the session to react before sending the next', async () => {
    const send = vi.fn(async (_text: string) => true);   // resolves immediately, before any activity event
    const state = fakeState({ send });
    const items = [{ id: '1', text: 'first' }, { id: '2', text: 'second' }];
    const { rerender } = render(<Harness state={state} initial={items}/>);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await new Promise(r => setTimeout(r, 60));
    expect(send).toHaveBeenCalledTimes(1);          // no burst while nothing has moved
    // The session reports activity (a conversation event): the lock opens.
    rerender(<Harness state={fakeState({ send, conversation: conv({ activity: { state: 'done', updated: 2 } }) })} initial={items}/>);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls.map(c => c[0])).toEqual(['first', 'second']);
  });
});

describe('Hook behaviour', () => {
  async function loaded(h = harness()) {
    const hook = renderHook(() => useHarbor());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await waitFor(() => expect(hook.result.current.messages.length).toBeGreaterThan(0));
    return { ...h, hook };
  }
  it('replaces an updated message in place and inserts new ones by time', async () => {
    const { hook, push } = await loaded();
    const before = hook.result.current.messages.map(m => m.id);
    const first = hook.result.current.messages[0];
    await push({ type: 'message', message: { ...first, text: 'edited' } });
    expect(hook.result.current.messages.map(m => m.id)).toEqual(before);
    expect(hook.result.current.messages[0].text).toBe('edited');
    await push({ type: 'message', message: message('between', first.time + 1, 'between', { conversationId: 'account' }) });
    expect(hook.result.current.messages[1].id).toBe('between');
  });
  it('keeps the order of agents and CLIs when one of them updates', async () => {
    const { hook, push } = await loaded();
    const agents = hook.result.current.agents.map(a => a.id), clis = hook.result.current.clis.map(c => c.id);
    await push({ type: 'agent', agent: { ...hook.result.current.agents[0], summary: 'changed' } });
    await push({ type: 'cli', cli: { ...hook.result.current.clis[0], note: 'changed' } });
    expect(hook.result.current.agents.map(a => a.id)).toEqual(agents);
    expect(hook.result.current.clis.map(c => c.id)).toEqual(clis);
  });
  it('batches streamed deltas into few renders and loses no text', async () => {
    const h = harness();
    let renders = 0;
    const hook = renderHook(() => { renders++; return useHarbor(); });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await waitFor(() => expect(hook.result.current.messages.length).toBeGreaterThan(0));
    const target = hook.result.current.messages.at(-1)!, start = renders;
    for (let i = 0; i < 100; i++) await h.push({ type: 'messageDelta', messageId: target.id, conversationId: 'account', text: '.' });
    await waitFor(() => expect(hook.result.current.messages.at(-1)!.text).toBe(target.text + '.'.repeat(100)));
    expect(renders - start).toBeLessThan(25);
  });
  it('drops a question when the agent stops waiting, when the user writes, or on stop', async () => {
    const { hook, push } = await loaded();
    const ask = (requestId: string, extra: Partial<Extract<HarborEvent, { type: 'question' }>> = {}) => push({ type: 'question', requestId, conversationId: 'account', prompt: 'Which?', options: ['a'], ...extra });
    const agent = hook.result.current.agents.find(a => a.role === 'implementer')!;
    await push({ type: 'agent', agent: { ...agent, state: 'waiting' } });
    await ask('q1', { agentId: agent.id });
    expect(hook.result.current.questions.map(q => q.requestId)).toEqual(['q1']);
    await push({ type: 'agent', agent: { ...agent, state: 'working' } });
    expect(hook.result.current.questions).toHaveLength(0);
    await ask('q2');
    await push({ type: 'message', message: message('u1', Date.now(), 'my answer in chat', { role: 'user', conversationId: 'account' }) });
    expect(hook.result.current.questions).toHaveLength(0);
    await ask('q3');
    await act(async () => { await hook.result.current.stopConversation('account'); });
    expect(hook.result.current.questions).toHaveLength(0);
  });
  it('keeps a failed answer on the question, not in the page banner', async () => {
    const { hook, push, api } = await loaded();
    api.answerQuestion = vi.fn().mockRejectedValue(new Error('agent is gone'));
    await push({ type: 'question', requestId: 'q', conversationId: 'account', prompt: 'Which?', options: ['a'] });
    await act(async () => { await hook.result.current.answerQuestion('q', 'a'); });
    expect(hook.result.current.questionErrors.q).toBe('agent is gone');
    expect(hook.result.current.error).toBe('');
    expect(hook.result.current.questions).toHaveLength(1);
  });
  it('shows a start-up failure with a retry path instead of an empty first run', async () => {
    const api = createMockApi({ delay: 0 });
    const real = api.listProjects;
    api.listProjects = vi.fn().mockRejectedValueOnce(new Error('service not ready')).mockImplementation(real);
    window.harbor = api;
    const hook = renderHook(() => useHarbor());
    await waitFor(() => expect(hook.result.current.startupError).toBe('service not ready'));
    expect(hook.result.current.projects).toEqual([]);
    await act(async () => { await hook.result.current.reload(); });
    expect(hook.result.current.startupError).toBe('');
    expect(hook.result.current.projects.length).toBeGreaterThan(0);
  });
  it('reports a message load failure separately and recovers on retry', async () => {
    const api = createMockApi({ delay: 0 });
    const real = api.listMessages;
    api.listMessages = vi.fn().mockRejectedValueOnce(new Error('read failed')).mockImplementation(real);
    window.harbor = api;
    const hook = renderHook(() => useHarbor());
    await waitFor(() => expect(hook.result.current.messagesError).toBe('read failed'));
    expect(hook.result.current.error).toBe('');
    await act(async () => { await hook.result.current.retryMessages(); });
    expect(hook.result.current.messagesError).toBe('');
    expect(hook.result.current.messages.length).toBeGreaterThan(0);
  });
  it('clears the open project when none is left', async () => {
    const { hook } = await loaded();
    act(() => hook.result.current.clearProject());
    expect(hook.result.current).toMatchObject({ projectId: '', conversations: [], messages: [], agents: [] });
    expect(hook.result.current.conversation).toBeUndefined();
  });
  it('does not let a slow project fetch overwrite an agent event that arrived meanwhile', async () => {
    const { hook, push, api } = await loaded();
    const slow = deferred<Agent[]>(), real = api.listAgents;
    api.listAgents = vi.fn(async (id: string) => id === 'harbor' ? slow.promise : real(id));
    let selecting!: Promise<void>;
    act(() => { selecting = hook.result.current.selectProject('harbor'); });
    const main = { id: 'main-harbor', projectId: 'harbor', role: 'main', title: 'Main agent', state: 'working', cli: 'codex', model: 'default', effort: 'medium' } as Agent;
    await push({ type: 'agent', agent: main });
    await act(async () => { slow.resolve([{ ...main, state: 'waiting' }]); await selecting; });
    expect(hook.result.current.agents.find(a => a.id === 'main-harbor')?.state).toBe('working');
  });
});

describe('Workspace storage', () => {
  it('prunes drafts and queues of a deleted conversation', async () => {
    const { useWorkspace } = await import('../hooks/useWorkspace');
    const ws = renderHook(() => useWorkspace());
    act(() => { ws.result.current.setDraft('x', 'draft'); ws.result.current.setQueue('x', [{ id: '1', text: 'q' }]); ws.result.current.setDraft('y', 'keep'); });
    act(() => ws.result.current.forgetConversation('x'));
    expect(ws.result.current.preferences.drafts).toEqual({ y: 'keep' });
    expect(ws.result.current.preferences.queue).toEqual({});
    ws.unmount();
    expect(JSON.parse(localStorage.getItem('harbor.workspace.v1')!).drafts).toEqual({ y: 'keep' });
  });
});

describe('App flows', () => {
  async function ready() { render(<App/>); await screen.findByRole('heading', { name: 'Build the account page', level: 1 }); await screen.findByText(/I've assigned the account page/); }
  it('shows a start-up error with Retry, not the first-run screen', async () => {
    const api = createMockApi({ delay: 0 });
    const real = api.listProjects;
    api.listProjects = vi.fn().mockRejectedValueOnce(new Error('service not ready')).mockImplementation(real);
    window.harbor = api; render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Harbor could not start' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open a project' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Build the account page', level: 1 })).toBeInTheDocument();
  });
  it('lets the user dismiss the error banner', async () => {
    await ready();
    window.harbor.send = vi.fn().mockRejectedValue(new Error('CLI disconnected'));
    await userEvent.type(screen.getByLabelText('Message Harbor'), 'x{enter}');
    const banner = await screen.findByRole('alert');
    await userEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('keeps a question as a card: a failed answer stays on it, other dialogs still open, typed text survives', async () => {
    const { api, push } = harness();
    await ready();
    api.answerQuestion = vi.fn().mockRejectedValue(new Error('agent is gone'));
    await push({ type: 'question', requestId: 'q1', conversationId: 'account', prompt: 'Which theme?', allowText: true });
    const card = await screen.findByRole('region', { name: /has a question/ });
    await userEvent.type(within(card).getByLabelText('Your answer'), 'warm tones');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: 'Quick actions' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /has a question/ })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(within(screen.getByRole('region', { name: /has a question/ })).getByLabelText('Your answer')).toHaveValue('warm tones');
    await userEvent.click(within(screen.getByRole('region', { name: /has a question/ })).getByRole('button', { name: 'Send answer' }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: /has a question/ })).getByRole('alert')).toHaveTextContent('agent is gone'));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
  it('disables deleting a conversation while it is working and asks in a dialog otherwise', async () => {
    const { push } = harness();
    await ready();
    const nav = within(screen.getByRole('navigation', { name: 'Projects and conversations' }));
    await userEvent.click(nav.getByRole('button', { name: 'New conversation' }));
    await userEvent.click((await screen.findAllByLabelText('Options for New conversation'))[0]);
    expect(await screen.findByRole('menuitem', { name: /^Delete conversation New conversation/ })).toBeEnabled();
    await userEvent.keyboard('{Escape}');
    const c = (await window.harbor.listConversations('store')).find(x => x.title === 'New conversation')!;
    await push({ type: 'conversation', conversation: { ...c, activity: { state: 'working', updated: Date.now() } } });
    await userEvent.click(screen.getAllByLabelText('Options for New conversation')[0]);
    const busy = await screen.findByRole('menuitem', { name: /^Delete conversation New conversation/ });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAccessibleDescription('Stop this session or clear its queue before deleting it');
  });
  it('closes an open conversation menu with Escape', async () => {
    await ready();
    const trigger = screen.getByLabelText('Options for Polish the checkout');
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu', { name: 'Options for Polish the checkout' })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });
  it('removing the last project clears the open project instead of leaving stale state', async () => {
    const hook = renderHook(() => useHarbor());
    await waitFor(() => expect(hook.result.current.messages.length).toBeGreaterThan(0));
    for (const p of hook.result.current.projects) await act(async () => { await hook.result.current.removeProject(p.id); });
    await waitFor(() => expect(hook.result.current.projects).toEqual([]));
    expect(hook.result.current).toMatchObject({ projectId: '', conversations: [], messages: [], agents: [], startupError: '' });
    expect(hook.result.current.conversation).toBeUndefined();
  });
  it('moves focus to the view heading when the view changes', async () => {
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Connections & preferences', level: 1 })).toHaveFocus());
  });
});

describe('Git history window', () => {
  it('renders only a window of the loaded commits', async () => {
    const api = createMockApi({ delay: 0 });
    const commits: GitCommit[] = Array.from({ length: 250 }, (_, i) => ({ hash: i.toString(16).padStart(40, '0'), parents: i < 249 ? [(i + 1).toString(16).padStart(40, '0')] : [], subject: `commit ${i}`, author: 'A', time: 1000 + i, refs: [] }));
    api.getGitLog = vi.fn(async () => commits);
    window.harbor = api as HarborApi; render(<App/>);
    await screen.findByRole('heading', { name: 'Build the account page', level: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Git' }));
    await screen.findByText('commit 0');
    expect(screen.queryByText('commit 150')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Show more commits/ }));
    expect(await screen.findByText('commit 150')).toBeInTheDocument();
  });
});

describe('Production entry', () => {
  it('shows an error screen instead of sample data when the bridge is missing outside development', async () => {
    vi.resetModules(); vi.stubEnv('DEV', false);
    document.body.innerHTML = '<div id="root"></div>';
    // @ts-expect-error the bridge is absent in this scenario
    delete window.harbor;
    await import('../main');
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot reach its background service');
    expect(window.harbor).toBeUndefined();
  });
});

describe('Send now with attachments', () => {
  it('sends the attached images with the steer message and clears them from the composer', async () => {
    const send = vi.fn(async () => true);
    const state = fakeState({ send, conversation: conv({ activity: { state: 'working', updated: 1 } }), messages: [message('e', Date.now(), 'hi', { conversationId: 'A' })] });
    render(view(state, fakeWorkspace().ws));
    await userEvent.upload(screen.getByLabelText('Choose images'), [new File(['x'], 'shot.png', { type: 'image/png' })]);
    await screen.findByRole('list', { name: 'Images to send' });
    await userEvent.type(screen.getByRole('textbox', { name: 'Message Harbor' }), 'look at this');
    await userEvent.click(screen.getByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][0]).toBe('look at this');
    expect(send.mock.calls[0][1]).toEqual([{ name: 'shot.png', mime: 'image/png', dataBase64: expect.any(String) }]);
    expect(send.mock.calls[0][2]).toEqual({ steer: true });
    expect(screen.queryByRole('list', { name: 'Images to send' })).not.toBeInTheDocument();
  });
  it('offers Send now for attachments alone and keeps them when the send fails', async () => {
    const send = vi.fn(async () => false);
    render(view(fakeState({ send, conversation: conv({ activity: { state: 'working', updated: 1 } }) }), fakeWorkspace().ws));
    expect(screen.getByRole('button', { name: 'Send now' })).toBeDisabled();
    await userEvent.upload(screen.getByLabelText('Choose images'), [new File(['x'], 'shot.png', { type: 'image/png' })]);
    await screen.findByRole('list', { name: 'Images to send' });
    expect(screen.getByRole('button', { name: 'Send now' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][1]).toEqual([{ name: 'shot.png', mime: 'image/png', dataBase64: expect.any(String) }]);
    expect(await screen.findByRole('button', { name: 'Remove shot.png' })).toBeInTheDocument(); // put back for a retry
    expect(screen.getByText('Your message was kept. Retry when the connection is ready.')).toBeInTheDocument();
  });
});
