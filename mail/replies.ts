import { createDraft } from './drafts.js';
import { messageId, validateReply } from './reply-metadata.js';
import { MailError, type MailStore } from './store.js';
import type { MailOAuth } from './oauth.js';

// Resolve the RFC Message-ID returned by `mailctl read`, never a local notmuch
// thread ID. All reads are scoped to the same account used to create the draft.
export async function createGmailReply(store: MailStore, oauth: Pick<MailOAuth, 'accessToken'>,
  account: string, parent: string, input: unknown, request: typeof fetch = fetch) {
  const rfcId = messageId(parent.startsWith('<') ? parent : `<${parent}>`);
  return store.withAccountSyncLock(account, async () => {
    const token = await oauth.accessToken(account);
    async function get(path: string): Promise<any> {
      try {
        const response = await request(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
          headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error();
        const text = await response.text();
        if (text.length > 128000) throw new Error();
        return JSON.parse(text);
      } catch { throw new MailError('REPLY_LOOKUP_FAILED'); }
    }
    const query = new URLSearchParams({ q: `rfc822msgid:${rfcId}`, maxResults: '2', includeSpamTrash: 'true' });
    const found = await get(`messages?${query}`);
    if (!Array.isArray(found?.messages) || found.messages.length !== 1 || found.nextPageToken ||
        typeof found.messages[0]?.id !== 'string' || !/^[a-fA-F0-9]{1,256}$/.test(found.messages[0].id)) {
      throw new MailError('REPLY_TARGET_NOT_UNIQUE');
    }
    const id = found.messages[0].id;
    const params = new URLSearchParams({ format: 'metadata' });
    for (const name of ['Message-ID', 'References', 'Subject']) params.append('metadataHeaders', name);
    const target = await get(`messages/${id}?${params}`);
    const headers = target?.payload?.headers;
    if (target?.id !== id || !Array.isArray(headers)) throw new MailError('INVALID_REPLY_TARGET');
    function header(name: string, required = true): string {
      const matches = headers.filter((h: any) => typeof h?.name === 'string' && h.name.toLowerCase() === name.toLowerCase());
      if ((!matches.length && required) || matches.length > 1 || (matches.length && typeof matches[0].value !== 'string')) {
        throw new MailError('INVALID_REPLY_TARGET');
      }
      return matches[0]?.value ?? '';
    }
    if (header('Message-ID') !== rfcId) throw new MailError('REPLY_MESSAGE_ID_MISMATCH');
    const references = header('References', false).trim().split(/\s+/).filter(Boolean).map(messageId);
    // Keep the parent's chain, placing the parent last exactly once.
    const chain = [...new Set(references.filter(ref => ref !== rfcId)), rfcId];
    const subject = header('Subject');
    const metadata = validateReply({ provider: 'gmail', messageId: rfcId, references: chain, subject,
      gmail: { messageId: id, threadId: target.threadId } }, subject);
    return createDraft(store, account, input, metadata);
  });
}
