import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, Conversation, HarborApi } from '../../shared/api';
import { Onboarding } from '../components/Onboarding';
import { ReadyToApplyPrompt } from '../components/ReadyToApply';
import { RenameDialog } from '../components/RenameDialog';
import { TagEditor } from '../components/TagEditor';
import type { HarborState } from '../hooks/useHarbor';

const conversation = { id: 'c1', projectId: 'p', title: 'Polish the checkout' } as Conversation;

describe('TagEditor chips', () => {
  const setup = (tags: string[] = [], known: string[] = []) => {
    const save = vi.fn(), close = vi.fn();
    render(<TagEditor conversation={conversation} tags={tags} known={known} save={save} close={close}/>);
    return { save, close, dialog: screen.getByRole('dialog', { name: 'Edit tags' }) };
  };
  it('adds a chip on Enter and on comma, removes the last with Backspace, and saves them', async () => {
    const { save, dialog } = setup();
    const input = within(dialog).getByLabelText(/Tags, separated/);
    await userEvent.type(input, 'Release{Enter}ui,bug,');
    expect(within(dialog).getByRole('list', { name: 'Current tags' })).toHaveTextContent('#release#ui#bug');
    await userEvent.type(input, '{Backspace}{Backspace}');
    expect(within(dialog).queryByText('#ui')).not.toBeInTheDocument();
    await userEvent.type(input, 'late');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save tags' }));
    expect(save).toHaveBeenCalledWith(['release', 'late']);
  });
  it('removes a chip with its button and adds a suggestion with a click', async () => {
    const { dialog } = setup(['a', 'b'], ['zed']);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove tag a' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add tag zed' }));
    expect(within(dialog).getByRole('list', { name: 'Current tags' })).toHaveTextContent('#b#zed');
  });
});

describe('RenameDialog', () => {
  it('selects the current name, saves on Enter and shows the counter near the limit', async () => {
    const onSave = vi.fn();
    render(<RenameDialog title="Old name" onSave={onSave} onCancel={() => undefined}/>);
    const input = screen.getByLabelText('Conversation name') as HTMLInputElement;
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Old name'.length);
    fireEvent.change(input, { target: { value: 'x'.repeat(150) } });
    expect(screen.getByText('150 of 160 characters')).toBeInTheDocument();
    await userEvent.type(input, '{Enter}');
    expect(onSave).toHaveBeenCalledWith('x'.repeat(150));
  });
  it('blocks an empty name, shows the error as an alert and disables Save while pending', () => {
    const { rerender } = render(<RenameDialog title="" error="Could not rename." onSave={vi.fn()} onCancel={() => undefined}/>);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not rename.');
    expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
    rerender(<RenameDialog title="Fine" pending onSave={vi.fn()} onCancel={() => undefined}/>);
    expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
  });
});

describe('Onboarding dialog', () => {
  const state = { clis: [{ id: 'claude', name: 'Claude Code', installed: true, signedIn: true, authState: 'ok' }], settings: { cliOverrides: {} }, projects: [], projectId: '', error: '', api: {}, run: vi.fn(), refreshClis: vi.fn(), addProject: vi.fn() } as unknown as HarborState;
  it('ignores Escape (only Skip or Close end it) and shows numbered steps', async () => {
    const finish = vi.fn();
    render(<Onboarding state={state} finish={finish}/>);
    const dialog = screen.getByRole('dialog', { name: 'Welcome to Harbor' });
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(finish).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole('button', { name: 'Close dialog' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('list', { name: 'Step 1 of 4' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('list', { name: 'Detected CLIs' })).toHaveTextContent('Ready');
    await userEvent.click(screen.getByRole('button', { name: 'Skip the guide' }));
    expect(finish).toHaveBeenCalled();
  });
});

describe('ReadyToApplyPrompt branch line', () => {
  it('shows base and head when the integration has them', async () => {
    const base = { projectId: 'store', role: 'other', state: 'done', cli: 'harbor', model: 'git', effort: 'low' } as const;
    const agent: Agent = { ...base, id: 'i1', title: 'Integrate', integration: { target: 'master', base: '1111111aaaa', head: 'abcdef0123456789', sources: [{ agentId: 'h1', state: 'merged' }] } };
    render(<ReadyToApplyPrompt api={{} as HarborApi} agents={[agent]} projectId="store"/>);
    expect(await screen.findByLabelText('Branch change')).toHaveTextContent(/1111111.*abcdef0.*master/);
  });
});
