import { resolve, join } from 'node:path';
import { googleStore } from '../google/runtime.js';
import { MailStore } from './store.js';
import { MailOAuth } from './oauth.js';

export function mailRuntime() {
  const store = new MailStore(resolve(process.env.MAIL_DIR ?? join(resolve(process.env.STATE_DIR ?? '.local/state'), '..', 'mail')), googleStore());
  const oauth = new MailOAuth(store, process.env.PUBLIC_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`);
  return { store, oauth };
}
