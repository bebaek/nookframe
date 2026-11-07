import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailStore } from '../mail/store.js';
import { createDraft, deleteDraft, reviseDraft, showDraft } from '../mail/drafts.js';
import { sendDraft } from '../mail/sending.js';
const input = { to: ['you@example.com'], subject: 'Hello', body: 'Hi' };
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'draft-delete-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new MailStore(root);
  mkdirSync(store.path('outbox'), { recursive: true });
  store.saveAccount({ alias: 'personal', provider: 'gmail', email: 'me@example.com', polling: false,
    oauth: { clientId: 'test', refreshToken: 'fixture', accessToken: 'fixture', expiresAt: 0 } });
  return { store, draft: createDraft(store, 'personal', input) };
}
test('delete is local, version-bound, persists across restart and cannot delete another draft', async t => {
  const { store, draft } = fixture(t);
  const other = createDraft(store, 'personal', input);
  await assert.rejects(deleteDraft(store, draft.id, 0), /INVALID_DRAFT_VERSION/);
  await assert.rejects(deleteDraft(store, '../escape', 1), /INVALID_DRAFT_ID/);
  await reviseDraft(store, draft.id, 1, { ...input, body: 'Changed' });
  await assert.rejects(deleteDraft(store, draft.id, 1), /DRAFT_VERSION_CONFLICT/);
  assert.equal(showDraft(store, draft.id).version, 2);
  assert.deepEqual(await deleteDraft(store, draft.id, 2), { draftId: draft.id, version: 2, deleted: true, scope: 'local' });
  assert.throws(() => showDraft(new MailStore(store.root), draft.id), /DRAFT_NOT_FOUND_OR_INVALID/);
  assert.deepEqual(showDraft(store, other.id), other);
  await assert.rejects(deleteDraft(store, draft.id, 2), /DRAFT_NOT_FOUND_OR_INVALID/);
});
test('all attempt markers block deletion without modifying either file', async t => {
  for (const state of ['sent', 'rejected', 'uncertain', 'corrupt']) {
    const { store, draft } = fixture(t);
    const marker = store.path('outbox', draft.id + '.json');
    store.write(marker, state === 'corrupt' ? {} : { state });
    const before = readFileSync(marker, 'utf8');
    await assert.rejects(deleteDraft(store, draft.id, 1), /DRAFT_ALREADY_SUBMITTED/);
    assert.equal(readFileSync(marker, 'utf8'), before);
    assert.deepEqual(showDraft(store, draft.id), draft);
  }
  const { store, draft } = fixture(t);
  store.write(store.path('outbox', 'placeholder.json'), {});
  symlinkSync('/nonexistent-fixture-target', store.path('outbox', draft.id + '.json'));
  await assert.rejects(deleteDraft(store, draft.id, 1), /DRAFT_ALREADY_SUBMITTED/);
});
test('deletion shares the revision/send lock and preserves in-flight sends', async t => {
  const { store, draft } = fixture(t);
  await store.withDraftLock(draft.id, async () => {
    await assert.rejects(deleteDraft(new MailStore(store.root), draft.id, 1), /MAIL_BUSY/);
  });
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const start = new Promise<void>(resolve => { started = resolve; });
  const send = sendDraft(store, { accessToken: async () => 'fixture' }, draft.id, 1, async () => {
    started(); await gate; return Response.json({ id: 'abc' });
  });
  await start;
  try { await assert.rejects(deleteDraft(store, draft.id, 1), /MAIL_BUSY/); }
  finally { release(); }
  await send;
  await assert.rejects(deleteDraft(store, draft.id, 1), /DRAFT_ALREADY_SUBMITTED/);
});
test('CLI requires exact version and explicit confirmation; other commands reject confirm', t => {
  const { store, draft } = fixture(t);
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'mail/cli.ts', 'draft', ...args], {
    encoding: 'utf8', env: { ...process.env, MAIL_DIR: store.root, PUBLIC_ORIGIN: 'http://localhost:3000' },
  });
  for (const flags of [[], ['--version', '1'], ['--confirm'], ['--version', 'NaN', '--confirm'], ['--version', '1', '--confirm', '--file', '-']]) {
    const result = run(['delete', draft.id, ...flags]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error, 'DELETE_REQUIRES_VERSION_AND_CONFIRM');
    assert.ok(existsSync(store.path('drafts', draft.id + '.json')));
  }
  assert.equal(run(['show', draft.id, '--confirm']).status, 1);
  const result = run(['delete', draft.id, '--version', '1', '--confirm']);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).deleted, true);
});
