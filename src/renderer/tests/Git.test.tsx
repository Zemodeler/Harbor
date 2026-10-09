import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { createMockApi } from '../mock/mockApi';
import { layoutGraph } from '../gitGraph';
import type { GitCommit } from '../../shared/api';

beforeEach(() => { localStorage.clear(); window.harbor = createMockApi({ delay: 0 }); });
const commit = (hash: string, ...parents: string[]): GitCommit => ({ hash, parents, subject: hash, author: 'A', time: 0, refs: [] });

describe('commit graph layout', () => {
  it('keeps a straight line, opens a lane for a side branch and joins it at the merge', () => {
    // m merges b into a; a and b both come from root r.
    const { rows, width } = layoutGraph([commit('m', 'a', 'b'), commit('b', 'r'), commit('a', 'r'), commit('r')]);
    expect(width).toBe(2);
    expect(rows[0]).toEqual({ lane: 0, before: [], after: ['a', 'b'], parentLanes: [0, 1] });
    expect(rows[1]).toEqual({ lane: 1, before: ['a', 'b'], after: ['a', 'r'], parentLanes: [1] });
    expect(rows[2]).toEqual({ lane: 0, before: ['a', 'r'], after: [null, 'r'], parentLanes: [1] });
    expect(rows[3]).toEqual({ lane: 1, before: [null, 'r'], after: [], parentLanes: [] });
  });
  it('gives an unrelated branch tip its own lane', () => {
    const { rows } = layoutGraph([commit('x', 'p'), commit('y', 'q')]);
    expect(rows.map(r => r.lane)).toEqual([0, 1]);
  });
});

describe('Git view', () => {
  async function openGit() {
    render(<App/>);
    await screen.findByRole('heading', { name: 'Build the account page' });
    await userEvent.click(screen.getByRole('button', { name: 'Git' }));
    return screen.findByRole('region', { name: 'Git' });
  }
  it('shows branches, the helper that owns one, history and uncommitted changes', async () => {
    const view = await openGit();
    expect(screen.getByRole('heading', { name: 'Branches and changes' })).toBeInTheDocument();
    expect(await within(view).findByText('Implement account page')).toBeInTheDocument();
    expect(within(view).getByText('1 ahead · 0 behind main', { exact: false })).toBeInTheDocument();
    expect(await within(view).findByRole('button', { name: /^Merge checkout polish main/ })).toBeInTheDocument();
    expect(await within(view).findByText('README.md')).toBeInTheDocument();
  });
  it('compares a helper branch, opens a diff and never previews credential files', async () => {
    const view = await openGit();
    const diff = vi.spyOn(window.harbor, 'getGitDiff');
    await userEvent.click(await within(view).findByRole('button', { name: /^harbor\/implement-account-page/ }));
    expect(within(view).getByText(/since it split from main/)).toBeInTheDocument();
    await userEvent.click(await within(view).findByRole('button', { name: /src\/account\.tsx/ }));
    expect(await within(view).findByText(/return <AccountForm\/>;/)).toBeInTheDocument();
    await userEvent.click(within(view).getByRole('button', { name: /\.env\.local/ }));
    expect(within(view).getByText(/never shows its contents/)).toBeInTheDocument();
    expect(diff).toHaveBeenCalledTimes(1);
    expect(diff).toHaveBeenCalledWith('store', 'src/account.tsx', { branch: 'harbor/implement-account-page-1a2b3c' });
  });
  it('selects a commit and opens the helper conversation from its branch', async () => {
    const view = await openGit();
    const changes = vi.spyOn(window.harbor, 'getGitChanges');
    await userEvent.click(await within(view).findByRole('button', { name: /Polish checkout spacing/ }));
    expect(changes).toHaveBeenLastCalledWith('store', { commit: '1234567890abcdef1234567890abcdef12345678' });
    await userEvent.click(within(view).getByRole('button', { name: 'Implement account page' }));
    expect(await screen.findByRole('button', { name: 'Back to main' })).toBeInTheDocument();
  });
  it('explains a folder that is not a repository without asking for history', async () => {
    window.harbor.getGitOverview = async projectId => ({ projectId, branches: [], worktrees: [], notes: ['This project folder is not a Git repository.'] });
    const log = vi.spyOn(window.harbor, 'getGitLog');
    render(<App/>);
    await screen.findByRole('heading', { name: 'Build the account page' });
    await userEvent.click(screen.getByRole('button', { name: 'Git' }));
    expect(await screen.findByText('This project folder is not a Git repository.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(log).not.toHaveBeenCalled();
  });
});
