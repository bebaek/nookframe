import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { classifyFailure, sanitizeDiagnostic } from '../mail/diagnostics.js';
import { MailStore } from '../mail/store.js';
import { privateCommand, MailCommandError, syncMail } from '../mail/commands.js';

const canary = 'fixture-private-credential-never-return';
test('diagnostics expose only fixed vocabulary and numeric process metadata', () => {
  const d = classifyFailure({ code: 1, signal: canary }, `[OVERQUOTA] Account exceeded command or bandwidth limits ${canary}`, false, 54000, 900000);
  assert.equal(d.category, 'quota'); assert.equal(d.responseCode, 'OVERQUOTA');
  assert.equal(d.providerMessage, 'Account exceeded command or bandwidth limits');
  assert.ok(!JSON.stringify(d).includes(canary));
  const projected = sanitizeDiagnostic({ ...d, message: canary, providerMessage: canary, responseCode: canary, signal: canary, extra: canary });
  assert.ok(!JSON.stringify(projected).includes(canary));
  assert.equal(sanitizeDiagnostic({ ...d, category: '__proto__' }), undefined);
  assert.equal(classifyFailure({ code: 1 }, 'Socket timeout', false, 60000, 900000).category, 'network');
  assert.equal(classifyFailure({ code: 1 }, 'MAIL_TOKEN_ERROR:RECONNECT_ACCOUNT', false, 1, 900000).category, 'authentication');
});

test('real subprocess deadline, ordinary exit, signal, and missing executable are distinguished', async () => {
  for (const [args, timeout, category] of [
    [['-e', 'setInterval(()=>{},1000)'], 100, 'timeout'],
    [['-e', `process.stderr.write('${canary}');process.exit(2)`], 5000, 'unknown'],
    [['-e', "process.kill(process.pid,'SIGTERM')"], 5000, 'signal'],
  ] as const) {
    await assert.rejects(privateCommand(process.execPath, [...args], process.env, timeout), error => {
      assert.ok(error instanceof MailCommandError);
      assert.equal(error.diagnostic.category, category);
      assert.ok(!JSON.stringify(error).includes(canary)); return true;
    });
  }
  await assert.rejects(privateCommand('/nonexistent/mail-fixture', [], process.env, 5000), error => error instanceof MailCommandError && error.diagnostic.category === 'spawn_failed');
});

test('sync persists failing phase/diagnostic and diagnose reads it without retrying', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-diagnostic-'));
  const store = new MailStore(dir);
  store.saveAccount({ alias: 'fixture', provider: 'gmail', email: 'fixture@example.test', polling: false, oauth: { clientId: 'fixture', refreshToken: canary, accessToken: canary, expiresAt: 0 } });
  try {
    for (const failure of ['download', 'index'] as const) {
      const phases: string[] = [];
      const result = await syncMail(store, 'fixture', false, (_, state) => phases.push(state.phase!), async file => {
        const phase = file.endsWith('mbsync') ? 'download' : 'index';
        assert.equal(store.status('fixture')?.phase, phase);
        if (phase === failure) throw new MailCommandError(classifyFailure({ signal: 'SIGTERM' }, canary, true, 900000, 900000));
        return '';
      });
      assert.equal(result.results[0].error, 'MAIL_TIMEOUT');
      assert.equal(store.status('fixture')?.phase, failure);
      assert.equal(store.status('fixture')?.diagnostic?.category, 'timeout');
      assert.ok(phases.includes(failure));
      assert.equal(store.status('fixture')?.lastSuccess, undefined);
      const raw = execFileSync(process.execPath, ['--import', 'tsx', resolve('mail/cli.ts'), 'diagnose', 'fixture'], { env: { ...process.env, MAIL_DIR: dir, PUBLIC_ORIGIN: 'http://localhost:3000' }, encoding: 'utf8' });
      assert.ok(!raw.includes(canary));
      const report = JSON.parse(raw);
      assert.equal(report.diagnosticAvailable, true); assert.equal(report.syncLockHeld, false);
    }
    await store.locked('sync', async () => assert.equal(await store.syncLocked(), true));
    store.write(store.path('state/fixture.json'), { status: 'syncing', attemptedAt: new Date().toISOString() });
    assert.equal(store.status('fixture')?.diagnostic, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
