import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MailAccountRegistry, MailAccounts, type MailProviderAdapter } from '../mail/account-registry.js';
import { gmailAdapter, zohoAdapter } from '../mail/providers.js';
import { MailStore, type Account } from '../mail/store.js';
import { GoogleStore } from '../google/store.js';
import { migrateMail } from '../google/migrate.js';
import { CalendarStore } from '../calendar/store.js';
import { MailOAuth, MAIL_SCOPE } from '../mail/oauth.js';
import { ZohoMail } from '../mail/zoho.js';
import { createDraft, showDraft } from '../mail/drafts.js';
import { sendDraft } from '../mail/sending.js';
import { prepareConfig } from '../mail/config.js';
import { indexMail } from '../mail/commands.js';

const original: Account = { alias: 'personal', provider: 'gmail', email: 'me@example.com', polling: false,
  oauth: { clientId: 'fixture.apps.googleusercontent.com', refreshToken: 'fixture-refresh', accessToken: 'fixture-access', expiresAt: 0 } };
function fixture(t: { after(fn: () => void): void }, shared = false) {
  const root = mkdtempSync(join(tmpdir(), 'mail-registry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = new MailAccountRegistry(join(root, 'mail'));
  const google = shared ? new GoogleStore(join(root, 'google')) : undefined;
  const store = new MailStore(registry.root, google, registry);
  store.saveAccount(original);
  store.write(store.path('oauth-client.json'), { clientId: original.oauth.clientId, clientSecret: 'fixture-secret', redirectUri: 'https://example.com/mail/oauth/callback' });
  const calls: string[] = [];
  const zoho = new ZohoMail(store.path('zoho'), 'https://example.com', async url => {
    calls.push(String(url)); return Response.json({ status: { code: 200 }, data: {} });
  }, Date.now, registry);
  zoho.store.write(zoho.store.path('client.json'), { clientId: '1000.fixture', clientSecret: 'fixture-secret', redirectUri: zoho.redirectUri });
  zoho.store.write(zoho.store.path('accounts/work.json'), { alias: 'work', email: 'work@example.com', accountId: '123', clientId: '1000.fixture', refreshToken: 'fixture-refresh', accessToken: 'fixture-access', expiresAt: Date.now() + 3600000 });
  const providers = [gmailAdapter(store), zohoAdapter(zoho)];
  return { root, registry, store, google, zoho, calls, providers, accounts: new MailAccounts(registry, providers) };
}
function snapshot(root: string) {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === '.locks' || name === 'account-registry.json') continue;
      const file = join(dir, name);
      if (statSync(file).isDirectory()) walk(file); else files[relative(root, file)] = readFileSync(file).toString('base64');
    }
  };
  walk(root); return files;
}
function fakeProvider(): MailProviderAdapter {
  return { id: 'fixture-provider', capabilities: ['fixture-capability'],
    discover: () => [{ storageRef: 'opaque-connection', suggestedAlias: 'third' }],
    describe: () => ({ email: 'third@example.com', connected: true }),
    withMigrationLock: action => action() };
}

