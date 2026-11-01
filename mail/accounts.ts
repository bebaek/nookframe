import { MailError, MailStore, alias } from './store.js';
import type { ZohoMail } from './zoho.js';
import { renameAccount } from './rename.js';

// Account management is provider-independent. Hold both control-plane locks in
// a fixed order so discovery and collision checks cannot race a connection.
export async function renameMailbox(gmail: MailStore, zoho: ZohoMail, from: string, to: string) {
  alias(from); alias(to);
  return gmail.locked('oauth', () => zoho.store.locked('oauth', async () => {
    const stores = [gmail, zoho.store];
    const matches = stores.filter(store => {
      const account = store.accountMetadata(from);
      return account && !account.renamedTo;
    });
    if (matches.length > 1) throw new MailError('AMBIGUOUS_ACCOUNT_ALIAS');
    if (!matches.length) throw new MailError(stores.some(store => store.accountMetadata(from)?.renamedTo) ? 'ACCOUNT_ALIAS_RENAMED' : 'ACCOUNT_NOT_CONNECTED');
    if (from === to) throw new MailError('ACCOUNT_ALIAS_UNCHANGED');
    if (stores.some(store => store.accountMetadata(to))) throw new MailError('ACCOUNT_ALIAS_IN_USE');
    const store = matches[0], isGmail = store === gmail;
    return renameAccount(store, from, to, () => { if (isGmail) gmail.account(from); else zoho.status(from); }, isGmail, true);
  }));
}
