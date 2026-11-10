import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { MailScheduler } from '../mail/scheduler.js';
import { MailStore } from '../mail/store.js';
import { syncMail, indexMail } from '../mail/commands.js';
import { createMailLog } from '../mail/logging.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mail-health-')), store = new MailStore(root);
  for (const alias of ['first', 'second']) store.saveAccount({ alias, provider: 'gmail', email: `${alias}@example.test`, polling: true,
    oauth: { clientId: 'fixture', refreshToken: 'fixture', accessToken: 'fixture', expiresAt: 0 } });
  const lines: string[] = [];
  const log = createMailLog({ write: line => { lines.push(line); } });
  return { store, log, events: () => lines.map(line => JSON.parse(line)), clean: () => rmSync(root, { recursive: true, force: true }) };
}

test('persistent capacity blocking warns at bounded intervals, recovers and ages overdue health', async () => {
  const f = fixture();
  let now = Date.now();
  const children: ChildProcess[] = [];
  const launch = (() => { const child = new EventEmitter() as ChildProcess; children.push(child); return child; }) as typeof spawn;
  const scheduler = new MailScheduler(f.store, '/fixture-cli', 'http://localhost', 1, launch, f.log, () => now);
  try {
    await scheduler.tick();
    assert.equal(f.events().filter(e => e.event === 'mail.job.blocked').length, 0);
    now += 5 * 60000; await scheduler.tick();
    let blocked = f.events().filter(e => e.event === 'mail.job.blocked');
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].reason, 'capacity');
    assert.equal(blocked[0].durationMs, 5 * 60000);
    assert.equal(f.events().at(-1).capacityBlockedAccounts, 1);
    now += 60000; await scheduler.tick();
    assert.equal(f.events().filter(e => e.event === 'mail.job.blocked').length, 1);
    now += 9 * 60000; await scheduler.tick();
    blocked = f.events().filter(e => e.event === 'mail.job.blocked');
    assert.equal(blocked.length, 2);
    assert.equal(f.events().at(-1).oldestOverdueMs, 15 * 60000);
    assert.equal(f.events().at(-1).level, 'warn');
    const first = f.store.account('first'); first.polling = false; f.store.saveAccount(first);
    children[0].emit('close', 0, null);
    await scheduler.tick();
    assert.equal(f.events().filter(e => e.event === 'mail.job.unblocked').length, 1);
    assert.equal(children.length, 2);
  } finally { await scheduler.close(); f.clean(); }
});

test('persistent locks identify the account without logging every eligibility tick', async () => {
  const f = fixture();
  let now = Date.now();
  const scheduler = new MailScheduler(f.store, '/fixture-cli', 'http://localhost', 2,
    (() => new EventEmitter() as ChildProcess) as typeof spawn, f.log, () => now);
  try {
    await f.store.withAccountSyncLock('first', async () => {
      await scheduler.tick();
      now += 5 * 60000; await scheduler.tick();
      const blocked = f.events().find(e => e.event === 'mail.job.blocked');
      assert.equal(blocked.reason, 'locked');
      assert.match(blocked.accountId, /^legacy-/);
    });
    await scheduler.tick();
    assert.equal(f.events().filter(e => e.event === 'mail.job.unblocked').length, 1);
  } finally { await scheduler.close(); f.clean(); }
});

test('sync records independent index retry after a completed download, and index success has a terminal event', async () => {
  const f = fixture();
  try {
    await syncMail(f.store, 'first', false, undefined, async file => {
      if (file.endsWith('notmuch')) throw new Error('private-index-output');
      return '';
    }, f.log);
    const terminal = f.events().at(-1);
    assert.equal(terminal.event, 'mail.job.failed');
    assert.equal(terminal.phase, 'index');
    assert.equal(terminal.downloadCompleted, true);
    assert.equal(terminal.indexDeferred, false);
    assert.ok(Date.parse(terminal.indexNextRetryAt) < Date.parse(terminal.nextRetryAt));
    await indexMail(f.store, 'first', async () => '', false, f.log);
    assert.equal(f.events().at(-1).event, 'mail.job.succeeded');
    assert.equal(f.events().at(-1).work, 'index');
    assert.equal(f.events().at(-1).nextRetryAt, null);
    assert.ok(!JSON.stringify(f.events()).includes('private-index-output'));
  } finally { f.clean(); }
});

test('synchronous spawn failures are sanitized and do not suppress attempts on other accounts', async () => {
  const f = fixture();
  let calls = 0;
  const scheduler = new MailScheduler(f.store, '/fixture-cli', 'http://localhost', 1,
    (() => { calls++; throw new Error('private-token'); }) as typeof spawn, f.log);
  try {
    await scheduler.tick();
    assert.equal(calls, 2);
    assert.equal(f.events().filter(e => e.event === 'mail.job.failed' && e.errorCode === 'WORKER_SPAWN_FAILED').length, 2);
    assert.ok(!JSON.stringify(f.events()).includes('private-token'));
  } finally { await scheduler.close(); f.clean(); }
});
