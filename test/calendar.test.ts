import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createApp } from '../server/http.js';
import { Workspace, type Agent } from '../server/workspace.js';
import { CalendarStore } from '../calendar/store.js';
import { CalendarOAuth, CALENDAR_SCOPES } from '../calendar/oauth.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-test-'));
  const store = new CalendarStore(dir);
  let now = Date.now(), subject = 'subject-1', scope = CALENDAR_SCOPES.join(' '), fail = false, revoked = false, calls = 0;
  const request: typeof fetch = async (url, options) => {
    assert.equal(options?.redirect, 'error');
    if (fail) throw new Error('private-token');
    if (String(url).endsWith('/token')) {
      calls++;
      const fields = options?.body as URLSearchParams;
      if (fields.get('grant_type') === 'authorization_code') assert.equal(fields.get('code_verifier')?.length, 43);
      if (revoked) return Response.json({ error: 'invalid_grant', detail: 'private-token' }, { status: 400 });
      return Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope });
    }
    return Response.json({ sub: subject, email: 'fixture@example.com', email_verified: true });
  };
  const oauth = new CalendarOAuth(store, 'https://workspace.example', request, () => now);
  return { dir, store, oauth, get calls() { return calls; }, advance() { now += 3600000; }, wrong() { subject = 'subject-2'; }, missingScope() { scope = 'openid email'; }, fail() { fail = true; }, revoke() { revoked = true; }, clean() { rmSync(dir, { recursive: true, force: true }); } };
}
async function callback(oauth: CalendarOAuth, name = 'personal') {
  const link = await oauth.connect(name);
  const authorization = new URL(link.authorizationUrl);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(!authorization.searchParams.get('scope')!.includes('mail.google.com'));
  return new URL(`${oauth.redirectUri}?state=${authorization.searchParams.get('state')}&code=private-code`);
}
async function configure(oauth: CalendarOAuth) { await oauth.configure('fixture.apps.googleusercontent.com', 'private-secret'); }

test('calendar OAuth: private storage, one-use state, identity binding and serialized refresh', async () => {
  const f = fixture();
  try {
    await configure(f.oauth);
    assert.equal(statSync(f.store.path('oauth-client.json')).mode & 0o777, 0o600);
    const url = await callback(f.oauth); await f.oauth.callback(url);
    assert.equal(f.store.account('personal').subject, 'subject-1');
    assert.equal(statSync(f.store.path('accounts/personal.json')).mode & 0o777, 0o600);
    await assert.rejects(f.oauth.callback(url), /INVALID_OR_EXPIRED/);
    await assert.rejects(f.oauth.callback(await callback(f.oauth, 'duplicate')), /ACCOUNT_ALREADY_CONNECTED/);
    f.wrong(); await assert.rejects(f.oauth.callback(await callback(f.oauth)), /WRONG_ACCOUNT_FOR_ALIAS/);
    assert.equal(f.store.account('personal').subject, 'subject-1');
    f.advance(); const before = f.calls;
    assert.deepEqual(await Promise.all([f.oauth.accessToken('personal'), f.oauth.accessToken('personal')]), ['private-access', 'private-access']);
    assert.equal(f.calls, before + 1);
    const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('calendar/cli.ts'), 'account', 'status'], { env: { ...process.env, CALENDAR_DIR: f.dir }, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.ok(!result.stdout.includes('private-'));
    assert.equal(JSON.parse(result.stdout).accounts[0].status, 'authorization_stored');
    f.revoke(); f.advance(); await assert.rejects(f.oauth.accessToken('personal'), /RECONNECT_ACCOUNT/);
  } finally { f.clean(); }
});

test('calendar OAuth rejects expired, duplicate, denied, reconfigured and insufficient grants', async () => {
  const f = fixture();
  try {
    await configure(f.oauth);
    const expired = await callback(f.oauth); f.advance();
    await assert.rejects(f.oauth.callback(expired), /INVALID_OR_EXPIRED/);
    const duplicate = await callback(f.oauth); duplicate.searchParams.append('state', duplicate.searchParams.get('state')!);
    await assert.rejects(f.oauth.callback(duplicate), /INVALID_OR_EXPIRED/);
    const denied = await callback(f.oauth); denied.searchParams.set('error', 'access_denied');
    await assert.rejects(f.oauth.callback(denied), /AUTHORIZATION_DENIED/);
    const old = await callback(f.oauth); await configure(f.oauth);
    await assert.rejects(f.oauth.callback(old), /INVALID_OR_EXPIRED/);
    f.missingScope(); await assert.rejects(f.oauth.callback(await callback(f.oauth)), /CALENDAR_READ_SCOPES_REQUIRED/);
    assert.equal(f.store.accounts().length, 0);
    f.fail(); await assert.rejects(f.oauth.callback(await callback(f.oauth)), error => String(error).includes('OAUTH_REQUEST_FAILED') && !String(error).includes('private-token'));
    assert.throws(() => f.oauth.connect('../escape'), /INVALID_ACCOUNT_ALIAS/);
  } finally { f.clean(); }
});

test('calendar HTTP callback needs no cookie and redirects without secrets', async () => {
  const f = fixture();
  const agent = { onEvent() { return () => {}; } } as unknown as Agent;
  const workspace = new Workspace(agent, f.dir);
  const app = createApp(workspace, { token: 'a'.repeat(64), origin: 'https://workspace.example', webDir: resolve('dist/web'), calendar: f.oauth });
  try {
    await configure(f.oauth);
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const address = app.server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const url = await callback(f.oauth);
    const response = await fetch(base + url.pathname + url.search, { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/calendar/oauth/result?status=connected');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const replay = await fetch(base + url.pathname + url.search, { redirect: 'manual' });
    assert.match(replay.headers.get('location')!, /INVALID_OR_EXPIRED_AUTHORIZATION/);
    const result = await fetch(base + '/calendar/oauth/result?status=private-token');
    assert.ok(!(await result.text()).includes('private-token'));
  } finally { await app.close(); f.clean(); }
});

test('calendar configuration is TTY-only and HTTP origins must be secure', () => {
  const f = fixture();
  try {
    assert.throws(() => new CalendarOAuth(f.store, 'http://example.com'), /HTTPS_ORIGIN_REQUIRED/);
    const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('calendar/cli.ts'), 'oauth', 'configure'], { env: { ...process.env, CALENDAR_DIR: f.dir }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error, 'PRIVATE_TERMINAL_REQUIRED');
    assert.throws(() => f.store.client(), /OAUTH_CLIENT_NOT_CONFIGURED/);
  } finally { f.clean(); }
});
