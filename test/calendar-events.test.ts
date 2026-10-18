import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CalendarStore, CalendarError } from '../calendar/store.js';
import { CalendarEvents } from '../calendar/events.js';
import { CalendarOAuth, CALENDAR_SCOPES, CALENDAR_WRITE_SCOPE } from '../calendar/oauth.js';
const input = { summary: 'Appointment', start: { dateTime: '2026-11-02T09:00:00-06:00', timeZone: 'America/Chicago' }, end: { dateTime: '2026-11-02T10:00:00-06:00', timeZone: 'America/Chicago' } };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'calendar-events-')); const store = new CalendarStore(root);
  store.write(store.path('oauth-client.json'), { version: 1, clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'private-secret', redirectUri: 'https://example.com/calendar/oauth/callback' });
  store.saveAccount({ version: 1, alias: 'personal', provider: 'google', subject: 'subject', email: 'fixture@example.com', scopes: [...CALENDAR_SCOPES, CALENDAR_WRITE_SCOPE], oauth: { clientId: 'fixture.apps.googleusercontent.com', refreshToken: 'private-refresh', accessToken: 'private-access', expiresAt: Date.now() + 3600000 } });
  let now = Date.now(), role = 'owner', mode = 'ok', mutations = 0;
  let target: any = { id: 'event', etag: '"v1"', organizer: { self: true }, ...input };
  const requests: { url: string; init?: RequestInit }[] = [];
  const oauth = new CalendarOAuth(store, 'https://example.com', async () => { throw new Error('No refresh expected'); });
  const api = new CalendarEvents(store, oauth, async (url, init) => {
    requests.push({ url: String(url), init });
    assert.equal(init?.redirect, 'error');
    if (init?.method === 'GET') return Response.json(String(url).includes('calendarList') ? { id: 'owned', accessRole: role } : target);
    mutations++;
    // Durable submission must exist before the external side effect.
    const submitted = readdirSync(store.path('operations')).map(p => JSON.parse(readFileSync(store.path('operations', p), 'utf8'))).filter(op => op.status === 'submitting');
    assert.equal(submitted.length, 1);
    if (mode === 'network') throw new Error('private-provider-error');
    if (mode === 'conflict') return new Response('private-provider-error', { status: 412 });
    if (mode === 'server') return new Response('private-provider-error', { status: 503 });
    if (mode === 'bad-json') return new Response('private-provider-error');
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ id: init?.method === 'POST' ? JSON.parse(String(init.body)).id : 'event' });
  }, () => now);
  return { root, store, api, requests, get mutations() { return mutations; }, mode(v: string) { mode = v; }, role(v: string) { role = v; }, target(v: any) { target = { ...target, ...v }; }, advance() { now += 900001; }, clean() { rmSync(root, { recursive: true, force: true }); } };
}

test('writes require separate consent and owned-calendar enablement; preparing never mutates', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.api.prepare('personal', 'owned', 'create', undefined, input), /WRITES_NOT_ENABLED/);
    f.role('writer'); await assert.rejects(f.api.enable('personal', 'owned'), /OWNED_CALENDAR_REQUIRED/);
    f.role('owner');
    const account = f.store.account('personal'); account.scopes = CALENDAR_SCOPES; f.store.saveAccount(account);
    await assert.rejects(f.api.enable('personal', 'owned'), /WRITE_SCOPE_REQUIRED/);
    account.scopes = [...CALENDAR_SCOPES, CALENDAR_WRITE_SCOPE]; f.store.saveAccount(account);
    await f.api.enable('personal', 'owned');
    const op = await f.api.prepare('personal', 'owned', 'create', undefined, input);
    assert.equal(f.mutations, 0); assert.equal(op.status, 'ready');
    assert.equal(statSync(f.store.path('operations', op.id + '.json')).mode & 0o777, 0o600);
    await assert.rejects(f.api.apply(op.id, 'wrong'), /CONFIRMATION_MISMATCH/);
    await f.api.disable('personal', 'owned');
    await assert.rejects(f.api.apply(op.id, op.confirmation), /WRITES_NOT_ENABLED/);
    assert.equal(f.mutations, 0);
  } finally { f.clean(); }
});

