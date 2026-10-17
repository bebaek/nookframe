import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GoogleStore } from '../google/store.js';
import { migrateMail } from '../google/migrate.js';
import { MailStore } from '../mail/store.js';
import { MailOAuth, MAIL_SCOPE } from '../mail/oauth.js';
import { CalendarStore } from '../calendar/store.js';
import { CalendarOAuth, CALENDAR_SCOPES } from '../calendar/oauth.js';

const clientId = 'fixture.apps.googleusercontent.com';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'google-shared-'));
  const google = new GoogleStore(join(root, 'google'));
  const mail = new MailStore(join(root, 'mail'), google);
  const calendar = new CalendarStore(join(root, 'calendar'), google);
  let now = Date.now(), refreshes = 0, scopes = [MAIL_SCOPE, ...CALENDAR_SCOPES], sub = 'user-1', revoked = false;
  const request: typeof fetch = async (url, options) => {
    if (String(url).endsWith('/token')) {
      if ((options?.body as URLSearchParams).get('grant_type') === 'refresh_token') {
        refreshes++;
        if (revoked) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      return Response.json({ access_token: 'private-access', refresh_token: 'private-rotated', expires_in: 3600, scope: scopes.join(' ') });
    }
    return Response.json({ sub, email: 'fixture@example.com', email_verified: true });
  };
  const mailOAuth = new MailOAuth(mail, 'https://workspace.example', request, () => now);
  const calendarOAuth = new CalendarOAuth(calendar, 'https://workspace.example', request, () => now);
  return { root, google, mail, calendar, mailOAuth, calendarOAuth, advance() { now += 3600000; }, get refreshes() { return refreshes; }, calendarOnly() { scopes = [...CALENDAR_SCOPES]; }, wrong() { sub = 'user-2'; }, revoke() { revoked = true; }, clean() { rmSync(root, { recursive: true, force: true }); } };
}
async function authorize(oauth: MailOAuth | CalendarOAuth, alias = 'personal') {
  const link = await oauth.connect(alias);
  const url = new URL(link.authorizationUrl);
  await oauth.callback(new URL(`${oauth.redirectUri}?state=${url.searchParams.get('state')}&code=fixture-code`));
}

test('shared Google client, incremental consent, one credential set and cross-capability refresh lock', async () => {
  const f = fixture();
  try {
    await f.mailOAuth.configure(clientId, 'private-secret');
    assert.equal(f.calendar.client().clientId, clientId, 'client entered once');
    await authorize(f.mailOAuth);
    const consent = new URL((await f.calendarOAuth.connect('personal')).authorizationUrl);
    assert.equal(consent.searchParams.get('include_granted_scopes'), 'true');
    assert.ok(consent.searchParams.get('scope')!.includes(MAIL_SCOPE));
    await authorize(f.calendarOAuth);
    assert.equal(f.google.accounts().length, 1);
    for (const store of [f.mail, f.calendar]) {
      const metadata = readFileSync(store.path('accounts/personal.json'), 'utf8');
      assert.ok(!metadata.includes('private-') && !metadata.includes('refreshToken'));
    }
    f.advance();
    assert.deepEqual(await Promise.all([f.mailOAuth.accessToken('personal'), f.calendarOAuth.accessToken('personal')]), ['private-access', 'private-access']);
    assert.equal(f.refreshes, 1);
    assert.equal(f.mail.account('personal').oauth.refreshToken, 'private-rotated');
    f.wrong(); await assert.rejects(authorize(f.calendarOAuth), /WRONG_ACCOUNT_FOR_ALIAS/);
    f.revoke(); f.advance();
    await assert.rejects(f.mailOAuth.accessToken('personal'), /RECONNECT_ACCOUNT/);
    await assert.rejects(f.calendarOAuth.accessToken('personal'), /RECONNECT_ACCOUNT/);
  } finally { f.clean(); }
});

test('calendar-only consent requests no mail access and refuses duplicate shared identities', async () => {
  const f = fixture();
  try {
    f.calendarOnly(); await f.calendarOAuth.configure(clientId, 'private-secret');
    const consent = new URL((await f.calendarOAuth.connect('personal')).authorizationUrl);
    assert.ok(!consent.searchParams.get('scope')!.includes(MAIL_SCOPE));
    await authorize(f.calendarOAuth);
    assert.deepEqual(f.mail.accounts(), []);
    await assert.rejects(authorize(f.calendarOAuth, 'duplicate'), /ACCOUNT_ALREADY_CONNECTED/);
    await assert.rejects(authorize(f.mailOAuth), /GMAIL_IMAP_SCOPE_REQUIRED/);
    assert.equal(f.google.accounts().length, 1);
  } finally { f.clean(); }
});

test('explicit mail migration preserves state, is restartable and keeps rotated shared tokens', async () => {
  const f = fixture();
  try {
    const legacy = new MailStore(f.mail.root);
    legacy.write(legacy.path('oauth-client.json'), { clientId, clientSecret: 'private-secret', redirectUri: 'https://workspace.example/mail/oauth/callback' });
    legacy.saveAccount({ alias: 'personal', provider: 'gmail', email: 'fixture@example.com', polling: false,
      oauth: { clientId, accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 0 } });
    legacy.write(legacy.path('state/personal.json'), { preserved: true });
    assert.deepEqual((await migrateMail(f.mail.root, f.google)).migrated, ['personal']);
    assert.equal(f.google.account('personal')!.oauth.refreshToken, 'old-refresh');
    assert.equal(existsSync(legacy.path('oauth-client.json')), false);
    assert.equal(f.mail.account('personal').polling, false);
    assert.ok(readFileSync(legacy.path('state/personal.json'), 'utf8').includes('preserved'));
    await f.mailOAuth.accessToken('personal');
    await migrateMail(f.mail.root, f.google);
    assert.equal(f.google.account('personal')!.oauth.refreshToken, 'private-rotated');
    assert.ok(!readFileSync(legacy.path('accounts/personal.json'), 'utf8').includes('refreshToken'));
    await authorize(f.calendarOAuth);
    assert.equal(f.google.account('personal')!.subject, 'user-1');
  } finally { f.clean(); }
});

test('migration refuses active jobs without changing existing credentials', async () => {
  const f = fixture();
  try {
    const legacy = new MailStore(f.mail.root);
    legacy.write(legacy.path('oauth-client.json'), { clientId, clientSecret: 'private-secret', redirectUri: 'https://workspace.example/mail/oauth/callback' });
    legacy.saveAccount({ alias: 'personal', provider: 'gmail', email: 'fixture@example.com', polling: true,
      oauth: { clientId, accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 0 } });
    await assert.rejects(migrateMail(f.mail.root, f.google), /PAUSE_MAIL_JOBS_FIRST/);
    assert.equal(f.google.accounts().length, 0);
    assert.equal(legacy.account('personal').oauth.refreshToken, 'old-refresh');
  } finally { f.clean(); }
});
