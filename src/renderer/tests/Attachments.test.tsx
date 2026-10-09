import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { acceptImages, MAX_IMAGE_BYTES, MAX_IMAGES } from '../attachments';
import { ComplexityBadge } from '../components/SessionStatus';
import { ModePicker } from '../components/ModePicker';
import { createMockApi } from '../mock/mockApi';
import type { Conversation } from '../../shared/api';

const png = (name = 'a.png', size = 10, type = 'image/png') => { const f = new File(['x'], name, { type }); Object.defineProperty(f, 'size', { value: size }); return f; };
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

describe('Mode picker', () => {
  const conversation: Conversation = { id: 'c', projectId: 'p', title: 'T', updated: 0, agentId: 'a' };
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
