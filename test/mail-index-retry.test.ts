import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { execFileSync, type spawn, type ChildProcess } from 'node:child_process';
import { MailStore, MailError } from '../mail/store.js';
import { indexRetryPlan, nextMailWork, retryPlan } from '../mail/jobs.js';
import { syncMail, indexMail, freshness } from '../mail/commands.js';
import { MailScheduler } from '../mail/scheduler.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'index-retry-')), store = new MailStore(root);
  store.saveAccount({ alias: 'fixture', provider: 'gmail', email: 'fixture@example.test', polling: true,
    oauth: { clientId: 'fixture', refreshToken: 'fixture', accessToken: 'fixture', expiresAt: 0 } });
  mkdirSync(store.path('state', 'fixture'), { recursive: true });
  return { root, store, old: new Date(Date.now() - 11 * 60000).toISOString(), clean: () => rmSync(root, { recursive: true, force: true }) };
}

test('index retry policy: pending, interrupted, bounded exponential backoff, and separate download eligibility', () => {
  const time = '2026-10-03T00:00:00.000Z', start = Date.parse(time);
  assert.equal(indexRetryPlan(undefined).nextRetryAt, null);
  assert.equal(indexRetryPlan({ status: 'ok', attemptedAt: time }).nextRetryAt, null);
  assert.equal(indexRetryPlan({ status: 'pending', attemptedAt: time }).nextRetryAt, time);
  assert.equal(Date.parse(indexRetryPlan({ status: 'indexing', attemptedAt: time }).nextRetryAt!) - start, 5 * 60000);
  for (const [failures, minutes] of [[undefined, 5], [1, 5], [2, 10], [1000, 360]]) {
    const plan = indexRetryPlan({ status: 'failed', attemptedAt: time, completedAt: time, failures });
    assert.equal(Date.parse(plan.nextRetryAt!) - start, minutes! * 60000);
  }
  const quota = { status: 'failed' as const, attemptedAt: time, completedAt: time, error: 'MAIL_QUOTA' };
  assert.equal(nextMailWork(quota, { status: 'failed', attemptedAt: time }, start + 4 * 60000), undefined);
  assert.equal(nextMailWork(quota, { status: 'failed', attemptedAt: time }, start + 5 * 60000), 'index');
  assert.equal(nextMailWork(undefined, undefined, start), 'sync', 'Do not index empty new accounts');
  assert.equal(nextMailWork(undefined, { status: 'pending', attemptedAt: time }, start), 'index', 'Recovery wins when both domains are due');
  const indexFailure = { ...quota, error: 'MAIL_TIMEOUT', phase: 'index' as const, downloadCompletedAt: time };
  assert.equal(retryPlan(indexFailure).reason, 'periodic_sync');
  assert.equal(Date.parse(retryPlan(indexFailure).nextRetryAt!) - start, 10 * 60000);
});

test('scheduled index retry recovers legacy failures during quota/auth blocks without touching download state', async () => {
  const f = fixture();
  try {
    for (const error of ['MAIL_QUOTA', 'RECONNECT_ACCOUNT']) {
      f.store.write(f.store.path('state', 'fixture.json'), { status: 'failed', attemptedAt: f.old, completedAt: f.old, error, failures: 3 });
      f.store.write(f.store.path('state', 'fixture', 'index-status.json'), { status: 'failed', attemptedAt: f.old, completedAt: f.old });
      const sync = f.store.status('fixture'), plan = retryPlan(sync), calls: string[] = [];
      const result = await indexMail(new MailStore(f.root), 'fixture', async file => { calls.push(file); return ''; }, true);
      assert.deepEqual(calls, ['/usr/bin/notmuch']);
      assert.equal(result.partial, true);
      assert.equal(f.store.indexStatus('fixture')?.failures, 0);
      assert.equal(freshness(f.store, 'fixture').partial, true);
      assert.deepEqual(f.store.status('fixture'), sync);
      assert.deepEqual(retryPlan(f.store.status('fixture')), plan);
      assert.equal(nextMailWork(sync, f.store.indexStatus('fixture')), undefined);
    }
  } finally { f.clean(); }
});

test('index-only retry repairs successful-download freshness without re-downloading or rewriting sync history', async () => {
  const f = fixture();
  try {
    await syncMail(f.store, 'fixture', false, undefined, async file => {
      if (file.endsWith('notmuch')) throw new MailError('MAIL_TIMEOUT');
      return '';
    });
    const sync = f.store.status('fixture')!;
    assert.equal(sync.phase, 'index');
    assert.equal(sync.failures, 0, 'Index failures do not count as download failures');
    assert.equal(f.store.indexStatus('fixture')?.failures, 1);
    assert.equal(freshness(f.store, 'fixture').partial, true);
    f.store.write(f.store.path('state', 'fixture', 'index-status.json'), { ...f.store.indexStatus('fixture'), completedAt: f.old });
    await indexMail(f.store, 'fixture', async file => { assert.equal(file, '/usr/bin/notmuch'); return ''; }, true);
    assert.deepEqual(f.store.status('fixture'), sync);
    assert.equal(f.store.indexStatus('fixture')?.completeThrough, sync.downloadCompletedAt);
    assert.equal(freshness(f.store, 'fixture').partial, false);
  } finally { f.clean(); }
});

