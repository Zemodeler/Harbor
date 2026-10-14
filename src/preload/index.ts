import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { HarborApi, HarborEvent } from '../shared/api';
import { EVENT_CHANNEL, INVOKE_METHODS, channel } from '../shared/ipc';

const api = {} as Record<string, unknown>;
for (const m of INVOKE_METHODS) {
  api[m] = (...args: unknown[]) => ipcRenderer.invoke(channel(m), ...args);
}
api.onEvent = (cb: (e: HarborEvent) => void) => {
  const handler = (_: unknown, e: HarborEvent) => cb(e);
  ipcRenderer.on(EVENT_CHANNEL, handler);
  return () => { ipcRenderer.removeListener(EVENT_CHANNEL, handler); };
};

// A dropped file's local path (File.path is gone since Electron 32). Verified in a sandboxed preload on Electron 44: webUtils is available.
// The path only ever goes back to main through openDocument, which applies the same checks as any other path.
api.pathForFile = (file: File): string => { try { return webUtils.getPathForFile(file); } catch { return ''; } };

contextBridge.exposeInMainWorld('harbor', api as unknown as HarborApi);
