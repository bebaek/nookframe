import { randomBytes } from 'node:crypto';
import { validateReply, type ReplyMetadata } from './reply-metadata.js';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { MailError, MailStore, validEmail } from './store.js';

export interface DraftContent { to: string[]; cc: string[]; subject: string; body: string }
export interface Draft extends DraftContent {
  reply?: ReplyMetadata;
  id: string; version: number; account: string; from: string; createdAt: string; updatedAt: string;
}
const invalid = () => new MailError('INVALID_DRAFT');
function content(value: unknown): DraftContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['to', 'cc', 'subject', 'body'].includes(k))) throw invalid();
  const recipients = (input: unknown, required: boolean): string[] => {
    if (!Array.isArray(input) || input.length > 50 || (required && !input.length) || !input.every(validEmail)) throw invalid();
    return [...input];
  };
  if (typeof v.subject !== 'string' || v.subject.length > 998 || /[\r\n\x00-\x1f\x7f]/.test(v.subject) ||
      typeof v.body !== 'string' || Buffer.byteLength(v.body) > 100000 || v.body.includes('\0')) throw invalid();
  return { to: recipients(v.to, true), cc: recipients(v.cc ?? [], false), subject: v.subject, body: v.body };
}
function draftPath(store: MailStore, id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new MailError('INVALID_DRAFT_ID');
  return store.path('drafts', id + '.json');
}
export function showDraft(store: MailStore, id: string): Draft {
  const path = draftPath(store, id);
  let d: Draft;
  try { d = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new MailError('DRAFT_NOT_FOUND_OR_INVALID'); }
  if (!d || d.id !== id || !Number.isSafeInteger(d.version) || d.version < 1 || !validEmail(d.from) ||
      typeof d.account !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(d.account) ||
      typeof d.createdAt !== 'string' || !Number.isFinite(Date.parse(d.createdAt)) ||
      typeof d.updatedAt !== 'string' || !Number.isFinite(Date.parse(d.updatedAt))) throw invalid();
  return { id, version: d.version, account: d.account, from: d.from, createdAt: d.createdAt, updatedAt: d.updatedAt,
    ...content({ to: d.to, cc: d.cc, subject: d.subject, body: d.body }),
    ...(d.reply === undefined ? {} : { reply: validateReply(d.reply, d.subject) }) };
}
export function createDraft(store: MailStore, account: string, input: unknown, reply?: ReplyMetadata): Draft {
  const fields = content(input), connected = store.account(account), from = connected.email;
  account = connected.alias; // Stable local ID once the registry is enabled.
  const replyFields = reply === undefined ? {} : { reply: validateReply(reply, fields.subject) };
  mkdirSync(store.path('drafts'), { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const draft: Draft = { id: randomBytes(16).toString('hex'), version: 1, account, from, createdAt: now, updatedAt: now, ...fields, ...replyFields };
  store.write(draftPath(store, draft.id), draft);
  return draft;
}
export async function deleteDraft(store: MailStore, id: string, expectedVersion: number) {
  const path = draftPath(store, id);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new MailError('INVALID_DRAFT_VERSION');
  return store.withDraftLock(id, async () => {
    // Any directory entry is a submission marker, including a corrupt file or
    // dangling symlink. Never remove attempt history or infer safety from content.
    try {
      lstatSync(store.path('outbox', id + '.json'));
      throw new MailError('DRAFT_ALREADY_SUBMITTED');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const draft = showDraft(store, id);
    if (draft.version !== expectedVersion) throw new MailError('DRAFT_VERSION_CONFLICT');
    if (!lstatSync(path).isFile()) throw new MailError('INVALID_DRAFT');
    unlinkSync(path);
    const fd = openSync(store.path('drafts'), 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return { draftId: id, version: expectedVersion, deleted: true, scope: 'local' };
  });
}

export async function reviseDraft(store: MailStore, id: string, expectedVersion: number, input: unknown): Promise<Draft> {
  // Serialize revisions across CLI processes; later send must use this same lock.
  draftPath(store, id);
  const fields = content(input);
  return store.withDraftLock(id, async () => {
    if (existsSync(store.path('outbox', id + '.json'))) throw new MailError('DRAFT_ALREADY_SUBMITTED');
    const previous = showDraft(store, id);
    if (previous.version !== expectedVersion) throw new MailError('DRAFT_VERSION_CONFLICT');
    if (previous.version === Number.MAX_SAFE_INTEGER) throw invalid();
    if (previous.reply) validateReply(previous.reply, fields.subject);
    const draft: Draft = { ...previous, ...fields, version: previous.version + 1, updatedAt: new Date().toISOString() };
    store.write(draftPath(store, id), draft);
    return draft;
  });
}
