import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '../App';
import { createMockApi } from '../mock/mockApi';

beforeEach(() => { localStorage.clear(); window.harbor = createMockApi({ delay: 0 }); });

async function transferTab() {
  render(<App/>); await screen.findByRole('heading', { name: 'Build the account page' });
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
  await userEvent.click(await screen.findByRole('tab', { name: 'Import & export' }));
}

describe('Import & export', () => {
  it('export: shows exactly what goes in and what never does, and needs a choice about possible secrets before saving', async () => {
    await window.harbor.send('checkout', 'Use password=hunter22 for the staging login');
    await transferTab();
    const panel = await screen.findByRole('group', { name: 'Export a Harbor bundle' });
    await userEvent.click(within(panel).getByRole('checkbox', { name: 'Polish the checkout' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Check what goes in' }));
    const pv = await within(panel).findByRole('status', { name: 'Bundle contents' });
    expect(within(pv).getByRole('list', { name: 'Goes into the bundle' })).toHaveTextContent('Polish the checkout');
    expect(within(pv).getByRole('list', { name: 'Never included' })).toHaveTextContent('CLI paths and custom CLI descriptors');
    const secrets = within(pv).getByRole('group', { name: 'Possible secrets' });
    expect(secrets).toHaveTextContent('The secret scan found 1 possible secret');
    expect(secrets).not.toHaveTextContent('hunter22');
    const save = within(pv).getByRole('button', { name: 'Save bundle…' });
    expect(save).toBeDisabled();
    await userEvent.click(within(secrets).getByRole('radio', { name: /Remove them/ }));
    await userEvent.click(save);
    expect(await within(panel).findByText(/Saved \d+ items? .* to C:\\Users\\you\\Documents\\storefront-.*\.harbor\.zip; 1 secret-looking string removed\./)).toBeInTheDocument();
  });

  it('bundle import: preview first, never replaces the project\'s own routing preferences without a tick, refuses a newer version', async () => {
    await window.harbor.setSettings({ projectOverrides: { store: { concurrencyLimit: 3 } } });
    await transferTab();
    const panel = await screen.findByRole('group', { name: 'Import a Harbor bundle' });
    await userEvent.type(within(panel).getByLabelText('Bundle file'), 'C:\\Downloads\\from-a-newer-harbor.harbor.zip');
    await userEvent.click(within(panel).getByRole('button', { name: 'Check bundle' }));
    expect(await within(panel).findByRole('list', { name: 'Problems' })).toHaveTextContent('made by a newer Harbor (bundle version 2; this Harbor reads up to version 1). Update Harbor');
    expect(within(panel).queryByRole('button', { name: /^Import into/ })).not.toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Browse…' }));
    await waitFor(() => expect(within(panel).getByLabelText('Bundle file')).toHaveValue('C:\\Downloads\\storefront.harbor.zip'));
    await userEvent.click(within(panel).getByRole('button', { name: 'Check bundle' }));
    const pv = await within(panel).findByRole('status', { name: 'Bundle preview' });
    expect(pv).toHaveTextContent('Bash(git push ...) (refused: never always allowed)');
    expect(pv).toHaveTextContent('Its commands stay in the repository and run only after you approve them here.');
    await userEvent.click(within(pv).getByRole('checkbox', { name: /Routing preferences/ }));
    const importButton = within(pv).getByRole('button', { name: 'Import into Storefront' });
    expect(importButton).toBeDisabled();
    await userEvent.click(within(pv).getByRole('checkbox', { name: /Replace them/ }));
    await userEvent.click(within(pv).getByRole('checkbox', { name: /Refund flow/ }));
    await userEvent.click(importButton);
    const done = await within(panel).findByRole('status', { name: 'Bundle imported' });
    expect(done).toHaveTextContent('Imported: Routing preferences, 1 skill into the library, 1 conversation as read-only history.');
    await userEvent.click(within(done).getByRole('button', { name: 'Open “Shipping estimates”' }));
    expect(await screen.findByRole('region', { name: 'Imported conversation' })).toHaveTextContent('From Harbor bundle from Storefront · read-only history');
  });

  it('chat import: list, choose, import as read-only history, then Continue with… opens a new conversation', async () => {
    await transferTab();
    const panel = await screen.findByRole('group', { name: 'Import chats from other tools' });
    const sources = await within(panel).findByRole('radiogroup', { name: 'Import chats from' });
    expect(within(sources).getAllByText('format not yet verified')).toHaveLength(2);
    await userEvent.click(within(sources).getByRole('radio', { name: /Claude Code/ }));
    await userEvent.click(within(panel).getByRole('button', { name: 'List chats' }));
    const found = await within(panel).findByRole('status', { name: 'Chats found' });
    await userEvent.click(within(found).getAllByRole('checkbox')[0]!);
    await userEvent.click(within(found).getByRole('button', { name: 'Import 1 chat' }));
    const done = await within(panel).findByRole('status', { name: 'Chats imported' });
    expect(done).toHaveTextContent('Imported 1 chat as read-only history.');
    expect(within(done).getByRole('list', { name: 'Import notes' })).toHaveTextContent('left out 12 tool calls');
    await userEvent.click(within(done).getByRole('button', { name: /^Open “Dark mode toggle/ }));
    const notice = await screen.findByRole('region', { name: 'Imported conversation' });
    expect(notice).toHaveTextContent('From Claude Code · read-only history');
    expect(notice).toHaveTextContent('Left out on import: 12 tool calls, 12 tool results, 3 thinking blocks.');
    expect(screen.queryByRole('textbox', { name: 'Message Harbor' })).not.toBeInTheDocument();
    expect(screen.getAllByText('imported').length).toBeGreaterThan(0); // the sidebar tag
    await expect(window.harbor.send((await window.harbor.listConversations('store')).find(c => c.imported)!.id, 'hi')).rejects.toThrow(/read-only/);
    await userEvent.selectOptions(within(notice).getByLabelText('Continue with'), 'codex');
    await userEvent.click(within(notice).getByRole('button', { name: 'Continue in a new conversation' }));
    expect(await screen.findByRole('heading', { name: /\(continued\)$/ })).toBeInTheDocument();
    expect(await screen.findByText(/On its first turn the lead gets Harbor's summary of that chat as quoted history/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message Harbor' })).toBeEnabled();
  });

  it('is hidden when the API has no import or export', async () => {
    const api = createMockApi({ delay: 0 });
    delete api.previewBundleExport; delete api.previewBundle; delete api.previewImport;
    window.harbor = api;
    render(<App/>); await screen.findByRole('heading', { name: 'Build the account page' });
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await screen.findByRole('tab', { name: 'Connections' });
    expect(screen.queryByRole('tab', { name: 'Import & export' })).not.toBeInTheDocument();
  });
});
