import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { appearanceKey, defaultAppearance, parseAppearance } from '../appearance';
import { createMockApi } from '../mock/mockApi';
import { boardLane, leadState } from '../workspaceModes';
import type { HarborEvent } from '../../shared/api';

beforeEach(() => { localStorage.clear(); window.harbor = createMockApi({ delay: 0 }); });
async function appearanceSettings() {
  await userEvent.click(await screen.findByRole('button', { name: 'Open settings' }));
  await userEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
}

describe('Workspace modes', () => {
  it('migrates older preferences and recovers an invalid layout without discarding colors', () => {
    expect(parseAppearance('{"palette":"rose","mode":"light"}')).toEqual({ palette: 'rose', mode: 'light', layout: 'command' });
    expect(parseAppearance('{"palette":"ice","mode":"dark","layout":"unknown"}')).toEqual({ palette: 'ice', mode: 'dark', layout: 'command' });
  });

  it('switches all layouts, retains drafts and colors, and restores the saved selection', async () => {
    const view = render(<App/>);
    await userEvent.type(await screen.findByLabelText('Message Harbor'), 'Keep this draft');
    await appearanceSettings();
    await userEvent.click(screen.getByRole('radio', { name: 'Violet' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Focus Studio' }));
    await userEvent.click(screen.getByRole('button', { name: 'Back to conversation' }));
    expect(await screen.findByRole('region', { name: 'Agent dock' })).toBeInTheDocument();
    expect(screen.getByLabelText('Message Harbor')).toHaveValue('Keep this draft');
    expect(document.documentElement.dataset.palette).toBe('violet');
    await appearanceSettings();
    await userEvent.click(screen.getByRole('radio', { name: 'Mission Board' }));
    await userEvent.click(screen.getByRole('button', { name: 'Back to conversation' }));
    expect(await screen.findByRole('region', { name: 'Mission Board' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open full conversation' }));
    expect(screen.getByLabelText('Message Harbor')).toHaveValue('Keep this draft');
    await appearanceSettings();
    await userEvent.click(screen.getByRole('radio', { name: 'Command Center' }));
    await userEvent.click(screen.getByRole('button', { name: 'Back to conversation' }));
    await appearanceSettings();
    await userEvent.click(screen.getByRole('radio', { name: 'Mission Board' }));
    await userEvent.click(screen.getByRole('button', { name: 'Back to conversation' }));
    expect(screen.getByRole('region', { name: 'Mission Board' })).toBeInTheDocument();
    view.unmount(); render(<App/>);
    expect(await screen.findByRole('region', { name: 'Mission Board' })).toBeInTheDocument();
    expect(document.documentElement.dataset.palette).toBe('violet');
    await appearanceSettings();
    await userEvent.click(screen.getByRole('radio', { name: 'Command Center' }));
    await userEvent.click(screen.getByRole('button', { name: 'Back to conversation' }));
    expect(screen.queryByRole('region', { name: 'Mission Board' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Agent dock' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Message Harbor')).toHaveValue('Keep this draft');
  });

  it('provides one settings entry point and restores each original color scheme explicitly', async () => {
    render(<App/>);
    await screen.findByLabelText('Message Harbor');
    expect(screen.getAllByRole('button', { name: /settings/i })).toHaveLength(1);
    await appearanceSettings();
    for (const [name, palette, mode] of [['Focus Studio', 'porcelain', 'light'], ['Mission Board', 'graphite', 'dark'], ['Command Center', 'command', 'dark']]) {
      await userEvent.click(screen.getByRole('radio', { name }));
      await userEvent.click(screen.getByRole('button', { name: 'Use this mode’s original colors' }));
      expect(document.documentElement.dataset.palette).toBe(palette);
      expect(document.documentElement.style.colorScheme).toBe(mode);
    }
  });

  it('shows command activity on wide windows, hides it on request, and never auto-opens a narrow drawer', async () => {
    vi.stubGlobal('innerWidth', 1600);
    try {
      const view = render(<App/>);
      await screen.findByLabelText('Message Harbor');
      expect(await screen.findByRole('heading', { name: 'Live activity' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Close live activity' }));
      expect(screen.queryByRole('heading', { name: 'Live activity' })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Session information' }));
      expect(screen.getByRole('heading', { name: 'Live activity' })).toBeInTheDocument();
      view.unmount(); vi.stubGlobal('innerWidth', 600); render(<App/>);
      await screen.findByLabelText('Message Harbor');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Session information' }));
      expect(screen.getByRole('dialog', { name: 'Session details' })).toBeInTheDocument();
    } finally { vi.unstubAllGlobals(); }
  });

  it('updates board lanes from events and opens the correct conversation', async () => {
    localStorage.setItem(appearanceKey, JSON.stringify({ ...defaultAppearance, layout: 'mission' }));
    const api = window.harbor;
    let deliver: ((e: HarborEvent) => void) | undefined;
    const onEvent = api.onEvent;
    api.onEvent = cb => { deliver = cb; return onEvent(cb); };
    render(<App/>);
    const board = await screen.findByRole('region', { name: 'Mission Board' });
    const task = (await api.listConversations('store')).find(c => c.id === 'checkout')!;
    act(() => deliver?.({ type: 'conversation', conversation: { ...task, activity: { state: 'working', updated: Date.now(), detail: 'Checking checkout' } } }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Working' })).getByRole('button', { name: /Polish the checkout/ })).toBeInTheDocument());
    await userEvent.click(within(board).getByRole('button', { name: /Polish the checkout/ }));
    expect(await screen.findByRole('heading', { name: 'Polish the checkout' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Message Harbor')).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Show board' }));
    act(() => deliver?.({ type: 'conversation', conversation: { ...task, activity: { state: 'done', updated: Date.now() } } }));
    await userEvent.click(screen.getByText(/Finished conversations/));
    const finished = screen.getByText(/Finished conversations/).closest('details')!;
    expect(within(finished).getByRole('button', { name: /Polish the checkout/ })).toBeInTheDocument();
  });

  it('keeps shared lead state from leaking into other board conversations', async () => {
    const tasks = await window.harbor.listConversations('store');
    const agents = await window.harbor.listAgents('store');
    const checkout = tasks.find(c => c.id === 'checkout')!;
    expect(boardLane(checkout, agents.map(a => a.role === 'main' ? { ...a, state: 'working' } : a), new Set())).toBe('ready');
    expect(leadState({ conversation: checkout, agents, sending: new Set() })).toBe('idle');
    expect(boardLane(checkout, agents, new Set([checkout.id]))).toBe('ready');
    expect(boardLane({ ...checkout, activity: { state: 'failed', updated: 1 } }, agents, new Set())).toBe('attention');
  });
});
