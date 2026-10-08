import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { createMockApi, installMockApi } from '../mock/mockApi';
import { Markdown } from '../components/Markdown';

beforeEach(() => { window.harbor = createMockApi({ delay: 0 }); });
async function ready() { render(<App/>); await screen.findByRole('heading', { name: 'Build the account page' }); await screen.findByText(/I've assigned the account page/); }

describe('Harbor main flows', () => {
  it('preserves an existing preload API', () => { const api = window.harbor; installMockApi(); expect(window.harbor).toBe(api); });
  it('opens a project on first run and creates a conversation', async () => {
    window.harbor = createMockApi({ empty: true, delay: 0 }); render(<App/>);
    await userEvent.click(await screen.findByRole('button', { name: 'Open a project' }));
    await userEvent.type(screen.getByLabelText('Project folder'), 'C:\\Projects\\Example');
    await userEvent.click(screen.getByRole('button', { name: 'Open project' }));
    await userEvent.click(await screen.findByRole('button', { name: 'New conversation' }));
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
  it('keeps drafts separate and supports project switching and new-chat shortcuts', async () => {
    await ready(); await userEvent.type(screen.getByLabelText('Message Harbor'), 'Storefront draft');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await userEvent.type(screen.getByLabelText('Find a project'), 'Internal');
    await userEvent.click(screen.getByRole('button', { name: /Internal tools C:/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'New conversation' })).toBeEnabled());
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    expect(await screen.findByLabelText('Message Harbor')).toHaveValue('');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await userEvent.click(screen.getByRole('button', { name: /Storefront C:/ }));
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

