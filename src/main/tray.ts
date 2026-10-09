import type { AgentState, Settings } from '../shared/api';

/** An explicit quit must always get past the window's close handler. */
export function shouldHideOnClose(settings: Pick<Settings, 'keepRunningInBackground'>, quitting: boolean): boolean {
  return settings.keepRunningInBackground === true && !quitting;
}

export function trayMenuModel(): Array<{ label: string; action: 'open' | 'quit' }> {
  return [{ label: 'Open Harbor', action: 'open' }, { label: 'Quit', action: 'quit' }];
}

export function trayTooltip(agents: ReadonlyArray<{ state: AgentState }>): string {
  const running = agents.filter(a => a.state === 'working').length;
  return `Harbor — ${running} running agent${running === 1 ? '' : 's'}`;
}
