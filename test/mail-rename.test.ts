import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MailStore, type Account } from '../mail/store.js';
import { GoogleStore } from '../google/store.js';
import { CalendarStore } from '../calendar/store.js';
import { MailOAuth, MAIL_SCOPE } from '../mail/oauth.js';
import { renameAccount } from '../mail/rename.js';
import { renameMailbox } from '../mail/accounts.js';
import { prepareConfig } from '../mail/config.js';
import { createDraft } from '../mail/drafts.js';
import { sendDraft } from '../mail/sending.js';
import { ZohoMail } from '../mail/zoho.js';
import { migrateMail } from '../google/migrate.js';

const account: Account = { alias: 'work', provider: 'gmail', email: 'me@example.com', polling: false,
  oauth: { clientId: 'fixture.apps.googleusercontent.com', refreshToken: 'fixture-refresh', accessToken: 'fixture-access', expiresAt: 0 } };
function fixture(t: { after(fn: () => void): void }, shared = false) {
  const root = mkdtempSync(join(tmpdir(), 'mail-rename-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const google = shared ? new GoogleStore(join(root, 'google')) : undefined;
  const store = new MailStore(join(root, 'mail'), google);
  store.saveAccount(account);
  return { root, store, google };
}

test('Gmail rename preserves mail, index, sync state and regenerates local paths; reserves old alias', async t => {
  const { store } = fixture(t);
  prepareConfig(store, account);
  writeFileSync(store.path('maildir/work/INBOX/cur/message'), 'fixture email');
  writeFileSync(store.path('index/work/fixture'), 'index');
  store.write(store.path('state/work.json'), { status: 'failed', attemptedAt: new Date().toISOString(), failures: 2 });
  store.write(store.path('state/work/index-status.json'), { status: 'pending', attemptedAt: new Date().toISOString() });
  const draft = createDraft(store, 'work', { to: ['recipient@example.com'], subject: 'Test', body: 'Body' });
  const result = await renameAccount(store, 'work', 'business');
  assert.equal(result.account, 'business');
  assert.deepEqual(store.accounts().map(a => a.alias), ['business']);
  assert.equal(store.account('business').oauth.refreshToken, account.oauth.refreshToken);
  assert.equal(readFileSync(store.path('maildir/business/INBOX/cur/message'), 'utf8'), 'fixture email');
  assert.equal(readFileSync(store.path('index/business/fixture'), 'utf8'), 'index');
  assert.equal(store.status('business')?.failures, 2);
  assert.equal(store.indexStatus('business')?.status, 'pending');
  assert.match(readFileSync(store.path('state/business/mbsyncrc'), 'utf8'), /pi-mail-token business/);
  assert.ok(readFileSync(store.path('state/business/notmuch-config'), 'utf8').includes(store.path('maildir/business')));
  assert.throws(() => store.account('work'), /ACCOUNT_NOT_CONNECTED/);
  const oauth = new MailOAuth(store, 'https://example.com', async () => { throw new Error('must not request'); });
  await assert.rejects(oauth.connect('work'), /ACCOUNT_ALIAS_RENAMED/);
  await assert.rejects(sendDraft(store, oauth, draft.id, draft.version), /ACCOUNT_NOT_CONNECTED/);
  assert.equal(existsSync(store.path('outbox', draft.id + '.json')), false);
  await renameAccount(store, 'business', 'office');
  assert.equal(store.account('office').email, account.email);
  await assert.rejects(renameAccount(store, 'office', 'work'), /ACCOUNT_ALIAS_IN_USE/);
});

test('rename validates input, collisions, paused jobs, sync and credential locks without changing source', async t => {
  const { store } = fixture(t);
  for (const bad of ['../escape', 'UPPER', '']) await assert.rejects(renameAccount(store, 'work', bad), /INVALID_ACCOUNT_ALIAS/);
  await assert.rejects(renameAccount(store, 'work', 'work'), /ACCOUNT_ALIAS_UNCHANGED/);
  await assert.rejects(renameAccount(store, 'missing', 'new'), /ACCOUNT_NOT_CONNECTED/);
  store.saveAccount({ ...account, alias: 'taken' });
  await assert.rejects(renameAccount(store, 'work', 'taken'), /ACCOUNT_ALIAS_IN_USE/);
  store.saveAccount({ ...account, polling: true });
  await assert.rejects(renameAccount(store, 'work', 'new'), /PAUSE_MAIL_JOBS_FIRST/);
  store.saveAccount(account);
  for (const name of ['work', 'new']) {
    await store.withAccountSyncLock(name, () => assert.rejects(renameAccount(store, 'work', 'new'), /MAIL_BUSY/));
    await store.withAccountCredentialLock(name, () => assert.rejects(renameAccount(store, 'work', 'new'), /MAIL_BUSY/));
  }
  assert.deepEqual(store.account('work'), account);
});

test('an in-flight send excludes rename and its attempt history survives afterward', async t => {
  const { store } = fixture(t);
  const draft = createDraft(store, 'work', { to: ['recipient@example.com'], subject: 'Test', body: 'Body' });
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const sending = sendDraft(store, { accessToken: async () => 'fixture-token' }, draft.id, draft.version, async () => {
    started(); await pending; return Response.json({ id: 'fixture-message' });
  });
  await entered;
  try { await assert.rejects(renameAccount(store, 'work', 'business'), /MAIL_BUSY/); }
  finally { finish(); }
  assert.equal((await sending).state, 'sent');
  const history = readFileSync(store.path('outbox', draft.id + '.json'), 'utf8');
  await renameAccount(store, 'work', 'business');
  assert.equal(readFileSync(store.path('outbox', draft.id + '.json'), 'utf8'), history);
});

test('failed final write rolls back moved data and metadata', async t => {
  const { store } = fixture(t);
  prepareConfig(store, account);
  const originalConfig = readFileSync(store.path('state/work/mbsyncrc'), 'utf8');
  const write = store.write.bind(store);
  store.write = (file, value) => { if (file === store.path('accounts/new.json')) throw new Error('fixture failure'); write(file, value); };
  await assert.rejects(renameAccount(store, 'work', 'new'), /fixture failure/);
  assert.deepEqual(store.account('work'), account);
  assert.equal(readFileSync(store.path('state/work/mbsyncrc'), 'utf8'), originalConfig);
  assert.equal(existsSync(store.path('maildir/new')), false);
  assert.equal(existsSync(store.path('.rename-recovery/work.json')), false);
});

test('shared Google identity, calendar, refresh locks and reauthorization survive a mail-only rename', async t => {
  const { root, store, google } = fixture(t, true);
  google!.configure({ clientId: account.oauth.clientId, clientSecret: 'fixture-secret' });
  const calendar = new CalendarStore(join(root, 'calendar'), google);
  calendar.saveAccount({ ...account, provider: 'google', version: 1, subject: 'fixture-sub', scopes: [MAIL_SCOPE] });
  let requests = 0;
  const oauth = new MailOAuth(store, 'https://example.com', async url => {
    requests++;
    return String(url).endsWith('/token') ? Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: MAIL_SCOPE })
      : Response.json({ sub: 'fixture-sub', email: account.email, email_verified: true });
  });
  const pending = await oauth.connect('work');
  await renameAccount(store, 'work', 'business');
  await assert.rejects(oauth.callback(new URL(`${oauth.redirectUri}?state=${new URL(pending.authorizationUrl).searchParams.get('state')}&code=fixture`)), /ACCOUNT_ALIAS_RENAMED/);
  assert.equal(requests, 0);
  assert.equal(store.account('business').googleAccount, 'work');
  assert.deepEqual(google!.accounts().map(a => a.alias), ['work']);
  await calendar.withAccountCredentialLock('work', () => assert.rejects(renameAccount(store, 'business', 'office'), /MAIL_BUSY/));
  assert.equal(await oauth.accessToken('business'), 'new-access');
  assert.equal(calendar.account('work').oauth.refreshToken, 'new-refresh');
  const link = await oauth.connect('business');
  await oauth.callback(new URL(`${oauth.redirectUri}?state=${new URL(link.authorizationUrl).searchParams.get('state')}&code=fixture`));
  assert.equal(store.account('business').googleAccount, 'work');
  await store.withOAuthConfigurationLock(async () => {});
  await migrateMail(store.root, google!);
  assert.deepEqual(google!.accounts().map(a => a.alias), ['work']);
  assert.ok(!readFileSync(store.path('accounts/business.json'), 'utf8').includes('refreshToken'));
});

