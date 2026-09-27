import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { MailStore, MailError } from '../mail/store.js';
import { MailOAuth, MAIL_SCOPE } from '../mail/oauth.js';
import { renderMbsync } from '../mail/config.js';
import { privateCommand, projectThread } from '../mail/commands.js';
import { Workspace, type Agent } from '../server/workspace.js';
import { createApp } from '../server/http.js';
import * as pty from 'node-pty';

function fixture(scenario: { scope?: string; revoked?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mail-test-'));
  const store = new MailStore(dir);
  let now = Date.now(), calls = 0, email = 'fixture@gmail.com', fail = false;
  const request: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(options?.redirect, 'error');
    if (fail) throw new Error('private-fixture-access-token');
    if (String(url).endsWith('/token')) {
      const fields = options?.body as URLSearchParams;
      assert.equal(fields.get('client_secret'), 'fixture-client-secret');
      if (fields.get('grant_type') === 'authorization_code') assert.ok(fields.get('code_verifier')?.length === 43);
      if (scenario.revoked) return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'private-fixture-token' }), { status: 400 });
      return new Response(JSON.stringify({ access_token: 'private-fixture-access-token', refresh_token: 'private-fixture-refresh-token', expires_in: 3600, scope: scenario.scope ?? `${MAIL_SCOPE} openid email` }));
    }
    assert.equal(String(url), 'https://openidconnect.googleapis.com/v1/userinfo');
    return new Response(JSON.stringify({ email, email_verified: true }));
  };
  const oauth = new MailOAuth(store, 'https://workspace.example', request, () => now);
  return { dir, store, oauth, get calls() { return calls; }, advance() { now += 3600 * 1000; }, wrongAccount() { email = 'different@gmail.com'; }, fail() { fail = true; }, clean() { rmSync(dir, { recursive: true, force: true }); } };
}
async function authorize(oauth: MailOAuth, name = 'personal') {
  const link = await oauth.connect(name);
  const url = new URL(oauth.redirectUri);
  url.searchParams.set('state', new URL(link.authorizationUrl).searchParams.get('state')!);
  url.searchParams.set('code', 'private-fixture-code');
  await oauth.callback(url);
  return url;
}

test('mail OAuth: PKCE, one-use state, private persistence, refresh, aliases, and redacted failures', async () => {
  const f = fixture();
  try {
    await f.oauth.configure('fixture.apps.googleusercontent.com', 'fixture-client-secret');
    assert.equal(statSync(f.store.path('oauth-client.json')).mode & 0o777, 0o600);
    const link = await f.oauth.connect('personal');
    assert.ok(!JSON.stringify(link).includes('fixture-client-secret'));
    assert.equal(new URL(link.authorizationUrl).searchParams.get('code_challenge_method'), 'S256');
    const callback = await authorize(f.oauth);
    assert.equal(f.store.account('personal').polling, false, 'Authorization alone never enables sync');
    assert.equal(statSync(f.store.path('accounts/personal.json')).mode & 0o777, 0o600);
    await assert.rejects(f.oauth.callback(callback), /INVALID_OR_EXPIRED_AUTHORIZATION/);
    const calls = f.calls;
    assert.equal(await f.oauth.accessToken('personal'), 'private-fixture-access-token');
    assert.equal(f.calls, calls, 'Cached access token avoids unnecessary requests');
    f.advance(); await f.oauth.accessToken('personal'); assert.equal(f.calls, calls + 1);
    await assert.rejects(authorize(f.oauth, 'duplicate'), /ACCOUNT_ALREADY_CONNECTED/);
    f.wrongAccount(); await assert.rejects(authorize(f.oauth), /WRONG_ACCOUNT_FOR_ALIAS/);
    assert.equal(f.store.account('personal').email, 'fixture@gmail.com');
    await assert.rejects(f.oauth.connect('../escape'), /INVALID_ACCOUNT_ALIAS/);
    const expired = await f.oauth.connect('secondary'); f.advance();
    await assert.rejects(f.oauth.callback(new URL(`${f.oauth.redirectUri}?state=${new URL(expired.authorizationUrl).searchParams.get('state')}&code=fixture`)), /INVALID_OR_EXPIRED_AUTHORIZATION/);
    f.fail();
    await assert.rejects(authorize(f.oauth, 'secondary'), error => error instanceof MailError && error.code === 'OAUTH_REQUEST_FAILED' && !String(error).includes('private-fixture'));
    assert.ok(readFileSync(f.store.path('accounts/personal.json'), 'utf8').includes('private-fixture-refresh-token'));
  } finally { f.clean(); }
});

