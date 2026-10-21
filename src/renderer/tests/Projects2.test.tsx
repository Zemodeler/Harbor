import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '../App';
import { createMockApi } from '../mock/mockApi';

beforeEach(() => { localStorage.clear(); window.harbor = createMockApi({ delay: 0 }); });
async function ready() { render(<App/>); await screen.findByRole('heading', { name: 'Build the account page' }); }
async function openNewProject() {
  await userEvent.click(screen.getByRole('button', { name: 'New project' }));
  return screen.findByRole('dialog', { name: 'New project' });
}

describe('B1 start from an existing repository', () => {
  it('keeps the new-project form as the first tab and offers the clone tab', async () => {
    await ready();
    const dialog = await openNewProject();
    expect(within(dialog).getByRole('tab', { name: 'Start from scratch' })).toHaveAttribute('aria-selected', 'true');
    expect(within(dialog).getByLabelText('Project name')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Start from existing repo' }));
    expect(within(dialog).getByLabelText('Repository URL')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Clone project' })).toBeDisabled();
  });
  it('clones by URL, opens the project and closes the dialog', async () => {
    await ready();
    const dialog = await openNewProject();
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Start from existing repo' }));
    await userEvent.type(within(dialog).getByLabelText('Repository URL'), 'https://github.com/demo-user/Widget.git');
    expect(within(dialog).getByText(/Widget/, { selector: 'code' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clone project' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New project' })).not.toBeInTheDocument());
    expect(await screen.findByRole('button', { name: 'Widget', pressed: true })).toBeInTheDocument();
  });
  it('fills the URL and name from the repository picker', async () => {
    await ready();
    const dialog = await openNewProject();
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Start from existing repo' }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Load my repositories' }));
    const list = await within(dialog).findByRole('list', { name: 'Your GitHub repositories' });
    await userEvent.type(within(dialog).getByLabelText('Filter repositories'), 'notes');
    expect(within(list).queryByText(/storefront/)).not.toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button', { name: /demo-user\/notes-cli/ }));
    expect(within(dialog).getByLabelText('Repository URL')).toHaveValue('https://github.com/demo-user/notes-cli.git');
    expect(within(dialog).getByLabelText('Project name (optional)')).toHaveValue('notes-cli');
  });
  it('shows why a clone failed and stays open; notes after an empty repository', async () => {
    await ready();
    const dialog = await openNewProject();
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Start from existing repo' }));
    await userEvent.type(within(dialog).getByLabelText('Repository URL'), 'https://github.com/demo-user/missing.git');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clone project' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/was not found/);
    expect(within(dialog).getByRole('button', { name: 'Clone project' })).toBeEnabled();
    await userEvent.clear(within(dialog).getByLabelText('Repository URL'));
    await userEvent.type(within(dialog).getByLabelText('Repository URL'), 'https://github.com/demo-user/empty.git');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clone project' }));
    expect(await screen.findByRole('list', { name: 'Notes about the cloned project' })).toHaveTextContent(/no commits/);
  });
});
