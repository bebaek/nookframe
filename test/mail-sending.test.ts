import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailStore } from '../mail/store.js';
import { createDraft, reviseDraft } from '../mail/drafts.js';
import { mimeMessage, sendDraft, sendStatus } from '../mail/sending.js';
const input = { to: ['you@example.com'], cc: ['cc@example.com'], subject: 'Hello 안녕', body: 'First\n안녕' };
const oauth = { accessToken: async () => 'private-token' };
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'mail-send-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new MailStore(root);
  store.saveAccount({ alias: 'personal', provider: 'gmail', email: 'me@example.com', polling: false,
    oauth: { clientId: 'test', refreshToken: 'private-refresh', accessToken: 'private-token', expiresAt: 0 } });
  return { store, draft: createDraft(store, 'personal', input) };
}
test('send persists before submission, encodes MIME, and blocks duplicate send/revise across restart', async t => {
  const { store, draft } = fixture(t);
  const request: typeof fetch = async (url, options) => {
    assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    assert.equal(options?.redirect, 'error');
    assert.equal(sendStatus(new MailStore(store.root), draft.id).state, 'uncertain');
    const raw = JSON.parse(options!.body as string).raw;
    const mime = Buffer.from(raw, 'base64url').toString();
    assert.match(mime, /From: me@example.com\r\nTo: you@example.com\r\nCc: cc@example.com/);
    assert.match(mime, /Subject: =\?UTF-8\?B\?/);
    assert.ok(mime.includes(Buffer.from(input.body.replaceAll('\n', '\r\n')).toString('base64')));
    assert.ok(!mime.includes('private-token'));
    return new Response(JSON.stringify({ id: 'abc123' }), { status: 200 });
  };
  const result = await sendDraft(store, oauth, draft.id, 1, request);
  assert.equal(result.state, 'sent');
  const restarted = new MailStore(store.root);
  assert.deepEqual(sendStatus(restarted, draft.id), result);
  assert.equal(statSync(store.path('outbox', draft.id + '.json')).mode & 0o777, 0o600);
  await assert.rejects(sendDraft(restarted, oauth, draft.id, 1, request), /SEND_ALREADY_ATTEMPTED/);
  await assert.rejects(reviseDraft(restarted, draft.id, 1, input), /DRAFT_ALREADY_SUBMITTED/);
});
test('uncertain and rejected outcomes never auto-retry', async t => {
  for (const kind of ['network', '500', '408', '403', 'malformed'] as const) {
    const { store, draft } = fixture(t);
    let calls = 0;
    const request: typeof fetch = async () => {
      calls++;
      if (kind === 'network') throw new Error('secret provider detail');
      if (kind === 'malformed') return new Response('{}');
      return new Response('private provider detail', { status: Number(kind) });
    };
    const result = await sendDraft(store, oauth, draft.id, 1, request);
    assert.equal(result.state, kind === '403' ? 'rejected' : 'uncertain');
    assert.ok(!JSON.stringify(result).includes('private'));
    await assert.rejects(sendDraft(store, oauth, draft.id, 1, request), /SEND_ALREADY_ATTEMPTED/);
    assert.equal(calls, 1);
  }
});
test('stale version, changed identity, and credential failure make no submission', async t => {
  const { store, draft } = fixture(t);
  const request: typeof fetch = async () => { throw new Error('must not be called'); };
  await assert.rejects(sendDraft(store, oauth, draft.id, 2, request), /DRAFT_VERSION_CONFLICT/);
  await assert.rejects(sendDraft(store, { accessToken: async () => { throw new Error('credentials unavailable'); } }, draft.id, 1, request), /credentials unavailable/);
  assert.equal(sendStatus(store, draft.id).state, 'not_attempted');
  const account = store.account('personal'); account.email = 'different@example.com'; store.saveAccount(account);
  await assert.rejects(sendDraft(store, oauth, draft.id, 1, request), /DRAFT_ACCOUNT_CHANGED/);
  assert.equal(sendStatus(store, draft.id).state, 'not_attempted');
});
test('CLI requires explicit confirmation and version before attempting send', t => {
  const { store, draft } = fixture(t);
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'mail/cli.ts', ...args], {
    encoding: 'utf8', env: { ...process.env, MAIL_DIR: store.root, PUBLIC_ORIGIN: 'http://localhost:3000' },
  });
  for (const args of [['send', draft.id], ['send', draft.id, '--version', '1'], ['send', draft.id, '--confirm']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error, 'SEND_REQUIRES_VERSION_AND_CONFIRM');
  }
  const result = run(['send', 'status', draft.id]);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).state, 'not_attempted');
});
test('Unicode subject encoding keeps encoded words within RFC 2047 limits', t => {
  const { store } = fixture(t);
  const draft = createDraft(store, 'personal', { ...input, subject: '😀'.repeat(40) });
  const mime = mimeMessage(draft, { draftId: draft.id, version: 1, state: 'uncertain',
    attemptedAt: new Date().toISOString(), messageId: '<0123456789abcdef0123456789abcdef@mailctl.local>' });
  const words = mime.match(/=\?UTF-8\?B\?[^?]*\?=/g)!;
  assert.ok(words.every(word => word.length <= 75));
  assert.equal(words.map(word => Buffer.from(word.slice(10, -2), 'base64').toString()).join(''), draft.subject);
});
test('concurrent send is excluded and interrupted/corrupt markers fail closed', async t => {
  const { store, draft } = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const sending = sendDraft(store, oauth, draft.id, 1, async () => {
    started(); await gate; return new Response('{"id":"ok"}');
  });
  await start;
  try {
    await assert.rejects(sendDraft(new MailStore(store.root), oauth, draft.id, 1), /MAIL_BUSY/);
    await assert.rejects(reviseDraft(store, draft.id, 1, input), /MAIL_BUSY/);
  } finally { release(); }
  await sending;
  const status = sendStatus(store, draft.id);
  store.write(store.path('outbox', draft.id + '.json'), { ...status, state: 'uncertain' });
  await assert.rejects(sendDraft(new MailStore(store.root), oauth, draft.id, 1), /SEND_ALREADY_ATTEMPTED/);
  store.write(store.path('outbox', draft.id + '.json'), {});
  assert.throws(() => sendStatus(store, draft.id), /INVALID_SEND_STATUS/);
  await assert.rejects(sendDraft(store, oauth, draft.id, 1), /SEND_ALREADY_ATTEMPTED/);
});
