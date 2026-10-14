import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { createMockApi, installMockApi } from '../mock/mockApi';
import { Markdown } from '../components/Markdown';

beforeEach(() => { localStorage.clear(); window.harbor = createMockApi({ delay: 0 }); });
async function ready() { render(<App/>); await screen.findByRole('heading', { name: 'Build the account page' }); await screen.findByText(/I've assigned the account page/); }

describe('Harbor main flows', () => {
  it('preserves an existing preload API', () => { const api = window.harbor; installMockApi(); expect(window.harbor).toBe(api); });
  it('opens a project on first run and creates a conversation', async () => {
    window.harbor = createMockApi({ empty: true, delay: 0 }); render(<App/>);
    await userEvent.click(await screen.findByRole('button', { name: 'Open a project' }));
    await userEvent.click((await screen.findAllByRole('button', { name: 'New conversation' }))[0]);
    expect(await screen.findByLabelText('Message Harbor')).toBeInTheDocument();
  });
  it('streams, updates usage, and denies a reset without consuming it', async () => {
    await ready(); await userEvent.type(screen.getByLabelText('Message Harbor'), 'Add a validation message');
    await userEvent.click(screen.getByRole('button', { name: 'Send ↑' }));
    await screen.findByRole('heading', { name: 'Approve optional free reset?' });
    expect((await window.harbor.getUsage())[0].usedPct).toBe(41);
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(await screen.findByText(/Sample reset declined/)).toBeInTheDocument();
    expect((await window.harbor.getUsage())[1].usedPct).toBe(73);
    expect(screen.getByText("const status = 'ready for review';")).toBeInTheDocument();
  });
  it('opens a subagent conversation with a clear recipient and returns to main', async () => {
    await ready(); await userEvent.click(screen.getByRole('button', { name: /Implement account page implementer/ }));
    expect(await screen.findByLabelText('Message Implement account page')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back to main' }));
    expect(await screen.findByLabelText('Message Harbor')).toBeInTheDocument();
  });
  it('signs in and saves routing/reset preferences', async () => {
    await ready(); await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sign in to Claude Code' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sign in to Claude Code' })).not.toBeInTheDocument());
    expect((await window.harbor.listClis()).find(c => c.id === 'claude')?.signedIn).toBe(true);
    await userEvent.click(screen.getByRole('tab', { name: 'Routing' }));
    await userEvent.selectOptions(screen.getByLabelText('Optional free resets'), 'never');
    await waitFor(async () => expect((await window.harbor.getSettings()).allowFreeReset).toBe('never'));
  });
  it('keeps subagents out of the sidebar and shows them in the main chat', async () => {
    await ready();
    const nav = within(screen.getByRole('navigation', { name: 'Projects and conversations' }));
    expect(nav.queryByText(/Implement account page/)).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Subagents' })).getByRole('button', { name: /Implement account page implementer/ })).toBeInTheDocument();
    // Same main agent, different chat: its subagents must not leak in.
    await userEvent.click(nav.getByRole('button', { name: 'Polish the checkout' }));
    await screen.findByRole('heading', { name: 'Polish the checkout' });
    expect(screen.queryByRole('region', { name: 'Subagents' })).not.toBeInTheDocument();
  });
  it('keeps drafts separate and supports project switching and new-chat shortcuts', async () => {
    await ready(); await userEvent.type(screen.getByLabelText('Message Harbor'), 'Storefront draft');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await userEvent.type(screen.getByLabelText('Search commands, projects and conversations'), 'Internal');
    await userEvent.click(screen.getByRole('option', { name: /Internal tools C:/ }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'New conversation' })[0]).toBeEnabled());
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    expect(await screen.findByLabelText('Message Harbor')).toHaveValue('');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await userEvent.click(screen.getByRole('option', { name: /Storefront C:/ }));
    await waitFor(() => expect(screen.getByLabelText('Message Harbor')).toHaveValue('Storefront draft'));
  });
  it('retains a failed prompt and shows an error', async () => {
    await ready(); window.harbor.send = vi.fn().mockRejectedValue(new Error('CLI disconnected'));
    await userEvent.type(screen.getByLabelText('Message Harbor'), 'Keep this prompt{enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('CLI disconnected');
    await waitFor(() => expect(screen.getByLabelText('Message Harbor')).toHaveValue('Keep this prompt'));
  });
  it('renders untrusted HTML as text', () => { const { container } = render(<Markdown text={'<img src=x onerror=alert(1)>\n\n```html\n<script>alert(1)</script>\n```'}/>); expect(container.querySelector('img')).toBeNull(); expect(container.querySelector('script')).toBeNull(); });
  it('renders a heading followed by prose without a blank line', () => { render(<Markdown text={'### Ready for a first look\nA preview is ready.'}/>); expect(screen.getByRole('heading', { name: 'Ready for a first look' })).toBeInTheDocument(); expect(screen.getByText('A preview is ready.')).toBeInTheDocument(); });
});


describe('Delete conversation', () => {
  it('removes the conversation from the sidebar after confirming', async () => {
    await ready();
    await userEvent.click(screen.getByRole('button', { name: /New conversation/ }));
    const before = (await screen.findAllByRole('button', { name: /^Delete conversation/ })).length;
    await userEvent.click(screen.getAllByRole('button', { name: /^Delete conversation/ })[0]);
    const confirm = await screen.findByRole('dialog', { name: 'Delete conversation?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Delete conversation/ }).length).toBe(before - 1));
  });
  it('pops up an agent question, answers it with an option, and can be dismissed to answer in chat', async () => {
    const api = window.harbor, listeners: Array<(e: any) => void> = [], orig = api.onEvent;
    api.onEvent = cb => { listeners.push(cb); return orig(cb); };
    await ready();
    const ask = (requestId: string, prompt: string) => act(() => listeners.forEach(cb => cb({ type: 'question', requestId, conversationId: 'account', prompt, options: ['Blue', 'Green'], allowText: true })));
    ask('q1', 'Which theme?');
    const dialog = await screen.findByRole('region', { name: /has a question/ });
    expect(within(dialog).getByText('Which theme?')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Blue' }));
    expect(dialog).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send answer' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: /has a question/ })).not.toBeInTheDocument());
    ask('q2', 'Anything else?');
    await userEvent.click(within(await screen.findByRole('region', { name: /has a question/ })).getByRole('button', { name: 'Answer in chat' }));
    expect(screen.queryByRole('region', { name: /has a question/ })).not.toBeInTheDocument();
  });
});
