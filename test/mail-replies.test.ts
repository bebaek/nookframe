import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailStore } from '../mail/store.js';
import { createGmailReply } from '../mail/replies.js';
import { createDraft, reviseDraft, showDraft } from '../mail/drafts.js';
import { sendDraft, sendStatus } from '../mail/sending.js';

const oauth = { accessToken: async () => 'test-token' };
const input = { to: ['recruiter@example.com'], subject: 'Re: Opportunity', body: 'Thanks, but not now.' };
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'mail-reply-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new MailStore(root);
  store.saveAccount({ alias: 'personal', provider: 'gmail', email: 'me@example.com', polling: false,
    oauth: { clientId: 'test', refreshToken: 'test-refresh', accessToken: 'test-token', expiresAt: 0 } });
  return store;
}
function lookup(overrides: Record<string, unknown> = {}, headers?: unknown[]): typeof fetch {
  return async (url, options) => {
    assert.equal(options?.redirect, 'error');
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, 'https://gmail.googleapis.com');
    assert.equal(options?.method, undefined); // Preparation only reads remotely.
    if (parsed.pathname.endsWith('/messages')) {
      assert.equal(parsed.searchParams.get('q'), 'rfc822msgid:<parent@example.com>');
      return Response.json({ messages: [{ id: 'abc123' }] });
    }
    assert.equal(parsed.pathname, '/gmail/v1/users/me/messages/abc123');
    return Response.json({ id: 'abc123', threadId: 'def456', payload: { headers: headers ?? [
      { name: 'Message-ID', value: '<parent@example.com>' },
      { name: 'References', value: '<root@example.com>' },
      { name: 'Subject', value: 'Opportunity' },
    ] }, ...overrides });
  };
}
test('reply resolves RFC ID, persists provider metadata, revises and sends with headers and Gmail thread ID', async t => {
  const store = fixture(t);
  const draft = await createGmailReply(store, oauth, 'personal', 'parent@example.com', input, lookup());
  assert.deepEqual(showDraft(new MailStore(store.root), draft.id), draft);
  assert.equal(draft.reply?.gmail.threadId, 'def456');
  assert.throws(() => createDraft(store, 'personal', { ...input, reply: draft.reply }), /INVALID_DRAFT/);
  assert.deepEqual(draft.reply?.references, ['<root@example.com>', '<parent@example.com>']);
  const revised = await reviseDraft(store, draft.id, 1, { ...input, body: 'Updated reply' });
  assert.deepEqual(revised.reply, draft.reply);
  await assert.rejects(sendDraft(store, oauth, draft.id, 1), /DRAFT_VERSION_CONFLICT/);
  const result = await sendDraft(store, oauth, draft.id, 2, async (_url, options) => {
    assert.equal(sendStatus(store, draft.id).state, 'uncertain');
    const payload = JSON.parse(options!.body as string);
    assert.equal(payload.threadId, 'def456');
    const mime = Buffer.from(payload.raw, 'base64url').toString();
    assert.match(mime, /In-Reply-To: <parent@example.com>\r\n/);
    assert.match(mime, /References: <root@example.com>\r\n <parent@example.com>\r\n/);
    return Response.json({ id: 'aaa' });
  });
  assert.equal(result.state, 'sent');
  await assert.rejects(sendDraft(store, oauth, draft.id, 2), /SEND_ALREADY_ATTEMPTED/);
});
test('ordinary drafts do not gain threading metadata', async t => {
  const store = fixture(t);
  const draft = createDraft(store, 'personal', input);
  await sendDraft(store, oauth, draft.id, 1, async (_url, options) => {
    const payload = JSON.parse(options!.body as string);
    assert.equal(payload.threadId, undefined);
    assert.doesNotMatch(Buffer.from(payload.raw, 'base64url').toString(), /In-Reply-To:|References:/);
    return Response.json({ id: 'bbb' });
  });
});
test('reply lookup fails closed on ambiguous, missing, malformed and mismatched targets', async t => {
  const store = fixture(t);
  for (const response of [{ messages: [] }, { messages: [{ id: 'a' }, { id: 'b' }] },
    { messages: [{ id: 'a' }], nextPageToken: 'more' }, { messages: [{ id: '../../x' }] }]) {
    await assert.rejects(createGmailReply(store, oauth, 'personal', 'parent@example.com', input,
      async () => Response.json(response)), /REPLY_TARGET_NOT_UNIQUE/);
  }
  await assert.rejects(createGmailReply(store, oauth, 'personal', 'parent@example.com', input,
    lookup({ threadId: 'bad\r\nInjected: yes' })), /INVALID_REPLY/);
  await assert.rejects(createGmailReply(store, oauth, 'personal', 'parent@example.com', input,
    lookup({}, [{ name: 'Message-ID', value: '<other@example.com>' }])), /REPLY_MESSAGE_ID_MISMATCH/);
  await assert.rejects(createGmailReply(store, oauth, 'personal', 'parent@example.com', input,
    async () => { throw new Error('secret-provider-details'); }), /^Error: REPLY_LOOKUP_FAILED$/);
});
test('reply input, headers, subject revisions and changed account identity are validated', async t => {
  const store = fixture(t);
  await assert.rejects(createGmailReply(store, oauth, 'personal', '<a@b>\r\nBcc: x@y', input), /INVALID_REPLY_MESSAGE_ID/);
  await assert.rejects(createGmailReply(store, oauth, 'personal', 'parent@example.com', { ...input, subject: 'Unrelated' }, lookup()), /INVALID_REPLY_METADATA_OR_SUBJECT/);
  for (const bad of ['<root@example.com>\r\nBcc: injected@example.com', 'not-a-message-id']) {
    await assert.rejects(createGmailReply(store, oauth, 'personal', 'parent@example.com', input, lookup({}, [
      { name: 'Message-ID', value: '<parent@example.com>' }, { name: 'Subject', value: 'Opportunity' },
      { name: 'References', value: bad },
    ])), /INVALID_REPLY_MESSAGE_ID/);
  }
  const draft = await createGmailReply(store, oauth, 'personal', 'parent@example.com', input, lookup());
  await assert.rejects(reviseDraft(store, draft.id, 1, { ...input, subject: 'Other' }), /INVALID_REPLY_METADATA_OR_SUBJECT/);
  assert.equal(showDraft(store, draft.id).version, 1);
  const account = store.account('personal'); account.email = 'other@example.com'; store.saveAccount(account);
  await assert.rejects(sendDraft(store, oauth, draft.id, 1), /DRAFT_ACCOUNT_CHANGED/);
  assert.equal(sendStatus(store, draft.id).state, 'not_attempted');
  store.write(store.path('drafts', draft.id + '.json'), { ...draft, reply: { ...draft.reply, messageId: '<x@y>\r\nBcc: bad' } });
  assert.throws(() => showDraft(store, draft.id), /INVALID_REPLY_MESSAGE_ID/);
});
