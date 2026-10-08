import { EventEmitter } from 'node:events';
import type { HarborEvent } from '../shared/api';

/** In-process event bus shared by the orchestrator, service, and IPC layer. */
export class EventBus {
  private em = new EventEmitter();
  emit(e: HarborEvent): void { this.em.emit('event', e); }
  on(cb: (e: HarborEvent) => void): () => void {
    this.em.on('event', cb);
    return () => { this.em.off('event', cb); };
  }
}
