// Ephemeral, per-connection leases: a suspended or disconnected page must not
// suppress a device's notifications forever. No browser focus state is persisted.
export class PushFocus {
  private views = new Map<object, { session: string; threadId: string; expires: number }>();
  constructor(private now: () => number = Date.now) {}
  update(connection: object, session: string, threadId: string, focused: boolean) {
    if (focused && threadId) this.views.set(connection, { session, threadId, expires: this.now() + 45000 });
    else this.remove(connection);
  }
  remove(connection: object) { this.views.delete(connection); }
  has(session: string, threadId: string) {
    for (const [connection, view] of this.views) {
      if (view.expires <= this.now()) { this.views.delete(connection); continue; }
      if (view.session === session && view.threadId === threadId) return true;
    }
    return false;
  }
}
