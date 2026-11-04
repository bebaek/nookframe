import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushNotifications, validateSubscription } from '../server/push.js';
import type { ThreadChoice } from '../shared/protocol.js';

const subscription = { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/example', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } };
test('push subscription destinations and keys are strictly validated', () => {
  assert.deepEqual(validateSubscription(subscription), subscription);
  for (const endpoint of ['http://updates.push.services.mozilla.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://updates.push.services.mozilla.com.evil.test/x', 'https://user@updates.push.services.mozilla.com/x']) {
    assert.throws(() => validateSubscription({ ...subscription, endpoint }));
  }
  assert.throws(() => validateSubscription({ ...subscription, keys: {} }));
});

test('focused completions are suppressed across devices; different threads still push', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nookframe-push-focus-'));
  const calls: string[] = [];
  const destinations: string[] = [];
  let focused = true;
  try {
    const push = new PushNotifications(dir, 'https://example.test', () => true,
      async (s, payload) => { calls.push(s.endpoint); destinations.push(JSON.parse(String(payload)).threadId); return {} as any; },
      thread => focused && thread === 'a');
    push.subscribe('phone', subscription);
    push.subscribe('desktop', { ...subscription, endpoint: subscription.endpoint + '-desktop' });
    const threads = (a: boolean, b = false) => [{ id: 'a', busy: a }, { id: 'b', busy: b }] as ThreadChoice[];
    push.update(threads(true)); push.update(threads(false));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [], 'same thread focused on any device silences all subscriptions');
    calls.length = 0;
    focused = false;
    push.update(threads(true)); push.update(threads(false));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 2);
    calls.length = 0;
    focused = true;
    push.update(threads(true, true)); push.update(threads(false));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 2, 'only b notifies both devices when a is focused');
    assert.deepEqual(destinations.slice(-2), ['b', 'b']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('push persists keys, isolates sessions, removes expired subscriptions and sends generic completions once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nookframe-push-'));
  const calls: string[] = [];
  const valid = new Set(['one', 'two']);
  const send = async (_s: unknown, payload?: string | Buffer | null) => { calls.push(String(payload)); return {} as any; };
  try {
    const push = new PushNotifications(dir, 'https://example.test', id => valid.has(id), send);
    push.subscribe('one', subscription);
    push.subscribe('two', subscription);
    assert.equal(push.has('one'), false, 'same browser is rebound to the new login');
    assert.equal(new PushNotifications(dir, 'https://example.test', () => true, send).publicKey, push.publicKey);
    assert.equal(statSync(join(dir, 'push.json')).mode & 0o777, 0o600);
    const threads = (busy: boolean) => [{ id: 'private-thread', name: 'Private title', busy }] as unknown as ThreadChoice[];
    push.update(threads(false)); assert.equal(calls.length, 0);
    push.update(threads(true)); push.update(threads(false));
    await new Promise(resolve => setImmediate(resolve));
    push.update(threads(false)); assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0]), { type: 'attention', threadId: 'private-thread' });
    assert.equal(calls[0].includes('Private title'), false);
    valid.clear(); await push.notify();
    assert.equal(push.has('two'), false); assert.equal(calls.length, 1);
    valid.add('one');
    const gone = new PushNotifications(dir, 'https://example.test', id => valid.has(id), async () => { throw { statusCode: 410 }; });
    gone.subscribe('one', subscription); await gone.notify(); assert.equal(gone.has('one'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
