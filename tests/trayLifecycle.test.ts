import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarborEvent, Settings } from '../src/shared/api';
import { Store } from '../src/main/store';

const state = vi.hoisted(() => ({
  windows: [] as FakeWindow[], trays: [] as FakeTray[],
  store: undefined as Store | undefined,
  service: undefined as { setSettings(patch: Partial<Settings>): Promise<Settings> } | undefined,
  event: undefined as ((event: HarborEvent) => void) | undefined,
  shutdown: vi.fn(() => Promise.resolve()), emptyIcon: false
}));

class FakeWindow extends EventEmitter {
  visible = true;
  minimized = false;
  webContents = {};
  constructor() { super(); state.windows.push(this); }
  hide = vi.fn(() => { this.visible = false; });
  show = vi.fn(() => { this.visible = true; });
  focus = vi.fn();
  restore = vi.fn(() => { this.minimized = false; });
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  isFocused() { return false; }
  loadURL = vi.fn();
  loadFile = vi.fn();
}

class FakeTray extends EventEmitter {
  menu: Array<{ label: string; click(): void }> = [];
  constructor(readonly icon: unknown) { super(); state.trays.push(this); }
  setContextMenu(menu: FakeTray['menu']) { this.menu = menu; }
  setToolTip = vi.fn();
  destroy = vi.fn();
}

const app = Object.assign(new EventEmitter(), {
  requestSingleInstanceLock: vi.fn(() => true),
  whenReady: () => Promise.resolve(), isPackaged: false,
  getAppPath: () => '/harbor', getPath: () => '/data', getVersion: () => '0.0.0-test', exit: vi.fn(), setAppUserModelId: vi.fn(),
  quit: vi.fn(() => { app.emit('before-quit', { preventDefault: vi.fn() }); })
});

vi.mock('electron', () => ({
  app, BrowserWindow: FakeWindow, Tray: FakeTray, dialog: { showMessageBoxSync: vi.fn(() => 0) }, shell: {}, Notification: {}, powerMonitor: { on: vi.fn() },
  Menu: { buildFromTemplate: (menu: FakeTray['menu']) => menu },
  nativeImage: { createFromPath: () => ({ isEmpty: () => state.emptyIcon }), createEmpty: () => 'empty-icon' }
}));
vi.mock('../src/main/ipc', () => ({ registerIpc: vi.fn() }));
vi.mock('../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), file: '' }) }));
vi.mock('../src/main/codexLimits', () => ({ readCodexLimits: vi.fn() }));
vi.mock('../src/main/service', () => ({ createHarborService: () => {
  const service = {
    store: state.store!, shutdown: state.shutdown, activeRuns: () => 0, onResume: vi.fn(),
    onEvent: (cb: (event: HarborEvent) => void) => { state.event = cb; },
    setSettings: async (patch: Partial<Settings>) => state.store!.setSettings(patch)
  };
  state.service = service;
  return service;
} }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  app.removeAllListeners();
  state.windows = []; state.trays = []; state.store = new Store(); state.emptyIcon = false;
  state.service = undefined;
  app.requestSingleInstanceLock.mockReturnValue(true);
});

const start = async (enabled?: boolean) => {
  state.store!.setSettings({ keepRunningInBackground: enabled });
  await import('../src/main/index');
};
const close = () => {
  const event = { preventDefault: vi.fn() };
  state.windows[0].emit('close', event);
  return event;
};

describe('Electron tray lifecycle (mocked)', () => {
  it('quits a duplicate launch before creating the service or a window', async () => {
    app.requestSingleInstanceLock.mockReturnValue(false);
    await start();
    expect(app.quit).toHaveBeenCalledOnce();
    expect(state.service).toBeUndefined();
    expect(state.windows).toHaveLength(0);
    expect(state.shutdown).not.toHaveBeenCalled();
  });

  it('restores and focuses the existing hidden window on a second launch', async () => {
    await start(true);
    close();
    state.windows[0].minimized = true;
    app.emit('second-instance');
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0].visible).toBe(true);
    expect(state.windows[0].restore).toHaveBeenCalledOnce();
    expect(state.windows[0].focus).toHaveBeenCalledOnce();
    expect(state.shutdown).not.toHaveBeenCalled();
  });
  it('preserves normal close/quit when the preference is absent', async () => {
    await start();
    expect(close().preventDefault).not.toHaveBeenCalled();
    expect(state.trays).toHaveLength(0);
    app.emit('window-all-closed');
    expect(state.shutdown).toHaveBeenCalledOnce();
  });

  it('hides without shutting down, reopens the same window and lets tray Quit close it', async () => {
    await start(true);
    expect(close().preventDefault).toHaveBeenCalledOnce();
    expect(state.windows[0].visible).toBe(false);
    expect(state.shutdown).not.toHaveBeenCalled();
    const tray = state.trays[0];
    state.windows[0].minimized = true;
    tray.menu[0].click();
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0].restore).toHaveBeenCalledOnce();
    expect(state.windows[0].visible).toBe(true);
    expect(state.windows[0].focus).toHaveBeenCalledOnce();
    close();
    tray.menu[1].click();
    expect(state.shutdown).toHaveBeenCalledOnce();
    expect(tray.destroy).toHaveBeenCalledOnce();
    expect(close().preventDefault).not.toHaveBeenCalled();
  });

  it('updates the tooltip and restores a hidden window when background running is disabled', async () => {
    await start(true);
    close();
    state.event!({ type: 'usage', windows: [] });
    state.event!({ type: 'conversation', conversation: { id: 'c', projectId: 'p', title: 'Task', updated: 1, agentId: 'a' } });
    expect(state.trays[0].setToolTip).toHaveBeenLastCalledWith('Harbor — 0 running agents');
    await state.service!.setSettings({ keepRunningInBackground: false });
    expect(state.windows[0].visible).toBe(true);
    expect(state.trays[0].destroy).toHaveBeenCalledOnce();
    expect(close().preventDefault).not.toHaveBeenCalled();
  });

  it('falls back to an empty native image if the existing icon cannot be loaded', async () => {
    state.emptyIcon = true;
    await start(true);
    expect(state.trays[0].icon).toBe('empty-icon');
    app.quit();
    expect(close().preventDefault).not.toHaveBeenCalled();
    expect(state.shutdown).toHaveBeenCalledOnce();
  });
});