test('account management accepts a third provider; migration and rename never rewrite provider state', async t => {
  const f = fixture(t);
  prepareConfig(f.store, original);
  writeFileSync(f.store.path('maildir/personal/INBOX/cur/message'), 'fixture message');
  writeFileSync(f.store.path('index/personal/fixture-index'), 'fixture index');
  f.store.write(f.store.path('state/personal.json'), { status: 'failed', attemptedAt: new Date().toISOString(), failures: 3 });
  const providers = [...f.providers, fakeProvider()], accounts = new MailAccounts(f.registry, providers);
  const before = snapshot(f.root);
  assert.equal(accounts.preview().canApply, true);
  assert.equal(f.registry.enabled, false);
  await accounts.migrate();
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(statSync(f.registry.file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(f.registry.file, 'utf8').includes('fixture-secret'));
  const third = accounts.resolve('third', 'fixture-capability').account;
  assert.throws(() => accounts.resolve('third', 'sync'), /MAIL_CAPABILITY_UNSUPPORTED/);
  await accounts.rename('third', 'renamed');
  assert.equal(accounts.resolve('renamed').account.id, third.id);
  assert.equal(accounts.resolve(third.id).account.storageRef, 'opaque-connection');
  assert.throws(() => accounts.resolve('third'), /ACCOUNT_NOT_CONNECTED/);
  assert.equal(accounts.list().find(a => a.id === third.id)?.provider, 'fixture-provider');
  const id = accounts.resolve('personal').account.id;
  await accounts.rename('personal', 'home');
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(f.store.account(id).alias, id);
  assert.equal(f.store.status(id)?.failures, 3);
  assert.equal(f.store.path('index', id), f.store.path('index/personal'));
  await f.store.withAccountSyncLock(id, () => assert.rejects(f.store.withAccountSyncLock('personal', async () => {}), /MAIL_BUSY/));
  // A rename needs neither worker cancellation nor provider credentials.
  await f.store.withAccountSyncLock(id, () => accounts.rename(id, 'personal'));
  const restarted = new MailAccounts(new MailAccountRegistry(f.registry.root), providers);
  assert.equal(restarted.resolve('personal').account.id, id);
  assert.equal((await restarted.migrate()).migrated, false);
  assert.deepEqual(snapshot(f.root), before);
});

test('migration reports collisions and applies explicit aliases atomically, without touching approvals or history', async t => {
  const f = fixture(t);
  f.store.saveAccount({ ...original, alias: 'work', email: 'second@example.com' });
  const before = snapshot(f.root);
  assert.deepEqual(f.accounts.preview().collisions, ['work']);
  await assert.rejects(f.accounts.migrate(), /AMBIGUOUS_ACCOUNT_ALIAS/);
  assert.equal(f.registry.enabled, false);
  assert.deepEqual(snapshot(f.root), before);
  const mappings = { gmail: { work: 'gmail-work' }, zoho: { work: 'zoho-work' } };
  await f.accounts.migrate(mappings);
  assert.equal(f.accounts.resolve('gmail-work').account.provider, 'gmail');
  assert.equal(f.accounts.resolve('zoho-work').account.provider, 'zoho');
  assert.deepEqual(snapshot(f.root), before);
  await assert.rejects(f.accounts.rename('gmail-work', 'zoho-work'), /ACCOUNT_ALIAS_IN_USE/);
  for (const alias of ['../escape', 'UPPER', '', 'm' + 'a'.repeat(31)]) await assert.rejects(f.accounts.rename('gmail-work', alias), /INVALID_ACCOUNT_ALIAS/);
  const beforeRename = f.registry.accounts();
  const outcomes = await Promise.allSettled([f.accounts.rename('gmail-work', 'same'), f.accounts.rename('zoho-work', 'same')]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(new Set(f.registry.accounts().map(a => a.alias)).size, beforeRename.length);
});

test('migration pauses/drains workers, refuses pending consent or unresolved approvals, and retries safely', async t => {
  const f = fixture(t);
  f.store.saveAccount({ ...original, polling: true });
  await assert.rejects(f.accounts.migrate(), /PAUSE_MAIL_JOBS_FIRST/);
  f.store.saveAccount(original);
  await f.store.withAccountSyncLock('personal', () => assert.rejects(f.accounts.migrate(), /MAIL_BUSY/));
  await f.zoho.store.withAccountSyncLock('work', () => assert.rejects(f.accounts.migrate(), /MAIL_BUSY/));
  f.store.write(f.store.path('pending', 'a'.repeat(64) + '.json'), { expiresAt: Date.now() + 60000 });
  await assert.rejects(f.accounts.migrate(), /MIGRATION_PENDING_AUTHORIZATION/);
  f.store.write(f.store.path('pending', 'a'.repeat(64) + '.json'), { expiresAt: 0 });
  const draft = createDraft(f.store, 'personal', { to: ['recipient@example.com'], subject: 'Test', body: 'Body' });
  f.store.write(f.store.path('drafts', draft.id + '.json'), { ...draft, from: 'different@example.com' });
  await assert.rejects(f.accounts.migrate(), /MIGRATION_APPROVAL_IDENTITY_UNRESOLVED/);
  assert.equal(f.registry.enabled, false);
  f.store.write(f.store.path('drafts', draft.id + '.json'), draft);
  const failing = { ...fakeProvider(), withMigrationLock: async () => { throw new Error('fixture interrupted before publication'); } };
  await assert.rejects(f.registry.migrate([...f.providers, failing]), /fixture interrupted/);
  assert.equal(f.registry.enabled, false);
  await f.accounts.migrate();
  const first = readFileSync(f.registry.file, 'utf8');
  await f.accounts.migrate();
  assert.equal(readFileSync(f.registry.file, 'utf8'), first);
});

test('old and new drafts keep stable identities through alias reuse; rename during a send is safe', async t => {
  const f = fixture(t);
  const draft = createDraft(f.store, 'personal', { to: ['recipient@example.com'], subject: 'Test', body: 'Body' });
  const bytes = readFileSync(f.store.path('drafts', draft.id + '.json'), 'utf8');
  await f.accounts.migrate();
  const identity = f.accounts.resolve('personal').account;
  const newDraft = createDraft(f.store, identity.id, { to: ['recipient@example.com'], subject: 'New', body: 'Body' });
  assert.equal(newDraft.account, identity.id);
  await f.accounts.rename('personal', 'home');
  const replacement = await f.registry.reserve('gmail', 'personal');
  assert.notEqual(replacement.id, identity.id);
  f.store.saveAccount({ ...original, alias: replacement.id, email: 'replacement@example.com' });
  assert.equal(f.store.account(f.registry.resolve('personal').id).email, 'replacement@example.com');
  assert.equal(f.store.account(showDraft(f.store, draft.id).account).email, original.email);
  assert.equal(readFileSync(f.store.path('drafts', draft.id + '.json'), 'utf8'), bytes);
  let start!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { start = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const sending = sendDraft(f.store, { accessToken: async name => { assert.equal(f.store.accountId(name), identity.id); return 'fixture-access'; } }, draft.id, draft.version, async () => {
    start(); await pending; return Response.json({ id: 'fixture-message' });
  });
  await entered;
  try { await f.accounts.rename(identity.id, 'again'); } finally { finish(); }
  assert.equal((await sending).state, 'sent');
  const attempt = readFileSync(f.store.path('outbox', draft.id + '.json'), 'utf8');
  await f.accounts.rename(identity.id, 'final');
  assert.equal(readFileSync(f.store.path('outbox', draft.id + '.json'), 'utf8'), attempt);
  await assert.rejects(sendDraft(f.store, { accessToken: async () => { throw new Error('must not refresh'); } }, draft.id, draft.version), /SEND_ALREADY_ATTEMPTED/);
});

test('Zoho plans retain exact hashes and provider identity while aliases change or are reused', async t => {
  const f = fixture(t);
  const plan = f.zoho.plan('work', { action: 'archive', messageId: '456' });
  const before = readFileSync(f.zoho.store.path('plans', plan.plan.id + '.json'), 'utf8');
  await f.accounts.migrate();
  const identity = f.accounts.resolve('work').account;
  await f.accounts.rename('work', 'business');
  const replacement = await f.registry.reserve('zoho', 'work');
  assert.notEqual(replacement.id, identity.id);
  assert.equal(f.zoho.show(plan.plan.id).version, plan.version);
  assert.equal(f.zoho.show(plan.plan.id).accountIdentity?.id, identity.id);
  assert.equal(f.zoho.show(plan.plan.id).accountIdentity?.alias, 'business');
  assert.equal(f.zoho.plan(identity.id, { action: 'archive', messageId: '456' }).plan.account, identity.id);
  assert.equal((await f.zoho.execute(plan.plan.id, plan.version)).state, 'accepted');
  assert.ok(f.calls[0].includes('/123/updatemessage'));
  assert.equal(readFileSync(f.zoho.store.path('plans', plan.plan.id + '.json'), 'utf8'), before);
  await assert.rejects(f.zoho.execute(plan.plan.id, plan.version), /ZOHO_ALREADY_ATTEMPTED/);
});

test('shared Google connection, calendar locks, token rotation and reconnect are independent of the mail alias', async t => {
  const f = fixture(t, true);
  const calendar = new CalendarStore(join(f.root, 'calendar'), f.google);
  calendar.saveAccount({ ...original, version: 1, provider: 'google', subject: 'fixture-user', scopes: [MAIL_SCOPE] });
  await f.accounts.migrate();
  const identity = f.accounts.resolve('personal').account;
  await f.accounts.rename(identity.id, 'home');
  await calendar.withAccountCredentialLock('personal', () => assert.rejects(f.store.withAccountCredentialLock(identity.id, async () => {}), /MAIL_BUSY/));
  const oauth = new MailOAuth(f.store, 'https://example.com', async url => String(url).endsWith('/token')
    ? Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, scope: MAIL_SCOPE })
    : Response.json({ email: original.email, email_verified: true, sub: 'fixture-user' }));
  assert.equal(await oauth.accessToken(identity.id), 'rotated-access');
  assert.equal(calendar.account('personal').oauth.refreshToken, 'rotated-refresh');
  const consent = await oauth.connect('home');
  await f.accounts.rename(identity.id, 'renamed-during-consent');
  await oauth.callback(new URL(`${oauth.redirectUri}?state=${new URL(consent.authorizationUrl).searchParams.get('state')}&code=fixture`));
  assert.deepEqual(f.google!.accounts().map(a => a.alias), ['personal']);
  assert.equal(f.store.account(identity.id).email, original.email);
  assert.equal(f.store.accountLabel(identity.id), 'renamed-during-consent');
  prepareConfig(f.store, f.store.account(identity.id));
  const config = readFileSync(f.store.path('state', identity.id, 'mbsyncrc'), 'utf8');
  assert.ok(config.includes(`pi-mail-token ${identity.id}`));
  assert.ok(config.includes(f.store.path('maildir/personal')));
  f.store.write(f.store.path('state', identity.id + '.json'), { status: 'ok', attemptedAt: new Date().toISOString(), downloadCompletedAt: new Date().toISOString() });
  const indexed = await indexMail(f.store, identity.id, async () => '');
  assert.equal(indexed.account, 'renamed-during-consent');
  assert.equal(f.store.indexStatus(identity.id)?.status, 'ok');
});

test('new connections use ID-backed storage and a separately stable shared credential reference', async t => {
  const f = fixture(t, true);
  await f.accounts.migrate();
  const oauth = new MailOAuth(f.store, 'https://example.com', async url => String(url).endsWith('/token')
    ? Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: MAIL_SCOPE })
    : Response.json({ email: 'new@example.com', email_verified: true, sub: 'new-user' }));
  const consent = await oauth.connect('new-account');
  const identity = f.registry.resolve('new-account');
  assert.equal(identity.storageRef, identity.id);
  assert.equal(identity.connectionRef, 'new-account');
  assert.equal(f.accounts.list().find(a => a.id === identity.id)?.connected, false);
  await f.accounts.rename(identity.id, 'new-label');
  await oauth.callback(new URL(`${oauth.redirectUri}?state=${new URL(consent.authorizationUrl).searchParams.get('state')}&code=fixture`));
  assert.equal(f.google!.account('new-account')?.email, 'new@example.com');
  assert.equal(f.store.account(identity.id).email, 'new@example.com');
  assert.ok(existsSync(join(f.store.root, 'accounts', identity.id + '.json')));
  assert.equal(JSON.parse(readFileSync(f.store.path('accounts', identity.id + '.json'), 'utf8')).googleAccount, 'new-account');
  assert.ok(!readFileSync(f.store.path('accounts', identity.id + '.json'), 'utf8').includes('refreshToken'));
  await migrateMail(f.store.root, f.google!);
  assert.equal(f.google!.account('new-account')?.oauth.refreshToken, 'new-refresh');
  // Reusing the original display alias cannot steal that shared connection.
  await oauth.connect('new-account');
  const reused = f.registry.resolve('new-account');
  assert.notEqual(reused.id, identity.id);
  assert.equal(reused.connectionRef, reused.id);
});

