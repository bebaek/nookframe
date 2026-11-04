import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { MessageChannel, type MessagePort } from 'node:worker_threads';

async function fixture(userAgent = 'Mozilla/5.0 (X11; Linux x86_64; rv:155.0) Gecko/20100101 Firefox/155.0') {
  const listeners = new Map<string, (event: any) => void>();
  const calls: any[] = [];
  const client = { id: 'exact-tab', type: 'window', url: 'https://example.test/#thread=other',
    focus: async (): Promise<{ focused: boolean } | undefined> => { calls.push('focus'); return { focused: true }; }, postMessage(data: any, ports?: MessagePort[]) {
      if (data.type === 'query-attention-view') ports?.[0].postMessage({ type: 'attention-view', threadId: new URLSearchParams(new URL(this.url).hash.slice(1)).get('thread') });
      else calls.push(JSON.parse(JSON.stringify(data)));
    } };
  const notifications: any[] = [];
  const scope = { location: { origin: 'https://example.test' }, navigator: { userAgent },
    addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn),
    clients: { matchAll: async () => [client], get: async (id: string) => id === client.id ? client : undefined,
      openWindow: async (url: string) => calls.push(url), claim: async () => {} },
    skipWaiting() {}, registration: {
      showNotification: async (title: string, options: any) => notifications.push({ title, ...options, close() { this.closed = true; } }),
      getNotifications: async () => notifications,
    } };
  runInNewContext(await readFile('web/public/notification-worker.js', 'utf8'), { self: scope, URL, URLSearchParams, MessageChannel, setTimeout, clearTimeout });
  async function emit(name: string, data: any) {
    const work: Promise<unknown>[] = [];
    listeners.get(name)!({ ...data, waitUntil: (promise: Promise<unknown>) => work.push(promise) });
    await Promise.all(work);
  }
  return { emit, client, calls, notifications, clients: scope.clients };
}

test('Firefox Android opens the exact push URL without attempting tab reuse', async () => {
  for (const ua of [
    'Mozilla/5.0 (Android 15; Mobile; rv:155.0) Gecko/155.0 Firefox/155.0',
    'Mozilla/5.0 (Android 15; Tablet; rv:155.0) Gecko/155.0 Firefox/155.0',
  ]) {
    const f = await fixture(ua);
    f.clients.matchAll = async () => { throw new Error('Firefox Android must not discover clients'); };
    for (const threadId of ['other', 'a&b/#', undefined]) {
      await f.emit('notificationclick', { notification: { close() {}, data: { push: true, threadId } } });
      assert.equal(f.calls.at(-1), threadId ? `/#thread=${encodeURIComponent(threadId)}` : '/');
    }
    assert.equal(f.calls.length, 3, 'no focus or navigation messages sent to existing tabs');
  }
});

test('desktop Firefox and Android Chromium still reuse matching live tabs', async () => {
  for (const ua of [
    'Mozilla/5.0 (X11; Linux x86_64; rv:155.0) Gecko/20100101 Firefox/155.0',
    'Mozilla/5.0 (Android 15; Mobile) AppleWebKit/537.36 Chrome/142.0.0.0 Mobile Safari/537.36',
    '',
  ]) {
    const f = await fixture(ua);
    await f.emit('notificationclick', { notification: { close() {}, data: { push: true, threadId: 'other' } } });
    assert.deepEqual(f.calls, ['focus', { type: 'open-attention', threadId: 'other' }]);
  }
});

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

test('legacy push opens home rather than focusing an arbitrary Firefox tab', async () => {
  const f = await fixture();
  await f.emit('push', {});
  assert.equal(f.notifications.length, 1);
  assert.equal(f.notifications[0].tag, 'nookframe:push');
  assert.equal(f.notifications[0].data.push, true);
  await f.emit('notificationclick', { notification: f.notifications[0] });
  assert.equal(f.calls[0], '/');
});

test('push click opens the encoded conversation route without touching another tab', async () => {
  const f = await fixture();
  for (const threadId of ['a&b/#', 'https://evil.example/path', 'another']) {
    await f.emit('push', { data: { json: () => ({ type: 'attention', threadId }) } });
    const notification = f.notifications.at(-1);
    assert.equal(notification.data.threadId, threadId);
    assert.equal(notification.tag, `nookframe:push:${threadId}`);
    assert.equal(notification.body.includes(threadId), false);
    await f.emit('notificationclick', { notification });
    assert.equal(f.calls.at(-1), `/#thread=${encodeURIComponent(threadId)}`);
  }
  assert.equal(new Set(f.notifications.map(n => n.tag)).size, 3);
  assert.equal(f.calls.length, 3, 'no focus or navigation messages to unrelated tabs');
});

