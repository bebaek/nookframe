import webpush, { type PushSubscription } from 'web-push';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ThreadChoice } from '../shared/protocol.js';
import { notificationSummary } from '../shared/notification-summary.js';

// Never accept arbitrary outbound destinations from subscription JSON (SSRF).
export function validateSubscription(value: unknown): PushSubscription {
  const s = value as PushSubscription;
  const url = new URL(s?.endpoint);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
      !['updates.push.services.mozilla.com', 'fcm.googleapis.com', 'web.push.apple.com'].includes(url.hostname) ||
      s.endpoint.length > 4096 || !/^[A-Za-z0-9_-]{87}$/.test(s.keys?.p256dh) || !/^[A-Za-z0-9_-]{22}$/.test(s.keys?.auth)) throw new Error('Invalid subscription');
  return { endpoint: url.href, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}

type Saved = { keys: { publicKey: string; privateKey: string }; subscriptions: Record<string, PushSubscription>; summaries?: Record<string, boolean> };
export class PushNotifications {
  private saved: Saved;
  private file: string;
  private busy = new Set<string>();
  private pending = new Set<string>();
  constructor(directory: string, private subject: string, private valid: (session: string) => boolean,
    private send: typeof webpush.sendNotification = webpush.sendNotification,
    private focused: (threadId: string) => boolean = () => false) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, 'push.json');
    this.saved = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { keys: webpush.generateVAPIDKeys(), subscriptions: {} };
    this.save();
  }
  get publicKey() { return this.saved.keys.publicKey; }
  has(session: string) { return !!this.saved.subscriptions[session]; }
  subscribe(session: string, value: unknown, includeSummary = false) {
    const subscription = validateSubscription(value);
    for (const [id, s] of Object.entries(this.saved.subscriptions)) {
      if (!this.valid(id) || s.endpoint === subscription.endpoint) {
        delete this.saved.subscriptions[id];
        if (this.saved.summaries) delete this.saved.summaries[id];
      }
    }
    this.saved.subscriptions[session] = subscription;
    (this.saved.summaries ??= {})[session] = includeSummary;
    this.save();
  }
  remove(session: string) {
    delete this.saved.subscriptions[session];
    if (this.saved.summaries) delete this.saved.summaries[session];
    this.save();
  }
  update(threads: ThreadChoice[]) {
    const finished = threads.filter(t => this.busy.has(t.id) && t.busy === false).map(t => t.id);
    this.busy = new Set(threads.filter(t => t.busy).map(t => t.id));
    if (finished.length) void this.notify(undefined, finished, new Map(threads.map(t => [t.id, t.notificationSummary ?? ''])));
  }
  async notify(only?: string, finished?: string[], summaries = new Map<string, string>()) {
    // Freeze the completion-time decision across devices; focus changing during
    // delivery must not cause only some devices to receive a suppressed event.
    const destinations = finished?.filter(threadId => !this.focused(threadId));
    if (destinations?.length === 0) return;
    for (const [id, subscription] of Object.entries(this.saved.subscriptions)) {
      if (!this.valid(id)) { this.remove(id); continue; }
      if ((only && only !== id) || this.pending.has(id)) continue;
      this.pending.add(id);
      try {
        // Summaries are opt-in per subscription and stay inside the encrypted
        // payload. Never put conversation content or identifiers in headers.
        for (const threadId of destinations ?? [undefined]) {
          if (!this.valid(id) || this.saved.subscriptions[id] !== subscription) break;
          const summary = this.saved.summaries?.[id] && threadId ? notificationSummary(summaries.get(threadId) ?? '') : '';
          await this.send(subscription, JSON.stringify({ type: 'attention', ...(threadId ? { threadId } : {}), ...(summary ? { summary } : {}) }), {
            vapidDetails: { subject: this.subject, ...this.saved.keys }, TTL: 3600, timeout: 10000,
          });
        }
      } catch (error) {
        // Never expose endpoint URLs or provider responses in logs.
        if ([404, 410].includes((error as { statusCode?: number }).statusCode ?? 0) && this.saved.subscriptions[id] === subscription) this.remove(id);
      } finally { this.pending.delete(id); }
    }
  }
  private save() {
    const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.saved), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, this.file);
  }
}
