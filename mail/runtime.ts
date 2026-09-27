import { resolve } from 'node:path';
import { MailStore } from './store.js';
import { MailOAuth } from './oauth.js';

export function mailRuntime() {
  const store = new MailStore(resolve(process.env.MAIL_DIR ?? '.local/mail'));
  const oauth = new MailOAuth(store, process.env.PUBLIC_ORIGIN ?? 'http://localhost:3000');
  return { store, oauth };
}
