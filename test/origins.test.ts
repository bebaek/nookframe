import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedBrowserOrigins } from '../server/origins.js';

test('browser origins default to canonical and explicitly extend it without wildcards', () => {
  assert.deepEqual([...allowedBrowserOrigins('https://main.example')], ['https://main.example']);
  assert.deepEqual([...allowedBrowserOrigins('https://main.example', [' https://fallback.example/ ', 'https://main.example'])],
    ['https://main.example', 'https://fallback.example']);
  for (const value of ['*', 'https://*.example', '', 'null', 'https://user:pass@fallback.example', 'https://fallback.example/path',
    'https://fallback.example?query=1', 'https://fallback.example#fragment', 'http://fallback.example', 'file:///tmp']) {
    assert.throws(() => allowedBrowserOrigins('https://main.example', [value]));
  }
});
