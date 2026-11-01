import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { MailAccounts, MailAccountRegistry, type MailProviderAdapter } from './account-registry.js';
import { MailError, type MailStore } from './store.js';
import type { ZohoMail } from './zoho.js';
import { mailRuntime } from './runtime.js';
import { zohoRuntime } from './zoho.js';

function checkPending(store: MailStore) {
  for (const file of readdirSync(store.path('pending'))) {
    if (!file.endsWith('.json')) continue;
    let pending: { expiresAt?: number };
    try { pending = JSON.parse(readFileSync(store.path('pending', file), 'utf8')); }
    catch { throw new MailError('MIGRATION_PENDING_AUTHORIZATION'); }
    if (!Number.isFinite(pending.expiresAt) || pending.expiresAt! > Date.now()) throw new MailError('MIGRATION_PENDING_AUTHORIZATION');
  }
}
function checkApprovals(store: MailStore, directory: string, attempts: string, validate: (record: any) => void) {
  if (!existsSync(store.path(directory))) return;
  for (const file of readdirSync(store.path(directory))) {
    if (!/^[a-f0-9]{32}\.json$/.test(file) || existsSync(store.path(attempts, file))) continue;
    try { validate(JSON.parse(readFileSync(store.path(directory, file), 'utf8'))); }
    catch { throw new MailError('MIGRATION_APPROVAL_IDENTITY_UNRESOLVED'); }
  }
}
export function gmailAdapter(store: MailStore): MailProviderAdapter {
  return {
    id: 'gmail', capabilities: ['local-search', 'local-read', 'sync', 'index', 'send'],
    discover: () => store.accounts().map(a => ({ storageRef: store.connectionKey(a.alias), connectionRef: store.credentialKey(a.alias), suggestedAlias: store.accountLabel(a.alias) })),
    describe: key => {
      if (!existsSync(store.path('accounts', key + '.json'))) return { email: '', connected: false };
      const account = store.account(key);
      return { email: account.email, connected: true, details: { polling: account.polling, sync: store.status(account.alias), index: store.indexStatus(account.alias) } };
    },
    withMigrationLock: action => store.withOAuthConfigurationLock(async () => {
      checkPending(store);
      checkApprovals(store, 'drafts', 'outbox', draft => {
        if (store.account(draft.account).email !== draft.from) throw new Error();
      });
      return action();
    }),
  };
}
export function zohoAdapter(zoho: ZohoMail): MailProviderAdapter {
  const store = zoho.store;
  return {
    id: 'zoho', capabilities: ['live-search', 'live-read', 'send', 'mailbox-write'],
    discover: () => zoho.connections().map(c => ({ ...c, suggestedAlias: store.accountLabel(c.storageRef) })),
    describe: key => {
      if (!existsSync(store.path('accounts', key + '.json'))) return { email: '', connected: false };
      const account = zoho.status(key).accounts[0];
      return { email: account.email, connected: true, details: { providerAccountId: account.accountId } };
    },
    withMigrationLock: action => store.locked('oauth', async () => {
      const names = zoho.connections().map(c => c.storageRef).sort();
      const next = (i: number): ReturnType<typeof action> => i === names.length ? perform()
        : store.withAccountSyncLock(names[i], () => store.withAccountCredentialLock(names[i], () => next(i + 1)));
      const perform = async () => {
        checkPending(store);
        checkApprovals(store, 'plans', 'attempts', plan => {
          const account = zoho.status(plan.account).accounts[0];
          if (account.email !== plan.from || account.accountId !== plan.accountId) throw new Error();
        });
        return action();
      };
      return next(0);
    }),
  };
}
// Only this composition root knows concrete providers. Account management and
// migration depend solely on the adapter contract, including third-party ones.
export function mailAccountsRuntime() {
  const { store } = mailRuntime();
  return new MailAccounts(store.registry ?? new MailAccountRegistry(store.root), [gmailAdapter(store), zohoAdapter(zohoRuntime())]);
}
