import { ipcMain, type WebContents } from 'electron';
import { EVENT_CHANNEL, INVOKE_METHODS, channel } from '../shared/ipc';
import type { HarborService } from './service';

/** Wire every contract method to ipcMain and forward events to the given window. */
export function registerIpc(service: HarborService, target: () => WebContents | undefined): () => void {
  for (const m of INVOKE_METHODS) {
    ipcMain.handle(channel(m), (_e, ...args: unknown[]) =>
      (service[m] as (...a: unknown[]) => Promise<unknown>)(...args));
  }
  const off = service.onEvent((e) => {
    const wc = target();
    if (wc && !wc.isDestroyed()) wc.send(EVENT_CHANNEL, e);
  });
  return () => { off(); for (const m of INVOKE_METHODS) ipcMain.removeHandler(channel(m)); };
}