test('mail OAuth rejects insufficient scopes/revoked grants; status projection and locks are safe', async () => {
  for (const [options, code] of [[{ scope: 'openid email' }, 'GMAIL_IMAP_SCOPE_REQUIRED'], [{ revoked: true }, 'RECONNECT_ACCOUNT']] as const) {
    const f = fixture(options);
    try {
      await f.oauth.configure('fixture.apps.googleusercontent.com', 'fixture-client-secret');
      await assert.rejects(authorize(f.oauth), new RegExp(code));
      assert.equal(f.store.accounts().length, 0);
      f.store.write(f.store.path('state/personal.json'), { status: 'failed', attemptedAt: new Date().toISOString(), error: 'private-fixture-token', extra: 'private-fixture-token' });
      assert.ok(!JSON.stringify(f.store.status('personal')).includes('private-fixture-token'));
      await f.store.locked('sync', async () => {
        await assert.rejects(f.store.locked('sync', async () => {}), /MAIL_BUSY/);
        await f.store.locked('oauth', async () => {});
      });
    } finally { f.clean(); }
  }
});

test('OAuth client entry is a hidden TTY prompt, never echoed or passed as arguments', { timeout: 10000 }, async () => {
  const f = fixture();
  const terminal = pty.spawn(process.execPath, ['--import', 'tsx', resolve('mail/cli.ts'), 'oauth', 'configure'], {
    cwd: process.cwd(), name: 'xterm-256color', cols: 80, rows: 24,
    env: { ...process.env, MAIL_DIR: f.dir, PUBLIC_ORIGIN: 'https://workspace.example' },
  });
  let output = '', stage = 0;
  const timeout = setTimeout(() => terminal.kill(), 8000);
  terminal.onData(chunk => {
    output += chunk;
    if (stage === 0 && output.includes('client ID (hidden):')) { stage++; terminal.write('fixture.apps.googleusercontent.com\r'); }
    else if (stage === 1 && output.includes('Client secret (hidden):')) { stage++; terminal.write('fixture-client-secret\r'); }
  });
  try {
    const exit = await new Promise<number>(resolve => terminal.onExit(e => resolve(e.exitCode)));
    assert.equal(exit, 0); assert.equal(stage, 2);
    assert.ok(!output.includes('fixture-client-secret') && !output.includes('fixture.apps.googleusercontent.com'));
    assert.equal(f.store.client().clientSecret, 'fixture-client-secret');
  } finally { clearTimeout(timeout); terminal.kill(); f.clean(); }
});

test('mail configuration is pull-only and never embeds OAuth credentials; untrusted mail is bounded', async () => {
  const config = renderMbsync('/tmp/mail dir', { alias: 'personal', email: 'fixture@gmail.com' });
  for (const line of ['Sync Pull New Flags', 'Create Near', 'Remove None', 'Expunge None', 'AuthMechs XOAUTH2', 'SSLType IMAPS']) assert.ok(config.includes(line));
  assert.ok(!/^(Pass |.*Push|.*Expunge (Both|Far))/m.test(config));
  assert.throws(() => renderMbsync('/tmp/mail', { alias: 'personal', email: 'bad\nExpunge Both' }), /INVALID_EMAIL/);
  assert.throws(() => renderMbsync('/tmp/mail\nCreate Far', { alias: 'personal', email: 'fixture@gmail.com' }), /INVALID_MAIL_CONFIG/);
  const body = projectThread([[{ id: 'fixture', headers: { Subject: 'Untrusted subject' }, body: [{ 'content-type': 'text/plain', content: 'x'.repeat(50000) }, { filename: 'do-not-run.sh', 'content-type': 'text/plain', content: 'DO_NOT_EXECUTE' }] }, []]]);
  assert.equal(body.truncated, true); assert.ok(JSON.stringify(body).length < 12000); assert.ok(!JSON.stringify(body).includes('DO_NOT_EXECUTE'));
  await assert.rejects(privateCommand(process.execPath, ['-e', 'process.stderr.write("private-fixture-refresh-token");process.exit(1)']), error => error instanceof MailError && !String(error).includes('private-fixture'));
});

test('OAuth callback needs no browser cookie, strips code from redirect, and returns no credentials', async () => {
  const f = fixture();
  await f.oauth.configure('fixture.apps.googleusercontent.com', 'fixture-client-secret');
  const workspace = new Workspace({ onEvent() { return () => {}; }, async stop() {} } as unknown as Agent, f.dir);
  const app = createApp(workspace, { token: 't'.repeat(64), origin: 'https://workspace.example', webDir: resolve('dist/web'), mail: f.oauth });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const link = await f.oauth.connect('personal');
    const state = new URL(link.authorizationUrl).searchParams.get('state');
    const response = await fetch(`${base}/mail/oauth/callback?state=${state}&code=private-fixture-code`, { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/mail/oauth/result?status=connected');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const result = await (await fetch(base + response.headers.get('location'))).text();
    assert.ok(result.includes('Account connected')); assert.ok(!result.includes('private-fixture'));
  } finally { await app.close(); await workspace.close(); f.clean(); }
});
