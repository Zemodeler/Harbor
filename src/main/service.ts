import { EventEmitter } from 'node:events';
import type { HarborApi, HarborEvent, Settings } from '../shared/api';

export type HarborService = Omit<HarborApi, 'onEvent'> & {
  onEvent(cb: (e: HarborEvent) => void): () => void;
};

/** Event bus shared by the service and the IPC layer. */
export class EventBus {
  private em = new EventEmitter();
  emit(e: HarborEvent): void { this.em.emit('event', e); }
  on(cb: (e: HarborEvent) => void): () => void {
    this.em.on('event', cb);
    return () => { this.em.off('event', cb); };
  }
}

export const DEFAULT_SETTINGS: Settings = { routing: 'auto', cliOverrides: {}, allowFreeReset: 'ask' };

/** Scaffold service: returns empty data. Replaced step by step by the real implementation. */
export function createStubService(bus = new EventBus()): HarborService {
  let settings = DEFAULT_SETTINGS;
  const nope = async (): Promise<never> => { throw new Error('not implemented'); };
  return {
    listClis: async () => [], refreshClis: async () => [], openLogin: async () => {},
    listProjects: async () => [], addProject: async () => null, removeProject: async () => {},
    listConversations: async () => [], newConversation: nope,
    listMessages: async () => [], send: async () => {},
    listAgents: async () => [], openAgentConversation: nope, stopAgent: async () => {},
    getUsage: async () => [],
    getSettings: async () => settings,
    setSettings: async (s) => (settings = { ...settings, ...s }),
    answerPermission: async () => {},
    onEvent: (cb) => bus.on(cb)
  };
}
