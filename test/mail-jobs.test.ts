import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MailStore } from '../mail/store.js';
import { syncMail, indexMail, freshness, MailCommandError } from '../mail/commands.js';
import { classifyFailure } from '../mail/diagnostics.js';
import { retryPlan, jobDue } from '../mail/jobs.js';

test('job policy: quota/legacy cooldown, exponential backoff, auth pause and restart recovery', () => {
  const now = Date.now(), attemptedAt = new Date(now).toISOString();
  for (const error of ['MAIL_QUOTA', 'MAIL_COMMAND_FAILED']) {
    const s = { status: 'failed' as const, attemptedAt, error };
    assert.equal(Date.parse(retryPlan(s).nextRetryAt!) - now, 24 * 3600000);
    assert.equal(jobDue(s, now + 3600000), false);
  }
  assert.equal(retryPlan({ status: 'failed', attemptedAt, error: 'RECONNECT_ACCOUNT' }).nextRetryAt, null);
  assert.equal(Date.parse(retryPlan({ status: 'failed', attemptedAt, failures: 3 }).nextRetryAt!) - now, 20 * 60000);
  assert.equal(jobDue({ status: 'syncing', attemptedAt }, now + 10 * 60000), false);
});

test('scheduled work rechecks pause before queued accounts and indexes after download failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mail-queue-')), store = new MailStore(root);
  for (const alias of ['first', 'second']) store.saveAccount({ alias, provider: 'gmail', email: `${alias}@example.test`, polling: true, oauth: { clientId: 'fixture', refreshToken: 'fixture', accessToken: 'fixture', expiresAt: 0 } });
  try {
    const calls: string[] = [];
    await syncMail(store, undefined, true, undefined, async file => {
      calls.push(file);
      if (file.endsWith('mbsync')) {
        const queued = store.account('second'); queued.polling = false; store.saveAccount(queued);
        throw new MailCommandError(classifyFailure({ code: 1 }, '[OVERQUOTA]', false, 1, 900000));
      }
      assert.equal(store.status('first')?.error, 'MAIL_QUOTA', 'Quota failure is durable before indexing starts');
      return '';
    });
    assert.deepEqual(calls, ['/usr/bin/mbsync', '/usr/bin/notmuch']);
    assert.equal(store.status('second'), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed downloads index partial mail; opt-in/cooldown/pause survive CLI replacement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mail-jobs-')), store = new MailStore(root);
  store.saveAccount({ alias: 'fixture', provider: 'gmail', email: 'fixture@example.test', polling: false, oauth: { clientId: 'fixture', refreshToken: 'private-fixture-secret', accessToken: 'private-fixture-secret', expiresAt: 0 } });
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', resolve('mail/cli.ts'), ...args], { env: { ...process.env, MAIL_DIR: root, PUBLIC_ORIGIN: 'http://localhost:3000' }, encoding: 'utf8' }));
  try {
    const calls: string[] = [];
    await syncMail(store, 'fixture', false, undefined, async file => {
      calls.push(file);
      if (file.endsWith('mbsync')) throw new MailCommandError(classifyFailure({ code: 1 }, '[OVERQUOTA]', false, 1, 900000));
      return '';
    });
    assert.deepEqual(calls, ['/usr/bin/mbsync', '/usr/bin/notmuch']);
    assert.equal(store.status('fixture')?.error, 'MAIL_QUOTA');
    assert.equal(store.indexStatus('fixture')?.status, 'ok');
    assert.equal(freshness(store, 'fixture').partial, true);
    assert.ok(freshness(store, 'fixture').indexedAt);
    const first = cli('jobs', 'enable', 'fixture');
    assert.equal(first.reason, 'provider_quota');
    assert.equal(cli('jobs', 'enable', 'fixture').nextRetryAt, first.nextRetryAt);
    assert.equal(cli('jobs', 'status').jobs[0].enabled, true);
    await syncMail(store, undefined, true, undefined, async () => { throw new Error('Must not retry during cooldown'); });
    cli('jobs', 'pause', 'fixture');
    assert.equal(new MailStore(root).account('fixture').polling, false);
    await indexMail(store, 'fixture', async () => '');
    assert.equal(store.status('fixture')?.error, 'MAIL_QUOTA', 'Local indexing preserves provider cooldown');
    assert.ok(!JSON.stringify(cli('jobs', 'status')).includes('private-fixture-secret'));
    await syncMail(store, 'fixture', false, undefined, async () => '');
    assert.equal(freshness(store, 'fixture').partial, false);
    assert.equal(store.status('fixture')?.failures, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