test('Zoho rename preserves credentials and audit records, invalidates old plans and pending consent', async t => {
  const { root } = fixture(t);
  let calls = 0;
  const zoho = new ZohoMail(join(root, 'zoho'), 'https://example.com', async () => { calls++; throw new Error('no network'); });
  await zoho.configure('1000.fixture', 'fixture-secret');
  zoho.store.write(zoho.store.path('accounts/work.json'), { alias: 'work', email: account.email, accountId: '123', clientId: '1000.fixture', refreshToken: 'fixture-refresh', accessToken: 'fixture-access', expiresAt: Date.now() + 3600000 });
  const pending = await zoho.connect('work', account.email);
  const plan = zoho.plan('work', { action: 'archive', messageId: '456' });
  const original = readFileSync(zoho.store.path('plans', plan.plan.id + '.json'), 'utf8');
  await zoho.rename('work', 'business');
  assert.deepEqual(zoho.status().accounts, [{ alias: 'business', email: account.email, accountId: '123' }]);
  assert.equal(readFileSync(zoho.store.path('plans', plan.plan.id + '.json'), 'utf8'), original);
  await assert.rejects(zoho.execute(plan.plan.id, plan.version), /ACCOUNT_ALIAS_RENAMED/);
  await assert.rejects(zoho.connect('work', account.email), /ACCOUNT_ALIAS_RENAMED/);
  await assert.rejects(zoho.callback(new URL(`${zoho.redirectUri}?state=${new URL(pending.authorizationUrl).searchParams.get('state')}&code=fixture`)), /ACCOUNT_ALIAS_RENAMED/);
  assert.equal(zoho.attempt(plan.plan.id).state, 'not_attempted');
  assert.equal(zoho.plan('business', { action: 'archive', messageId: '456' }).plan.account, 'business');
  assert.equal(calls, 0);
});

