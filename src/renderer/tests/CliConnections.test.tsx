import { render, screen, waitFor } from '@testing-library/react';
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

  it('is hidden when the API cannot test paths', async () => {
    const api = createMockApi({ delay: 0 }); delete api.testCliPath; window.harbor = api;
    await connections();
    await screen.findByRole('heading', { name: 'Codex' });
    expect(screen.queryByLabelText(/Executable path for/)).not.toBeInTheDocument();
  });
});
