import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { Conversation } from '../components/Conversation';
import type { HarborState } from '../hooks/useHarbor';
import type { WorkspaceState } from '../hooks/useWorkspace';
import { createMockApi } from '../mock/mockApi';
import type { Conversation as ConversationData, Message } from '../../shared/api';

beforeEach(() => localStorage.clear());
const panel = () => screen.getByRole('region', { name: /Waiting for your answer|Approval requests/ });
const shotCard = () => within(panel()).getByRole('article', { name: 'Allow a screenshot?' });
async function ready() { render(<App/>); await screen.findByRole('heading', { name: 'Build the account page', level: 1 }); }

describe('Screenshot request card', () => {
  it('shows who asks and why, warns about secrets, and needs the user to pick and preview a source before capturing', async () => {
    const api = createMockApi({ delay: 0 });
    window.harbor = api;
    const preview = vi.spyOn(api, 'previewScreenshot');
    const answer = vi.spyOn(api, 'answerScreenshot');
    await api.send('account', 'Please take a screenshot of the page');
    await ready();
    const card = await waitFor(() => shotCard());
    expect(within(card).getByText('Screenshot')).toBeInTheDocument();
    expect(within(card).getByText('check the new account page layout')).toBeInTheDocument();
    expect(within(card).getByText(/a window like “Storefront”/)).toBeInTheDocument();
    expect(within(card).getByRole('note')).toHaveTextContent(/passwords, tokens and private messages/);
    // A live preview of every window and screen; nothing is preselected, so Capture is not available yet.
    const sources = await within(card).findAllByRole('radio');
    expect(sources).toHaveLength(3);
    expect(sources.every(r => !(r as HTMLInputElement).checked)).toBe(true);
    expect(within(card).getByText(/matches the request/)).toBeInTheDocument();
    const capture = within(card).getByRole('button', { name: 'Capture and send' });
    expect(capture).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(capture);
    expect(answer).not.toHaveBeenCalled();

    // A whole screen: no "allow for this conversation".
    await userEvent.click(within(card).getByRole('radio', { name: /Screen: Entire Screen/ }));
    expect(await within(card).findByRole('img', { name: /Preview of Entire Screen/ })).toBeInTheDocument();
    expect(within(card).queryByRole('checkbox')).not.toBeInTheDocument();
    // A window: the option appears, unticked; switching sources resets it.
    await userEvent.click(within(card).getByRole('radio', { name: /Storefront – localhost/ }));
    const allow = within(card).getByRole('checkbox', { name: /Allow this window for the rest of this conversation/ });
    expect(allow).not.toBeChecked();
    await userEvent.click(allow);
    await within(card).findByRole('img', { name: /Preview of Storefront/ });
    expect(preview).toHaveBeenCalledWith(expect.any(String), { sourceId: 'window:101:0' });
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Capture and send' })).toHaveAttribute('aria-disabled', 'false'));
    await userEvent.click(within(card).getByRole('button', { name: 'Capture and send' }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith(expect.any(String), { allow: true, sourceId: 'window:101:0', forConversation: true }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Allow a screenshot?' })).not.toBeInTheDocument());
  });

  it('deny declines through answerPermission and never captures', async () => {
    const api = createMockApi({ delay: 0 });
    window.harbor = api;
    const permission = vi.spyOn(api, 'answerPermission');
    const answer = vi.spyOn(api, 'answerScreenshot');
    await api.send('account', 'take a screenshot');
    await ready();
    const card = await waitFor(() => shotCard());
    await userEvent.click(within(card).getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(permission).toHaveBeenCalledWith(expect.any(String), false));
    expect(answer).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Allow a screenshot?' })).not.toBeInTheDocument());
  });

  it('cannot be approved without the preview methods (an older Harbor)', async () => {
    const api = createMockApi({ delay: 0 });
    delete (api as Partial<typeof api>).previewScreenshot;
    window.harbor = api;
    await api.send('account', 'take a screenshot');
    await ready();
    const card = await waitFor(() => shotCard());
    expect(within(card).getByRole('alert')).toHaveTextContent(/cannot show a preview/);
    expect(within(card).getByRole('button', { name: 'Capture and send' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('the mock refuses a bare yes and a capture of a source that was never previewed, like Harbor', async () => {
    const api = createMockApi({ delay: 0 });
    await api.send('account', 'take a screenshot');
    const [p] = await api.listPendingPermissions();
    await expect(api.answerPermission(p.requestId, true)).rejects.toThrow(/screenshot card/);
    await expect(api.answerScreenshot!(p.requestId, { allow: true, sourceId: 'screen:0:0' })).rejects.toThrow(/preview first/);
    await api.previewScreenshot!(p.requestId);
    await expect(api.answerScreenshot!(p.requestId, { allow: true, sourceId: 'screen:0:0', forConversation: true })).rejects.toThrow(/window only/);
    await api.answerScreenshot!(p.requestId, { allow: true, sourceId: 'screen:0:0' });
    expect(await api.listPendingPermissions()).toEqual([]);
  });
});

describe('Image thumbnails in messages', () => {
  const conv: ConversationData = { id: 'c', projectId: 'p', title: 'T', updated: 0, agentId: 'main' };
  const state = (messages: Message[]) => ({
    conversation: conv, agents: [{ id: 'main', role: 'main', title: 'Harbor', state: 'waiting' }], projects: [{ id: 'p', name: 'Project' }], projectId: 'p',
    messages, messagesLoading: false, permissions: [], sending: new Set<string>(), send: vi.fn(), setConversationMode: vi.fn(), run: vi.fn(), openAgent: vi.fn(), refreshClis: vi.fn(), updateConversation: vi.fn(), api: {}
  }) as unknown as HarborState;
  const ws = { preferences: { drafts: {}, queue: {}, templates: [] }, setDraft: vi.fn(), setQueue: vi.fn(), saveError: '' } as unknown as WorkspaceState;

  it('shows stored images and screenshots through harbor-file:// and never loads other URLs', () => {
    const messages: Message[] = [
      { id: 'm1', conversationId: 'c', role: 'system', text: 'Screenshot of the window "Storefront" captured for the lead.', time: 1, attachments: [{ name: 'screenshot-window.png', mime: 'image/png', url: 'harbor-file://attachments/c/abc.png', origin: 'screenshot' }] },
      { id: 'm2', conversationId: 'c', role: 'user', text: 'see this', time: 2, attachments: [{ name: 'mine.png', mime: 'image/png', url: 'harbor-file://attachments/c/def.png', origin: 'user' }] },
      { id: 'm3', conversationId: 'c', role: 'assistant', text: 'odd', time: 3, attachments: [{ name: 'remote.png', mime: 'image/png', url: 'https://example.com/x.png' }] }
    ];
    render(<Conversation state={state(messages)} workspace={ws} openProject={() => {}} review={() => {}}/>);
    expect(screen.getByRole('img', { name: 'Screenshot: screenshot-window.png' })).toHaveAttribute('src', 'harbor-file://attachments/c/abc.png');
    expect(screen.getByText('mine.png').closest('li')!.querySelector('img')).toHaveAttribute('src', 'harbor-file://attachments/c/def.png');
    expect(document.querySelector('img[src^="https:"]')).toBeNull();
    expect(screen.getByText('remote.png')).toBeInTheDocument();
  });
});
