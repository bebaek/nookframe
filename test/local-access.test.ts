import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { acceptsLocalRequest, validateLocalAccess } from '../server/local-access.js';

const origin = 'http://localhost:3000';
test('tokenless configuration fails closed', () => {
  validateLocalAccess('127.0.0.1', origin, [origin]);
  for (const host of ['0.0.0.0', '::', 'localhost', '::1']) {
    assert.throws(() => validateLocalAccess(host, origin, [origin]));
  }
  for (const value of ['https://localhost:3000', 'http://example.com', 'http://localhost:3000/path', 'http://user@localhost:3000']) {
    assert.throws(() => validateLocalAccess('127.0.0.1', value, []));
  }
  assert.throws(() => validateLocalAccess('127.0.0.1', origin, ['http://localhost:4000']));
});
test('local requests require exact host, loopback peer and safe browser provenance', () => {
  const request = (headers = {}, remoteAddress = '127.0.0.1') => ({
    headers: { host: 'localhost:3000', ...headers }, socket: { remoteAddress },
  }) as IncomingMessage;
  assert.equal(acceptsLocalRequest(request(), origin), true);
  assert.equal(acceptsLocalRequest(request({ origin, 'sec-fetch-site': 'same-origin' }), origin), true);
  for (const headers of [
    { host: 'attacker.example:3000' }, { host: 'localhost:4000' },
    { origin: 'http://attacker.example' }, { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
    { forwarded: 'for=127.0.0.1' }, { 'x-forwarded-host': 'localhost:3000' },
  ]) assert.equal(acceptsLocalRequest(request(headers), origin), false);
  assert.equal(acceptsLocalRequest(request({}, '192.0.2.1'), origin), false);
});
