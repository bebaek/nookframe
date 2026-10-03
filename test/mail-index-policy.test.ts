import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexTimeout } from '../mail/index-policy.js';
import { indexMail, syncMail, MailCommandError } from '../mail/commands.js';
import { MailStore, MailError } from '../mail/store.js';
import { classifyFailure } from '../mail/diagnostics.js';

test('index deadline defaults to an hour and validates a bounded override', () => {
  assert.equal(indexTimeout({}), 3600000);
  for (const minutes of [1, 120, 1440]) assert.equal(indexTimeout({ MAIL_INDEX_TIMEOUT_MINUTES: String(minutes) }), minutes * 60000);
  for (const value of ['', '0', '-1', '1.5', '1441', 'Infinity', 'private-fixture-value']) {
    assert.throws(() => indexTimeout({ MAIL_INDEX_TIMEOUT_MINUTES: value }), /^Error: INVALID_MAIL_CONFIG$/);
  }
});

test('automatic and local-only indexing share deadlines without clearing download cooldowns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mail-index-timeout-'));
  const store = new MailStore(root);
  const override = process.env.MAIL_INDEX_TIMEOUT_MINUTES;
  store.saveAccount({ alias: 'fixture', provider: 'gmail', email: 'fixture@example.test', polling: true,
    oauth: { clientId: 'fixture', refreshToken: 'fixture', accessToken: 'fixture', expiresAt: 0 } });
  try {
    delete process.env.MAIL_INDEX_TIMEOUT_MINUTES;
    const calls: Array<[string, number | undefined]> = [];
    await syncMail(store, 'fixture', true, undefined, async (file, _args, _env, timeout) => {
      calls.push([file, timeout]);
      if (file.endsWith('mbsync')) throw new MailError('MAIL_QUOTA');
      return '';
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], ['/usr/bin/notmuch', 3600000]);
    const downloadState = store.status('fixture');
    assert.equal(downloadState?.error, 'MAIL_QUOTA');
    process.env.MAIL_INDEX_TIMEOUT_MINUTES = '120';
    let indexDeadline: number | undefined;
    const localCalls: string[] = [];
    const result = await indexMail(store, 'fixture', async (file, _args, _env, timeout) => {
      localCalls.push(file); indexDeadline = timeout;
      return '';
    });
    assert.deepEqual(localCalls, ['/usr/bin/notmuch']);
    assert.equal(indexDeadline, 7200000);
    assert.equal(result.partial, true);
    assert.deepEqual(store.status('fixture'), downloadState, 'Index-only must preserve quota/backoff state');
    process.env.MAIL_INDEX_TIMEOUT_MINUTES = 'invalid';
    await assert.rejects(indexMail(store, 'fixture', async () => { throw new Error('Must not launch'); }), /INVALID_MAIL_CONFIG/);
    assert.equal(store.indexStatus('fixture')?.status, 'failed');
    assert.equal(await store.accountSyncLocked('fixture'), false);
    process.env.MAIL_INDEX_TIMEOUT_MINUTES = '120';
    await assert.rejects(indexMail(store, 'fixture', async (_file, _args, _env, timeout) => {
      throw new MailCommandError(classifyFailure({ signal: 'SIGTERM' }, '', true, timeout!, timeout!));
    }), /MAIL_TIMEOUT/);
    assert.equal(store.indexStatus('fixture')?.diagnostic?.timeoutMs, 7200000);
    assert.deepEqual(store.status('fixture'), downloadState);
  } finally {
    if (override === undefined) delete process.env.MAIL_INDEX_TIMEOUT_MINUTES;
    else process.env.MAIL_INDEX_TIMEOUT_MINUTES = override;
    rmSync(root, { recursive: true, force: true });
  }
});
