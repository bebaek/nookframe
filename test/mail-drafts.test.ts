import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailStore } from '../mail/store.js';
import { createDraft, showDraft, reviseDraft } from '../mail/drafts.js';

const input = { to: ['recipient@example.com'], subject: 'Hello', body: 'Unicode: 안녕\nSecond line' };
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'mail-drafts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new MailStore(root);
  store.saveAccount({ alias: 'personal', provider: 'gmail', email: 'me@example.com', polling: false,
    oauth: { clientId: 'test', refreshToken: 'secret', accessToken: 'secret', expiresAt: 0 } });
  return store;
}
test('drafts persist privately and revisions require the reviewed version', async t => {
  const store = fixture(t), draft = createDraft(store, 'personal', input);
  assert.equal(draft.version, 1);
  assert.equal(draft.from, 'me@example.com');
  assert.deepEqual(showDraft(new MailStore(store.root), draft.id), draft);
  assert.equal(statSync(store.path('drafts', draft.id + '.json')).mode & 0o777, 0o600);
  const revised = await reviseDraft(store, draft.id, 1, { ...input, body: 'Changed' });
  assert.equal(revised.version, 2);
  await assert.rejects(reviseDraft(store, draft.id, 1, input), /DRAFT_VERSION_CONFLICT/);
  assert.deepEqual(showDraft(store, draft.id), revised);
  assert.ok(!JSON.stringify(revised).includes('secret'));
});
test('draft input rejects injection, unsupported fields, invalid IDs and oversized bodies', t => {
  const store = fixture(t);
  for (const value of [null, { ...input, subject: 'Hi\r\nBcc: other@example.com' },
    { ...input, to: ['a@example.com\nBcc: b@example.com'] }, { ...input, to: [] },
    { ...input, from: 'spoof@example.com' }, { ...input, body: 'x'.repeat(100001) }]) {
    assert.throws(() => createDraft(store, 'personal', value), /INVALID_DRAFT/);
  }
  assert.throws(() => showDraft(store, '../accounts/personal'), /INVALID_DRAFT_ID/);
});
test('concurrent revision never overwrites another successful revision', async t => {
  const store = fixture(t), draft = createDraft(store, 'personal', input);
  const outcomes = await Promise.allSettled([
    reviseDraft(store, draft.id, 1, { ...input, body: 'one' }),
    reviseDraft(new MailStore(store.root), draft.id, 1, { ...input, body: 'two' }),
  ]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(showDraft(store, draft.id).version, 2);
});
