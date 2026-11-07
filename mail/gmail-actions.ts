import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MailError, MailStore } from './store.js';
import type { MailOAuth } from './oauth.js';
import { privateCommand } from './commands.js';

// Message-level only: a conversation may acquire new messages after approval.
type Action = 'mark-read' | 'trash';
interface Snapshot { id: string; messageId: string; from: string; subject: string; date: string; labels: string[] }
export interface GmailPlan { id: string; version: string; account: string; email: string; subject?: string; action: Action; message: Snapshot; createdAt: string }
interface Attempt { planId: string; version: string; state: 'uncertain' | 'rejected' | 'verified'; attemptedAt: string; localIndex: 'pending' | 'updated' | 'failed' }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function path(store: MailStore, id: string, attempt = false) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new MailError('INVALID_GMAIL_PLAN_ID');
  return store.path(attempt ? 'gmail-action-attempts' : 'gmail-actions', id + '.json');
}
function persist(file: string, value: unknown) {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sync = (p: string) => { const fd = openSync(p, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
  sync(dirname(directory));
  const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file); sync(directory);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function messageId(value: unknown): string {
  if (typeof value !== 'string') throw new MailError('INVALID_RFC_MESSAGE_ID');
  const id = value.startsWith('<') && value.endsWith('>') ? value.slice(1, -1) : value;
  // Keep Gmail search and notmuch queries literal, not user-supplied expressions.
  if (id.length > 998 || !/^[a-zA-Z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-zA-Z0-9.-]+$/.test(id)) throw new MailError('INVALID_RFC_MESSAGE_ID');
  return id;
}
async function get(token: string, endpoint: string, request: typeof fetch): Promise<any> {
  try {
    const response = await request('https://gmail.googleapis.com/gmail/v1/users/me/' + endpoint, {
      headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error();
    return await response.json();
  } catch { throw new MailError('GMAIL_LOOKUP_FAILED'); }
}
async function snapshot(token: string, id: string, request: typeof fetch): Promise<Snapshot> {
  const data = await get(token, `messages/${id}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, request);
  if (data?.id !== id || !Array.isArray(data.labelIds) || !data.labelIds.every((x: unknown) => typeof x === 'string') || !Array.isArray(data.payload?.headers)) throw new MailError('INVALID_GMAIL_MESSAGE');
  const header = (name: string) => {
    const found = data.payload.headers.filter((h: any) => typeof h?.name === 'string' && h.name.toLowerCase() === name);
    if (found.length !== 1 || typeof found[0].value !== 'string' || found[0].value.length > 8000) throw new MailError('INVALID_GMAIL_MESSAGE');
    return found[0].value;
  };
  return { id, messageId: messageId(header('message-id')), from: header('from'), subject: header('subject'), date: header('date'), labels: [...new Set<string>(data.labelIds)].sort() };
}
export async function createGmailPlan(store: MailStore, oauth: Pick<MailOAuth, 'accessToken'>, name: string, input: unknown, request: typeof fetch = fetch) {
  const value = input as any;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['action', 'messageId'].includes(k)) || !['mark-read', 'trash'].includes(value.action)) throw new MailError('INVALID_GMAIL_ACTION');
  const rfcId = messageId(value.messageId);
  return store.withAccountSyncLock(name, async () => {
    const account = store.account(name), token = await oauth.accessToken(account.alias);
    const found = await get(token, 'messages?includeSpamTrash=true&maxResults=2&q=' + encodeURIComponent('rfc822msgid:' + rfcId), request);
    if (found?.nextPageToken || !Array.isArray(found?.messages) || found.messages.length !== 1 || typeof found.messages[0]?.id !== 'string' || !/^[a-f0-9]{1,64}$/.test(found.messages[0].id)) throw new MailError('GMAIL_MESSAGE_NOT_UNIQUE');
    const message = await snapshot(token, found.messages[0].id, request);
    if (message.messageId !== rfcId) throw new MailError('GMAIL_MESSAGE_ID_MISMATCH');
    const content = { id: randomBytes(16).toString('hex'), account: account.alias, email: account.email, ...(account.subject ? { subject: account.subject } : {}), action: value.action as Action, message, createdAt: new Date().toISOString() };
    const plan: GmailPlan = { ...content, version: hash(content) };
    persist(path(store, plan.id), plan);
    return showGmailPlan(store, plan.id);
  });
}
export function showGmailPlan(store: MailStore, id: string) {
  const file = path(store, id);
  let plan: GmailPlan;
  try {
    plan = JSON.parse(readFileSync(file, 'utf8'));
    const { version, ...content } = plan;
    if (plan.id !== id || version !== hash(content) || !['mark-read', 'trash'].includes(plan.action) || !/^[a-f0-9]{1,64}$/.test(plan.message.id) || messageId(plan.message.messageId) !== plan.message.messageId || !Array.isArray(plan.message.labels)) throw new Error();
  } catch { throw new MailError('INVALID_GMAIL_PLAN'); }
  return { untrustedEmail: true, plan, accountIdentity: { id: store.accountId(plan.account), alias: store.accountLabel(plan.account), email: store.account(plan.account).email } };
}
export function gmailActionStatus(store: MailStore, id: string): Attempt | { planId: string; state: 'not_attempted' } {
  const file = path(store, id, true);
  if (!existsSync(file)) { showGmailPlan(store, id); return { planId: id, state: 'not_attempted' }; }
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Attempt;
    if (value.planId !== id || !/^[a-f0-9]{64}$/.test(value.version) || !['uncertain', 'rejected', 'verified'].includes(value.state) || !['pending', 'updated', 'failed'].includes(value.localIndex) || !Number.isFinite(Date.parse(value.attemptedAt))) throw new Error();
    return value;
  } catch { throw new MailError('INVALID_GMAIL_ATTEMPT_DO_NOT_RETRY'); }
}
export async function executeGmailPlan(store: MailStore, oauth: Pick<MailOAuth, 'accessToken'>, id: string, version: string, request: typeof fetch = fetch, run: typeof privateCommand = privateCommand) {
  const initial = showGmailPlan(store, id).plan;
  return store.withAccountSyncLock(initial.account, () => store.withDraftLock(id, async () => {
    const { plan } = showGmailPlan(store, id);
    if (version !== plan.version) throw new MailError('GMAIL_PLAN_VERSION_CONFLICT');
    if (existsSync(path(store, id, true))) throw new MailError('GMAIL_ACTION_ALREADY_ATTEMPTED_CHECK_STATUS');
    const account = store.account(plan.account);
    if (account.email !== plan.email || account.subject !== plan.subject) throw new MailError('GMAIL_PLAN_ACCOUNT_CHANGED');
    const token = await oauth.accessToken(plan.account);
    const before = await snapshot(token, plan.message.id, request);
    if (hash(before) !== hash(plan.message)) throw new MailError('GMAIL_MESSAGE_CHANGED_CREATE_NEW_PLAN');
    const attempt: Attempt = { planId: id, version, state: 'uncertain', attemptedAt: new Date().toISOString(), localIndex: 'pending' };
    // Durable, single-attempt marker before the first remote write. Even malformed
    // or interrupted markers block replay; never delete one to retry.
    persist(path(store, id, true), attempt);
    try {
      const response = await request(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${plan.message.id}/${plan.action === 'trash' ? 'trash' : 'modify'}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(plan.action === 'trash' ? {} : { removeLabelIds: ['UNREAD'] }), redirect: 'error', signal: AbortSignal.timeout(30000),
      });
      if (response.ok) {
        const after = await snapshot(token, plan.message.id, request);
        if (after.messageId === plan.message.messageId && (plan.action === 'trash' ? after.labels.includes('TRASH') : !after.labels.includes('UNREAD'))) attempt.state = 'verified';
      } else if (response.status >= 400 && response.status < 500 && response.status !== 408) attempt.state = 'rejected';
    } catch { /* Transport/read-back failure is uncertain; never replay. */ }
    persist(path(store, id, true), attempt);
    if (attempt.state === 'verified') {
      try {
        // Keep archived copies; notmuch applies flags across duplicate Maildir
        // copies. IMAP is Pull-only, so this cannot push other local flags.
        await run('/usr/bin/notmuch', [`--config=${store.path('state', plan.account, 'notmuch-config')}`, 'tag', plan.action === 'mark-read' ? '-unread' : '+gmail-trash', '--', `id:"${plan.message.messageId}"`]);
        attempt.localIndex = 'updated';
      } catch { attempt.localIndex = 'failed'; }
      persist(path(store, id, true), attempt);
    }
    return { ...attempt, note: 'Gmail read-back verified only when state=verified. Local archive retains trashed copies; later remote restores are not mirrored. Never replay an attempted plan.' };
  }));
}
