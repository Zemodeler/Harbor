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

async function openOverview() {
  await userEvent.click(screen.getByRole('button', { name: 'Projects overview' }));
  return screen.findByRole('region', { name: 'All projects' });
}

describe('B2 overview, archive, pin, search and usage', () => {
  it('shows every project with its status', async () => {
    await ready();
    const page = await openOverview();
    expect(within(page).getByRole('button', { name: 'Open Storefront' })).toBeInTheDocument();
    expect(within(page).getByRole('button', { name: 'Open Harbor' })).toBeInTheDocument();
    expect(await within(page).findByText(/2 unmerged branches, 3 unpushed commits/)).toBeInTheDocument();
    expect(within(page).getByText(/about 812.4 k-tokens \(estimate\)/)).toBeInTheDocument();
    expect(within(page).getByLabelText('Usage windows')).toHaveTextContent(/claude 5 hour: 42% used \(estimate\)/);
    await userEvent.click(within(page).getByRole('button', { name: 'Open Harbor' }));
    expect(await screen.findByRole('button', { name: 'Harbor', pressed: true })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'All projects' })).not.toBeInTheDocument();
  });
  it('pins a project and archives another; archived projects leave the sidebar and come back', async () => {
    await ready();
    const page = await openOverview();
    await userEvent.click(within(page).getByRole('button', { name: /^Pin Internal tools/ }));
    await waitFor(() => expect(within(page).getByRole('button', { name: /^Unpin Internal tools/ })).toBeInTheDocument());
    const rail = within(screen.getByRole('navigation', { name: 'Projects and conversations' }));
    const chips = () => rail.getAllByRole('button').map(b => b.getAttribute('aria-label')).filter(n => ['Storefront', 'Harbor', 'Internal tools'].includes(n ?? ''));
    expect(chips()[0]).toBe('Internal tools');
    await userEvent.click(within(page).getByRole('button', { name: /^Archive Harbor/ }));
    await waitFor(() => expect(chips()).not.toContain('Harbor'));
    await userEvent.click(within(page).getByRole('button', { name: /Show archived projects \(1\)/ }));
    const archived = within(await within(page).findByRole('list', { name: 'Archived projects' }));
    await userEvent.click(archived.getByRole('button', { name: /^Unarchive Harbor/ }));
    await waitFor(() => expect(chips()).toContain('Harbor'));
  });
  it('refuses to archive a project whose agents are running and says why', async () => {
    await ready();
    const page = await openOverview();
    await userEvent.click(within(page).getByRole('button', { name: /^Archive Storefront/ }));
    expect(await within(page).findByRole('alert')).toHaveTextContent(/still running/);
  });
  it('searches across projects and opens the conversation that matched', async () => {
    await ready();
    const page = await openOverview();
    await userEvent.type(within(page).getByLabelText('Search all projects'), 'checkout');
    await userEvent.click(within(page).getByRole('button', { name: 'Search' }));
    const list = await within(page).findByRole('list', { name: 'Search results' });
    await userEvent.click(within(list).getByRole('button', { name: /Polish the checkout/ }));
    expect(await screen.findByRole('heading', { name: 'Polish the checkout' })).toBeInTheDocument();
  });
  it('says when nothing matched', async () => {
    await ready();
    const page = await openOverview();
    await userEvent.type(within(page).getByLabelText('Search all projects'), 'zzzzqqqq');
    await userEvent.click(within(page).getByRole('button', { name: 'Search' }));
    expect(await within(page).findByText(/Nothing found for/)).toBeInTheDocument();
  });
  it('shows usage per CLI and per project, labelled as an estimate', async () => {
    await ready();
    const page = await openOverview();
    await userEvent.click(within(page).getByRole('button', { name: 'Show usage' }));
    expect(await within(page).findByRole('note')).toHaveTextContent(/Estimate:/);
    const perCli = within(within(page).getByRole('table', { name: 'Usage per CLI' }));
    expect(perCli.getByRole('rowheader', { name: 'claude' })).toBeInTheDocument();
    const perProject = within(within(page).getByRole('table', { name: 'Usage per project' }));
    expect(perProject.getByRole('rowheader', { name: 'Removed project' })).toBeInTheDocument();
  });
});

async function openProjectSettings() {
  await userEvent.click(screen.getByRole('button', { name: 'Project options' }));
  return screen.findByRole('dialog', { name: 'Project settings' });
}

