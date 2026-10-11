import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { HarborEvent } from '../src/shared/api';
import { EVENT_CHANNEL, INVOKE_METHODS, channel } from '../src/shared/ipc';
import { registerIpc, UNTRUSTED_SENDER, type IpcHost, type IpcTarget } from '../src/main/ipc';
import type { HarborService } from '../src/main/service';
import { appDocument, type FrameRef, type InvokeEventRef } from '../src/main/windowSecurity';

const indexFile = join(resolve('C:/Harbor/out'), 'renderer/index.html');
const doc = appDocument(indexFile);
const appUrl = pathToFileURL(indexFile).href;

function setup() {
  const handlers = new Map<string, (event: InvokeEventRef, ...args: unknown[]) => unknown>();
  const host: IpcHost = { handle: (c, l) => { handlers.set(c, l); }, removeHandler: c => { handlers.delete(c); } };
  let emit: (e: HarborEvent) => void = () => undefined;
  const service = Object.fromEntries(INVOKE_METHODS.map(m => [m, vi.fn(async (...args: unknown[]) => ({ m, args }))])) as unknown as HarborService;
  service.onEvent = (cb: (e: HarborEvent) => void) => { emit = cb; return () => { emit = () => undefined; }; };
  const main: { -readonly [K in keyof FrameRef]: FrameRef[K] } = { url: appUrl, parent: null, processId: 3, routingId: 1 };
  const win: IpcTarget & { destroyed: boolean } = { id: 1, mainFrame: main, destroyed: false, isDestroyed() { return this.destroyed; }, send: vi.fn() };
  let current: IpcTarget | undefined = win;
  const dispose = registerIpc(service, host, () => current, doc);
  const invoke = (m: string, event: InvokeEventRef, ...args: unknown[]) => handlers.get(channel(m as never))!(event, ...args);
  return { handlers, service, main, win, invoke, dispose, emit: (e: HarborEvent) => emit(e), setCurrent: (t?: IpcTarget) => { current = t; } };
}

describe('registerIpc guard', () => {
  it('registers every contract method and removes them on dispose', () => {
    const s = setup();
    expect([...s.handlers.keys()].sort()).toEqual(INVOKE_METHODS.map(channel).sort());
    s.dispose();
    expect(s.handlers.size).toBe(0);
  });

  it('forwards trusted invokes with their arguments', async () => {
    const s = setup();
    await expect(s.invoke('getSettings', { sender: s.win, senderFrame: s.main })).resolves.toEqual({ m: 'getSettings', args: [] });
    await expect(s.invoke('send', { sender: s.win, senderFrame: s.main }, 'c1', 'hi')).resolves.toEqual({ m: 'send', args: ['c1', 'hi'] });
  });

  it('rejects untrusted senders before the service runs, for every method', () => {
    const s = setup();
    const otherFrame: FrameRef = { url: appUrl, parent: null, processId: 8, routingId: 1 };
    const other: IpcTarget = { id: 2, mainFrame: otherFrame, isDestroyed: () => false, send: vi.fn() };
    const sub: FrameRef = { url: 'https://evil.example/', parent: s.main, processId: 3, routingId: 5 };
    for (const m of INVOKE_METHODS) {
      expect(() => s.invoke(m, { sender: other, senderFrame: otherFrame }), m).toThrow(UNTRUSTED_SENDER);
      expect(() => s.invoke(m, { sender: s.win, senderFrame: sub }), m).toThrow(UNTRUSTED_SENDER);
      expect(() => s.invoke(m, { sender: s.win, senderFrame: null }), m).toThrow(UNTRUSTED_SENDER);
      expect(s.service[m]).not.toHaveBeenCalled();
    }
  });

  it('rejects the window itself once it shows another document, and after it closed', () => {
    const s = setup();
    s.main.url = pathToFileURL('C:/Users/me/Downloads/evil.html').href;
    expect(() => s.invoke('listProjects', { sender: s.win, senderFrame: s.main })).toThrow(UNTRUSTED_SENDER);
    s.main.url = appUrl;
    s.setCurrent(undefined);
    expect(() => s.invoke('listProjects', { sender: s.win, senderFrame: s.main })).toThrow(UNTRUSTED_SENDER);
    expect(s.service.listProjects).not.toHaveBeenCalled();
  });

  it('forwards events only to the live window showing the app document', () => {
    const s = setup();
    const e: HarborEvent = { type: 'usage', windows: [] };
    s.emit(e);
    expect(s.win.send).toHaveBeenCalledWith(EVENT_CHANNEL, e);
    s.main.url = 'https://evil.example/';
    s.emit(e);
    s.main.url = appUrl;
    s.win.destroyed = true;
    s.emit(e);
    expect(s.win.send).toHaveBeenCalledTimes(1);
    s.dispose();
    s.win.destroyed = false;
    s.emit(e);
    expect(s.win.send).toHaveBeenCalledTimes(1);
  });
});
