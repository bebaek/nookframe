#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { calendarRuntime } from './runtime.js';
import { CalendarError } from './store.js';

async function configurePrivately() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CalendarError('PRIVATE_TERMINAL_REQUIRED');
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true, historySize: 0 });
  const abort = new AbortController();
  rl.on('SIGINT', () => abort.abort());
  async function ask(label: string) {
    process.stdout.write(label);
    const value = await rl.question('', { signal: abort.signal });
    process.stdout.write('\n'); return value.trim();
  }
  try {
    const clientId = await ask('Google WEB application client ID (hidden): ');
    const clientSecret = await ask('Client secret (hidden): ');
    const { oauth } = calendarRuntime();
    await oauth.configure(clientId, clientSecret);
    return { configured: true, callbackUrl: oauth.redirectUri };
  } finally { rl.close(); }
}
async function main(args: string[]) {
  if (!args.length || (args.length === 1 && ['help', '--help'].includes(args[0]))) return {
    commands: ['doctor', 'oauth configure (private Terminal only)', 'account connect ALIAS', 'account status [ALIAS]'],
    safety: 'Read-only Google Calendar authorization. No calendar fetching, event writes, or background jobs are implemented.',
  };
  if (args.join(' ') === 'oauth configure') return configurePrivately();
  const { store, oauth } = calendarRuntime();
  if (args.length === 1 && args[0] === 'doctor') {
    let configured = false; try { configured = store.client().redirectUri === oauth.redirectUri; } catch {}
    return { configured, callbackUrl: oauth.redirectUri, accounts: store.accounts().map(a => a.alias), nextStep: configured ? 'account connect ALIAS' : 'Run calendarctl oauth configure privately in Terminal' };
  }
  if (args[0] === 'account' && args[1] === 'connect' && args.length === 3) return oauth.connect(args[2]);
  if (args[0] === 'account' && args[1] === 'status' && [2, 3].includes(args.length)) {
    const accounts = args[2] ? [store.account(args[2])] : store.accounts();
    let clientId: string | undefined; try { clientId = store.client().clientId; } catch {}
    return { untrusted: true, accounts: accounts.map(a => ({ alias: a.alias, provider: a.provider, email: a.email, scopes: a.scopes, status: a.oauth.clientId === clientId ? 'authorization_stored' : 'reconnect_required' })), note: 'Local status only; does not verify provider access. No calendar data has been fetched.' };
  }
  throw new CalendarError('INVALID_COMMAND');
}
try { console.log(JSON.stringify({ version: 1, ...await main(process.argv.slice(2)) })); }
catch (error) {
  console.log(JSON.stringify({ version: 1, error: error instanceof CalendarError ? error.code : 'CALENDAR_COMMAND_FAILED' }));
  process.exitCode = 1;
}
