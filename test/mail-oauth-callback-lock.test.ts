import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MailStore } from '../mail/store.js';
import { MailOAuth, MAIL_SCOPE } from '../mail/oauth.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(firstGrant: string) {
  const root = mkdtempSync(join(tmpdir(), 'oauth-callback-lock-'));
  const store = new MailStore(root), entered = deferred(), release = deferred();
  store.write(store.path('oauth-client.json'), { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-secret', redirectUri: 'https://fixture.example/mail/oauth/callback' });
  store.saveAccount({ alias: 'personal', provider: 'gmail', email: 'fixture@example.test', polling: true,
    oauth: { clientId: 'fixture.apps.googleusercontent.com', refreshToken: 'original-refresh', accessToken: 'expired', expiresAt: 0 } });
  const grants: string[] = [];
  const request: typeof fetch = async (url, options) => {
    if (String(url).endsWith('/userinfo')) return new Response(JSON.stringify({ email: 'fixture@example.test', email_verified: true }));
    const grant = (options!.body as URLSearchParams).get('grant_type')!;
    grants.push(grant);
    if (grant === firstGrant) { entered.resolve(); await release.promise; }
    return new Response(JSON.stringify({ access_token: grant === 'refresh_token' ? 'refreshed-access' : 'consent-access',
      ...(grant === 'refresh_token' ? { refresh_token: 'rotated-refresh' } : {}), expires_in: 3600, scope: MAIL_SCOPE }));
  };
  const oauth = () => new MailOAuth(new MailStore(root), 'https://fixture.example', request);
  const callbackUrl = async () => {
    const link = await oauth().connect('personal');
    const url = new URL('https://fixture.example/mail/oauth/callback');
    url.searchParams.set('state', new URL(link.authorizationUrl).searchParams.get('state')!);
    url.searchParams.set('code', 'fixture-code');
    return url;
  };
  return { store, oauth, callbackUrl, grants, entered, release, clean: () => rmSync(root, { recursive: true, force: true }) };
}

for (const firstGrant of ['authorization_code', 'refresh_token']) {
  test(`consent and refresh serialize safely with ${firstGrant} first`, { timeout: 10000 }, async () => {
    const f = fixture(firstGrant);
    const pending: Promise<unknown>[] = [];
    try {
      const url = await f.callbackUrl();
      const consent = () => f.oauth().callback(url);
      const refresh = () => f.oauth().accessToken('personal');
      pending.push(firstGrant === 'authorization_code' ? consent() : refresh());
      await f.entered.promise;
      pending.push(firstGrant === 'authorization_code' ? refresh() : consent());
      await delay(50);
      assert.deepEqual(f.grants, [firstGrant], 'The second operation cannot exchange tokens while the first holds credentials');
      await assert.rejects(f.store.withAccountCredentialLock('personal', async () => {
        const account = f.store.account('personal'); account.polling = false; f.store.saveAccount(account);
      }), /MAIL_BUSY/);
      f.release.resolve();
      await Promise.all(pending);
      const saved = f.store.account('personal');
      assert.equal(saved.polling, true, 'Rejected polling updates do not mutate state');
      assert.equal(saved.oauth.accessToken, 'consent-access');
      assert.equal(saved.oauth.refreshToken, firstGrant === 'refresh_token' ? 'rotated-refresh' : 'original-refresh');
      assert.deepEqual(f.grants, firstGrant === 'refresh_token' ? ['refresh_token', 'authorization_code'] : ['authorization_code']);
      await f.store.withAccountCredentialLock('personal', async () => {
        const account = f.store.account('personal'); account.polling = false; f.store.saveAccount(account);
      });
      assert.equal(f.store.account('personal').polling, false);
      assert.deepEqual(f.store.account('personal').oauth, saved.oauth, 'Later settings updates preserve newly authorized credentials');
    } finally { f.release.resolve(); await Promise.allSettled(pending); f.clean(); }
  });
}

test('consent re-reads polling settings changed while waiting for the credential lock', { timeout: 10000 }, async () => {
  const f = fixture('unused');
  let consent: Promise<void> | undefined;
  try {
    const url = await f.callbackUrl();
    await f.store.withAccountCredentialLock('personal', async () => {
      consent = f.oauth().callback(url);
      await delay(50);
      assert.deepEqual(f.grants, []);
      const account = f.store.account('personal'); account.polling = false; f.store.saveAccount(account);
    });
    await consent;
    assert.equal(f.store.account('personal').polling, false);
    assert.equal(f.store.account('personal').oauth.accessToken, 'consent-access');
  } finally { if (consent) await Promise.allSettled([consent]); f.clean(); }
});
