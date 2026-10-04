import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MailStore, MailError } from '../mail/store.js';
import { syncMail, indexMail, freshness } from '../mail/commands.js';
import { indexRetryPlan, nextMailWork } from '../mail/jobs.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'index-review-')), store = new MailStore(root);
  store.saveAccount({ alias: 'fixture', provider: 'gmail', email: 'fixture@example.test', polling: true,
    oauth: { clientId: 'fixture', refreshToken: 'fixture', accessToken: 'fixture', expiresAt: 0 } });
  mkdirSync(store.path('state', 'fixture'), { recursive: true });
  return { store, root, syncPath: store.path('state', 'fixture.json'), indexPath: store.path('state', 'fixture', 'index-status.json'),
    old: new Date(Date.now() - 15 * 60000).toISOString(), clean: () => rmSync(root, { recursive: true, force: true }) };
}

for (const quota of [false, true]) {
  test(`scheduled downloads preserve index cooldown across pending/restart (quota=${quota})`, async () => {
    const f = fixture();
    try {
      f.store.write(f.syncPath, { status: 'failed', phase: 'index', attemptedAt: f.old, downloadCompletedAt: f.old, error: 'MAIL_TIMEOUT' });
      const recent = new Date(Date.now() - 60000).toISOString();
      f.store.write(f.indexPath, { status: 'failed', attemptedAt: recent, completedAt: recent, failures: 7 });
      const deadline = indexRetryPlan(f.store.indexStatus('fixture')).nextRetryAt!;
      assert.equal(nextMailWork(f.store.status('fixture'), f.store.indexStatus('fixture')), 'sync');
      const calls: string[] = [];
      const run = async (file: string) => {
        calls.push(file);
        if (quota) throw new MailError('MAIL_QUOTA');
        return '';
      };
      await syncMail(f.store, 'fixture', true, undefined, run);
      assert.deepEqual(calls, ['/usr/bin/mbsync']);
      const reopened = new MailStore(f.root);
      assert.equal(reopened.indexStatus('fixture')?.status, 'pending');
      assert.equal(reopened.indexStatus('fixture')?.failures, 7);
      assert.equal(indexRetryPlan(reopened.indexStatus('fixture')).nextRetryAt, deadline);
      assert.equal(reopened.status('fixture')?.indexDeferred, true);
      assert.equal(reopened.status('fixture')?.lastSuccess, undefined, 'No false full-sync success timestamp');
      assert.equal(freshness(reopened, 'fixture').partial, true);
      assert.equal(freshness(reopened, 'fixture').indexedAt, null, 'No claimed index before first successful indexing');
      assert.equal((await indexMail(reopened, 'fixture', async () => { throw new Error('Must not run'); }, true)).skipped, true);
      if (quota) {
        assert.equal(reopened.status('fixture')?.error, 'MAIL_QUOTA');
        assert.equal(nextMailWork(reopened.status('fixture'), reopened.indexStatus('fixture'), Date.parse(deadline)), 'index');
      } else {
        // Another scheduled download cannot reset the retained deadline either.
        reopened.write(f.syncPath, { ...reopened.status('fixture'), completedAt: f.old });
        await syncMail(reopened, 'fixture', true, undefined, run);
        assert.deepEqual(calls, ['/usr/bin/mbsync', '/usr/bin/mbsync']);
        assert.equal(indexRetryPlan(reopened.indexStatus('fixture')).nextRetryAt, deadline);
      }
      const syncBeforeIndex = reopened.status('fixture');
      // A deliberate manual index overrides backoff but leaves download history alone.
      await indexMail(reopened, 'fixture', async file => { assert.equal(file, '/usr/bin/notmuch'); return ''; });
      assert.equal(reopened.indexStatus('fixture')?.retryNotBefore, undefined);
      assert.equal(reopened.indexStatus('fixture')?.failures, 0);
      assert.deepEqual(reopened.status('fixture'), syncBeforeIndex);
      assert.equal(freshness(reopened, 'fixture').partial, quota);
    } finally { f.clean(); }
  });
}

test('diagnose exposes independent index diagnostics and interrupted indexing, respecting account locks', async () => {
  const f = fixture();
  const diagnose = () => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', resolve('mail/cli.ts'), 'diagnose', 'fixture'], {
    env: { ...process.env, MAIL_DIR: f.root, PUBLIC_ORIGIN: 'https://fixture.example' }, encoding: 'utf8',
  }));
  try {
    f.store.write(f.syncPath, { status: 'ok', attemptedAt: f.old, completedAt: f.old });
    f.store.write(f.indexPath, { status: 'failed', attemptedAt: f.old,
      diagnostic: { category: 'timeout', elapsedMs: 3600000, timeoutMs: 3600000 } });
    const failed = diagnose();
    assert.equal(failed.diagnosticAvailable, true);
    assert.equal(failed.indexDiagnosticAvailable, true);
    assert.equal(failed.syncDiagnosticAvailable, false);
    f.store.write(f.indexPath, { status: 'indexing', attemptedAt: f.old });
    const interrupted = diagnose();
    assert.equal(interrupted.potentiallyInterrupted, true);
    assert.equal(interrupted.indexPotentiallyInterrupted, true);
    assert.equal(interrupted.syncPotentiallyInterrupted, false);
    await f.store.withAccountSyncLock('fixture', async () => {
      const active = diagnose();
      assert.equal(active.indexPotentiallyInterrupted, false);
      assert.equal(active.potentiallyInterrupted, false);
    });
    f.store.write(f.indexPath, { status: 'pending', attemptedAt: f.old, retryNotBefore: 'invalid-date' });
    assert.equal(diagnose().potentiallyInterrupted, false, 'Deferred indexing is not a running/interrupted marker');
    assert.equal(f.store.indexStatus('fixture')?.retryNotBefore, undefined);
  } finally { f.clean(); }
});
