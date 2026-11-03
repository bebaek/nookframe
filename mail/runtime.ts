import { resolve, join } from 'node:path';
import { googleStore } from '../google/runtime.js';
import { MailStore } from './store.js';
import { MailOAuth } from './oauth.js';
import { MailAccountRegistry } from './account-registry.js';

export function mailRuntime() {
  const root = resolve(process.env.MAIL_DIR ?? join(resolve(process.env.STATE_DIR ?? '.local/state'), '..', 'mail'));
  const store = new MailStore(root, googleStore(), new MailAccountRegistry(root));
  const oauth = new MailOAuth(store, process.env.PUBLIC_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`);
  return { store, oauth };
}