test('CLI has one rename/list/status surface; migration is explicit and identity lookup is strict', async t => {
  const f = fixture(t);
  const cli = (...args: string[]) => spawnSync(process.execPath, ['dist/mail/cli.js', ...args], { encoding: 'utf8',
    env: { ...process.env, MAIL_DIR: f.store.root, GOOGLE_DIR: '', PUBLIC_ORIGIN: 'https://example.com' } });
  assert.match(cli('account', 'rename', 'work', 'business').stdout, /ACCOUNT_REGISTRY_MIGRATION_REQUIRED/);
  assert.equal(cli('account', 'migrate').status, 0);
  assert.equal(f.registry.enabled, false);
  const migrated = cli('account', 'migrate', '--confirm');
  assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
  for (const [old, next] of [['work', 'business'], ['personal', 'home']]) {
    const renamed = cli('account', 'rename', old, next);
    assert.equal(renamed.status, 0, renamed.stdout + renamed.stderr);
    assert.equal(JSON.parse(renamed.stdout).account.alias, next);
    assert.equal(cli('account', 'status', next).status, 0);
    assert.match(cli('account', 'status', old).stdout, /ACCOUNT_NOT_CONNECTED/);
  }
  assert.equal(JSON.parse(cli('account', 'list').stdout).accounts.length, 2);
  assert.equal(cli('jobs', 'status', 'home').status, 0);
  assert.match(cli('read', 'home:0123456789abcdef').stdout, /LEGACY_MAIL_REFERENCE_SEARCH_AGAIN/);
  assert.equal(cli('zoho', 'status', 'business').status, 0);
  assert.notEqual(cli('zoho', 'rename', 'business', 'other').status, 0);
  assert.notEqual(cli('account', 'rename', 'business', 'other', 'extra').status, 0);
  writeFileSync(f.registry.file, '{broken');
  assert.match(cli('account', 'list').stdout, /INVALID_ACCOUNT_REGISTRY/);
  assert.match(cli('account', 'rename', 'home', 'new').stdout, /INVALID_ACCOUNT_REGISTRY/);
});