describe('B3 templates', () => {
  it('saves a project as a template with default checks, then offers it under Starting point', async () => {
    await ready();
    const dialog = await openProjectSettings();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save as template…' }));
    expect(await within(dialog).findByText(/23 tracked files/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Left out of the template')).toHaveTextContent(/\.env.*credential/);
    expect(within(dialog).getByLabelText(/Default checks/)).toHaveValue('npm test'); // suggested from the project's own checks file
    await userEvent.clear(within(dialog).getByLabelText('Template name'));
    await userEvent.type(within(dialog).getByLabelText('Template name'), 'Shop kit');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save template' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Saved the template “Shop kit”.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    const np = await (async () => { await userEvent.click(screen.getByRole('button', { name: 'New project' })); return screen.findByRole('dialog', { name: 'New project' }); })();
    const mine = within(np).getByRole('radio', { name: /Shop kit/ });
    expect(mine).not.toBeChecked();
    expect(within(np).getByRole('radio', { name: /Shop kit/ }).closest('label')).toHaveTextContent(/default checks: npm test \(Harbor asks before running them\)/);
    await userEvent.click(mine);
    expect(within(np).getByRole('radio', { name: /^Empty/ })).not.toBeChecked();
    await userEvent.type(within(np).getByLabelText('Project name'), 'Kit Copy');
    await userEvent.click(within(np).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New project' })).not.toBeInTheDocument());
    expect(await screen.findByRole('button', { name: 'Kit Copy', pressed: true })).toBeInTheDocument();
  });
  it('blocks saving when the secret scan finds something, and names the finding without a value', async () => {
    await ready();
    const np = await (async () => { await userEvent.click(screen.getByRole('button', { name: 'New project' })); return screen.findByRole('dialog', { name: 'New project' }); })();
    await userEvent.type(within(np).getByLabelText('Project name'), 'Leaky app');
    await userEvent.click(within(np).getByRole('button', { name: 'Create project' }));
    await screen.findByRole('button', { name: 'Leaky app', pressed: true });
    const dialog = await openProjectSettings();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save as template…' }));
    expect(await within(dialog).findByLabelText('Secret scan findings')).toHaveTextContent('github-token in src/config.ts:4');
    expect(within(dialog).getByRole('button', { name: 'Save template' })).toBeDisabled();
  });
  it('edits default checks and deletes a template from the settings list', async () => {
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await userEvent.click(await screen.findByRole('tab', { name: 'Folders & storage' }));
    const list = await screen.findByRole('list', { name: 'Your templates' });
    expect(within(list).getByText(/Default checks: npm test, npm run build/)).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button', { name: /Edit checks/ }));
    const box = within(list).getByLabelText('Default checks for Web starter');
    await userEvent.clear(box); await userEvent.type(box, 'pnpm test');
    await userEvent.click(within(list).getByRole('button', { name: 'Save checks' }));
    expect(await within(list).findByText('Default checks: pnpm test')).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button', { name: /^Delete Web starter/ }));
    await userEvent.click(within(list).getByRole('button', { name: 'Delete template' }));
    expect(await screen.findByText('No templates yet.')).toBeInTheDocument();
  });
});

describe('B4 recycle-bin delete', () => {
  async function openDelete() {
    const dialog = await openProjectSettings();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove…' }));
    return dialog;
  }
  it('says the folder goes to the Recycle Bin and that it can be restored', async () => {
    await ready();
    const dialog = await openDelete();
    const bin = within(dialog).getByRole('radio', { name: /Also move the folder to the Recycle Bin/ });
    expect(within(dialog).getByRole('radio', { name: /Delete the folder permanently/ })).toBeInTheDocument();
    await userEvent.click(bin);
    expect(bin.closest('label')).toHaveTextContent(/restore it from the Recycle Bin/);
    expect(within(dialog).queryByLabelText(/again to delete it permanently/)).not.toBeInTheDocument();
  });
  it('permanent delete asks for the name a second time and is its own button', async () => {
    await ready();
    const dialog = await openDelete();
    await userEvent.click(within(dialog).getByRole('radio', { name: /Delete the folder permanently/ }));
    const go = within(dialog).getByRole('button', { name: 'Delete folder and project' });
    await userEvent.type(within(dialog).getByLabelText(/Type “Storefront” to confirm/), 'Storefront');
    expect(go).toBeDisabled(); // the second confirmation is still empty
    await userEvent.type(within(dialog).getByLabelText(/again to delete it permanently/), 'Storefront');
    expect(go).toBeEnabled();
    await userEvent.click(go);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Storefront' })).not.toBeInTheDocument());
  });
  it('a failed trash keeps the project, shows the reason, and the permanent option is the way out', async () => {
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Internal tools' }));
    const dialog = await openDelete();
    await userEvent.click(within(dialog).getByRole('radio', { name: /Also move the folder to the Recycle Bin/ }));
    await userEvent.type(within(dialog).getByLabelText(/Type “Internal tools” to confirm/), 'Internal tools');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move folder to Recycle Bin and remove project' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/could not be moved to the Recycle Bin.*choose permanent delete/);
    expect(screen.getByRole('button', { name: 'Internal tools' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('radio', { name: /Delete the folder permanently/ }));
    await userEvent.type(within(dialog).getByLabelText(/again to delete it permanently/), 'Internal tools');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete folder and project' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Internal tools' })).not.toBeInTheDocument());
  });
});

describe('B5 pull request status, merge and release tags', () => {
  async function openBranch(name: RegExp | string) {
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Git' }));
    const view = await screen.findByRole('region', { name: 'Git' });
    await userEvent.click(await within(view).findByRole('button', { name }));
    return view;
  }
  const SAMPLE = /^harbor\/implement-account-page-1a2b3c/;

  it('shows the pull request, its check summary and why it cannot be merged yet', async () => {
    const view = await openBranch(SAMPLE);
    const card = await within(view).findByRole('region', { name: 'Pull request' });
    expect(await within(card).findByRole('link', { name: /#12 implement account page/ })).toHaveAttribute('href', 'https://github.com/demo-user/storefront/pull/12');
    expect(within(card).getByLabelText('Check summary')).toHaveTextContent('1 passing, 1 failing, 0 running');
    expect(within(card).getByLabelText('Why it cannot be merged')).toHaveTextContent(/1 check is failing/);
    expect(within(card).getByRole('button', { name: 'Re-run failed checks' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Merge pull request…' })).toBeInTheDocument();
  });

  it('re-runs the failed checks and shows them go from running to passing on refresh', async () => {
    const view = await openBranch(SAMPLE);
    const card = await within(view).findByRole('region', { name: 'Pull request' });
    await userEvent.click(await within(card).findByRole('button', { name: 'Re-run failed checks' }));
    expect(await within(card).findByRole('status')).toHaveTextContent(/Restarted 1 workflow run/);
    await userEvent.click(within(card).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(within(card).getByLabelText('Check summary')).toHaveTextContent('1 passing, 0 failing, 1 running'));
    await userEvent.click(within(card).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(within(card).getByLabelText('Check summary')).toHaveTextContent('2 passing, 0 failing, 0 running'));
    expect(within(card).getByText('Ready to merge.')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Re-run failed checks' })).not.toBeInTheDocument();
  });

  it('merging names the pull request and the method, and shows the pull request as merged afterwards', async () => {
    const view = await openBranch(SAMPLE);
    const card = await within(view).findByRole('region', { name: 'Pull request' });
    await userEvent.click(await within(card).findByRole('button', { name: 'Re-run failed checks' }));
    await userEvent.click(within(card).getByRole('button', { name: 'Refresh' }));
    await userEvent.click(within(card).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(within(card).getByText('Ready to merge.')).toBeInTheDocument());
    await userEvent.click(within(card).getByRole('button', { name: 'Merge pull request…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Merge pull request' });
    expect(within(dialog).getByText(/Merge #12 “implement account page” into main\?/)).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /Squash and merge/ })).toBeChecked();
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument(); // green: nothing to override
    await userEvent.click(within(dialog).getByRole('radio', { name: /Rebase and merge/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Merge #12' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Merged #12 into main.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(within(card).getByText('merged')).toBeInTheDocument());
    expect(within(card).queryByRole('button', { name: 'Merge pull request…' })).not.toBeInTheDocument();
  });

  it('failing checks need an explicit override in the merge dialog', async () => {
    const view = await openBranch(SAMPLE);
    const card = await within(view).findByRole('region', { name: 'Pull request' });
    await userEvent.click(await within(card).findByRole('button', { name: 'Merge pull request…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Merge pull request' });
    const go = within(dialog).getByRole('button', { name: 'Merge #12' });
    expect(go).toBeDisabled();
    expect(within(dialog).getByText(/1 check is failing/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Merge anyway/ }));
    expect(go).toBeEnabled();
    await userEvent.click(go);
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Merged #12 into main.');
  });

  it('creates a release tag from the default branch, suggesting the next version and pushing only when asked', async () => {
    const view = await openBranch(/^main/);
    await userEvent.click(within(view).getByRole('button', { name: 'Release tag…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Release tag' });
    expect(await within(dialog).findByText(/Recent tags: v1.2.3, v1.2.2/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Tag name')).toHaveValue('v1.2.4');
    const push = within(dialog).getByRole('checkbox', { name: /Also push this tag/ });
    expect(push).toBeEnabled();
    expect(push).not.toBeChecked();
    await userEvent.click(push);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create tag' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Created and pushed v1.2.4.');
  });

  it('refuses a bad or existing tag name and explains why', async () => {
    const view = await openBranch(/^main/);
    await userEvent.click(within(view).getByRole('button', { name: 'Release tag…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Release tag' });
    const name = within(dialog).getByLabelText('Tag name');
    await userEvent.clear(name); await userEvent.type(name, 'a..b');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/letters, digits/);
    expect(within(dialog).getByRole('button', { name: 'Create tag' })).toBeDisabled();
    await userEvent.clear(name); await userEvent.type(name, 'v1.2.3');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create tag' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/already exists.*never moves/);
  });
});
