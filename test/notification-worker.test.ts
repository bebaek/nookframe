import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function fixture() {
  const listeners = new Map<string, (event: any) => void>();
  const calls: any[] = [];
  const client = { id: 'exact-tab', type: 'window', url: 'https://example.test/#thread=other',
    focus: async () => { calls.push('focus'); }, postMessage: (data: unknown) => calls.push(data) };
  const notifications: any[] = [];
  const scope = { location: { origin: 'https://example.test' },
    addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn),
    clients: { get: async (id: string) => id === client.id ? client : undefined,
      openWindow: async (url: string) => calls.push(url), claim: async () => {} },
    skipWaiting() {}, registration: {
      showNotification: async (title: string, options: any) => notifications.push({ title, ...options, close() { this.closed = true; } }),
      getNotifications: async () => notifications,
    } };
  runInNewContext(await readFile('web/public/notification-worker.js', 'utf8'), { self: scope, URL });
  async function emit(name: string, data: any) {
    const work: Promise<unknown>[] = [];
    listeners.get(name)!({ ...data, waitUntil: (promise: Promise<unknown>) => work.push(promise) });
    await Promise.all(work);
  }
  return { emit, client, calls, notifications };
}

test('worker binds notifications to exact sender, focuses before navigating, and clears only its notifications', async () => {
  const f = await fixture();
  await f.emit('message', { source: f.client, data: { type: 'show-attention', threadId: 'a' } });
  const notification = f.notifications[0];
  assert.equal(notification.data.clientId, 'exact-tab');
  f.notifications.push({ data: { clientId: 'different-window' }, close() { throw new Error('wrong notification cleared'); } });
  await f.emit('notificationclick', { notification });
  assert.equal(f.calls[0], 'focus');
  assert.equal(f.calls[1].type, 'open-attention');
  assert.equal(f.calls[1].threadId, 'a');
  await f.emit('message', { source: f.client, data: { type: 'clear-attention' } });
  assert.equal(notification.closed, true);
});

test('closed originating tab opens an encoded conversation URL, not another existing tab', async () => {
  const f = await fixture();
  await f.emit('notificationclick', { notification: { close() {}, data: { clientId: 'closed', threadId: 'a&b/#' } } });
  assert.equal(f.calls[0], '/#thread=a%26b%2F%23');
});

test('denied focus still navigates; invalid sources and click data do nothing', async () => {
  const f = await fixture();
  f.client.focus = async () => { throw new Error('compositor denied activation'); };
  await f.emit('notificationclick', { notification: { close() {}, data: { clientId: 'exact-tab', threadId: 'a' } } });
  assert.equal(f.calls[0].type, 'open-attention');
  await f.emit('message', { source: { ...f.client, url: 'https://other.test/' }, data: { type: 'show-attention', threadId: 'a' } });
  await f.emit('message', { source: f.client, data: { type: 'show-attention', threadId: '' } });
  await f.emit('notificationclick', { notification: { close() {}, data: { clientId: 'closed', threadId: null } } });
  assert.equal(f.notifications.length, 0);
  assert.equal(f.calls.length, 1);
});
