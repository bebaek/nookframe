import { contactsRuntime } from './runtime.js';
import { searchContacts } from './search.js';
import { CalendarError } from '../calendar/store.js';
import { CONTACTS_READ_SCOPE, CONTACTS_WRITE_SCOPE } from '../calendar/oauth.js';

async function main(args: string[]) {
  if (!args.length || ['help', '--help'].includes(args[0])) return { commands: ['account status', 'account connect SHARED_ALIAS [--write]', 'search SHARED_ALIAS QUERY'] };
  const oauth = contactsRuntime();
  if (!oauth) throw new CalendarError('SHARED_GOOGLE_DIR_REQUIRED');
  if (args.join(' ') === 'account status') {
    const enrolled = new Set(oauth.store.accounts().map(a => a.alias));
    return { callbackUrl: oauth.redirectUri, accounts: oauth.store.google!.accounts().map(a => {
      const valid = enrolled.has(a.alias) && a.oauth.clientId === oauth.store.client().clientId;
      const writeAuthorizationStored = valid && a.scopes.includes(CONTACTS_WRITE_SCOPE);
      return { alias: a.alias, authorizationStored: writeAuthorizationStored || (valid && a.scopes.includes(CONTACTS_READ_SCOPE)), writeAuthorizationStored };
    }) };
  }
  if (args[0] === 'account' && args[1] === 'connect' && (args.length === 3 || (args.length === 4 && args[3] === '--write'))) return oauth.connect(args[2], args[3] === '--write');
  if (args.length === 3 && args[0] === 'search') return searchContacts(args[2], () => oauth.accessToken(args[1]));
  throw new CalendarError('INVALID_COMMAND');
}
try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
catch (e) { console.error(JSON.stringify({ error: e instanceof CalendarError ? e.code : 'CONTACTS_FAILED' })); process.exitCode = 1; }
