import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mailRuntime } from '../mail/runtime.js';
import { MailAccounts } from '../mail/account-registry.js';
import { gmailAdapter } from '../mail/providers.js';
import { MailScheduler } from '../mail/scheduler.js';
import { syncMail } from '../mail/commands.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'mail-scheduler-registry-'));
  const previous = { MAIL_DIR: process.env.MAIL_DIR, GOOGLE_DIR: process.env.GOOGLE_DIR, PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN };
  process.env.MAIL_DIR = join(root, 'mail');
  process.env.GOOGLE_DIR = join(root, 'google');
  process.env.PUBLIC_ORIGIN = 'https://fixture.example';
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const runtime = mailRuntime();
  runtime.store.saveAccount({ alias: 'original', provider: 'gmail', email: 'fixture@example.test', polling: false,
    oauth: { clientId: 'fixture.apps.googleusercontent.com', refreshToken: 'fixture-refresh', accessToken: 'fixture-access', expiresAt: 0 } });
  return runtime;
}

test('shared server/CLI mail runtime schedules stable IDs after migration, rename and restart', async t => {
  const { store } = fixture(t);
  const accounts = new MailAccounts(store.registry!, [gmailAdapter(store)]);
  await accounts.migrate();
  const id = accounts.resolve('original').account.id;
  await accounts.rename(id, 'renamed');
  assert.throws(() => store.registry!.resolve('original'), /ACCOUNT_NOT_CONNECTED/);
  const account = store.account(id); account.polling = true; store.saveAccount(account);
  // Restart the composition root used by server/main.ts and mail/cli.ts.
  const restarted = mailRuntime();
  assert.equal(restarted.store.accounts()[0].alias, id);
  assert.equal(restarted.store.accountLabel(id), 'renamed');
  const calls: { args: string[]; options: SpawnOptions; child: ChildProcess }[] = [];
  const launch = ((_file: string, args: string[], options: SpawnOptions) => {
    const child = new EventEmitter() as ChildProcess; calls.push({ args, options, child }); return child;
  }) as typeof spawn;
  const scheduler = new MailScheduler(restarted.store, resolve('dist/mail/cli.js'), 'https://fixture.example', 1, launch, () => {});
  try {
    await scheduler.tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(1), ['sync', id, '--scheduled']);
    // Rename again after dispatch. Stable identity still resolves in a separate
    // real CLI worker; pausing before it runs guarantees no provider contact.
    await accounts.rename(id, 'renamed-again');
    account.polling = false; store.saveAccount(account);
    const child = spawnSync(process.execPath, calls[0].args, { env: calls[0].options.env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { results: [] });
    const skipped = JSON.parse(child.stderr);
    assert.equal(skipped.event, 'mail.job.skipped');
    assert.equal(skipped.reason, 'paused');
    assert.equal(skipped.accountId, id);
    assert.equal(skipped.attemptId, calls[0].options.env!.NOOKFRAME_MAIL_ATTEMPT_ID);
    calls[0].child.emit('close', 0, null);
    account.polling = true; store.saveAccount(account);
    // Exercise the actual scheduled sync path with fake private subprocesses.
    const executed: string[] = [];
    const result = await syncMail(mailRuntime().store, id, true, undefined, async file => { executed.push(file); return ''; }, () => {});
    assert.equal(result.results[0].status, 'ok');
    assert.equal(result.results[0].account, 'renamed-again');
    assert.deepEqual(executed, ['/usr/bin/mbsync', '/usr/bin/notmuch']);
    assert.equal(store.path('maildir', id), join(store.root, 'maildir', 'original'));
    assert.equal(store.status(id)?.status, 'ok');
  } finally { await scheduler.close(); }
});

test('scheduled CLI reports account-resolution failures on stderr without starting a job or exposing private state', async t => {
  const { store } = fixture(t);
  const accounts = new MailAccounts(store.registry!, [gmailAdapter(store)]);
  await accounts.migrate();
  const id = accounts.resolve('original').account.id;
  await accounts.rename(id, 'renamed');
  const attemptId = '12345678-1234-1234-1234-123456789abc';
  for (const work of ['sync', 'index']) {
    const result = spawnSync(process.execPath, [resolve('dist/mail/cli.js'), work, 'original', '--scheduled'], {
      env: { ...process.env, NOOKFRAME_MAIL_ATTEMPT_ID: attemptId }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error, 'ACCOUNT_NOT_CONNECTED');
    const event = JSON.parse(result.stderr);
    assert.equal(event.event, 'mail.worker.failed');
    assert.equal(event.work, work);
    assert.equal(event.errorCode, 'ACCOUNT_NOT_CONNECTED');
    assert.equal(event.attemptId, attemptId);
    assert.equal(event.scheduled, true);
    assert.match(event.accountId, /^legacy-/);
    for (const privateValue of ['original', 'fixture-refresh', 'fixture-access', 'fixture@example.test', store.root]) {
      assert.ok(!result.stderr.includes(privateValue), `logs must not contain ${privateValue}`);
    }
  }
});

test('legacy installations still schedule legacy names before registry migration', async t => {
  const { store } = fixture(t);
  const account = store.account('original'); account.polling = true; store.saveAccount(account);
  const restarted = mailRuntime();
  assert.equal(restarted.store.registry!.enabled, false);
  const calls: string[][] = [];
  const scheduler = new MailScheduler(restarted.store, '/fixture-cli', 'https://fixture.example', 1,
    ((_file: string, args: string[]) => { calls.push(args); return new EventEmitter() as ChildProcess; }) as typeof spawn, () => {});
  try {
    await scheduler.tick();
    assert.deepEqual(calls[0], ['/fixture-cli', 'sync', 'original', '--scheduled']);
  } finally { await scheduler.close(); }
});
