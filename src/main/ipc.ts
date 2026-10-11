import { EVENT_CHANNEL, INVOKE_METHODS, channel } from '../shared/ipc';
import type { HarborService } from './service';
import { isAppDocumentUrl, isTrustedInvoke, type AppDocument, type ContentsRef, type InvokeEventRef } from './windowSecurity';

/** The part of ipcMain Harbor uses; index.ts passes the real one so this file stays free of Electron. */
export interface IpcHost {
  handle(channel: string, listener: (event: InvokeEventRef, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export interface IpcTarget extends ContentsRef { send(channel: string, ...args: unknown[]): void }

export const UNTRUSTED_SENDER = 'Harbor refused a request that did not come from its own window';

/** Wire every contract method to the host and forward events to the given window, for the app document only. */
export function registerIpc(service: HarborService, host: IpcHost, target: () => IpcTarget | undefined, doc: AppDocument): () => void {
  for (const m of INVOKE_METHODS) {
    host.handle(channel(m), (event, ...args: unknown[]) => {
      if (!isTrustedInvoke(event, target(), doc)) throw new Error(UNTRUSTED_SENDER);
      return (service[m] as (...a: unknown[]) => Promise<unknown>)(...args);
    });
  }
  const off = service.onEvent((e) => {
    const wc = target();
    // Navigation is guarded too, but events carry project content: never hand them to another document.
    if (wc && !wc.isDestroyed() && isAppDocumentUrl(wc.mainFrame.url, doc)) wc.send(EVENT_CHANNEL, e);
  });
  return () => { off(); for (const m of INVOKE_METHODS) host.removeHandler(channel(m)); };
}
