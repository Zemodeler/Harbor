import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpdater, type UpdaterLike } from '../src/main/updater';

function fake() {
  const handlers: Record<string, (x: any) => void> = {};
  const u = {
    autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: true,
    on: vi.fn((e: string, l: (x: any) => void) => { handlers[e] = l; }),
    checkForUpdates: vi.fn(async () => undefined),
    quitAndInstall: vi.fn()
  };
  return { u: u as unknown as UpdaterLike & typeof u, handlers };
}
const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };

describe('updater', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does nothing when not packaged, opted out by env, or disabled in settings', async () => {
    for (const extra of [{ isPackaged: false }, { env: { HARBOR_NO_UPDATE: '1' } }, { isEnabled: () => false }]) {
      const { u } = fake();
      const r = createUpdater({ autoUpdater: u, isPackaged: true, ask: async () => 1, log: log(), ...extra });
      await vi.advanceTimersByTimeAsync(5 * 60 * 60_000);
      expect(r.started).toBe(false);
      expect(u.checkForUpdates).not.toHaveBeenCalled();
      expect(u.on).not.toHaveBeenCalled();
    }
  });

  it('configures the updater and checks at 30 s, then every 4 h', async () => {
    const { u } = fake();
    const r = createUpdater({ autoUpdater: u, isPackaged: true, ask: async () => 1, log: log(), isEnabled: () => undefined });
    expect(u.autoDownload).toBe(true); expect(u.autoInstallOnAppQuit).toBe(true); expect(u.allowPrerelease).toBe(false);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(u.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(u.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
    expect(u.checkForUpdates).toHaveBeenCalledTimes(2);
    r.stop();
    await vi.advanceTimersByTimeAsync(8 * 60 * 60_000);
    expect(u.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('prompts only after download; Restart now installs silently, Later does not', async () => {
    const { u, handlers } = fake();
    const ask = vi.fn(async () => 1);
    createUpdater({ autoUpdater: u, isPackaged: true, ask, log: log() });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ask).not.toHaveBeenCalled();
    handlers['update-downloaded']!({ version: '0.1.7' }); await flush();
    expect(ask).toHaveBeenCalledWith('Harbor 0.1.7 is ready. Restart now to update?', ['Restart now', 'Later']);
    expect(u.quitAndInstall).not.toHaveBeenCalled();
    ask.mockResolvedValueOnce(0);
    handlers['update-downloaded']!({ version: '0.1.7' }); await flush();
    expect(u.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('waits while busy, then prompts once idle', async () => {
    const { u, handlers } = fake();
    let busy = true;
    const ask = vi.fn(async () => 0);
    createUpdater({ autoUpdater: u, isPackaged: true, ask, log: log(), isBusy: () => busy });
    handlers['update-downloaded']!({ version: '0.1.8' }); await flush();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(ask).not.toHaveBeenCalled();
    expect(u.quitAndInstall).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(u.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('does not install if work started while the dialog was open', async () => {
    const { u, handlers } = fake();
    let busy = false;
    const ask = vi.fn(async () => { busy = true; return 0; });
    createUpdater({ autoUpdater: u, isPackaged: true, ask, log: log(), isBusy: () => busy });
    handlers['update-downloaded']!({ version: '0.1.9' }); await flush();
    expect(u.quitAndInstall).not.toHaveBeenCalled();
  });

  it('logs errors without throwing and retries at the next interval', async () => {
    const { u, handlers } = fake();
    const l = log();
    u.checkForUpdates.mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => { throw new Error('sync'); });
    createUpdater({ autoUpdater: u, isPackaged: true, ask: async () => 1, log: l });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
    expect(u.checkForUpdates).toHaveBeenCalledTimes(3);
    expect(l.warn).toHaveBeenCalledTimes(2);
    expect(() => handlers['error']!(new Error('x'))).not.toThrow();
  });
});
