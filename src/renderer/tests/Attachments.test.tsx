import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { acceptImages, MAX_IMAGE_BYTES, MAX_IMAGES } from '../attachments';
import { ComplexityBadge } from '../components/SessionStatus';
import { ModePicker } from '../components/ModePicker';
import { Conversation } from '../components/Conversation';
import type { HarborState } from '../hooks/useHarbor';
import type { WorkspaceState } from '../hooks/useWorkspace';
import { createMockApi } from '../mock/mockApi';
import type { Conversation as ConversationData } from '../../shared/api';

// Lets one test hold an image read open; every other test keeps the real reader.
const reader = vi.hoisted(() => ({ override: undefined as undefined | ((f: File) => Promise<unknown>) }));
vi.mock('../attachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../attachments')>();
  return { ...actual, readImage: (f: File) => (reader.override ? reader.override(f) : actual.readImage(f)) };
});

const png = (name ='a.png', size = 10, type = 'image/png') => { const f = new File(['x'], name, { type }); Object.defineProperty(f, 'size', { value: size }); return f; };
beforeEach(() => { localStorage.clear(); window.harbor = createMockApi({ delay: 0 }); });
async function ready() { render(<App/>); await screen.findByRole('heading', { name: 'Build the account page' }); await screen.findByText(/I've assigned/); }

describe('Image attachment limits', () => {
  it('accepts supported images and rejects other types, oversized files and surplus files', () => {
    expect(acceptImages(0, [png()]).error).toBe('');
    expect(acceptImages(0, [png('a.svg', 10, 'image/svg+xml')])).toMatchObject({ accepted: [], error: expect.stringContaining('not a supported image') });
    expect(acceptImages(0, [png('big.png', MAX_IMAGE_BYTES + 1)])).toMatchObject({ accepted: [], error: expect.stringContaining('10 MB') });
    expect(acceptImages(0, [png('exactly.png', MAX_IMAGE_BYTES)]).accepted).toHaveLength(1);
    const many = Array.from({ length: MAX_IMAGES + 2 }, (_, i) => png(`${i}.png`));
    const r = acceptImages(MAX_IMAGES - 2, many);
    expect(r.accepted).toHaveLength(2);
    expect(r.error).toContain('up to 6 images');
  });

  it('shows thumbnails with remove, then sends the images as base64 and lists them on the message', async () => {
    await ready();
    const send = vi.spyOn(window.harbor, 'send');
    await userEvent.upload(screen.getByLabelText('Choose images'), [png('shot.png')]);
    const thumbs = await screen.findByRole('list', { name: 'Images to send' });
    expect(thumbs).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove shot.png' }));
    expect(screen.queryByRole('list', { name: 'Images to send' })).not.toBeInTheDocument();
    await userEvent.upload(screen.getByLabelText('Choose images'), [png('again.png')]);
    await screen.findByRole('button', { name: 'Remove again.png' });
    await userEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][1]).toBe('');
    expect(send.mock.calls[0][2]).toEqual([{ name: 'again.png', mime: 'image/png', dataBase64: expect.any(String) }]);
    expect(await screen.findByRole('list', { name: 'Attached images' })).toHaveTextContent('again.png');
  });

  it('explains the limit instead of adding a seventh image', async () => {
    await ready();
    await userEvent.upload(screen.getByLabelText('Choose images'), Array.from({ length: 7 }, (_, i) => png(`${i}.png`)));
    expect(await screen.findByRole('alert')).toHaveTextContent('up to 6 images');
    expect(screen.getAllByRole('button', { name: /^Remove \d\.png$/ })).toHaveLength(6);
  });
});

