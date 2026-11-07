import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailStore } from '../mail/store.js';
import { prepareConfig } from '../mail/config.js';
import { privateCommand, searchMail } from '../mail/commands.js';
import { MailAccounts, MailAccountRegistry } from '../mail/account-registry.js';
import { gmailAdapter } from '../mail/providers.js';
import { createGmailPlan, executeGmailPlan, gmailActionStatus, showGmailPlan } from '../mail/gmail-actions.js';
const oauth = { accessToken: async () => 'secret-token' };
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'gmail-actions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new MailStore(root);
  store.saveAccount({ alias: 'personal', provider: 'gmail', email: 'me@example.com', polling: false,
    oauth: { clientId: 'test', refreshToken: 'secret-refresh', accessToken: 'secret-token', expiresAt: 0 } });
  let labels = ['INBOX', 'UNREAD'];
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const request: typeof fetch = async (url, options) => {
    assert.equal(options?.redirect, 'error');
    const method = options?.method ?? 'GET';
    calls.push({ url: String(url), method, body: options?.body ? JSON.parse(String(options.body)) : null });
    if (method === 'POST') {
      labels = String(url).endsWith('/trash') ? ['TRASH', 'UNREAD'] : ['INBOX'];
      return Response.json({ id: 'ab123' });
    }
    if (String(url).includes('messages?')) return Response.json({ messages: [{ id: 'ab123' }] });
    return Response.json({ id: 'ab123', labelIds: labels, payload: { headers: [
      { name: 'Message-ID', value: '<example@mail.test>' }, { name: 'From', value: 'Sender <sender@example.com>' },
      { name: 'Subject', value: 'Hello' }, { name: 'Date', value: 'Tue, 3 Nov 2026 12:00:00 +0000' },
    ] } });
  };
  return { store, request, calls, setLabels: (value: string[]) => { labels = value; } };
}
test('plans resolve exact RFC ID live and are immutable, private, versioned, and read-only', async t => {
  const { store, request, calls } = fixture(t);
  const result = await createGmailPlan(store, oauth, 'personal', { action: 'mark-read', messageId: '<example@mail.test>' }, request);
  assert.equal(result.plan.message.id, 'ab123');
  assert.equal(result.accountIdentity.email, 'me@example.com');
  assert.ok(calls.every(c => c.method === 'GET'));
  assert.match(calls[0].url, /includeSpamTrash=true/);
  assert.deepEqual(showGmailPlan(new MailStore(store.root), result.plan.id), result);
  assert.equal(statSync(store.path('gmail-actions', result.plan.id + '.json')).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(result).includes('secret-token'));
});
test('mark-read and trash submit once with durable marker, read back and reconcile local tags', async t => {
  for (const action of ['mark-read', 'trash']) {
    const { store, request, calls } = fixture(t);
    const { plan } = await createGmailPlan(store, oauth, 'personal', { action, messageId: 'example@mail.test' }, request);
    const tags: string[][] = [];
    const result = await executeGmailPlan(store, oauth, plan.id, plan.version, async (url, options) => {
      if (options?.method === 'POST') assert.equal(gmailActionStatus(new MailStore(store.root), plan.id).state, 'uncertain');
      return request(url, options);
    }, async (file, args) => { assert.equal(file, '/usr/bin/notmuch'); tags.push(args); return ''; });
    assert.equal(result.state, 'verified');
    assert.equal(result.localIndex, 'updated');
    const posts = calls.filter(c => c.method === 'POST');
    assert.equal(posts.length, 1);
    assert.ok(posts[0].url.endsWith(action === 'trash' ? '/trash' : '/modify'));
    assert.deepEqual(posts[0].body, action === 'trash' ? {} : { removeLabelIds: ['UNREAD'] });
    assert.ok(tags[0].includes(action === 'trash' ? '+gmail-trash' : '-unread'));
    assert.equal(tags[0].at(-1), 'id:"example@mail.test"');
    await assert.rejects(executeGmailPlan(new MailStore(store.root), oauth, plan.id, plan.version, request), /ALREADY_ATTEMPTED/);
    assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  }
});
test('unsupported actions, injection, duplicate or mismatched lookup refuse plans', async t => {
  const { store, request } = fixture(t);
  for (const input of [{ action: 'delete', messageId: 'example@mail.test' }, { action: 'trash', messageId: 'x OR newer:1d' }, { action: 'trash', messageId: 'example@mail.test', threadId: 'abc' }]) {
    await assert.rejects(createGmailPlan(store, oauth, 'personal', input, request), /INVALID/);
  }
  for (const data of [{ messages: [] }, { messages: [{ id: 'a' }, { id: 'b' }] }, { messages: [{ id: 'a' }], nextPageToken: 'more' }]) {
    await assert.rejects(createGmailPlan(store, oauth, 'personal', { action: 'trash', messageId: 'example@mail.test' }, async () => Response.json(data)), /NOT_UNIQUE/);
  }
  await assert.rejects(createGmailPlan(store, oauth, 'personal', { action: 'trash', messageId: 'different@mail.test' }, request), /ID_MISMATCH/);
});
test('stale approval, changed labels or account and tampered plan cause no write', async t => {
  const { store, request, calls, setLabels } = fixture(t);
  const { plan } = await createGmailPlan(store, oauth, 'personal', { action: 'trash', messageId: 'example@mail.test' }, request);
  await assert.rejects(executeGmailPlan(store, oauth, plan.id, 'old', request), /VERSION_CONFLICT/);
  setLabels(['INBOX']);
  await assert.rejects(executeGmailPlan(store, oauth, plan.id, plan.version, request), /MESSAGE_CHANGED/);
  const account = store.account('personal'); account.email = 'other@example.com'; store.saveAccount(account);
  await assert.rejects(executeGmailPlan(store, oauth, plan.id, plan.version, request), /ACCOUNT_CHANGED/);
  assert.equal(gmailActionStatus(store, plan.id).state, 'not_attempted');
  writeFileSync(store.path('gmail-actions', plan.id + '.json'), JSON.stringify({ ...plan, action: 'mark-read' }));
  assert.throws(() => showGmailPlan(store, plan.id), /INVALID_GMAIL_PLAN/);
  assert.ok(calls.every(c => c.method !== 'POST'));
});
test('timeouts, 5xx, rejection and failed read-back never retry and do not touch local tags', async t => {
  for (const outcome of ['timeout', '500', '408', '403', 'readback', 'unchanged']) {
    const { store, request } = fixture(t);
    const { plan } = await createGmailPlan(store, oauth, 'personal', { action: 'mark-read', messageId: 'example@mail.test' }, request);
    let posts = 0;
    const failing: typeof fetch = async (url, options) => {
      if (options?.method === 'POST') {
        posts++;
        if (outcome === 'timeout') throw new Error('private provider data');
        if (outcome === 'readback' || outcome === 'unchanged') return Response.json({});
        return new Response('private provider data', { status: Number(outcome) });
      }
      if (posts && outcome === 'readback') throw new Error('private provider data');
      return request(url, options);
    };
    let localCalls = 0;
    const result = await executeGmailPlan(store, oauth, plan.id, plan.version, failing, async () => { localCalls++; return ''; });
    assert.equal(result.state, outcome === '403' ? 'rejected' : 'uncertain');
    assert.equal(localCalls, 0);
    assert.ok(!JSON.stringify(result).includes('private provider'));
    await assert.rejects(executeGmailPlan(store, oauth, plan.id, plan.version, failing), /ALREADY_ATTEMPTED/);
    assert.equal(posts, 1);
  }
});
test('local index failure does not turn verified remote success into retryable failure', async t => {
  const { store, request } = fixture(t);
  const { plan } = await createGmailPlan(store, oauth, 'personal', { action: 'trash', messageId: 'example@mail.test' }, request);
  const result = await executeGmailPlan(store, oauth, plan.id, plan.version, request, async () => { throw new Error('index failed'); });
  assert.equal(result.state, 'verified'); assert.equal(result.localIndex, 'failed');
  await assert.rejects(executeGmailPlan(store, oauth, plan.id, plan.version, request), /ALREADY_ATTEMPTED/);
});
test('corrupt attempt markers and concurrent execution fail closed', async t => {
  const { store, request } = fixture(t);
  const { plan } = await createGmailPlan(store, oauth, 'personal', { action: 'trash', messageId: 'example@mail.test' }, request);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const executing = executeGmailPlan(store, oauth, plan.id, plan.version, async (url, options) => {
    if (options?.method === 'POST') { started(); await gate; }
    return request(url, options);
  }, async () => '');
  await ready;
  await assert.rejects(executeGmailPlan(store, oauth, plan.id, plan.version, request), /MAIL_BUSY/);
  release(); await executing;
  writeFileSync(store.path('gmail-action-attempts', plan.id + '.json'), '{');
  assert.throws(() => gmailActionStatus(store, plan.id), /DO_NOT_RETRY/);
  await assert.rejects(executeGmailPlan(store, oauth, plan.id, plan.version, request), /ALREADY_ATTEMPTED/);
});
test('real notmuch reconciliation updates duplicate copies and excludes trash from unread searches', async t => {
  if (spawnSync('/usr/bin/notmuch', ['--version']).status !== 0) { t.skip('notmuch unavailable'); return; }
  for (const action of ['mark-read', 'trash']) {
    const { store, request } = fixture(t);
    const config = prepareConfig(store, store.account('personal'));
    const message = 'From: sender@example.com\nTo: me@example.com\nSubject: Hello\nMessage-ID: <example@mail.test>\nDate: Tue, 3 Nov 2026 12:00:00 +0000\n\nTest message\n';
    writeFileSync(store.path('maildir', 'personal', 'INBOX', 'new', 'one'), message);
    writeFileSync(store.path('maildir', 'personal', 'INBOX', 'new', 'two'), message);
    await privateCommand('/usr/bin/notmuch', [`--config=${config.notmuch}`, 'new']);
    store.write(store.path('state', 'personal.json'), { status: 'ok', attemptedAt: new Date().toISOString(), lastSuccess: new Date().toISOString() });
    assert.equal((await searchMail(store, { unread: true })).results.length, 1);
    const { plan } = await createGmailPlan(store, oauth, 'personal', { action, messageId: 'example@mail.test' }, request);
    const result = await executeGmailPlan(store, oauth, plan.id, plan.version, request);
    assert.equal(result.localIndex, 'updated');
    assert.equal((await searchMail(store, { unread: true })).results.length, 0);
    assert.equal((await searchMail(store, {})).results.length, 1);
    // Re-indexing retained archive copies must not immediately undo the tags.
    await privateCommand('/usr/bin/notmuch', [`--config=${config.notmuch}`, 'new']);
    assert.equal((await searchMail(store, { unread: true })).results.length, 0);
  }
});
test('legacy and stable plans survive migration and alias reuse without changing approved identity', async t => {
  const { store: legacy, request } = fixture(t);
  const registry = new MailAccountRegistry(legacy.root);
  const store = new MailStore(legacy.root, undefined, registry);
  const accounts = new MailAccounts(registry, [gmailAdapter(store)]);
  const { plan: old } = await createGmailPlan(store, oauth, 'personal', { action: 'trash', messageId: 'example@mail.test' }, request);
  await accounts.migrate();
  const id = registry.resolve('personal').id;
  const { plan: current } = await createGmailPlan(store, oauth, id, { action: 'mark-read', messageId: 'example@mail.test' }, request);
  await accounts.rename(id, 'renamed');
  const replacement = await registry.reserve('gmail', 'personal');
  store.saveAccount({ ...store.account(id), alias: replacement.id, email: 'replacement@example.com' });
  assert.notEqual(registry.resolve('personal').id, id);
  assert.equal(showGmailPlan(store, old.id).accountIdentity.id, id);
  assert.equal(showGmailPlan(store, current.id).accountIdentity.alias, 'renamed');
  assert.equal(showGmailPlan(store, old.id).plan.version, old.version);
  const result = await executeGmailPlan(store, oauth, old.id, old.version, request, async () => '');
  assert.equal(result.state, 'verified');
});
test('migration refuses unresolved Gmail action identity', async t => {
  const { store: legacy, request } = fixture(t);
  const registry = new MailAccountRegistry(legacy.root);
  const store = new MailStore(legacy.root, undefined, registry);
  const accounts = new MailAccounts(registry, [gmailAdapter(store)]);
  await createGmailPlan(store, oauth, 'personal', { action: 'trash', messageId: 'example@mail.test' }, request);
  const account = store.account('personal'); account.email = 'other@example.com'; store.saveAccount(account);
  await assert.rejects(accounts.migrate(), /MIGRATION_APPROVAL_IDENTITY_UNRESOLVED/);
});
test('CLI requires exact version and explicit confirmation', t => {
  const { store } = fixture(t);
  for (const args of [['execute', 'abc'], ['execute', 'abc', '--version', 'hash'], ['execute', 'abc', '--confirm']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'mail/cli.ts', 'gmail-action', ...args], {
      encoding: 'utf8', env: { ...process.env, MAIL_DIR: store.root, PUBLIC_ORIGIN: 'http://localhost:3000' },
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error, 'GMAIL_ACTION_REQUIRES_EXACT_PLAN_AND_CONFIRM');
  }
});
