import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PushFocus } from '../server/push-focus.js';

test('push focus is connection-, session-, and conversation-scoped and expires', () => {
  let now = 0;
  const focus = new PushFocus(() => now);
  const a = {}, b = {};
  focus.update(a, 'phone', 'chat-a', true);
  assert.equal(focus.has('phone', 'chat-a'), true);
  assert.equal(focus.has('desktop', 'chat-a'), false);
  assert.equal(focus.has('phone', 'chat-b'), false);
  focus.update(b, 'phone', 'chat-a', false);
  assert.equal(focus.has('phone', 'chat-a'), true, 'background tab cannot clear another tab');
  focus.update(a, 'phone', 'chat-a', false);
  assert.equal(focus.has('phone', 'chat-a'), false, 'blur clears immediately');
  focus.update(a, 'phone', 'chat-b', true);
  now = 44000;
  assert.equal(focus.has('phone', 'chat-b'), true);
  focus.update(a, 'phone', 'chat-b', true);
  now = 45000;
  assert.equal(focus.has('phone', 'chat-b'), true, 'heartbeat renews lease');
  now = 89000;
  assert.equal(focus.has('phone', 'chat-b'), false, 'suspended tab expires');
  focus.update(a, 'phone', 'chat-a', true);
  focus.remove(a);
  assert.equal(focus.has('phone', 'chat-a'), false, 'disconnect clears lease');
});
