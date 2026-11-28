import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createApp } from '../server/http.js';
import { Workspace, type Agent } from '../server/workspace.js';
import { GoogleStore } from '../google/store.js';
import { CalendarStore } from '../calendar/store.js';
import { CalendarOAuth, CONTACTS_READ_SCOPE, CONTACTS_WRITE_SCOPE, CALENDAR_WRITE_SCOPE } from '../calendar/oauth.js';
import { searchContacts } from '../contacts/search.js';

test('contacts requires separate enrollment for an existing shared identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'contacts-'));
  try {
    const google = new GoogleStore(root), store = new CalendarStore(join(root, 'contacts'), google);
    const clientId = 'fixture.apps.googleusercontent.com';
    google.configure({ clientId, clientSecret: 'fixture-secret' });
    google.save({ version: 1, alias: 'one', subject: 'one', email: 'one@example.com', scopes: [], oauth: { clientId, refreshToken: 'old', accessToken: 'old', expiresAt: 1 } });
    let scope = '', sub = 'two';
    const oauth = new CalendarOAuth(store, 'https://example.org', async url => String(url).endsWith('/token') ? Response.json({ scope, access_token: 'ok', expires_in: 3600 }) : Response.json({ sub, email: 'one@example.com', email_verified: true }), Date.now, 'contacts');
    await assert.rejects(oauth.connect('other'), /EXISTING_GOOGLE_ACCOUNT_REQUIRED/);
    await assert.rejects(oauth.accessToken('one'), /ACCOUNT_NOT_CONNECTED/);
    const consent = async () => {
      const u = new URL((await oauth.connect('one')).authorizationUrl);
      assert.equal(u.searchParams.get('redirect_uri'), 'https://example.org/calendar/oauth/callback');
      assert.deepEqual(u.searchParams.get('scope')!.split(' '), [CONTACTS_READ_SCOPE, 'openid', 'email']);
      return oauth.callback(new URL(oauth.redirectUri + '?code=fixture&state=' + u.searchParams.get('state')));
    };
    await assert.rejects(consent(), /CONTACTS_READ_SCOPE_REQUIRED/);
    scope = CONTACTS_READ_SCOPE; await assert.rejects(consent(), /WRONG_ACCOUNT_FOR_ALIAS/);
    sub = 'one';
    const calendar = new CalendarOAuth(new CalendarStore(join(root, 'calendar'), google), 'https://example.org');
    const workspace = new Workspace({ onEvent: () => () => {} } as unknown as Agent, root);
    const app = createApp(workspace, { token: 'a'.repeat(64), origin: 'https://example.org', webDir: root, contacts: oauth, calendar });
    try {
      app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
      const addr = app.server.address(); assert.ok(addr && typeof addr !== 'string');
      const state = new URL((await oauth.connect('one')).authorizationUrl).searchParams.get('state')!;
      assert.match(state, /^contacts\.[A-Za-z0-9_-]{43}$/);
      const route = async (s: string) => (await fetch(`http://127.0.0.1:${addr.port}/calendar/oauth/callback?code=fixture&state=${s}`, { redirect: 'manual' })).headers.get('location');
      assert.equal(await route(state.slice('contacts.'.length)), '/calendar/oauth/result?status=INVALID_OR_EXPIRED_AUTHORIZATION');
      assert.equal(await route(state), '/contacts/oauth/result?status=connected');
      assert.equal(await route(state), '/contacts/oauth/result?status=INVALID_OR_EXPIRED_AUTHORIZATION');
      assert.equal(await oauth.accessToken('one'), 'ok');
      await assert.rejects(oauth.accessToken('one', true), /CONTACTS_WRITE_SCOPE_REQUIRED/);
      const requestWrite = async () => {
        const u = new URL((await oauth.connect('one', true)).authorizationUrl);
        const requested = u.searchParams.get('scope')!.split(' ');
        assert.ok(requested.includes(CONTACTS_WRITE_SCOPE)); assert.ok(!requested.includes(CALENDAR_WRITE_SCOPE));
        return route(u.searchParams.get('state')!);
      };
      assert.equal(await requestWrite(), '/contacts/oauth/result?status=CONTACTS_WRITE_SCOPE_REQUIRED');
      scope = CONTACTS_WRITE_SCOPE;
      assert.equal(await requestWrite(), '/contacts/oauth/result?status=connected');
      assert.equal(await oauth.accessToken('one', true), 'ok');
    } finally { await app.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('search warms the cache then returns only names and email addresses', async () => {
  const queries: string[] = [];
  const result = await searchContacts('Pat & Lee', async () => 'fixture', async (url, init) => {
    const u = new URL(String(url)); assert.equal(u.origin + u.pathname, 'https://people.googleapis.com/v1/people:searchContacts');
    assert.equal(init?.method ?? 'GET', 'GET'); assert.equal(init?.redirect, 'error');
    queries.push(u.searchParams.get('query')!);
    return Response.json({ results: [{ person: { names: [{ displayName: 'Pat' }], emailAddresses: [{ value: 'pat@example.com' }], private: true } }] });
  });
  assert.deepEqual(queries, ['', 'Pat & Lee']);
  assert.deepEqual(result.results, [{ names: ['Pat'], emails: ['pat@example.com'] }]);
  await assert.rejects(searchContacts(' ', async () => { throw Error(); }), /INVALID_CONTACT_QUERY/);
  await assert.rejects(searchContacts('Pat', async () => 'fixture', async () => new Response('private', { status: 403 })), /CONTACTS_ACCESS_DENIED/);
});
