import type { HarborEvent, Id, SessionActivity } from '../shared/api';

export type NotificationKind = 'finished' | 'attention';

/**
 * Decides which events deserve a desktop notification. A conversation notifies only when its activity state changes to
 * done (and no helper of it is still busy) or to failed; a rename, pin or deadline change re-emits the conversation with
 * the same state and must stay silent. Questions and permission requests always notify. Pure apart from the state it keeps.
 */
export class NotificationGate {
  private readonly last = new Map<Id, SessionActivity['state'] | undefined>();

  /** Known states at startup, so the first cosmetic event of an already finished conversation is not a transition. */
  seed(conversations: Iterable<{ id: Id; activity?: { state: SessionActivity['state'] } }>): void {
    for (const c of conversations) this.last.set(c.id, c.activity?.state);
  }

  /** `helpersBusy`: whether a helper of the event's conversation is still queued, working or waiting. */
  check(e: HarborEvent, helpersBusy: () => boolean): NotificationKind | undefined {
    if (e.type === 'question' || e.type === 'permission') return 'attention';
    if (e.type !== 'conversation') return undefined;
    const state = e.conversation.activity?.state;
    const previous = this.last.get(e.conversation.id);
    this.last.set(e.conversation.id, state);
    if (state === previous) return undefined;
    if (state === 'failed') return 'attention';
    if (state === 'done' && !helpersBusy()) return 'finished';
    return undefined;
  }
}
