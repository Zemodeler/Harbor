import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '../App';
import { createMockApi } from '../mock/mockApi';

beforeEach(() => { localStorage.clear(); window.harbor = createMockApi({ delay: 0 }); });

async function mcpTab() {
  render(<App/>); await screen.findByRole('heading', { name: 'Build the account page' });
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
  await userEvent.click(await screen.findByRole('tab', { name: 'MCP servers' }));
  return screen.findByRole('list', { name: 'MCP servers list' });
}

describe('MCP servers page', () => {
  it('lists servers with their kind, the without-asking badge and per-project choices; shows the CLIs\' own servers read-only', async () => {
    const list = await mcpTab();
    const items = within(list).getAllByRole('listitem');
    expect(items.map(i => i.querySelector('span')?.textContent)).toEqual(['context7', 'github']);
    expect(items[0]).toHaveTextContent('Local command (stdio)');
    expect(items[0]).toHaveTextContent('allowed without asking');
    expect(items[0]).toHaveTextContent('npx -y @upstash/context7-mcp');
    expect(items[1]).toHaveTextContent('Headers: Authorization');
    expect(items[1]).not.toHaveTextContent('demo-token');
    expect(within(items[1]).getByRole('checkbox', { name: 'Use github in Storefront' })).toBeChecked();
    await userEvent.click(within(items[1]).getByRole('checkbox', { name: 'Use github in Storefront' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'MCP servers list' })).getByRole('checkbox', { name: 'Use github in Storefront' })).not.toBeChecked());
    expect((await window.harbor.listMcpServers!('store')).find(s => s.name === 'github')!.enabled).toBe(false);
    const own = screen.getByRole('group', { name: 'Servers your CLIs already have' });
    expect(own).toHaveTextContent('playwright');
    expect(own).toHaveTextContent('Claude Code · user');
  });

  it('adds a stdio server: the plain-text warning sits next to the values, problems are shown, values are hidden by default', async () => {
    await mcpTab();
    await userEvent.click(screen.getByRole('button', { name: 'Add MCP server' }));
    const form = await screen.findByRole('group', { name: 'Add an MCP server' });
    await userEvent.type(within(form).getByLabelText('Name'), 'docs');
    await userEvent.type(within(form).getByLabelText('Command'), 'npx');
    await userEvent.type(within(form).getByLabelText('Arguments (one per line)'), '-y{enter}@acme/docs');
    await userEvent.click(within(form).getByRole('button', { name: 'Add variable' }));
    expect(within(form).getByRole('note')).toHaveTextContent('Stored as plain text in Harbor’s data folder');
    await userEvent.type(within(form).getByLabelText('Variable 1'), 'PATH');
    await userEvent.type(within(form).getByLabelText('Value 1'), 'sk-secret-value');
    expect(within(form).getByLabelText('Value 1')).toHaveAttribute('type', 'password');
    await userEvent.click(within(form).getByRole('button', { name: 'Add server' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('env: PATH cannot be set for an MCP server.');
    expect(within(form).getByRole('alert')).not.toHaveTextContent('sk-secret-value');
    await userEvent.clear(within(form).getByLabelText('Variable 1'));
    await userEvent.type(within(form).getByLabelText('Variable 1'), 'DOCS_TOKEN');
    await userEvent.click(within(form).getByRole('button', { name: 'Add server' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Add an MCP server' })).not.toBeInTheDocument());
    const docs = (await window.harbor.listMcpServers!('store')).find(s => s.name === 'docs')!;
    expect(docs).toMatchObject({ command: 'npx', args: ['-y', '@acme/docs'], env: { DOCS_TOKEN: 'sk-secret-value' }, enabled: false });
    const item = within(screen.getByRole('list', { name: 'MCP servers list' })).getAllByRole('listitem').find(i => i.querySelector('span')?.textContent === 'docs')!;
    expect(item).toHaveTextContent('Variables: DOCS_TOKEN');
    expect(item).not.toHaveTextContent('sk-secret-value');
  });

  it('testing a local command needs a confirmation naming it first', async () => {
    const list = await mcpTab();
    const ctx = within(list).getAllByRole('listitem')[0]!;
    await userEvent.click(within(ctx).getByRole('button', { name: 'Test' }));
    const confirm = within(ctx).getByRole('group', { name: 'Test context7' });
    expect(confirm).toHaveTextContent('npx -y @upstash/context7-mcp');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Run npx' }));
    expect(await within(ctx).findByRole('status', { name: 'Test result of context7' })).toHaveTextContent('Works: context7 (demo) 1.0.0 answered in 420 ms with 2 tools: search, fetch.');
    await expect(window.harbor.testMcpServer!({ name: 'x', transport: 'stdio', command: 'npx' })).rejects.toThrow('Confirm that Harbor may run npx first.');
  });

  it('the Claude Code own-servers switch is a setting', async () => {
    await mcpTab();
    const box = screen.getByRole('checkbox', { name: /Also let Claude Code use its own MCP servers/ });
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Also let Claude Code use its own MCP servers/ })).toBeChecked());
    expect((await window.harbor.getSettings()).claudeOwnMcp).toBe(true);
  });

  it('removes a server after a confirmation', async () => {
    const list = await mcpTab();
    const gh = within(list).getAllByRole('listitem')[1]!;
    await userEvent.click(within(gh).getByRole('button', { name: 'Remove' }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Remove github' })).getByRole('button', { name: 'Remove github' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'MCP servers list' })).queryByText('github')).not.toBeInTheDocument());
  });
});
