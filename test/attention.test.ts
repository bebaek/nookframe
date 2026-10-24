import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionTracker, chatNeedsAttention } from '../web/attention.js';

const thread = (id: string, busy?: boolean) => ({ id, busy, title: 'Private title', updatedAt: 'now' });
test('attention detects each observed run ending once, not history or catalog edits', () => {
  const tracker = new AttentionTracker();
  assert.deepEqual(tracker.update([thread('a', false)]), []);
  assert.deepEqual(tracker.update([thread('a', true), thread('b', true)]), []);
  assert.deepEqual(tracker.update([thread('a', false), thread('b', true)]), ['a']);
  assert.deepEqual(tracker.update([thread('a', false), thread('b', false)]), ['b']);
  assert.deepEqual(tracker.update([thread('a', false)]), []);
  tracker.update([thread('a', true)]);
  tracker.reset();
  assert.deepEqual(tracker.update([thread('a', false)]), [], 'reconnect does not replay stale completions');
  tracker.update([thread('a', true)]);
  assert.deepEqual(tracker.update([]), [], 'deletion is not a completion');
  tracker.update([thread('a', true)]);
  assert.deepEqual(tracker.update([thread('a')]), [], 'missing busy state is not completion');
});

test('only the visible focused selected chat suppresses attention', () => {
  assert.equal(chatNeedsAttention('a', 'a', true, true, true), false);
  assert.equal(chatNeedsAttention('a', 'b', true, true, true), true);
  assert.equal(chatNeedsAttention('a', 'a', false, true, true), true);
  assert.equal(chatNeedsAttention('a', 'a', true, false, true), true);
  assert.equal(chatNeedsAttention('a', 'a', true, true, false), true);
});
