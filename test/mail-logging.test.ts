import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createMailLog, safeMailError, type MailLogFields } from '../mail/logging.js';
import { MailScheduler } from '../mail/scheduler.js';
import { MailStore } from '../mail/store.js';
import { syncMail, indexMail, MailCommandError } from '../mail/commands.js';
import { classifyFailure } from '../mail/diagnostics.js';

function capture() {
  const lines: string[] = [];
  const log = createMailLog({ write: line => { lines.push(line); } });
  return { log, lines, events: () => lines.map(line => JSON.parse(line)) };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mail-logging-')), store = new MailStore(root);
  store.saveAccount({ alias: 'private-name', provider: 'gmail', email: 'private-email@example.test', polling: true,
    oauth: { clientId: 'private-client', refreshToken: 'private-token', accessToken: 'private-access', expiresAt: 0 } });
  return { root, store, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test('structured logging projects only safe fields, masks legacy aliases and excludes arbitrary errors', () => {
  const c = capture();
  c.log('mail.job.failed', { accountId: 'private-name', attemptId: 'private-token', errorCode: 'PRIVATE_TOKEN',
    phase: 'private-phase', signal: 'private-signal', reason: 'private-reason', nextRetryAt: 'private-date',
    durationMs: Infinity, err: new Error('private-message'), token: 'private-token', email: 'private-email' } as MailLogFields, 'warn');
  const [event] = c.events();
  assert.deepEqual(Object.keys(event).sort(), ['accountId', 'component', 'errorCode', 'event', 'level', 'service', 'slot', 'time'].sort());
  assert.match(event.accountId, /^legacy-[a-f0-9]{16}$/);
  assert.equal(event.errorCode, 'MAIL_OPERATION_FAILED');
  assert.equal(event.level, 'warn');
  assert.equal(event.service, 'nookframe');
  assert.equal(event.component, 'mail');
  assert.match(event.time, /^\d{4}-.*Z$/);
  assert.ok(!c.lines.join('').includes('private-'));
  assert.equal(safeMailError(new Error('private-token')), 'MAIL_OPERATION_FAILED');
  assert.equal(safeMailError({ code: 'PRIVATE_TOKEN' }), 'MAIL_OPERATION_FAILED');
  assert.equal(safeMailError({ code: 'MAIL_QUOTA' }), 'MAIL_QUOTA');
});

test('sync and independent index log correlated lifecycle, failures and retry deadlines without private output', async () => {
  const f = fixture(), c = capture();
  try {
    await syncMail(f.store, 'private-name', false, undefined, async () => 'private-stdout', c.log);
    const events = c.events();
    assert.deepEqual(events.map(e => e.event), ['mail.job.started', 'mail.job.phase_changed', 'mail.job.phase_changed', 'mail.job.phase_changed', 'mail.job.succeeded']);
    assert.deepEqual(events.filter(e => e.phase).map(e => e.phase), ['preparing', 'download', 'index', 'complete']);
    assert.equal(new Set(events.map(e => e.attemptId)).size, 1);
    assert.equal(events.at(-1).nextRetryAt, new Date(Date.parse(f.store.status('private-name')!.completedAt!) + 600000).toISOString());
    const failed = capture();
    await syncMail(f.store, 'private-name', false, undefined, async file => {
      if (file.endsWith('mbsync')) throw new MailCommandError(classifyFailure({ code: 1 }, '[OVERQUOTA] private-stderr private-token', false, 12, 1000));
      return '';
    }, failed.log);
    const terminal = failed.events().at(-1);
    assert.equal(terminal.event, 'mail.job.failed');
    assert.equal(terminal.errorCode, 'MAIL_QUOTA');
    assert.equal(terminal.failures, 1);
    assert.equal(Date.parse(terminal.nextRetryAt) - Date.parse(f.store.status('private-name')!.completedAt!), 24 * 3600000);
    const index = capture();
    await assert.rejects(indexMail(f.store, 'private-name', async () => { throw new Error('private-token'); }, false, index.log));
    assert.deepEqual(index.events().map(e => e.event), ['mail.job.started', 'mail.job.phase_changed', 'mail.job.failed']);
    assert.equal(index.events().at(-1).errorCode, 'INDEX_FAILED');
    assert.equal(index.events().at(-1).failures, 1);
    assert.ok(index.events().at(-1).nextRetryAt);
    for (const logs of [c, failed, index]) assert.ok(!logs.lines.join('').includes('private-'));
  } finally { f.clean(); }
});

test('paused/not-due/busy workers emit skipped instead of started/succeeded', async () => {
  const f = fixture(), c = capture();
  try {
    const account = f.store.account('private-name'); account.polling = false; f.store.saveAccount(account);
    await syncMail(f.store, account.alias, true, undefined, async () => { throw new Error('must not run'); }, c.log);
    await indexMail(f.store, account.alias, undefined, true, c.log);
    account.polling = true; f.store.saveAccount(account);
    await syncMail(f.store, account.alias, false, undefined, async () => '', () => {});
    await syncMail(f.store, account.alias, true, undefined, undefined, c.log);
    await f.store.withAccountSyncLock(account.alias, async () => {
      await syncMail(f.store, undefined, true, undefined, undefined, c.log);
    });
    assert.deepEqual(c.events().map(e => [e.event, e.reason]), [
      ['mail.job.skipped', 'paused'], ['mail.job.skipped', 'paused'], ['mail.job.skipped', 'not_due'], ['mail.job.skipped', 'locked'],
    ]);
  } finally { f.clean(); }
});

test('scheduler inherits only worker stderr, correlates dispatches and reports rate-limited health/abnormal exits', async () => {
  const f = fixture(), c = capture();
  let now = Date.now();
  const calls: { options: SpawnOptions; child: ChildProcess }[] = [];
  const launch = ((_file: string, _args: string[], options: SpawnOptions) => {
    const child = new EventEmitter() as ChildProcess; calls.push({ options, child }); return child;
  }) as typeof spawn;
  const scheduler = new MailScheduler(f.store, '/private-cli', 'https://private-origin', 1, launch, c.log, () => now);
  try {
    await scheduler.tick();
    assert.deepEqual(calls[0].options.stdio, ['ignore', 'ignore', 'inherit']);
    const dispatch = c.events().find(e => e.event === 'mail.job.dispatched');
    assert.equal(dispatch.attemptId, calls[0].options.env!.NOOKFRAME_MAIL_ATTEMPT_ID);
    await scheduler.tick();
    assert.equal(c.events().filter(e => e.event === 'mail.scheduler.health').length, 1);
    calls[0].child.emit('close', 1, null);
    const exit = c.events().at(-1);
    assert.equal(exit.event, 'mail.worker.exited');
    assert.equal(exit.level, 'warn');
    assert.equal(exit.attemptId, dispatch.attemptId);
    await f.store.withAccountSyncLock('private-name', async () => {
      now += 5 * 60000;
      await scheduler.tick();
    });
    const health = c.events().at(-1);
    assert.equal(health.event, 'mail.scheduler.health');
    assert.equal(health.lockedAccounts, 1);
    assert.equal(health.overdueAccounts, 1);
    assert.equal(health.oldestOverdueMs, 5 * 60000);
    assert.ok(!c.lines.join('').includes('private-'));
    await scheduler.close(); await scheduler.close();
    assert.equal(c.events().filter(e => e.event === 'mail.scheduler.stopped').length, 1);
  } finally { await scheduler.close(); f.clean(); }
});

test('scheduler logs sanitized read/spawn errors and releases capacity on async worker errors', async () => {
  const f = fixture(), c = capture();
  const child = new EventEmitter() as ChildProcess;
  const launch = (() => child) as typeof spawn;
  const scheduler = new MailScheduler(f.store, '/fixture-cli', 'http://localhost', 1, launch, c.log);
  try {
    await scheduler.tick();
    child.emit('error', new Error('private-token'));
    assert.equal(c.events().at(-1).errorCode, 'WORKER_SPAWN_FAILED');
    child.emit('close', -2, null);
    const original = f.store.accounts;
    f.store.accounts = () => { throw new Error('private-credentials'); };
    await scheduler.tick();
    assert.equal(c.events().at(-1).event, 'mail.scheduler.error');
    assert.equal(c.events().at(-1).errorCode, 'SCHEDULER_FAILED');
    f.store.accounts = original;
    assert.ok(!c.lines.join('').includes('private-'));
  } finally { await scheduler.close(); f.clean(); }
});

test('CLI polling changes log JSON on stderr without contaminating stdout or logging redundant changes', () => {
  const f = fixture();
  try {
    const cli = () => spawnSync(process.execPath, ['--import', 'tsx', resolve('mail/cli.ts'), 'jobs', 'pause', 'private-name'], {
      env: { ...process.env, MAIL_DIR: f.root, PUBLIC_ORIGIN: 'http://localhost:3000' }, encoding: 'utf8',
    });
    const result = cli();
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).enabled, false);
    assert.equal(JSON.parse(result.stderr).event, 'mail.polling.changed');
    assert.ok(!result.stderr.includes('private-'));
    assert.equal(cli().stderr, '');
  } finally { f.clean(); }
});
