import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { MailStore } from '../mail/store.js';
import { syncMail, indexMail } from '../mail/commands.js';
import { MailScheduler, mailConcurrency } from '../mail/scheduler.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mail-concurrency-'));
  const store = new MailStore(root);
  for (const alias of ['first', 'second', 'third']) store.saveAccount({ alias, provider: 'gmail', email: `${alias}@example.test`, polling: true,
    oauth: { clientId: 'fixture', refreshToken: 'fixture', accessToken: 'fixture', expiresAt: 0 } });
  return { store, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test('account locks exclude same-account sync/index across store instances, not other accounts', async () => {
  const f = fixture(), other = new MailStore(f.store.root);
  try {
    await f.store.withAccountSyncLock('first', async () => {
      assert.equal(await other.accountSyncLocked('first'), true);
      assert.equal(await other.accountSyncLocked('second'), false);
      const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath,
        ['--import', 'tsx', resolve('mail/cli.ts'), ...args], {
          env: { ...process.env, MAIL_DIR: f.store.root, PUBLIC_ORIGIN: 'http://localhost:3000' }, encoding: 'utf8',
        }));
      const report = cli('jobs', 'status');
      assert.equal(report.syncLockHeld, true);
      assert.deepEqual(report.jobs.map((job: { syncLockHeld: boolean }) => job.syncLockHeld), [true, false, false]);
      assert.equal(cli('diagnose', 'first').syncLockHeld, true);
      assert.equal(cli('diagnose', 'second').syncLockHeld, false);
      assert.equal(cli('jobs', 'status', 'second').syncLockHeld, false);
      await assert.rejects(syncMail(other, 'first'), /MAIL_BUSY/);
      await assert.rejects(indexMail(other, 'first'), /MAIL_BUSY/);
      const result = await syncMail(other, undefined, false, undefined, async () => '');
      assert.deepEqual(result.results.map(r => [r.account, r.status]), [['first', 'busy'], ['second', 'ok'], ['third', 'ok']]);
      assert.equal(other.status('first'), undefined);
      await indexMail(other, 'second', async () => '');
    });
    assert.equal(await other.accountSyncLocked('first'), false);
  } finally { f.clean(); }
});

test('different account downloads overlap while same-account index is excluded', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new EventEmitter();
  const first = syncMail(f.store, 'first', false, undefined, async file => {
    if (file.endsWith('mbsync')) { started.emit('download'); await gate; }
    return '';
  });
  try {
    await once(started, 'download');
    const second = await syncMail(f.store, 'second', false, undefined, async () => '');
    assert.equal(second.results[0].status, 'ok');
    assert.equal(await f.store.accountSyncLocked('first'), true);
    await assert.rejects(indexMail(f.store, 'first'), /MAIL_BUSY/);
  } finally { release(); await first; f.clean(); }
});

test('scheduler capacity, account-specific workers, pause/busy checks and slot reuse', async () => {
  const f = fixture();
  const calls: { args: string[]; child: ChildProcess }[] = [];
  const launch = ((_file: string, args: string[]) => {
    const child = new EventEmitter() as ChildProcess;
    calls.push({ args, child });
    return child;
  }) as typeof spawn;
  const scheduler = new MailScheduler(f.store, '/fixture-cli', 'http://localhost', 2, launch);
  try {
    await scheduler.tick();
    assert.deepEqual(calls.map(c => c.args), [
      ['/fixture-cli', 'sync', 'first', '--scheduled'], ['/fixture-cli', 'sync', 'second', '--scheduled'],
    ]);
    await scheduler.tick();
    assert.equal(calls.length, 2);
    const account = f.store.account('first'); account.polling = false; f.store.saveAccount(account);
    calls[0].child.emit('close');
    await f.store.withAccountSyncLock('third', async () => {
      await scheduler.tick();
      assert.equal(calls.length, 2);
    });
    await scheduler.tick();
    assert.equal(calls[2].args[2], 'third');
    // Even a worker queued before pause rechecks opt-in after acquiring its lock.
    const result = await syncMail(f.store, 'first', true, undefined, async () => { throw new Error('Must not start'); });
    assert.deepEqual(result.results, []);
    await scheduler.close();
    await scheduler.tick();
    assert.equal(calls.length, 3);
    assert.equal(mailConcurrency('2'), 2);
    for (const value of ['0', '9', '2.5', 'invalid']) assert.throws(() => mailConcurrency(value), /INVALID_MAIL_CONFIG/);
  } finally { await scheduler.close(); f.clean(); }
});

test('scheduler shutdown terminates and awaits every worker process group', { timeout: 15000 }, async () => {
  const f = fixture();
  const children: ChildProcess[] = [];
  const launch = (() => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    children.push(child);
    return child;
  }) as typeof spawn;
  const scheduler = new MailScheduler(f.store, '/fixture-cli', 'http://localhost', 2, launch);
  try {
    await scheduler.tick();
    assert.equal(children.length, 2);
    const exited = children.map(child => once(child, 'close'));
    await scheduler.close();
    await Promise.all(exited);
    for (const child of children) assert.throws(() => process.kill(child.pid!, 0), /ESRCH/);
  } finally { await scheduler.close(); f.clean(); }
});
