import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('different account refreshes overlap and do not acquire the global OAuth control lock', async () => {
  const f = fixture();
  try {
    await f.store.locked('oauth', async () => {
      const results = await Promise.allSettled([f.oauth().accessToken('first'), f.oauth().accessToken('second')]);
      assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled']);
    });
    assert.equal(f.calls, 2);
    assert.equal(f.peak, 2);
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

test('same-account credential contention is bounded and remains a sanitized retryable error', { timeout: 40000 }, async () => {
  const f = fixture();
  try {
    await f.store.withAccountCredentialLock('first', async () => {
      // Ordinary account-setting writers fail fast; token helpers wait.
      await assert.rejects(new MailStore(f.root).withAccountCredentialLock('first', async () => {}), /MAIL_BUSY/);
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

test('shared configuration changes require paused and drained accounts and release partial locks', async () => {
  const f = fixture();
  try {
    const original = f.store.client();
    await assert.rejects(f.oauth().configure(original.clientId, 'replacement-secret'), /PAUSE_MAIL_JOBS_FIRST/);
    const changedOrigin = new MailOAuth(new MailStore(f.root), 'https://changed.example');
    await assert.rejects(changedOrigin.migrateCallback(), /PAUSE_MAIL_JOBS_FIRST/);
    await f.store.withAccountSyncLock('first', () => f.store.withAccountCredentialLock('first', async () => {
      assert.deepEqual(await f.oauth().migrateCallback(), { updated: false, callbackUrl: original.redirectUri });
    }));
    await f.store.locked('oauth', async () => {
      await assert.rejects(f.oauth().migrateCallback(), /MAIL_BUSY/, 'Even a no-op coordinates with configuration writers');
    });
    assert.deepEqual(f.store.client(), original);
    for (const account of f.store.accounts()) { account.polling = false; f.store.saveAccount(account); }
    await f.store.withAccountSyncLock('first', async () => {
      await assert.rejects(f.oauth().configure(original.clientId, 'replacement-secret'), /MAIL_BUSY/);
    });
    await f.store.withAccountCredentialLock('second', async () => {
      await assert.rejects(f.oauth().configure(original.clientId, 'replacement-secret'), /MAIL_BUSY/);
      assert.equal(await f.store.accountSyncLocked('first'), false);
      assert.equal(await f.store.accountSyncLocked('second'), false);
      await f.store.withAccountCredentialLock('first', async () => {});
    });
    assert.deepEqual(f.store.client(), original);
    await f.store.withOAuthConfigurationLock(async () => {
      for (const name of ['first', 'second']) {
        assert.equal(await f.store.accountSyncLocked(name), true);
        await assert.rejects(f.store.withAccountCredentialLock(name, async () => {}), /MAIL_BUSY/);
      }
      await assert.rejects(f.oauth().connect('third'), /MAIL_BUSY/);
    });
    await f.oauth().configure(original.clientId, 'replacement-secret');
    assert.equal(f.store.client().clientSecret, 'replacement-secret');
    assert.equal(await f.store.accountSyncLocked('first'), false);
  } finally { f.clean(); }
});

test('CLI account-setting writers use account locks across processes', async () => {
  const f = fixture();
  const cli = (...args: string[]) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('mail/cli.ts'), ...args], {
      env: { ...process.env, MAIL_DIR: f.root, PUBLIC_ORIGIN: 'https://fixture.example' }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.error, undefined);
    return { status: result.status, body: JSON.parse(result.stdout) };
  };
  try {
    await f.store.withAccountCredentialLock('first', async () => {
      for (const args of [['jobs', 'pause', 'first'], ['account', 'disable', 'first']]) {
        assert.deepEqual(cli(...args), { status: 1, body: { error: 'MAIL_BUSY' } });
      }
      assert.equal(cli('jobs', 'pause', 'second').status, 0);
      assert.equal(f.store.account('first').polling, true);
      assert.equal(f.store.account('second').polling, false);
    });
    assert.equal(cli('jobs', 'pause', 'first').status, 0);
    assert.equal(f.store.account('first').polling, false);
  } finally { f.clean(); }
});

test('refresh waiter re-reads account settings after credential lock acquisition', async () => {
  const f = fixture();
  let waiter: Promise<string> | undefined;
  try {
    await f.store.withAccountCredentialLock('first', async () => {
      waiter = f.oauth().accessToken('first');
      await delay(30);
      const account = f.store.account('first');
      account.polling = false;
      f.store.saveAccount(account);
      // The other account can refresh even while this account is held.
      await f.oauth().accessToken('second');
    });
    await waiter;
    assert.equal(f.store.account('first').polling, false);
    assert.equal(f.store.account('first').oauth.refreshToken, 'fixture-rotated');
  } finally { await waiter; f.clean(); }
});