test('create/update/delete use confirmed immutable previews, durable outcomes and conditional writes', async () => {
  const f = fixture();
  try {
    await f.api.enable('personal', 'owned');
    for (const action of ['create', 'update', 'delete'] as const) {
      const op = await f.api.prepare('personal', 'owned', action, 'event', action === 'create' ? input : { summary: 'Changed' });
      assert.equal((await f.api.apply(op.id, op.confirmation)).status, 'complete');
      const request = f.requests.at(-1)!;
      assert.ok(request.url.endsWith('?sendUpdates=none'));
      assert.equal(request.init?.method, { create: 'POST', update: 'PATCH', delete: 'DELETE' }[action]);
      if (action !== 'create') assert.equal((request.init?.headers as any)['If-Match'], '"v1"');
      else assert.equal(JSON.parse(String(request.init?.body)).id, op.eventId);
      await assert.rejects(f.api.apply(op.id, op.confirmation), /ALREADY_ATTEMPTED/);
    }
    assert.equal(f.mutations, 3);
  } finally { f.clean(); }
});

test('uncertain and rejected submissions cannot be blindly retried, including after restart', async () => {
  for (const mode of ['network', 'conflict', 'server', 'bad-json']) {
    const f = fixture();
    try {
      await f.api.enable('personal', 'owned'); const op = await f.api.prepare('personal', 'owned', 'create', undefined, input);
      f.mode(mode); await assert.rejects(f.api.apply(op.id, op.confirmation), error => /OPERATION_/.test(String(error)) && !String(error).includes('private-'));
      assert.equal(f.api.status(op.id).status, mode === 'conflict' ? 'rejected' : 'unknown');
      const restarted = new CalendarEvents(new CalendarStore(f.root), { accessToken: async () => { throw new Error('Must not refresh'); } });
      await assert.rejects(restarted.apply(op.id, op.confirmation), /ALREADY_ATTEMPTED/);
      assert.equal(f.mutations, 1);
    } finally { f.clean(); }
  }
});

test('changed events, stale previews and changed identities block submission', async () => {
  for (const mode of ['etag', 'expired', 'identity', 'tampered', 'submitting', 'scope', 'owner', 'attendees']) {
    const f = fixture();
    try {
      await f.api.enable('personal', 'owned'); const op = await f.api.prepare('personal', 'owned', 'delete', 'event');
      if (mode === 'etag') f.target({ etag: '"v2"' });
      if (mode === 'expired') f.advance();
      if (mode === 'scope') { const a = f.store.account('personal'); a.scopes = CALENDAR_SCOPES; f.store.saveAccount(a); }
      if (mode === 'owner') f.role('writer');
      if (mode === 'attendees') f.target({ attendees: [{}] });
      if (mode === 'identity') { const a = f.store.account('personal'); a.subject = 'other'; f.store.saveAccount(a); }
      if (mode === 'tampered') { op.eventId = 'other'; f.store.write(f.store.path('operations', op.id + '.json'), op); }
      if (mode === 'submitting') { op.status = 'submitting'; f.store.write(f.store.path('operations', op.id + '.json'), op); }
      await assert.rejects(f.api.apply(op.id, op.confirmation)); assert.equal(f.mutations, 0);
    } finally { f.clean(); }
  }
});

test('attendees, recurrence, special events and foreign organizers are excluded', async () => {
  for (const extra of [{ attendees: [{ email: 'guest@example.com' }] }, { attendeesOmitted: true }, { recurrence: ['RRULE:FREQ=DAILY'] }, { recurringEventId: 'series' }, { originalStartTime: {} }, { eventType: 'outOfOffice' }, { organizer: { self: false } }, { conferenceData: {} }, { locked: true }]) {
    const f = fixture();
    try {
      await f.api.enable('personal', 'owned'); f.target(extra);
      await assert.rejects(f.api.prepare('personal', 'owned', 'delete', 'event'), /UNSUPPORTED_EVENT_FOR_WRITE/);
      assert.equal(f.mutations, 0);
    } finally { f.clean(); }
  }
});

test('event fields and time zones validate strictly, including DST gaps and all-day end dates', async () => {
  const f = fixture();
  try {
    await f.api.enable('personal', 'owned');
    for (const invalid of [{ ...input, attendees: [] }, { ...input, recurrence: [] }, { ...input, summary: '' }, { ...input, end: input.start }, { ...input, start: { dateTime: '2026-03-08T02:30:00-06:00', timeZone: 'America/Chicago' } }, { ...input, start: { date: '2026-02-30' } }]) await assert.rejects(f.api.prepare('personal', 'owned', 'create', undefined, invalid));
    const op = await f.api.prepare('personal', 'owned', 'create', undefined, { summary: 'Day off', start: { date: '2026-11-02' }, end: { date: '2026-11-03' } });
    assert.deepEqual(op.after?.end, { date: '2026-11-03' });
    assert.equal(f.mutations, 0);
  } finally { f.clean(); }
});

