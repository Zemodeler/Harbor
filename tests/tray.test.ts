import { describe, expect, it } from 'vitest';
import { shouldHideOnClose, trayMenuModel, trayTooltip } from '../src/main/tray';
import type { AgentState } from '../src/shared/api';

describe('tray policy', () => {
  it('only hides when explicitly enabled and not quitting', () => {
    expect(shouldHideOnClose({}, false)).toBe(false);
    expect(shouldHideOnClose({ keepRunningInBackground: false }, false)).toBe(false);
    expect(shouldHideOnClose({ keepRunningInBackground: true }, false)).toBe(true);
    expect(shouldHideOnClose({ keepRunningInBackground: true }, true)).toBe(false);
  });

  it('provides open and explicit quit actions', () => {
    expect(trayMenuModel()).toEqual([{ label: 'Open Harbor', action: 'open' }, { label: 'Quit', action: 'quit' }]);
  });

  it('counts working agents without counting queued, waiting or finished records', () => {
    const states: AgentState[] = ['working', 'working', 'queued', 'waiting', 'done', 'failed', 'stopped'];
    expect(trayTooltip(states.map(state => ({ state })))).toBe('Harbor — 2 running agents');
    expect(trayTooltip([{ state: 'working' }])).toBe('Harbor — 1 running agent');
    expect(trayTooltip([])).toBe('Harbor — 0 running agents');
  });
});