test('push reuses an exact thread in another window, including uncontrolled clients', async () => {
  const f = await fixture();
  const threadId = 'a&b/#';
  f.clients.matchAll = async (...args: any[]) => {
    assert.equal(args[0].type, 'window');
    assert.equal(args[0].includeUncontrolled, true);
    return [f.client, { ...f.client, id: 'other-window', url: `https://example.test/#thread=${encodeURIComponent(threadId)}`,
      focus: async () => { f.calls.push('other-window-focus'); return { focused: true }; } }];
  };
  await f.emit('notificationclick', { notification: { close() {}, data: { push: true, threadId } } });
  assert.deepEqual(f.calls, ['other-window-focus', { type: 'open-attention', threadId }]);
});

test('push tries remaining matches after a closed tab and ignores foreign or non-app URLs', async () => {
  const f = await fixture();
  f.clients.matchAll = async () => [
    { ...f.client, url: 'https://foreign.test/#thread=a' },
    { ...f.client, url: 'https://example.test/auth/#thread=a' },
    { ...f.client, url: 'not a URL' },
    { ...f.client, url: 'https://example.test/#thread=a', focus: async () => { throw new Error('closed'); } },
    { ...f.client, url: 'https://example.test/#thread=a', focus: async () => { f.calls.push('match'); return { focused: true }; } },
  ];
  await f.emit('notificationclick', { notification: { close() {}, data: { push: true, threadId: 'a' } } });
  assert.deepEqual(f.calls, ['match', { type: 'open-attention', threadId: 'a' }]);
});

test('push opens a new tab if discovery fails or focus is denied or unconfirmed', async () => {
  for (const mode of ['discovery', 'denied', 'unconfirmed']) {
    const f = await fixture();
    f.clients.matchAll = async () => {
      if (mode === 'discovery') throw new Error('unavailable');
      return [{ ...f.client, url: 'https://example.test/#thread=a', focus: async () => {
        if (mode === 'denied') throw new Error('denied');
        return undefined;
      } }];
    };
    await f.emit('notificationclick', { notification: { close() {}, data: { push: true, threadId: 'a' } } });
    assert.deepEqual(f.calls, ['/#thread=a']);
  }
});

test('live thread wins over stale URL and resolved focus does not require focused snapshot', async () => {
  const f = await fixture();
  f.client.postMessage = (data, ports) => {
    if (data.type === 'query-attention-view') ports?.[0].postMessage({ type: 'attention-view', threadId: 'actual' });
    else f.calls.push(JSON.parse(JSON.stringify(data)));
  };
  f.client.focus = async () => { f.calls.push('focus'); return { focused: false }; };
  await f.emit('notificationclick', { notification: { close() {}, data: { push: true, threadId: 'actual' } } });
  assert.deepEqual(f.calls, ['focus', { type: 'open-attention', threadId: 'actual' }]);
  f.calls.length = 0;
  await f.emit('notificationclick', { notification: { close() {}, data: { push: true, threadId: 'other' } } });
  assert.deepEqual(f.calls, ['/#thread=other'], 'cached URL cannot override live page');
});

test('unresponsive tabs time out and fall back rather than trusting cached URLs', async () => {
  const f = await fixture();
  f.client.postMessage = () => {};
  await f.emit('notificationclick', { notification: { close() {}, data: { push: true, threadId: 'other' } } });
  assert.deepEqual(f.calls, ['/#thread=other']);
});

test('malformed push payloads and invalid destinations fall back to home', async () => {
  const f = await fixture();
  for (const payload of [null, {}, { type: 'attention', threadId: '' }, { type: 'attention', threadId: 42 }, { type: 'attention', threadId: 'x'.repeat(2048) }, { type: 'other', threadId: 'a' }]) {
    await f.emit('push', { data: { json: () => payload } });
    await f.emit('notificationclick', { notification: f.notifications.at(-1) });
    assert.equal(f.calls.at(-1), '/');
  }
  await f.emit('push', { data: { json: () => { throw new Error('invalid JSON'); } } });
  await f.emit('notificationclick', { notification: f.notifications.at(-1) });
  assert.equal(f.calls.at(-1), '/');
  await f.emit('notificationclick', { notification: { close() {}, data: { push: true, threadId: {} } } });
  assert.equal(f.calls.at(-1), '/');
});

test('takeover notification opens the request without approving it', async () => {
  const f = await fixture();
  await f.emit('message', { source: f.client, data: { type: 'show-attention', threadId: 'a', takeover: true } });
  assert.match(f.notifications[0].body, /requests this thread/);
  await f.emit('notificationclick', { notification: f.notifications[0] });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0], 'focus');
  assert.equal(f.calls[1].type, 'open-attention');
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
