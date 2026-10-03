import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOWNLOAD_SCOPE } from '../mail/config.js';
import { downloadTimeout } from '../mail/download-policy.js';
import { MailStore, MailError, type SyncStatus } from '../mail/store.js';
import { syncMail } from '../mail/commands.js';

const routine = 15 * 60000, backfill = 6 * 60 * 60000;
const attemptedAt = '2026-10-03T00:00:00.000Z';
const oldScope = 'sha256:' + '0'.repeat(64);

test('download policy: missing/legacy/changed scope backfills, matching scope routine, bounded override', () => {
  const legacy: SyncStatus = { status: 'ok', attemptedAt, lastSuccess: attemptedAt };
  assert.equal(downloadTimeout(undefined, {}), backfill);
  assert.equal(downloadTimeout(legacy, {}), backfill);
  assert.equal(downloadTimeout({ ...legacy, completedDownloadScope: oldScope }, {}), backfill);
  const complete = { ...legacy, completedDownloadScope: DOWNLOAD_SCOPE };
  assert.equal(downloadTimeout(complete, {}), routine);
  assert.equal(downloadTimeout({ ...complete, status: 'failed' }, {}), routine);
  for (const previous of [undefined, complete]) {
    assert.equal(downloadTimeout(previous, { MAIL_SYNC_TIMEOUT_MINUTES: '120' }), 120 * 60000);
    for (const invalid of ['', '0', '-1', '1.5', 'Infinity', '1441', 'secret-value']) {
      assert.throws(() => downloadTimeout(previous, { MAIL_SYNC_TIMEOUT_MINUTES: invalid }), /^Error: INVALID_MAIL_CONFIG$/);
    }
  }
});

test('scope survives failed retries/restarts; only successful download promotes it, even when indexing fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mail-scope-'));
  const previousOverride = process.env.MAIL_SYNC_TIMEOUT_MINUTES;
  delete process.env.MAIL_SYNC_TIMEOUT_MINUTES;
  let store = new MailStore(root);
  store.saveAccount({ alias: 'fixture', provider: 'gmail', email: 'fixture@example.test', polling: true,
    oauth: { clientId: 'fixture', refreshToken: 'fixture', accessToken: 'fixture', expiresAt: 0 } });
  const statusPath = store.path('state', 'fixture.json');
  try {
    store.write(statusPath, { status: 'failed', attemptedAt, completedDownloadScope: oldScope });
    const timeouts: number[] = [];
    const attempt = async (failure?: 'download' | 'index', scheduled = false) => {
      await syncMail(store, 'fixture', scheduled, undefined, async (file, _args, _env, timeout) => {
        if (file.endsWith('mbsync')) timeouts.push(timeout!);
        if ((file.endsWith('mbsync') && failure === 'download') || (file.endsWith('notmuch') && failure === 'index')) {
          throw new MailError('MAIL_TIMEOUT');
        }
        return '';
      });
      store = new MailStore(root); // Read the persisted/sanitized state, not an in-memory object.
    };
    await attempt('download', true);
    assert.equal(store.status('fixture')?.completedDownloadScope, oldScope);
    await attempt('index');
    assert.equal(store.status('fixture')?.status, 'failed');
    assert.equal(store.status('fixture')?.completedDownloadScope, DOWNLOAD_SCOPE);
    await attempt('download');
    assert.equal(store.status('fixture')?.completedDownloadScope, DOWNLOAD_SCOPE);
    await attempt();
    assert.equal(store.status('fixture')?.status, 'ok');
    assert.deepEqual(timeouts, [backfill, backfill, routine, routine]);
    store.write(statusPath, { status: 'ok', attemptedAt, completedDownloadScope: 'untrusted-state-value' });
    assert.equal(store.status('fixture')?.completedDownloadScope, undefined);
  } finally {
    if (previousOverride === undefined) delete process.env.MAIL_SYNC_TIMEOUT_MINUTES;
    else process.env.MAIL_SYNC_TIMEOUT_MINUTES = previousOverride;
    rmSync(root, { recursive: true, force: true });
  }
});
