import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MailStore, MailError } from '../mail/store.js';
import { classifyFailure, diagnosticErrorCode } from '../mail/diagnostics.js';
import { MailOAuth, MAIL_SCOPE } from '../mail/oauth.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oauth-lock-'));
  const store = new MailStore(root);
  store.write(store.path('oauth-client.json'), { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-secret', redirectUri: 'https://fixture.example/mail/oauth/callback' });
  for (const alias of ['first', 'second']) store.saveAccount({ alias, provider: 'gmail', email: `${alias}@example.test`, polling: true,
    oauth: { clientId: 'fixture.apps.googleusercontent.com', refreshToken: 'fixture-refresh', accessToken: 'expired', expiresAt: 0 } });
  let calls = 0, active = 0, peak = 0;
  const request: typeof fetch = async () => {
    calls++; active++; peak = Math.max(peak, active);
    await delay(100);
    active--;
    return new Response(JSON.stringify({ access_token: 'fixture-access', refresh_token: 'fixture-rotated', expires_in: 3600, scope: MAIL_SCOPE }));
  };
  const oauth = () => new MailOAuth(new MailStore(root), 'https://fixture.example', request);
  return { root, store, oauth, get calls() { return calls; }, get peak() { return peak; }, clean() { rmSync(root, { recursive: true, force: true }); } };
}

test('simultaneous account refreshes wait rather than fail; credential updates remain serialized', async () => {
  const f = fixture();
  try {
    const results = await Promise.allSettled([f.oauth().accessToken('first'), f.oauth().accessToken('second')]);
    assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled']);
    assert.equal(f.calls, 2);
    assert.equal(f.peak, 1);
    assert.equal(f.store.account('first').oauth.refreshToken, 'fixture-rotated');
    assert.equal(f.store.account('second').oauth.refreshToken, 'fixture-rotated');
  } finally { f.clean(); }
});

test('same-account refresh waiters re-read cache and never duplicate token rotation', async () => {
  const f = fixture();
  try {
    const results = await Promise.allSettled([f.oauth().accessToken('first'), f.oauth().accessToken('first')]);
    assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled']);
    assert.equal(f.calls, 1);
  } finally { f.clean(); }
});

test('OAuth writer contention is bounded and remains a sanitized retryable error', { timeout: 40000 }, async () => {
  const f = fixture();
  try {
    await f.store.locked('oauth', async () => {
      // Ordinary configuration writers still fail fast; helpers alone wait.
      await assert.rejects(new MailStore(f.root).locked('oauth', async () => {}), /MAIL_BUSY/);
      const started = Date.now();
      await assert.rejects(f.oauth().accessToken('first'), error => error instanceof MailError && error.code === 'MAIL_BUSY');
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 29000 && elapsed < 37000, `Bounded wait took ${elapsed}ms`);
      assert.equal(f.calls, 0, 'No token request may escape the credential lock');
    });
    // Released locks work normally; a timed-out waiter leaves no held lock.
    await f.oauth().accessToken('first');
    assert.equal(f.calls, 1);
    const d = classifyFailure({ code: 1 }, 'MAIL_TOKEN_ERROR:MAIL_BUSY private-fixture-secret authentication failed', false, 30100, 21600000);
    assert.equal(d.category, 'busy');
    assert.equal(diagnosticErrorCode(d.category), 'MAIL_BUSY');
    assert.ok(!JSON.stringify(d).includes('private-fixture-secret'));
  } finally { f.clean(); }
});
