import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { showDraft, type Draft } from './drafts.js';
import { MailError, MailStore } from './store.js';
import type { MailOAuth } from './oauth.js';

export interface SendStatus {
  draftId: string; version: number; state: 'uncertain' | 'sent' | 'rejected';
  attemptedAt: string; messageId: string; providerId?: string;
}
function path(store: MailStore, id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new MailError('INVALID_DRAFT_ID');
  return store.path('outbox', id + '.json');
}
// Unlike ordinary draft edits, submission markers must reach disk before any
// network side effect. Sync both the replacement file and its directory.
function persist(store: MailStore, status: SendStatus) {
  const destination = path(store, status.draftId), directory = dirname(destination);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const syncDirectory = (dir: string) => { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
  syncDirectory(store.root);
  const temporary = destination + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(status) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, destination);
    syncDirectory(directory);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function sendStatus(store: MailStore, id: string): SendStatus | { draftId: string; state: 'not_attempted' } {
  const file = path(store, id);
  if (!existsSync(file)) { showDraft(store, id); return { draftId: id, state: 'not_attempted' }; }
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    if (v.draftId !== id || !Number.isSafeInteger(v.version) || v.version < 1 ||
        !['uncertain', 'sent', 'rejected'].includes(v.state) || typeof v.attemptedAt !== 'string' ||
        !Number.isFinite(Date.parse(v.attemptedAt)) || typeof v.messageId !== 'string' ||
        !/^<[a-f0-9]{32}@mailctl.local>$/.test(v.messageId) ||
        (v.providerId !== undefined && (typeof v.providerId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(v.providerId)))) throw new Error();
    return { draftId: id, version: v.version, state: v.state, attemptedAt: v.attemptedAt, messageId: v.messageId, ...(v.providerId ? { providerId: v.providerId } : {}) };
  } catch { throw new MailError('INVALID_SEND_STATUS_DO_NOT_RETRY'); }
}
export function mimeMessage(draft: Draft, status: SendStatus): string {
  // Short RFC 2047 encoded words avoid header injection and handle Unicode.
  const chars = Array.from(draft.subject), words: string[] = [];
  for (let i = 0; i < chars.length; i += 10) words.push('=?UTF-8?B?' + Buffer.from(chars.slice(i, i + 10).join('')).toString('base64') + '?=');
  const body = Buffer.from(draft.body.replace(/\r\n|\r|\n/g, '\r\n')).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
  return [`From: ${draft.from}`, `To: ${draft.to.join(',\r\n ')}`, ...(draft.cc.length ? [`Cc: ${draft.cc.join(',\r\n ')}`] : []),
    `Subject: ${words.join('\r\n ')}`, `Date: ${new Date(status.attemptedAt).toUTCString()}`, `Message-ID: ${status.messageId}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body, ''].join('\r\n');
}
export async function sendDraft(store: MailStore, oauth: Pick<MailOAuth, 'accessToken'>, id: string, version: number, request: typeof fetch = fetch) {
  path(store, id);
  if (!Number.isSafeInteger(version) || version < 1) throw new MailError('INVALID_DRAFT_VERSION');
  return store.withAccountSyncLock(showDraft(store, id).account, () => store.withDraftLock(id, async () => {
    const draft = showDraft(store, id);
    if (draft.version !== version) throw new MailError('DRAFT_VERSION_CONFLICT');
    if (existsSync(path(store, id))) throw new MailError('SEND_ALREADY_ATTEMPTED_CHECK_STATUS');
    if (store.account(draft.account).email !== draft.from) throw new MailError('DRAFT_ACCOUNT_CHANGED');
    // Credential failures before submission are safe to retry.
    const token = await oauth.accessToken(draft.account);
    const status: SendStatus = { draftId: id, version, state: 'uncertain', attemptedAt: new Date().toISOString(), messageId: `<${randomBytes(16).toString('hex')}@mailctl.local>` };
    const raw = Buffer.from(mimeMessage(draft, status)).toString('base64url');
    persist(store, status);
    try {
      const response = await request('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }), redirect: 'error', signal: AbortSignal.timeout(30000),
      });
      if (response.ok) {
        const data = await response.json();
        if (typeof data?.id === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(data.id)) {
          status.state = 'sent'; status.providerId = data.id;
        }
      } else if (response.status >= 400 && response.status < 500 && response.status !== 408) {
        status.state = 'rejected';
      }
    } catch { /* No raw transport/provider errors; acceptance may already have happened. */ }
    try { persist(store, status); }
    catch { throw new MailError('SEND_STATUS_WRITE_FAILED_CHECK_STATUS_DO_NOT_RETRY'); }
    return status;
  }));
}