describe('Composer after switching conversations', () => {
  const conv = (id: string): ConversationData => ({ id, projectId: 'p', title: id, updated: 0, agentId: 'main' });
  const fakeState = (id: string, send: () => Promise<boolean>) => ({
    conversation: conv(id), agents: [{ id: 'main', role: 'main', title: 'Harbor', state: 'waiting' }], projects: [{ id: 'p', name: 'Project' }], projectId: 'p',
    messages: [], messagesLoading: false, permissions: [], sending: new Set<string>(), send, setConversationMode: vi.fn(), run: vi.fn(), openAgent: vi.fn(), refreshClis: vi.fn(), updateConversation: vi.fn(), api: {}
  }) as unknown as HarborState;
  const fakeWorkspace = (drafts: Record<string, string>, setDraft = vi.fn()) => ({ preferences: { drafts, queue: {}, templates: [] }, setDraft, setQueue: vi.fn(), saveError: '' }) as unknown as WorkspaceState;
  const view = (state: HarborState, ws: WorkspaceState) => <Conversation state={state} workspace={ws} openProject={() => {}} review={() => {}}/>;

  it('drops images that finish reading after the user moved to another conversation', async () => {
    let finish!: (v: unknown) => void;
    reader.override = () => new Promise(r => { finish = r; });
    try {
      const ws = fakeWorkspace({});
      const { rerender } = render(view(fakeState('A', async () => true), ws));
      await userEvent.upload(screen.getByLabelText('Choose images'), [png('late.png')]);
      rerender(view(fakeState('B', async () => true), ws));
      finish({ id: 'i1', name: 'late.png', mime: 'image/png', dataBase64: 'eA==', preview: 'data:image/png;base64,eA==' });
      await new Promise(r => setTimeout(r, 20));
      expect(screen.queryByRole('list', { name: 'Images to send' })).not.toBeInTheDocument();
    } finally { reader.override = undefined; }
  });

  it('does not restore images or show a send error in another conversation after a failed send', async () => {
    let fail!: (ok: boolean) => void;
    const setDraft = vi.fn();
    const ws = fakeWorkspace({ A: 'hello' }, setDraft);
    const { rerender } = render(view(fakeState('A', () => new Promise<boolean>(r => { fail = r; })), ws));
    await userEvent.upload(screen.getByLabelText('Choose images'), [png('keep.png')]);
    await screen.findByRole('button', { name: 'Remove keep.png' });
    await userEvent.click(screen.getByRole('button', { name: /Send/ }));
    rerender(view(fakeState('B', async () => true), fakeWorkspace({})));
    fail(false);
    await waitFor(() => expect(setDraft).toHaveBeenCalledWith('A', expect.any(Function)));
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByRole('list', { name: 'Images to send' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Your message was kept/)).not.toBeInTheDocument();
  });
});

describe('Mode picker', () => {
  const conversation: ConversationData ={ id: 'c', projectId: 'p', title: 'T', updated: 0, agentId: 'a' };
  it('switches mode with one click and asks for a goal before setting goal mode', async () => {
    const setMode = vi.fn().mockResolvedValue(undefined);
    render(<ModePicker conversation={conversation} setMode={setMode}/>);
    expect(screen.getByRole('radio', { name: 'Default' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Plan' }));
    expect(setMode).toHaveBeenLastCalledWith('plan');
    await userEvent.click(screen.getByRole('radio', { name: 'Goal' }));
    expect(setMode).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Set goal' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Goal'), 'All tests pass{enter}');
    expect(setMode).toHaveBeenLastCalledWith('goal', 'All tests pass');
  });

  it('reflects the conversation mode, shows the Auto warning in the header and clears it again', async () => {
    await ready();
    await userEvent.click(screen.getByRole('radio', { name: 'Auto' }));
    await userEvent.click(screen.getByRole('button', { name: 'Enable Auto mode' }));   // Auto asks for confirmation first
    expect(await screen.findByText(/Auto mode · no permission prompts/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Auto' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Default' }));
    await waitFor(() => expect(screen.queryByText(/no permission prompts/)).not.toBeInTheDocument());
  });
});

describe('Complexity in session info', () => {
  it('renders a Low/Medium/High badge and nothing without a value', () => {
    const { rerender, container } = render(<ComplexityBadge complexity="high"/>);
    expect(screen.getByText('High')).toBeInTheDocument();
    rerender(<ComplexityBadge complexity="low"/>);
    expect(screen.getByText('Low')).toBeInTheDocument();
    rerender(<ComplexityBadge/>);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists complexity and effort in the session panel after a turn', async () => {
    await ready();
    await userEvent.type(screen.getByLabelText('Message Harbor'), 'Please refactor the checkout{enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Session information' }));
    // Narrow test windows show the panel in a dialog, wide ones in a side panel; either way it is one <dl>.
    const facts = (await screen.findByText('Complexity')).closest('dl')!;
    expect(facts).toHaveTextContent('High');
    expect(facts).toHaveTextContent('Effort');
  });
});
