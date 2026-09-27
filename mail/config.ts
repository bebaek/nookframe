import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { alias, validEmail, MailError, type Account, type MailStore } from './store.js';

function quote(value: string) {
  if (/[\r\n\0]/.test(value)) throw new MailError('INVALID_MAIL_CONFIG');
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
export function renderMbsync(root: string, account: Pick<Account, 'alias' | 'email'>, tokenCommand = `/usr/local/libexec/pi-mail-token ${alias(account.alias)}`): string {
  alias(account.alias);
  if (!validEmail(account.email)) throw new MailError('INVALID_EMAIL');
  return `# Generated download-only configuration. Do not run with override flags.
IMAPAccount gmail
Host "imap.gmail.com"
Port 993
User ${quote(account.email)}
PassCmd ${quote(tokenCommand)}
AuthMechs XOAUTH2
SSLType IMAPS
SSLVersions TLSv1.2 TLSv1.3
SystemCertificates yes
CertificateFile "/etc/ssl/certs/ca-certificates.crt"
Timeout 60

IMAPStore remote
Account gmail

MaildirStore local
Path ${quote(join(root, 'maildir', account.alias) + '/')}
Inbox ${quote(join(root, 'maildir', account.alias, 'INBOX'))}
SubFolders Verbatim

Channel inbox
Far :remote:INBOX
Near :local:INBOX
Sync Pull New Flags
Create Near
Remove None
Expunge None
SyncState *
CopyArrivalDate yes
`;
}
export function prepareConfig(store: MailStore, account: Account) {
  const name = alias(account.alias);
  if (!validEmail(account.email) || /[\r\n\0]/.test(store.root)) throw new MailError('INVALID_MAIL_CONFIG');
  for (const path of [store.path('maildir', name), store.path('index', name), store.path('state', name), ...['cur', 'new', 'tmp'].map(p => store.path('maildir', name, 'INBOX', p))]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const mbsync = store.path('state', name, 'mbsyncrc');
  const notmuch = store.path('state', name, 'notmuch-config');
  store.writeText(mbsync, renderMbsync(store.root, account));
  store.writeText(notmuch, `[database]\npath=${store.path('index', name)}\nmail_root=${store.path('maildir', name)}\n[user]\nname=Pi Mail\nprimary_email=${account.email}\n[new]\ntags=unread;inbox;\n[maildir]\nsynchronize_flags=true\n`);
  return { mbsync, notmuch };
}