test('provider-independent discovery refuses ambiguous sources and cross-provider collisions', async t => {
  const { store } = fixture(t);
  const zoho = new ZohoMail(store.path('zoho'), 'https://example.com');
  const zohoAccount = { alias: 'work', email: account.email, accountId: '123', clientId: '1000.fixture', refreshToken: 'fixture-refresh', accessToken: 'fixture-access', expiresAt: 0 };
  zoho.store.write(zoho.store.path('accounts/work.json'), zohoAccount);
  await assert.rejects(renameMailbox(store, zoho, 'work', 'new'), /AMBIGUOUS_ACCOUNT_ALIAS/);
  assert.equal(store.account('work').alias, 'work');
  assert.equal(zoho.status().accounts[0].alias, 'work');
  store.saveAccount({ ...account, alias: 'personal' });
  zoho.store.write(zoho.store.path('accounts/zoho-only.json'), { ...zohoAccount, alias: 'zoho-only' });
  await assert.rejects(renameMailbox(store, zoho, 'personal', 'zoho-only'), /ACCOUNT_ALIAS_IN_USE/);
  await assert.rejects(renameMailbox(store, zoho, 'zoho-only', 'personal'), /ACCOUNT_ALIAS_IN_USE/);
  await assert.rejects(renameMailbox(store, zoho, 'missing', 'new'), /ACCOUNT_NOT_CONNECTED/);
  await zoho.store.locked('oauth', () => assert.rejects(renameMailbox(store, zoho, 'personal', 'new'), /MAIL_BUSY/));
  await renameMailbox(store, zoho, 'personal', 'new');
  await assert.rejects(renameMailbox(store, zoho, 'zoho-only', 'personal'), /ACCOUNT_ALIAS_IN_USE/);
});

test('mailctl uses the same account rename command for Gmail and Zoho', async t => {
  const { store } = fixture(t);
  const run = (...args: string[]) => spawnSync(process.execPath, ['dist/mail/cli.js', ...args], {
    encoding: 'utf8', env: { ...process.env, MAIL_DIR: store.root, GOOGLE_DIR: '', PUBLIC_ORIGIN: 'https://example.com' },
  });
  const result = run('account', 'rename', 'work', 'business');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).account, 'business');
  assert.doesNotMatch(run('zoho', 'help').stdout, /zoho rename/);
  const zoho = new ZohoMail(store.path('zoho'), 'https://example.com');
  zoho.store.write(zoho.store.path('accounts/work.json'), { alias: 'work', email: account.email, accountId: '123', clientId: '1000.fixture', refreshToken: 'fixture-refresh', accessToken: 'fixture-access', expiresAt: 0 });
  const zohoResult = run('account', 'rename', 'work', 'zoho-business');
  assert.equal(zohoResult.status, 0, zohoResult.stdout + zohoResult.stderr);
  assert.equal(zoho.status().accounts[0].alias, 'zoho-business');
  assert.notEqual(run('zoho', 'rename', 'zoho-business', 'other').status, 0);
  assert.notEqual(run('account', 'rename', 'business', 'other', 'extra').status, 0);
});
