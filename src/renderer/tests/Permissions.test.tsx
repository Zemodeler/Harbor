import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarborEvent, PendingPermission } from '../../shared/api';
import App from '../App';
import { createMockApi } from '../mock/mockApi';
import { PERMISSION_POLL_MS } from '../hooks/useHarbor';

type Listener = (e: HarborEvent) => void;
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
/** A mock API whose events can also be pushed by the test, recording the order of subscribe and snapshot calls. */
function harness(options: Parameters<typeof createMockApi>[0] = {}) {
  const api = createMockApi({ delay: 0, ...options });
  const listeners: Listener[] = [], calls: string[] = [];
  const onEvent = api.onEvent;
  api.onEvent = cb => { calls.push('subscribe'); listeners.push(cb); return onEvent(cb); };
  const list = api.listPendingPermissions;
  api.listPendingPermissions = vi.fn(() => { calls.push('list'); return list(); });
  const push = (e: HarborEvent) => act(() => listeners.forEach(cb => cb(e)));
  window.harbor = api;
  return { api, calls, push, original: { list, answer: api.answerPermission } };
}
const tool = (requestId: string, extra: Partial<PendingPermission> = {}): PendingPermission => ({ type: 'permission', requestId, kind: 'tool', tool: 'Bash', prompt: `The lead agent asks to run Bash: ${requestId}`, agentId: 'main-store', conversationId: 'account', alwaysAllow: true, expiresAt: Date.now() + 300000, ...extra });
const panel = () => screen.queryByRole('region', { name: /Waiting for your answer|Approval requests/ });
const card = (name: RegExp | string) => within(panel()!).getByRole('article', { name });
const cards = () => { const p = panel(); return p ? within(p).queryAllByRole('article') : []; };
const gone = (name: string) => expect(panel() && within(panel()!).queryByRole('article', { name })).toBeFalsy();
async function ready() { render(<App/>); await screen.findByRole('heading', { name: 'Build the account page', level: 1 }); }

beforeEach(() => localStorage.clear());
afterEach(() => { vi.useRealTimers(); });

