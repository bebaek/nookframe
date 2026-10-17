import { existsSync, unlinkSync } from 'node:fs';
import { MailStore } from '../mail/store.js';
import { MAIL_SCOPE } from '../mail/oauth.js';
import { GoogleStore } from './store.js';

// Run with the host/workers stopped and a private backup. Legacy locks exclude
// old workers; shared locks exclude new workers. Never reacquire the same sync
// lock: the capability directory (and hence sync locks) does not move.
export async function migrateMail(mailRoot: string, google: GoogleStore) {
  const legacy = new MailStore(mailRoot);
  const target = new MailStore(mailRoot, google);
  return legacy.locked('oauth', async () => {
    const names = target.accounts().map(a => a.alias).sort();
    const importLocked = () => target.locked('oauth', async () => {
      const sharedNames = [...new Set([...names, ...google.accounts().map(a => a.alias)])].sort();
      const perform = async () => {
        const accounts = target.accounts();
        if (accounts.some(a => a.polling)) throw new Error('PAUSE_MAIL_JOBS_FIRST');
        const client = existsSync(legacy.path('oauth-client.json')) ? legacy.client() : target.client();
        const configured = google.client();
        if (configured && configured.clientId !== client.clientId) throw new Error('GOOGLE_CLIENT_CONFLICT');
        // Validate the entire import before changing credentials or metadata.
        for (const account of accounts) {
          if (account.oauth.clientId !== client.clientId) throw new Error('RECONNECT_ACCOUNT');
          if (account.scopes && !account.scopes.includes(MAIL_SCOPE)) throw new Error('MAIL_CONSENT_REQUIRED');
          if (google.accounts().some(a => a.alias !== account.alias && a.email.toLowerCase() === account.email.toLowerCase())) throw new Error('ACCOUNT_ALREADY_CONNECTED');
        }
        if (!configured) google.configure(client);
        for (const account of accounts) target.saveAccount(account);
        if (existsSync(legacy.path('oauth-client.json'))) unlinkSync(legacy.path('oauth-client.json'));
        return { migrated: accounts.map(a => a.alias), note: 'Register both callback URLs; restart with GOOGLE_DIR set. No provider requests were made.' };
      };
      const acquireShared = (i: number): ReturnType<typeof perform> => i === sharedNames.length ? perform()
        : target.withAccountCredentialLock(sharedNames[i], () => acquireShared(i + 1));
      return acquireShared(0);
    });
    const acquireLegacy = (i: number): ReturnType<typeof importLocked> => i === names.length ? importLocked()
      : legacy.withAccountSyncLock(names[i], () => legacy.withAccountCredentialLock(names[i], () => acquireLegacy(i + 1)));
    return acquireLegacy(0);
  });
}
