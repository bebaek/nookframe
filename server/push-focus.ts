// Ephemeral, per-connection leases: a suspended or disconnected page must not
// suppress a device's notifications forever. No browser focus state is persisted.
export class PushFocus {
  private views = new Map<object, { session: string; threadId: string; expires: number }>();
  constructor(private now: () => number = Date.now, private valid: (session: string) => boolean = () => true) {}
  update(connection: object, session: string, threadId: string, focused: boolean) {
    if (focused && threadId) this.views.set(connection, { session, threadId, expires: this.now() + 45000 });
    else this.remove(connection);
  }
  remove(connection: object) { this.views.delete(connection); }
  has(threadId: string) {
    for (const [connection, view] of this.views) {
      if (view.expires <= this.now() || !this.valid(view.session)) { this.views.delete(connection); continue; }
      // All authenticated devices belong to this single-user workspace. Viewing
      // this conversation anywhere makes its completion push unnecessary everywhere.
      if (view.threadId === threadId) return true;
    }
    return false;
  }
}