describe('Pending permission requests', () => {
  it('restores requests raised before a renderer reload, after subscribing, with kind, prompt, target and expiry', async () => {
    const { api, calls } = harness();
    await api.send('account', 'Please ask for permission first');   // events fire while no renderer is listening
    expect(await api.listPendingPermissions()).toHaveLength(3);
    calls.length = 0;
    await ready();
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(calls.indexOf('subscribe')).toBeLessThan(calls.indexOf('list'));
    const bash = card('Allow Bash?');
    expect(within(bash).getByText('Tool permission')).toBeInTheDocument();
    expect(within(bash).getByText('The lead agent asks to run Bash: npm test')).toBeInTheDocument();
    expect(within(bash).getByText('Asked by Main agent')).toBeInTheDocument();
    expect(within(bash).getByText('In this conversation')).toBeInTheDocument();
    expect(within(bash).getByText(/Denied automatically at/)).toHaveTextContent(/5 min left/);
    const conflict = card('Allow parallel editing?');
    expect(within(conflict).getByText('File conflict')).toBeInTheDocument();
    expect(within(conflict).getByText('Asked by Implement account page')).toBeInTheDocument();
    expect(within(conflict).queryByText(/Denied automatically/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Waiting for your answer/ })).toHaveTextContent('3');
  });

  it('keeps events that arrive while the snapshot loads and never shows a request twice', async () => {
    const { api, push } = harness();
    const snapshot = deferred<PendingPermission[]>();
    api.listPendingPermissions = vi.fn(() => snapshot.promise);
    await ready();
    push(tool('live'));
    push(tool('live'));
    await act(async () => snapshot.resolve([tool('live'), tool('restored', { tool: 'Edit', prompt: 'Edit src/a.ts' })]));
    expect(cards()).toHaveLength(2);
    expect(card('Allow Edit?')).toBeInTheDocument();
    expect(screen.getAllByText('The lead agent asks to run Bash: live')).toHaveLength(1);
  });

  it('drops a request whose expiry already passed when restoring it', async () => {
    const { api } = harness();
    api.listPendingPermissions = vi.fn(async () => [tool('stale', { expiresAt: Date.now() - 1000 }), tool('fresh', { tool: 'Grep' })]);
    await ready();
    await waitFor(() => expect(card('Allow Grep?')).toBeInTheDocument());
    expect(cards()).toHaveLength(1);
  });

  it('offers Always allow only when the request allows it, and sends exactly that answer', async () => {
    const { api } = harness();
    const answer = vi.spyOn(api, 'answerPermission');
    await ready();
    await act(async () => { await api.send('account', 'ask for permission'); });
    await waitFor(() => expect(cards()).toHaveLength(3));
    const write = card('Allow Write?');
    expect(within(write).queryByRole('button', { name: 'Always allow for this project' })).not.toBeInTheDocument();
    expect(within(write).getByText(/can only be allowed once/)).toBeInTheDocument();
    expect(within(card('Allow parallel editing?')).queryByRole('button', { name: /Always/ })).not.toBeInTheDocument();
    const bash = card('Allow Bash?');
    const bashId = (await api.listPendingPermissions()).find(p => p.tool === 'Bash')!.requestId;
    await userEvent.click(within(bash).getByRole('button', { name: 'Always allow for this project' }));
    expect(answer).toHaveBeenCalledWith(bashId, true, { always: true });
    await waitFor(() => gone('Allow Bash?'));
    expect(await api.listToolRules('store')).toEqual([expect.objectContaining({ tool: 'Bash', prefix: 'npm test' })]);
    await userEvent.click(within(card('Allow Write?')).getByRole('button', { name: 'Allow once' }));
    expect(answer).toHaveBeenLastCalledWith(expect.any(String), true);
    await userEvent.click(within(card('Allow parallel editing?')).getByRole('button', { name: 'Deny' }));
    expect(answer).toHaveBeenLastCalledWith(expect.any(String), false);
    await waitFor(() => expect(cards()).toHaveLength(0));
    expect(await api.listToolRules('store')).toHaveLength(1);
  });

  it('removes an expired request without answering it and says Harbor denied it', async () => {
    const { api } = harness({ toolTimeoutMs: 200, conflictWithdrawMs: 60000 });
    const answer = vi.spyOn(api, 'answerPermission');
    await ready();
    await act(async () => { await api.send('account', 'ask for permission'); });
    await waitFor(() => expect(cards()).toHaveLength(3));
    await waitFor(() => expect(cards()).toHaveLength(1), { timeout: 2000 });
    expect(card('Allow parallel editing?')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('2 requests expired without an answer. Harbor denied them');
    expect(answer).not.toHaveBeenCalled();
  });

  it('reconciles withdrawn requests by polling only while some remain, and keeps requests newer than the check', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api, push, original } = harness({ conflictWithdrawMs: 1000 });
    await ready();
    await act(async () => { await api.send('account', 'ask for permission'); });
    await waitFor(() => expect(cards()).toHaveLength(3));
    // The conflict becomes moot in the core; no event says so.
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(card('Allow parallel editing?')).toBeInTheDocument();
    // A poll that started before a new event must not remove that event's card.
    const poll = deferred<PendingPermission[]>();
    vi.mocked(api.listPendingPermissions).mockImplementationOnce(() => poll.promise);
    await act(() => vi.advanceTimersByTimeAsync(PERMISSION_POLL_MS));
    push(tool('newer', { tool: 'Glob' }));
    await act(async () => poll.resolve(await original.list()));
    gone('Allow parallel editing?');
    expect(card('Allow Glob?')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('no longer needs an answer');
    // The next poll removes it once Harbor no longer lists it.
    await act(() => vi.advanceTimersByTimeAsync(PERMISSION_POLL_MS));
    gone('Allow Glob?');
    for (const name of ['Allow Bash?', 'Allow Write?']) await act(async () => { fireEvent.click(within(card(name)).getByRole('button', { name: 'Deny' })); });
    await waitFor(() => expect(cards()).toHaveLength(0));
    const count = vi.mocked(api.listPendingPermissions).mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(PERMISSION_POLL_MS * 6));
    expect(vi.mocked(api.listPendingPermissions).mock.calls.length).toBe(count);
  });

  it('shows a clear error when checking pending requests fails and keeps the requests', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api, push } = harness();
    await ready();
    push(tool('kept'));
    vi.mocked(api.listPendingPermissions).mockRejectedValue(new Error('Harbor is restarting'));
    await act(() => vi.advanceTimersByTimeAsync(PERMISSION_POLL_MS));
    expect(await screen.findByText(/Could not check which requests are still waiting \(Harbor is restarting\)/)).toBeInTheDocument();
    expect(cards()).toHaveLength(1);
  });

  it('keeps a request, the focus and the other cards usable when an answer fails', async () => {
    const { api } = harness({ conflictWithdrawMs: 60000 });
    await ready();
    await act(async () => { await api.send('account', 'ask for permission'); });
    await waitFor(() => expect(cards()).toHaveLength(3));
    const answer = vi.spyOn(api, 'answerPermission').mockRejectedValueOnce(new Error('Connection lost'));
    const allow = within(card('Allow Bash?')).getByRole('button', { name: 'Allow once' });
    await userEvent.click(allow);
    expect(await within(card('Allow Bash?')).findByRole('alert')).toHaveTextContent('Harbor did not accept your answer: Connection lost');
    expect(allow).toHaveFocus();
    expect(cards()).toHaveLength(3);
    answer.mockRestore();
    await userEvent.click(allow);
    await waitFor(() => expect(cards()).toHaveLength(2));
    // Focus moves to the card that took its place, not to the page; its buttons work from the keyboard.
    expect(card('Allow Write?')).toHaveFocus();
    const again = vi.spyOn(api, 'answerPermission');
    await userEvent.keyboard('{Tab}{Tab}{Enter}');
    expect(again).toHaveBeenLastCalledWith(expect.any(String), true);
    await waitFor(() => expect(cards()).toHaveLength(1));
  });

  it('asks again before using a free reset and never answers on its own', async () => {
    const { api, push } = harness();
    const answer = vi.spyOn(api, 'answerPermission').mockResolvedValue(undefined);
    await ready();
    push({ type: 'permission', requestId: 'reset', kind: 'freeReset', prompt: 'Use one free reset for the weekly window?' });
    const reset = card('Approve optional free reset?');
    await userEvent.click(within(reset).getByRole('button', { name: 'Use free reset…' }));
    expect(within(reset).getByRole('button', { name: 'Back' })).toHaveFocus();
    await userEvent.click(within(reset).getByRole('button', { name: 'Back' }));
    expect(within(reset).getByRole('button', { name: 'Use free reset…' })).toHaveFocus();
    expect(answer).not.toHaveBeenCalled();
    await userEvent.click(within(reset).getByRole('button', { name: 'Use free reset…' }));
    await userEvent.click(within(reset).getByRole('button', { name: 'Confirm free reset' }));
    expect(answer).toHaveBeenCalledWith('reset', true);
  });

  it('can hide the cards to read the conversation and shows them again for a new request', async () => {
    const { push } = harness();
    await ready();
    push(tool('a'));
    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(cards()).toHaveLength(0);
    expect(screen.getByRole('heading', { name: /Waiting for your answer/ })).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: 'Show requests' })).toHaveAttribute('aria-expanded', 'false');
    push(tool('b', { tool: 'Edit' }));
    expect(cards()).toHaveLength(2);
  });

  it('lets the user navigate, type, use shortcuts and answer questions while tool approvals wait', async () => {
    const { push } = harness();
    await ready();
    push(tool('a')); push(tool('b', { tool: 'Edit', conversationId: 'checkout' })); push(tool('c', { tool: 'Read', conversationId: 'elsewhere' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(card('Allow Read?')).getByText('In a conversation outside this project')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Message Harbor'), 'Still typing');
    expect(screen.getByLabelText('Message Harbor')).toHaveValue('Still typing');
    await userEvent.click(within(card('Allow Edit?')).getByRole('button', { name: 'Polish the checkout' }));
    await screen.findByRole('heading', { name: 'Polish the checkout', level: 1 });
    expect(within(card('Allow Edit?')).getByText('In this conversation')).toBeInTheDocument();
    const nav = within(screen.getByRole('navigation', { name: 'Projects and conversations' }));
    await userEvent.click(nav.getByRole('button', { name: /^Build the account page/ }));
    await screen.findByRole('heading', { name: 'Build the account page', level: 1 });
    await waitFor(() => expect(screen.getByLabelText('Message Harbor')).toHaveValue('Still typing'));
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: 'Quick actions' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    push({ type: 'question', requestId: 'q', conversationId: 'account', prompt: 'Which theme?', options: ['Blue'] });
    expect(await screen.findByRole('dialog', { name: /has a question/ })).toBeInTheDocument();
    expect(cards()).toHaveLength(3);
  });
});