test('concurrent applies submit once; persistence failures fail closed', async () => {
  const f = fixture();
  try {
    await f.api.enable('personal', 'owned');
    const op = await f.api.prepare('personal', 'owned', 'create', undefined, input);
    const results = await Promise.allSettled([f.api.apply(op.id, op.confirmation), f.api.apply(op.id, op.confirmation)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(f.mutations, 1);
    const blocked = await f.api.prepare('personal', 'owned', 'create', undefined, input);
    const original = f.store.write.bind(f.store);
    f.store.write = (path, value: any) => { if (value.status === 'submitting') throw new Error('disk full'); original(path, value); };
    await assert.rejects(f.api.apply(blocked.id, blocked.confirmation));
    assert.equal(f.mutations, 1);
    assert.equal(f.api.status(blocked.id).status, 'ready');
    f.store.write = (path, value: any) => { if (['complete', 'unknown'].includes(value.status)) throw new Error('disk full'); original(path, value); };
    await assert.rejects(f.api.apply(blocked.id, blocked.confirmation), /OUTCOME_UNKNOWN/);
    assert.equal(f.mutations, 2);
    assert.equal(f.api.status(blocked.id).status, 'submitting');
    await assert.rejects(f.api.apply(blocked.id, blocked.confirmation), /ALREADY_ATTEMPTED/);
  } finally { f.clean(); }
});

test('title-only edits preserve provider times without timeZone', async () => {
  const f = fixture();
  try {
    await f.api.enable('personal', 'owned');
    f.target({ start: { dateTime: '2026-11-02T09:00:00-06:00' }, end: { dateTime: '2026-11-02T10:00:00-06:00' } });
    const op = await f.api.prepare('personal', 'owned', 'update', 'event', { summary: 'New title' });
    await f.api.apply(op.id, op.confirmation);
    assert.deepEqual(JSON.parse(String(f.requests.at(-1)!.init?.body)), { summary: 'New title' });
  } finally { f.clean(); }
});

test('write scope is requested only explicitly and missing write consent is not fabricated', async () => {
  const f = fixture();
  try {
    const plain = new CalendarStore(join(f.root, 'standalone'));
    let scope = CALENDAR_SCOPES.join(' ');
    const oauth = new CalendarOAuth(plain, 'https://example.com', async url => String(url).endsWith('/token') ? Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope }) : Response.json({ sub: 'subject', email: 'fixture@example.com', email_verified: true }));
    await oauth.configure('fixture.apps.googleusercontent.com', 'secret');
    assert.ok(!new URL((await oauth.connect('personal')).authorizationUrl).searchParams.get('scope')!.includes(CALENDAR_WRITE_SCOPE));
    const url = new URL((await oauth.connect('personal', true)).authorizationUrl);
    assert.ok(url.searchParams.get('scope')!.includes(CALENDAR_WRITE_SCOPE));
    await assert.rejects(oauth.callback(new URL(oauth.redirectUri + '?code=code&state=' + url.searchParams.get('state'))), /WRITE_SCOPE_REQUIRED/);
    assert.ok(!plain.account('personal').scopes.includes(CALENDAR_WRITE_SCOPE));
    scope += ' ' + CALENDAR_WRITE_SCOPE;
    const allowed = new URL((await oauth.connect('personal', true)).authorizationUrl);
    await oauth.callback(new URL(oauth.redirectUri + '?code=code&state=' + allowed.searchParams.get('state')));
    assert.ok(plain.account('personal').scopes.includes(CALENDAR_WRITE_SCOPE));
    const account = plain.account('personal'); account.oauth.expiresAt = 0; plain.saveAccount(account);
    scope = CALENDAR_SCOPES.join(' ');
    await assert.rejects(oauth.accessToken('personal', true), /WRITE_SCOPE_REQUIRED/);
    assert.ok(!plain.account('personal').scopes.includes(CALENDAR_WRITE_SCOPE));
  } finally { f.clean(); }
});
