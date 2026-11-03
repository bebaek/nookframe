import webpush, { type PushSubscription } from 'web-push';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ThreadChoice } from '../shared/protocol.js';

// Never accept arbitrary outbound destinations from subscription JSON (SSRF).
export function validateSubscription(value: unknown): PushSubscription {
  const s = value as PushSubscription;
  const url = new URL(s?.endpoint);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
      !['updates.push.services.mozilla.com', 'fcm.googleapis.com', 'web.push.apple.com'].includes(url.hostname) ||
      s.endpoint.length > 4096 || !/^[A-Za-z0-9_-]{87}$/.test(s.keys?.p256dh) || !/^[A-Za-z0-9_-]{22}$/.test(s.keys?.auth)) throw new Error('Invalid subscription');
  return { endpoint: url.href, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}

type Saved = { keys: { publicKey: string; privateKey: string }; subscriptions: Record<string, PushSubscription> };
export class PushNotifications {
  private saved: Saved;
  private file: string;
  private busy = new Set<string>();
  private pending = new Set<string>();
  constructor(directory: string, private subject: string, private valid: (session: string) => boolean,
    private send: typeof webpush.sendNotification = webpush.sendNotification,
    private focused: (session: string, threadId: string) => boolean = () => false) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, 'push.json');
    this.saved = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { keys: webpush.generateVAPIDKeys(), subscriptions: {} };
    this.save();
  }
  get publicKey() { return this.saved.keys.publicKey; }
  has(session: string) { return !!this.saved.subscriptions[session]; }
  subscribe(session: string, value: unknown) {
    const subscription = validateSubscription(value);
    for (const [id, s] of Object.entries(this.saved.subscriptions)) {
      if (!this.valid(id) || s.endpoint === subscription.endpoint) delete this.saved.subscriptions[id];
    }
    this.saved.subscriptions[session] = subscription; this.save();
  }
  remove(session: string) { delete this.saved.subscriptions[session]; this.save(); }
  update(threads: ThreadChoice[]) {
    const finished = threads.filter(t => this.busy.has(t.id) && t.busy === false).map(t => t.id);
    this.busy = new Set(threads.filter(t => t.busy).map(t => t.id));
    if (finished.length) void this.notify(undefined, finished);
  }
  async notify(only?: string, finished?: string[]) {
    for (const [id, subscription] of Object.entries(this.saved.subscriptions)) {
      if (!this.valid(id)) { this.remove(id); continue; }
      if ((only && only !== id) || this.pending.has(id)) continue;
      this.pending.add(id);
      try {
        // Each completion needs its own encrypted destination. Never include
        // conversation text/title or put the identifier in provider headers.
        for (const threadId of finished ?? [undefined]) {
          if (!this.valid(id) || this.saved.subscriptions[id] !== subscription) break;
          if (threadId && this.focused(id, threadId)) continue;
          await this.send(subscription, JSON.stringify({ type: 'attention', ...(threadId ? { threadId } : {}) }), {
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
