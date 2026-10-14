import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '../App';
import { createMockApi } from '../mock/mockApi';

beforeEach(() => { localStorage.clear(); window.harbor = createMockApi({ delay: 0 }); });

async function skillsTab() {
  render(<App/>); await screen.findByRole('heading', { name: 'Build the account page' });
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
  await userEvent.click(await screen.findByRole('tab', { name: 'Skills' }));
  return screen.findByRole('list', { name: 'Skills list' });
}

describe('Skills page', () => {
  it('lists skills with their source, scripts warning and hash; project skills only for their project', async () => {
    const list = await skillsTab();
    const items = within(list).getAllByRole('listitem');
    expect(items.map(i => i.querySelector('span')?.textContent)).toEqual(['pdf-tools', 'release-notes', 'frontend-design', 'design-taste']);
    expect(items[0]).toHaveTextContent('Harbor library');
    expect(items[0]).toHaveTextContent('contains scripts');
    expect(items[0]).toHaveTextContent('hash 3f9a1c0d2b7e');
    expect(items[1]).toHaveTextContent('Project');
    expect(items[2]).toHaveTextContent('From Claude Code');
    expect(items[3]).toHaveTextContent('From Codex');
    expect(within(items[1]).getByRole('checkbox', { name: 'Use release-notes in Storefront' })).toBeChecked();
    expect(within(items[2]).getByRole('checkbox', { name: 'Use frontend-design in Storefront' })).not.toBeChecked();
    expect(within(items[2]).getByText(/read-only/)).toBeInTheDocument();
    expect(within(items[2]).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('enabling is per project and survives a reload of the list', async () => {
    const list = await skillsTab();
    await userEvent.click(within(list).getByRole('checkbox', { name: 'Use frontend-design in Storefront' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Skills list' })).getByRole('checkbox', { name: 'Use frontend-design in Storefront' })).toBeChecked());
    expect((await window.harbor.listSkills!('store')).find(s => s.id === 'claude:user/frontend-design')!.enabled).toBe(true);
    expect((await window.harbor.listSkills!('harbor')).find(s => s.id === 'claude:user/frontend-design')!.enabled).toBe(false);
    expect((await window.harbor.listSkills!()).find(s => s.id === 'claude:user/frontend-design')!.defaultEnabled).toBe(false);
  });

  it('shows SKILL.md and the file list, and removes a library skill after a confirmation', async () => {
    const list = await skillsTab();
    const pdf = within(list).getAllByRole('listitem')[0]!;
    await userEvent.click(within(pdf).getByRole('button', { name: 'View SKILL.md' }));
    expect(await within(pdf).findByLabelText('SKILL.md of pdf-tools')).toHaveTextContent('name: pdf-tools');
    expect(within(pdf).getByRole('list', { name: 'Files of pdf-tools' })).toHaveTextContent('scripts/extract.py');
    await userEvent.click(within(pdf).getByRole('button', { name: 'Remove' }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Remove pdf-tools' })).getByRole('button', { name: 'Remove pdf-tools' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Skills list' })).queryByText('pdf-tools')).not.toBeInTheDocument());
  });

  it('imports from a folder: check shows files, SKILL.md and the scripts warning before anything is imported', async () => {
    await skillsTab();
    await userEvent.click(screen.getByRole('button', { name: 'Import skill' }));
    const panel = await screen.findByRole('group', { name: 'Import a skill' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Browse…' }));
    await waitFor(() => expect(within(panel).getByLabelText('Folder path')).toHaveValue('C:\\Downloads\\sample-skill'));
    await userEvent.click(within(panel).getByRole('button', { name: 'Check' }));
    const pv = await within(panel).findByRole('status', { name: 'Import preview' });
    expect(pv).toHaveTextContent('Source: C:\\Downloads\\sample-skill');
    expect(within(pv).getByRole('list', { name: 'Warnings' })).toHaveTextContent('never runs them');
    expect(within(pv).getByRole('list', { name: 'Files in sample-skill' })).toHaveTextContent('scripts/run.ps1');
    await userEvent.click(within(pv).getByRole('button', { name: 'Show SKILL.md' }));
    expect(within(pv).getByLabelText('SKILL.md of sample-skill')).toHaveTextContent('name: sample-skill');
    expect((await window.harbor.listSkills!()).some(s => s.name === 'sample-skill')).toBe(false);
    await userEvent.click(within(pv).getByRole('button', { name: 'Import 1 skill' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Import a skill' })).not.toBeInTheDocument());
    expect(within(screen.getByRole('list', { name: 'Skills list' })).getByText('sample-skill')).toBeInTheDocument();
  });

  it('GitHub: Check lists source and size only; the download needs a second click; a taken name is kept as a copy', async () => {
    await skillsTab();
    await userEvent.click(screen.getByRole('button', { name: 'Import skill' }));
    const panel = await screen.findByRole('group', { name: 'Import a skill' });
    await userEvent.click(within(panel).getByRole('radio', { name: 'GitHub' }));
    await userEvent.type(within(panel).getByLabelText('GitHub address'), 'example/skills/pdf-tools');
    await userEvent.click(within(panel).getByRole('button', { name: 'Check' }));
    const pv = await within(panel).findByRole('status', { name: 'Import preview' });
    expect(pv).toHaveTextContent('Source: github.com/example/skills@0123456789ab/pdf-tools · 2 files · 2 KB');
    expect(pv).toHaveTextContent('Nothing has been downloaded yet.');
    expect(within(pv).queryByRole('button', { name: /^Import/ })).not.toBeInTheDocument();
    expect(within(pv).queryByLabelText('SKILL.md of pdf-tools')).not.toBeInTheDocument();
    await userEvent.click(within(pv).getByRole('button', { name: 'Download 2 files (2 KB)' }));
    await within(pv).findByRole('button', { name: 'Show SKILL.md' });
    expect(pv).toHaveTextContent('saved as pdf-tools-2 (the name is taken; both are kept)');
    await userEvent.click(within(pv).getByRole('button', { name: 'Import 1 skill' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Skills list' })).getAllByText('pdf-tools')).toHaveLength(2));
  });

  it('shows a refusal and imports nothing', async () => {
    await skillsTab();
    await userEvent.click(screen.getByRole('button', { name: 'Import skill' }));
    const panel = await screen.findByRole('group', { name: 'Import a skill' });
    await userEvent.click(within(panel).getByRole('radio', { name: '.zip file' }));
    await userEvent.type(within(panel).getByLabelText('.zip file path'), 'C:\\Downloads\\has-link.zip');
    await userEvent.click(within(panel).getByRole('button', { name: 'Check' }));
    expect(await within(panel).findByRole('list', { name: 'Problems' })).toHaveTextContent('symbolic link');
    expect(within(panel).queryByRole('button', { name: /^Import \d/ })).not.toBeInTheDocument();
    await userEvent.clear(within(panel).getByLabelText('.zip file path'));
    await userEvent.type(within(panel).getByLabelText('.zip file path'), 'relative.zip');
    await userEvent.click(within(panel).getByRole('button', { name: 'Check' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('full path');
  });

  it('is hidden when the API has no skills', async () => {
    const api = createMockApi({ delay: 0 }); delete api.listSkills; window.harbor = api;
    render(<App/>); await screen.findByRole('heading', { name: 'Build the account page' });
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await screen.findByRole('tab', { name: 'Connections' });
    expect(screen.queryByRole('tab', { name: 'Skills' })).not.toBeInTheDocument();
  });
});
