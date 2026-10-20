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
async function openRemove() {
  await userEvent.click(screen.getByRole('button', { name: 'Project options' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Remove…' }));
  return screen.findByRole('dialog', { name: 'Project settings' });
}

describe('New project', () => {
  it('creates a project in one step, opens it, and closes the dialog when nothing needs saying', async () => {
    await ready();
    const dialog = await openNewProject();
    const create = within(dialog).getByRole('button', { name: 'Create project' });
    expect(create).toBeDisabled(); // a name is needed
    await userEvent.type(within(dialog).getByLabelText('Project name'), 'Demo App');
    expect(within(dialog).getByText('Demo App', { selector: 'code', exact: false })).toBeInTheDocument(); // the place it will be created
    expect(within(dialog).getByRole('radio', { name: /^Empty/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole('radio', { name: /Node and TypeScript/ }));
    await userEvent.click(create);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New project' })).not.toBeInTheDocument());
    expect(await screen.findByRole('button', { name: 'Demo App', pressed: true })).toBeInTheDocument();
  });
  it('offers a private GitHub repository when gh is signed in and shows the result', async () => {
    await ready();
    const dialog = await openNewProject();
    const box = await within(dialog).findByRole('checkbox', { name: /Create a private GitHub repository/ });
    await waitFor(() => expect(box).toBeEnabled());
    expect(within(dialog).getByText(/Signed in to GitHub as demo-user/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Project name'), 'Shared');
    await userEvent.click(box);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New project' })).not.toBeInTheDocument());
    expect(await screen.findByRole('button', { name: 'Shared' })).toBeInTheDocument();
  });
  it('keeps the dialog open with the notes when part of it could not be done', async () => {
    await ready();
    const dialog = await openNewProject();
    await userEvent.type(within(dialog).getByLabelText('Project name'), 'No gh');
    await userEvent.click(await within(dialog).findByRole('checkbox', { name: /private GitHub repository/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));
    const notes = await screen.findByRole('list', { name: 'Notes about the new project' });
    expect(notes).toHaveTextContent(/not created.*winget install GitHub\.cli/);
    await userEvent.click(screen.getByRole('button', { name: 'Open project' }));
    expect(screen.queryByRole('dialog', { name: 'New project' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No gh', pressed: true })).toBeInTheDocument();
  });
  it('shows why a project could not be made and stays open for another try', async () => {
    await ready();
    const dialog = await openNewProject();
    await userEvent.type(within(dialog).getByLabelText('Project name'), 'Taken');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/already exists and is not empty/);
    expect(within(dialog).getByRole('button', { name: 'Create project' })).toBeEnabled();
    await userEvent.clear(within(dialog).getByLabelText('Project name'));
    await userEvent.type(within(dialog).getByLabelText('Project name'), 'Fail');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/was not created/);
  });
  it('lets the location be changed and reset', async () => {
    await ready();
    const dialog = await openNewProject();
    await userEvent.type(within(dialog).getByLabelText('Project name'), 'Placed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change location…' }));
    expect(await within(dialog).findByText(/C:\\Projects\\Harbor Projects\\Placed/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Use the default' }));
    expect(within(dialog).queryByText(/C:\\Projects\\Harbor Projects\\Placed/)).not.toBeInTheDocument();
  });
  it('is also reachable from the first-run guide and the command palette', async () => {
    window.harbor = createMockApi({ delay: 0, empty: true });
    render(<App/>);
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start a new project…' }));
    expect(await screen.findByRole('dialog', { name: 'New project' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('dialog', { name: 'Add a project' })).toBeInTheDocument(); // back in the guide, same step
  });
  it('opens with Ctrl+Shift+N', async () => {
    await ready();
    await userEvent.keyboard('{Control>}{Shift>}N{/Shift}{/Control}');
    expect(await screen.findByRole('dialog', { name: 'New project' })).toBeInTheDocument();
  });
});

describe('Removing a project', () => {
  it('keeps today’s default: remove from Harbor only', async () => {
    await ready();
    const dialog = await openRemove();
    expect(within(dialog).getByRole('radio', { name: /^Remove from Harbor only/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep project' }));
    expect(screen.getByRole('button', { name: 'Remove…' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove project' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Storefront' })).not.toBeInTheDocument());
  });
  it('shows what the worktree level removes and needs the project name for unmerged work', async () => {
    await ready();
    const dialog = await openRemove();
    await userEvent.click(within(dialog).getByRole('radio', { name: /Also remove Harbor’s worktrees and branches \(2\)/ }));
    const list = within(dialog).getByLabelText('What will be deleted');
    expect(list).toHaveTextContent(/1 running session will be stopped/);
    expect(list).toHaveTextContent(/harbor\/implement-account-page-1a2b3c/);
    expect(list).toHaveTextContent(/uncommitted changes/);
    expect(list).toHaveTextContent(/2 commits not merged/);
    const go = within(dialog).getByRole('button', { name: 'Delete worktrees and branches' });
    expect(go).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Type “Storefront” to confirm/), 'storefront');
    expect(go).toBeDisabled(); // exact match only
    await userEvent.clear(within(dialog).getByLabelText(/Type “Storefront” to confirm/));
    await userEvent.type(within(dialog).getByLabelText(/Type “Storefront” to confirm/), 'Storefront');
    expect(go).toBeEnabled();
    await userEvent.click(go);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Storefront' })).not.toBeInTheDocument());
  });
  it('the folder level lists what is lost, needs the name, and is disabled while pending', async () => {
    await ready();
    const dialog = await openRemove();
    await userEvent.click(within(dialog).getByRole('radio', { name: /Also delete the folder \(174 MB, C:\\Projects\\Storefront\)/ }));
    const list = within(dialog).getByLabelText('What will be deleted');
    expect(list).toHaveTextContent(/uncommitted changes that will be lost/);
    expect(list).toHaveTextContent(/2 commits exist nowhere else/);
    expect(list).toHaveTextContent(/outside your projects folder/);
    const go = within(dialog).getByRole('button', { name: 'Delete folder and project' });
    expect(go).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Type “Storefront” to confirm/), 'Storefront');
    await userEvent.click(go);
    expect(go).toBeDisabled(); // pending
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Storefront' })).not.toBeInTheDocument());
  });
  it('shows a blocker and keeps the folder level disabled', async () => {
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Harbor' }));
    const dialog = await openRemove();
    await userEvent.click(within(dialog).getByRole('radio', { name: /Also delete the folder/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Harbor’s own app|Harbor's own app/);
    await userEvent.type(within(dialog).getByLabelText(/Type “Harbor” to confirm/), 'Harbor');
    expect(within(dialog).getByRole('button', { name: 'Delete folder and project' })).toBeDisabled();
  });
});

describe('Publishing from the Git view', () => {
  async function openBranch(name: RegExp) {
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Git' }));
    const view = await screen.findByRole('region', { name: 'Git' });
    await userEvent.click(await within(view).findByRole('button', { name: name }));
    return view;
  }
  it('previews the commits and the secret scan, then pushes a helper branch', async () => {
    const view = await openBranch(/^harbor\/implement-account-page-1a2b3c/);
    await userEvent.click(within(view).getByRole('button', { name: 'Push branch…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Push branch' });
    expect(await within(dialog).findByRole('list', { name: 'Commits to push' })).toHaveTextContent(/Add account page form/);
    expect(within(dialog).getByText(/nothing found/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Push branch' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent(/Pushed harbor\/implement-account-page-1a2b3c to origin/);
  });
  it('opens a pull request after pushing and shows its link', async () => {
    const view = await openBranch(/^harbor\/implement-account-page-1a2b3c/);
    await userEvent.click(within(view).getByRole('button', { name: 'Open pull request…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Open pull request' });
    await within(dialog).findByRole('list', { name: 'Commits to push' });
    await userEvent.clear(within(dialog).getByLabelText('Title'));
    await userEvent.type(within(dialog).getByLabelText('Title'), 'Account page');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Push and open pull request' }));
    expect(await within(dialog).findByRole('link')).toHaveAttribute('href', 'https://github.com/demo-user/demo/pull/42');
  });
  it('needs a named confirmation to push the default branch and offers no pull request from it', async () => {
    const view = await openBranch(/^main/);
    expect(within(view).queryByRole('button', { name: 'Open pull request…' })).not.toBeInTheDocument();
    await userEvent.click(within(view).getByRole('button', { name: 'Push main…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Push branch' });
    const go = await within(dialog).findByRole('button', { name: 'Push main' });
    expect(go).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /publishes main, the default branch, with 2 commits/ }));
    expect(go).toBeEnabled();
  });
});

describe('Folders and storage settings', () => {
  async function open() {
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await userEvent.click(await screen.findByRole('tab', { name: 'Folders & storage' }));
  }
  it('saves the projects folder, shown in the New project dialog', async () => {
    await open();
    await userEvent.type(screen.getByLabelText('Projects folder'), 'D:\\Work');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect((await window.harbor.getSettings()).projectsDir).toBe('D:\\Work');
  });
  it('lists worktrees across projects and cleans up the merged and orphaned ones', async () => {
    await open();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Merged')).toBeInTheDocument();
    expect(within(table).getByText('Orphaned')).toBeInTheDocument();
    expect(within(table).getByText('Unmerged work')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clean up merged and stale (2)' }));
    expect(await screen.findByText(/Removed 2 worktrees and 1 merged branch/)).toBeInTheDocument();
    expect(within(await screen.findByRole('table')).queryByText('Orphaned')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clean up merged and stale' })).toBeDisabled();
  });
});
