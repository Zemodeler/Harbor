import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { createMockApi } from '../mock/mockApi';
import { QuestionDialog } from '../components/Question';
import { useWorkspace } from '../hooks/useWorkspace';
import { groupMessages, ToolActivity } from '../components/ToolActivity';
import { sessionStatus } from '../session';
import type { Agent, Message } from '../../shared/api';

beforeEach(() => { localStorage.clear(); window.harbor = createMockApi({ delay: 0 }); });
async function ready() { render(<App/>); await screen.findByRole('heading', { name: 'Build the account page' }); await screen.findByText(/I've assigned/); }
describe('Question menu', () => {
  it('requires explicit submission and preserves a custom answer while pending', async () => {
    const answer = vi.fn(), dismiss = vi.fn();
    const props = { q: { type: 'question' as const, requestId: 'q', conversationId: 'account', prompt: 'Which palette?', options: ['Ocean', 'Olive'], allowText: true }, who: 'Harbor', answer, dismiss, pending: false };
    const view = render(<QuestionDialog {...props}/>);
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: 'Olive' }));
    expect(answer).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('radio', { name: 'Write my own answer' }));
    await userEvent.type(screen.getByLabelText('Your answer'), 'Warm neutrals, please');
    await userEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(answer).toHaveBeenCalledWith('Warm neutrals, please');
    view.rerender(<QuestionDialog {...props} pending/>);
    expect(screen.getByLabelText('Your answer')).toHaveValue('Warm neutrals, please');
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(dismiss).not.toHaveBeenCalled();
  });
});
describe('Workspace quality of life', () => {
  it('persists drafts and pauses saved follow-ups after reopening', async () => {
    const first = renderHook(() => useWorkspace());
    act(() => { first.result.current.setDraft('account', 'Keep this draft'); first.result.current.setQueue('account', [{ id: 'follow', text: 'Review accessibility' }]); });
    first.unmount();
    const reopened = renderHook(() => useWorkspace());
    expect(reopened.result.current.preferences.drafts.account).toBe('Keep this draft');
    expect(reopened.result.current.preferences.queue.account[0]).toMatchObject({ text: 'Review accessibility', paused: true });
  });
  it('archives and restores a conversation through history', async () => {
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Polish the checkout' }));
    await screen.findByRole('heading', { name: 'Polish the checkout' });
    await userEvent.click(screen.getByLabelText('Options for Polish the checkout'));
    await userEvent.click(screen.getAllByRole('button', { name: 'Archive', hidden: true }).find(b => b.closest('details')?.open)!);
    await waitFor(() => expect(within(screen.getByRole('navigation')).queryByRole('button', { name: 'Polish the checkout' })).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Conversation history' }));
    const history = await screen.findByRole('dialog', { name: 'Conversation history' });
    await userEvent.click(within(history).getByRole('button', { name: /Polish the checkout Storefront · Archived/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Restore conversation' }));
    expect(await within(screen.getByRole('navigation')).findByRole('button', { name: 'Polish the checkout' })).toBeInTheDocument();
  });
  it('resumes a paused queue explicitly after a stopped session', async () => {
    await window.harbor.stopConversation('checkout');
    window.harbor.send = vi.fn().mockResolvedValue(undefined);
    localStorage.setItem('harbor.workspace.v1', JSON.stringify({ queue: { checkout: [{ id: 'follow', text: 'Continue the review' }] } }));
    await ready();
    await userEvent.click(screen.getByRole('button', { name: /Polish the checkout Stopped/ }));
    await screen.findByRole('heading', { name: 'Polish the checkout' });
    expect(window.harbor.send).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Resume queue' }));
    await waitFor(() => expect(window.harbor.send).toHaveBeenCalledExactlyOnceWith('checkout', 'Continue the review'));
    await waitFor(() => expect(screen.queryByText('1 queued follow-up')).not.toBeInTheDocument());
  });
  it('shows session details and finds commands by name with keyboard navigation', async () => {
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Session information' }));
    expect(await screen.findByText('Current step')).toBeInTheDocument();
    expect(screen.getByText('Subagents · 3')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close session information' }));
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = screen.getByLabelText('Find a project');
    await userEvent.type(input, 'settings');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(await screen.findByRole('heading', { name: 'Connections & preferences' })).toBeInTheDocument();
  });
  it('groups only consecutive tools and keeps commands available on expansion', async () => {
    const tools: Message[] = [1, 2].map(n => ({ id: String(n), conversationId: 'c', agentId: 'a', role: 'tool', time: n, text: n === 1 ? 'Read src/account.tsx' : 'Bash npm test' }));
    const answer: Message = { ...tools[0], id: 'answer', role: 'assistant', text: 'Checked.' };
    expect(groupMessages([...tools, answer, tools[0]]).map(g => g.length)).toEqual([2, 1, 1]);
    render(<ToolActivity messages={tools}/>);
    await userEvent.click(screen.getByText('Used 2 tools'));
    await userEvent.click(screen.getByText('Read account.tsx'));
    expect(screen.getByText('Read src/account.tsx')).toBeVisible();
  });
  it('does not use the shared main agent state for another conversation', () => {
    const main: Agent = { id: 'main', projectId: 'p', role: 'main', title: 'Lead', state: 'working', cli: 'claude', model: 'haiku', effort: 'low' };
    expect(sessionStatus({ id: 'other', projectId: 'p', title: 'Other', agentId: 'main', updated: 1 }, [main], new Set())).toBe('idle');
  });
});
