import { contextBridge, ipcRenderer } from 'electron';
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

contextBridge.exposeInMainWorld('harbor', api as unknown as HarborApi);
