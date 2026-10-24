import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/http.js';
import { Workspace, type Agent } from '../server/workspace.js';
import { explainModel } from '../server/operations.js';

test('operations reuse token and cookie auth; reject origins and writes; sanitize failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'operations-'));
  const workspace = new Workspace({ onEvent() { return () => {}; }, async stop() {} } as unknown as Agent, dir);
  const token = 't'.repeat(64);
  const origin = 'http://localhost:3000';
  const app = createApp(workspace, { token, origin, webDir: dir, operations: {
    status: () => ({ slot: 'test' }), config: () => { throw new Error('secret-path-and-token'); }, sessions: () => ({ sessions: [] }),
  } });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const auth = { Authorization: `Bearer ${token}` };
  try {
    assert.equal((await fetch(`${base}/api/operations/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/operations/status`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const status = await fetch(`${base}/api/operations/status`, { headers: auth });
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await status.json(), { slot: 'test' });
    assert.equal((await fetch(`${base}/api/operations/status`, { headers: { ...auth, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/api/operations/status`, { method: 'POST', headers: auth })).status, 405);
    assert.equal((await fetch(`${base}/api/operations/nope`, { headers: auth })).status, 404);
    const failure = await fetch(`${base}/api/operations/config`, { headers: auth });
    assert.equal(failure.status, 503);
    assert.doesNotMatch(await failure.text(), /secret/);
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(`${base}/api/operations/sessions`, { headers: { Cookie: cookie } })).status, 200);
    await fetch(`${base}/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
    assert.equal((await fetch(`${base}/api/operations/sessions`, { headers: { Cookie: cookie } })).status, 401);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('model explanation reports overrides without pretending to describe an active thread', () => {
  const result = explainModel({ source: 'environment', model: { provider: 'provider', id: 'model' } });
  assert.equal(result.environmentLocked, true);
  assert.equal(result.scope, 'instance-default');
  assert.deepEqual(result.selection, { provider: 'provider', id: 'model' });
  assert.equal(explainModel({ source: 'pi' }).selection, null);
});
