import type { ThreadChoice } from '../shared/protocol';

/** Only observed busy → idle transitions count; initial/reconnected catalogs are baselines. */
export class AttentionTracker {
  private busy = new Set<string>();
  reset() { this.busy.clear(); }
  update(threads: ThreadChoice[]): string[] {
    const finished = threads.filter(thread => this.busy.has(thread.id) && thread.busy === false).map(thread => thread.id);
    this.busy = new Set(threads.filter(thread => thread.busy).map(thread => thread.id));
    return finished;
  }
}

export function chatNeedsAttention(threadId: string, selected: string | undefined, chat: boolean, visible: boolean, focused: boolean) {
  return threadId !== selected || !chat || !visible || !focused;
}
