import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '../App';
import { createMockApi } from '../mock/mockApi';

beforeEach(() => { localStorage.clear(); window.harbor = createMockApi({ delay: 0 }); });

async function connections() {
  render(<App/>); await screen.findByRole('heading', { name: 'Build the account page' });
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
  await userEvent.click(await screen.findByRole('tab', { name: 'Connections' }));
}

describe('CLI executable path', () => {
  it('tests a path without saving, then saves and clears it', async () => {
    await connections();
    const field = await screen.findByLabelText(/Executable path for Gemini/);
    await userEvent.type(field, 'C:\\Tools\\gemini.cmd');
    await userEvent.click(screen.getAllByRole('button', { name: 'Test' })[2]);
    expect(await screen.findByText(/Found, sign-in status unknown · version 1.0.0 · Demo only: nothing was run./)).toBeInTheDocument();
    expect((await window.harbor.getSettings()).cliPaths).toBeUndefined();
    await userEvent.click(screen.getAllByRole('button', { name: 'Save path' })[2]);
    await waitFor(async () => expect((await window.harbor.getSettings()).cliPaths).toEqual({ gemini: 'C:\\Tools\\gemini.cmd' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use PATH again' }));
    await waitFor(async () => expect((await window.harbor.getSettings()).cliPaths).toBeUndefined());
    expect(screen.getByLabelText(/Executable path for Gemini/)).toHaveValue('');
  });

  it('shows the refusal next to the field', async () => {
    await connections();
    await userEvent.type(await screen.findByLabelText(/Executable path for Codex/), 'codex.exe');
    await userEvent.click(screen.getAllByRole('button', { name: 'Save path' })[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent('cliPaths.codex must be an absolute path.');
    await userEvent.click(screen.getAllByRole('button', { name: 'Test' })[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent('must be an absolute path');
  });

  it('Browse fills the field from the picker', async () => {
    await connections();
    await userEvent.click(screen.getAllByRole('button', { name: 'Browse…' })[1]);
    await waitFor(() => expect(screen.getByLabelText(/Executable path for Claude Code/)).toHaveValue('C:\\Tools\\demo-cli.exe'));
  });

  it('is not offered for a custom CLI', async () => {
    await window.harbor.saveCustomCli!({ id: 'mycli', name: 'My CLI', exe: 'C:\\Tools\\mycli.exe', run: { args: [] } }, { confirmExe: 'C:\\Tools\\mycli.exe' });
    await connections();
    await screen.findByRole('heading', { name: 'My CLI' });
    expect(screen.queryByLabelText(/Executable path for My CLI/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Executable path for Codex/)).toBeInTheDocument();
  });

  it('is hidden when the API cannot test paths', async () => {
    const api = createMockApi({ delay: 0 }); delete api.testCliPath; window.harbor = api;
    await connections();
    await screen.findByRole('heading', { name: 'Codex' });
    expect(screen.queryByLabelText(/Executable path for/)).not.toBeInTheDocument();
  });
});

describe('Add CLI wizard', () => {
  async function openWizard() {
    await connections();
    await userEvent.click(await screen.findByRole('button', { name: 'Add CLI' }));
    return screen.findByRole('group', { name: 'Add a CLI' });
  }

  it('starts from a template, needs the explicit OK and a dry run before saving, then lists the CLI with its features', async () => {
    const panel = await openWizard();
    await waitFor(() => expect(within(panel).getByLabelText('Name')).toHaveValue('My CLI'));
    expect(within(panel).getByRole('button', { name: 'Dry run' })).toBeDisabled();
    await userEvent.type(within(panel).getByLabelText('Program'), 'C:\\Tools\\mycli.exe');
    // No read-only mode in the template: the acceptance is offered, unticked.
    expect(within(panel).getByRole('checkbox', { name: /no read-only mode/ })).not.toBeChecked();
    expect(within(panel).getByRole('button', { name: 'Dry run' })).toBeDisabled();
    await userEvent.click(within(panel).getByRole('checkbox', { name: /I trust C:\\Tools\\mycli.exe/ }));
    expect(within(panel).getByRole('button', { name: 'Save CLI' })).toBeDisabled();
    await userEvent.click(within(panel).getByRole('button', { name: 'Dry run' }));
    const result = await within(panel).findByRole('status', { name: 'Dry run result' });
    expect(result).toHaveTextContent('Dry run passed (version 1.0.0)');
    expect(result).toHaveTextContent('Answer: “OK”');
    expect(within(result).getByLabelText('prompt output')).toHaveTextContent('OK');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save CLI' }));
    expect(await screen.findByRole('heading', { name: 'My CLI' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Add a CLI' })).not.toBeInTheDocument();
    expect(screen.getByText(/Not available: .*read-only mode/)).toBeInTheDocument();
    expect(await window.harbor.listCustomClis!()).toMatchObject([{ id: 'mycli', exe: 'C:\\Tools\\mycli.exe', approvedHash: 'demo' }]);
  });

  it('changing the settings after a dry run asks for a new one; problems are listed without running', async () => {
    const panel = await openWizard();
    await waitFor(() => expect(within(panel).getByLabelText(/^Id/)).toHaveValue('mycli'));
    await userEvent.type(within(panel).getByLabelText('Program'), 'C:\\Tools\\mycli.exe');
    await userEvent.click(within(panel).getByRole('checkbox', { name: /I trust/ }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Dry run' }));
    await within(panel).findByRole('status', { name: 'Dry run result' });
    await userEvent.clear(within(panel).getByLabelText(/^Id/));
    await userEvent.type(within(panel).getByLabelText(/^Id/), 'claude');
    expect(within(panel).getByRole('button', { name: 'Save CLI' })).toBeDisabled();
    expect(within(panel).getByText('Run the dry run on these settings before saving.')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Dry run' }));
    expect(await within(panel).findByRole('list', { name: 'Problems' })).toHaveTextContent('id "claude" is taken by a built-in CLI.');
  });

  it('shows invalid JSON and changing the program withdraws the OK', async () => {
    const panel = await openWizard();
    await waitFor(() => expect(within(panel).getByLabelText('CLI settings JSON')).not.toHaveValue(''));
    await userEvent.type(within(panel).getByLabelText('Program'), 'C:\\Tools\\mycli.exe');
    await userEvent.click(within(panel).getByRole('checkbox', { name: /I trust/ }));
    await userEvent.type(within(panel).getByLabelText('Program'), 'x');
    expect(within(panel).getByRole('checkbox', { name: /I trust/ })).not.toBeChecked();
    await userEvent.type(within(panel).getByLabelText('CLI settings JSON'), '{{oops');
    expect(within(panel).getByRole('alert')).toHaveTextContent('not valid JSON');
    await userEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Add a CLI' })).not.toBeInTheDocument();
  });

  it('a custom CLI can be edited (approved again) and removed', async () => {
    await window.harbor.saveCustomCli!({ id: 'mycli', name: 'My CLI', exe: 'C:\\Tools\\mycli.exe', run: { args: [] } }, { confirmExe: 'C:\\Tools\\mycli.exe' });
    await connections();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit or approve again' }));
    const panel = await screen.findByRole('group', { name: 'Edit My CLI' });
    expect(within(panel).getByLabelText(/^Id/)).toBeDisabled();
    await userEvent.click(within(panel).getByRole('checkbox', { name: /I trust/ }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Dry run' }));
    await within(panel).findByRole('status', { name: 'Dry run result' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Save and approve' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Edit My CLI' })).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Remove My CLI' })).getByRole('button', { name: 'Remove My CLI' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'My CLI' })).not.toBeInTheDocument());
    expect(await window.harbor.listCustomClis!()).toEqual([]);
  });
});
