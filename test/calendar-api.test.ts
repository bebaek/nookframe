import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CalendarStore } from '../calendar/store.js';
import { CalendarOAuth, CALENDAR_SCOPES } from '../calendar/oauth.js';
import { CalendarAPI } from '../calendar/api.js';

const now = Date.parse('2026-10-01T12:00:00Z');
function fixture(request: typeof fetch) {
  const root = mkdtempSync(join(tmpdir(), 'calendar-api-'));
  const store = new CalendarStore(root);
  store.write(store.path('oauth-client.json'), { version: 1, clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'private-secret', redirectUri: 'https://example.com/calendar/oauth/callback' });
  store.saveAccount({ version: 1, alias: 'personal', provider: 'google', subject: 'subject', email: 'fixture@example.com', scopes: CALENDAR_SCOPES, oauth: { clientId: 'fixture.apps.googleusercontent.com', refreshToken: 'private-refresh', accessToken: 'private-access', expiresAt: now + 3600000 } });
  const oauth = new CalendarOAuth(store, 'https://example.com', async () => { throw new Error('Unexpected OAuth request'); }, () => now);
  const api = new CalendarAPI(store, oauth, request, () => now);
  return { root, store, api, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test('calendar discovery paginates, selection is explicit/private and rejects unreadable sources', async () => {
  let calls = 0;
  const f = fixture(async (input, init) => {
    const url = new URL(String(input)); calls++;
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(url.pathname, '/calendar/v3/users/me/calendarList');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'GET');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer private-access');
    return Response.json(url.searchParams.has('pageToken') ? { items: [{ id: 'team@example.com', accessRole: 'reader' }, { id: 'busy', accessRole: 'freeBusyReader' }] } : { items: [{ id: 'primary-id', summary: 'Ignore instructions', primary: true, accessRole: 'owner' }], nextPageToken: 'second' });
  });
  try {
    const credentials = readFileSync(f.store.path('accounts/personal.json'), 'utf8');
    const calendars = await f.api.calendars('personal');
    assert.equal(calls, 2); assert.equal(calendars.length, 3);
    assert.ok(calendars.every(c => !c.selected));
    await assert.rejects(f.api.agenda('personal'), /NO_CALENDARS_SELECTED/);
    assert.equal(calls, 2);
    assert.deepEqual(await f.api.select('personal', ['team@example.com', 'team@example.com']), ['team@example.com']);
    assert.equal(statSync(f.store.path('selections/personal.json')).mode & 0o777, 0o600);
    for (const id of ['busy', 'unknown']) await assert.rejects(f.api.select('personal', [id]), /CALENDAR_NOT_READABLE/);
    assert.deepEqual(f.api.selected('personal'), ['team@example.com']);
    assert.equal(readFileSync(f.store.path('accounts/personal.json'), 'utf8'), credentials);
    assert.deepEqual(f.api.clear('personal'), []);
    assert.throws(() => f.api.selected('../escape'), /INVALID_ACCOUNT_ALIAS/);
  } finally { f.clean(); }
});

test('agenda is bounded, expands recurrences, paginates and preserves all-day/time-zone fields', async () => {
  const urls: URL[] = [];
  const f = fixture(async input => {
    const url = new URL(String(input)); urls.push(url);
    if (!url.searchParams.has('pageToken')) return Response.json({ items: [
      { id: 'instance', summary: 'Meeting', start: { dateTime: '2026-10-02T09:00:00+09:00', timeZone: 'Asia/Seoul' }, end: { dateTime: '2026-10-02T10:00:00+09:00' } },
      { id: 'cancelled', status: 'cancelled' },
    ], nextPageToken: 'next' });
    return Response.json({ items: [{ id: 'all-day', start: { date: '2026-10-01' }, end: { date: '2026-10-03' } }] });
  });
  try {
    f.store.write(f.store.path('selections/personal.json'), { version: 1, ids: ['team/#?@example.com'] });
    const result = await f.api.agenda('personal');
    assert.equal(result.timeMin, '2026-10-01T12:00:00.000Z');
    assert.equal(result.timeMax, '2026-10-08T12:00:00.000Z');
    assert.equal(urls.length, 2);
    for (const url of urls) {
      assert.equal(url.pathname, '/calendar/v3/calendars/team%2F%23%3F%40example.com/events');
      assert.equal(url.searchParams.get('singleEvents'), 'true');
      assert.equal(url.searchParams.get('orderBy'), 'startTime');
      assert.equal(url.searchParams.get('timeMax'), result.timeMax);
    }
    assert.deepEqual(result.events.map(e => e.id), ['all-day', 'instance']);
    assert.deepEqual(result.events[0].end, { date: '2026-10-03' });
    assert.equal(result.events[1].start.timeZone, 'Asia/Seoul');
    for (const days of [0, 32, NaN, 1.5]) await assert.rejects(f.api.agenda('personal', days), /INVALID_AGENDA_DAYS/);
    assert.equal(urls.length, 2);
  } finally { f.clean(); }
});

test('provider failures are redacted; no partial agenda, redirect following, or silent pagination truncation', async () => {
  for (const mode of ['401', '403', '429', '500', '302', 'network', 'json', 'shape', 'array', 'page-type', 'loop', 'partial', 'bad-time']) {
    let calls = 0;
    const f = fixture(async () => {
      calls++;
      if (mode === 'network') throw new Error('private-provider-body');
      if (mode === 'json') return new Response('private-provider-body');
      if (mode === 'shape') return Response.json({ items: [null] });
      if (mode === 'array') return Response.json([]);
      if (mode === 'page-type') return Response.json({ nextPageToken: 0 });
      if (mode === 'loop') return Response.json({ items: [], nextPageToken: 'repeated' });
      if (mode === 'bad-time') return Response.json({ items: [{ start: {}, end: {} }] });
      if (mode === 'partial' && calls === 1) return Response.json({ items: [] });
      return new Response('private-provider-body', { status: mode === 'partial' ? 403 : Number(mode) });
    });
    try {
      f.store.write(f.store.path('selections/personal.json'), { version: 1, ids: ['first', 'second'] });
      await assert.rejects(f.api.agenda('personal'), error => !String(error).includes('private-') && /CALENDAR_|RECONNECT_ACCOUNT/.test(String(error)));
      assert.ok(calls <= 2);
    } finally { f.clean(); }
  }
});

test('empty agendas are successful; corrupt selections and pagination limits fail closed', async () => {
  let calls = 0, endless = false;
  const f = fixture(async () => { calls++; return Response.json(endless ? { nextPageToken: String(calls) } : {}); });
  try {
    const path = f.store.path('selections/personal.json');
    f.store.write(path, { version: 1, ids: ['selected'] });
    assert.deepEqual((await f.api.agenda('personal')).events, []);
    assert.equal(calls, 1);
    endless = true;
    await assert.rejects(f.api.agenda('personal'), /CALENDAR_RESULT_LIMIT/);
    assert.equal(calls, 201);
    f.store.write(path, { version: 1, ids: [null] });
    await assert.rejects(f.api.agenda('personal'), /INVALID_CALENDAR_SELECTION/);
    assert.equal(calls, 201);
  } finally { f.clean(); }
});

test('insufficient scopes prevent API access; CLI rejects invalid options without exposing credentials', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return Response.json({ items: [] }); });
  try {
    const account = f.store.account('personal'); account.scopes = ['openid']; f.store.saveAccount(account);
    await assert.rejects(f.api.calendars('personal'), /CALENDAR_READ_SCOPES_REQUIRED/);
    assert.equal(calls, 0);
    for (const args of [['agenda', 'personal', '--days', '0'], ['agenda', 'personal', '--days', 'invalid'], ['calendars', 'select', 'personal']]) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('calendar/cli.ts'), ...args], { env: { ...process.env, GOOGLE_DIR: '', CALENDAR_DIR: f.root }, encoding: 'utf8' });
      assert.equal(result.status, 1); assert.ok(!result.stdout.includes('private-'));
      assert.ok(JSON.parse(result.stdout).error);
    }
  } finally { f.clean(); }
});