test('download marks index pending durably before launch and retry cannot overlap a download', async () => {
  const f = fixture(), started = new EventEmitter();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const run = syncMail(f.store, 'fixture', false, undefined, async file => {
    if (file.endsWith('mbsync')) { started.emit('download'); await gate; }
    return '';
  });
  try {
    await once(started, 'download');
    const reopened = new MailStore(f.root), index = reopened.indexStatus('fixture');
    assert.equal(index?.status, 'pending');
    assert.equal(nextMailWork(reopened.status('fixture'), index), 'index');
    await assert.rejects(indexMail(reopened, 'fixture', async () => '', true), /MAIL_BUSY/);
  } finally { release(); await run; f.clean(); }
});

test('scheduled indexing rechecks pause/eligibility; failed retries back off and release locks', async () => {
  const f = fixture();
  try {
    const path = f.store.path('state', 'fixture', 'index-status.json');
    f.store.write(path, { status: 'pending', attemptedAt: f.old });
    const account = f.store.account('fixture'); account.polling = false; f.store.saveAccount(account);
    const noRun = async () => { throw new Error('Must not run'); };
    assert.equal((await indexMail(f.store, 'fixture', noRun, true)).skipped, true);
    const cliResult = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', resolve('mail/cli.ts'), 'index', 'fixture', '--scheduled'], {
      env: { ...process.env, MAIL_DIR: f.root, PUBLIC_ORIGIN: 'https://fixture.example' }, encoding: 'utf8',
    }));
    assert.equal(cliResult.skipped, true);
    account.polling = true; f.store.saveAccount(account);
    await assert.rejects(indexMail(f.store, 'fixture', async () => { throw new MailError('MAIL_TIMEOUT'); }, true), /MAIL_TIMEOUT/);
    assert.equal(f.store.indexStatus('fixture')?.failures, 1);
    assert.equal(await f.store.accountSyncLocked('fixture'), false);
    assert.equal((await indexMail(f.store, 'fixture', noRun, true)).skipped, true);
    // An abandoned indexing record becomes eligible after five minutes, but still needs the account lock.
    f.store.write(path, { status: 'indexing', attemptedAt: f.old, failures: 1 });
    await indexMail(new MailStore(f.root), 'fixture', async () => '', true);
    assert.equal(f.store.indexStatus('fixture')?.status, 'ok');
  } finally { f.clean(); }
});

test('scheduler shares capacity between sync/index; status exposes independent retry schedules', async () => {
  const f = fixture();
  const calls: string[][] = [];
  const launch = ((_file: string, args: string[]) => { calls.push(args); return new EventEmitter() as ChildProcess; }) as typeof spawn;
  const scheduler = new MailScheduler(f.store, '/fixture-cli', 'https://fixture.example', 2, launch);
  try {
    f.store.write(f.store.path('state', 'fixture.json'), { status: 'failed', attemptedAt: f.old, completedAt: f.old, error: 'MAIL_QUOTA' });
    f.store.write(f.store.path('state', 'fixture', 'index-status.json'), { status: 'failed', attemptedAt: f.old });
    for (const alias of ['second', 'third']) f.store.saveAccount({ ...f.store.account('fixture'), alias, email: `${alias}@example.test` });
    await scheduler.tick();
    assert.deepEqual(calls, [['/fixture-cli', 'index', 'fixture', '--scheduled'], ['/fixture-cli', 'sync', 'second', '--scheduled']]);
    await scheduler.tick();
    assert.equal(calls.length, 2);
    const report = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', resolve('mail/cli.ts'), 'jobs', 'status', 'fixture'], {
      env: { ...process.env, MAIL_DIR: f.root, PUBLIC_ORIGIN: 'https://fixture.example' }, encoding: 'utf8',
    }));
    assert.equal(report.jobs[0].reason, 'provider_quota');
    assert.equal(report.jobs[0].indexRetry.reason, 'index_failure_backoff');
    assert.equal(report.jobs[0].nextWork, 'index');
    assert.ok(report.jobs[0].indexRetry.nextRetryAt < report.jobs[0].nextRetryAt);
  } finally { await scheduler.close(); f.clean(); }
});
