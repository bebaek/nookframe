import { MailError } from './store.js';

// Provider transport identifiers stay inside a discriminated provider payload.
export interface ReplyMetadata {
  provider: 'gmail';
  messageId: string;
  references: string[];
  subject: string;
  gmail: { messageId: string; threadId: string };
}
export function messageId(value: unknown): string {
  if (typeof value !== 'string' || !/^<[^<>\s\x00-\x1f\x7f]+@[^<>\s\x00-\x1f\x7f]+>$/.test(value) || value.length > 900) {
    throw new MailError('INVALID_REPLY_MESSAGE_ID');
  }
  return value;
}
export function replySubject(subject: string): string {
  return subject.replace(/^(?:re:\s*)+/i, '');
}
export function validateReply(value: unknown, subject: string): ReplyMetadata {
  const r = value as ReplyMetadata;
  const providerId = (v: unknown) => typeof v === 'string' && /^[a-fA-F0-9]{1,256}$/.test(v);
  if (!r || r.provider !== 'gmail' || !r.gmail || !providerId(r.gmail.messageId) || !providerId(r.gmail.threadId) ||
      typeof r.subject !== 'string' || /[\r\n\x00-\x1f\x7f]/.test(r.subject) || r.subject.length > 998 ||
      replySubject(subject) !== replySubject(r.subject) || !Array.isArray(r.references) || r.references.length > 100) {
    throw new MailError('INVALID_REPLY_METADATA_OR_SUBJECT');
  }
  const parent = messageId(r.messageId);
  const references = r.references.map(messageId);
  if (references.at(-1) !== parent) throw new MailError('INVALID_REPLY_REFERENCES');
  return { provider: 'gmail', messageId: parent, references, subject: r.subject,
    gmail: { messageId: r.gmail.messageId, threadId: r.gmail.threadId } };
}
