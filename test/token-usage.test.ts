import assert from 'node:assert/strict';
import test from 'node:test';
import { recordUsage, cachedShare } from '../shared/token-usage.js';

test('cached share weights tokens including cache writes, not calls', () => {
  const first = recordUsage(undefined, { input: 10, cacheRead: 0, cacheWrite: 10, output: 100 });
  const next = recordUsage(first, { input: 0, cacheRead: 80, cacheWrite: 0, output: 5 });
  assert.equal(next.calls, 2);
  assert.equal(cachedShare(next.total), '80.0%');
  assert.equal(cachedShare(next.last), '100.0%');
  assert.equal(next.total.output, 105);
});

test('partial reports never masquerade as complete totals', () => {
  const first = recordUsage(undefined, { output: 0 });
  const next = recordUsage(first, { input: 0, cacheRead: 0, cacheWrite: 0, output: 2 });
  assert.equal(cachedShare(next.total), 'Not reported');
  assert.equal(cachedShare(next.last), 'No input');
  assert.equal(next.total.output, 2);
});
