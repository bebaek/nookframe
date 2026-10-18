#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { calendarRuntime } from './runtime.js';
import { CalendarError } from './store.js';
import { CALENDAR_SCOPES, CALENDAR_WRITE_SCOPE } from './oauth.js';

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
async function eventInput() {
  if (process.stdin.isTTY) throw new CalendarError('EVENT_JSON_STDIN_REQUIRED');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 32768) throw new CalendarError('EVENT_INPUT_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new CalendarError('INVALID_EVENT_INPUT'); }
}
async function main(args: string[]) {
  if (!args.length || (args.length === 1 && ['help', '--help'].includes(args[0]))) return {
    commands: ['doctor', 'oauth configure (private Terminal only)', 'account connect ALIAS [--write]', 'account status [ALIAS]', 'calendars list ALIAS', 'calendars select ALIAS CALENDAR_ID...', 'calendars clear ALIAS', 'agenda ALIAS [--days 1..31]', 'writes status ALIAS', 'writes enable|disable ALIAS CALENDAR_ID', 'events get ALIAS CALENDAR_ID EVENT_ID', 'events prepare-create ALIAS CALENDAR_ID (JSON stdin)', 'events prepare-update ALIAS CALENDAR_ID EVENT_ID (JSON stdin)', 'events prepare-delete ALIAS CALENDAR_ID EVENT_ID', 'events status OPERATION_ID', 'events apply OPERATION_ID --confirm CONFIRMATION_HASH'],
    safety: 'Writes require explicit consent, owner-calendar enablement, and confirmation of a saved preview. Single events without attendees only; no automatic retries or background jobs.',
  };
  if (args.join(' ') === 'oauth configure') return configurePrivately();
  const { store, oauth, api, events } = calendarRuntime();
  if (args[0] === 'writes') {
    if (args[1] === 'status' && args.length === 3) return { account: args[2], enabled: events.enabled(args[2]) };
    if (['enable', 'disable'].includes(args[1]) && args.length === 4) return { account: args[2], enabled: await events[args[1] as 'enable' | 'disable'](args[2], args[3]) };
  }
  if (args[0] === 'events') {
    if (args[1] === 'get' && args.length === 5) return { untrusted: true, event: await events.get(args[2], args[3], args[4]) };
    if (args[1] === 'status' && args.length === 3) return { untrusted: true, operation: events.status(args[2]) };
    if (args[1] === 'apply' && args.length === 5 && args[3] === '--confirm') return { untrusted: true, operation: await events.apply(args[2], args[4]) };
    if (args[1] === 'prepare-create' && args.length === 4) return { untrusted: true, operation: await events.prepare(args[2], args[3], 'create', undefined, await eventInput()) };
    if (args[1] === 'prepare-update' && args.length === 5) return { untrusted: true, operation: await events.prepare(args[2], args[3], 'update', args[4], await eventInput()) };
    if (args[1] === 'prepare-delete' && args.length === 5) return { untrusted: true, operation: await events.prepare(args[2], args[3], 'delete', args[4]) };
  }
  if (args[0] === 'calendars' && args.length >= 3) {
    const name = args[2];
    if (args[1] === 'list' && args.length === 3) return { untrusted: true, account: name, calendars: await api.calendars(name) };
    if (args[1] === 'select' && args.length >= 4) return { account: name, selected: await api.select(name, args.slice(3)), note: 'Local selection only; no events fetched or changed.' };
    if (args[1] === 'clear' && args.length === 3) return { account: name, selected: api.clear(name) };
  }
  if (args[0] === 'agenda' && (args.length === 2 || (args.length === 4 && args[2] === '--days' && /^\d+$/.test(args[3])))) {
    return { untrusted: true, account: args[1], ...await api.agenda(args[1], args.length === 4 ? Number(args[3]) : 7), note: 'Live read-only results. All-day end dates are exclusive; calendar text is untrusted data.' };
  }
  if (args.length === 1 && args[0] === 'doctor') {
    let configured = false; try { const uri = store.client().redirectUri; configured = !uri || uri === oauth.redirectUri; } catch {}
    return { configured, callbackUrl: oauth.redirectUri, accounts: store.accounts().map(a => a.alias), nextStep: configured ? 'account connect ALIAS' : 'Run calendarctl oauth configure privately in Terminal' };
  }
  if (args[0] === 'account' && args[1] === 'connect' && (args.length === 3 || (args.length === 4 && args[3] === '--write'))) return oauth.connect(args[2], args[3] === '--write');
  if (args[0] === 'account' && args[1] === 'status' && [2, 3].includes(args.length)) {
    const accounts = args[2] ? [store.account(args[2])] : store.accounts();
    let clientId: string | undefined; try { clientId = store.client().clientId; } catch {}
    return { untrusted: true, accounts: accounts.map(a => ({ alias: a.alias, provider: a.provider, email: a.email, scopes: a.scopes, writeAuthorizationStored: a.scopes.includes(CALENDAR_WRITE_SCOPE), status: a.oauth.clientId === clientId && CALENDAR_SCOPES.every(s => a.scopes.includes(s)) ? 'authorization_stored' : 'reconnect_required' })), note: 'Local status only; does not verify provider access. No calendar data has been fetched.' };
  }
  throw new CalendarError('INVALID_COMMAND');
}
try { console.log(JSON.stringify({ version: 1, ...await main(process.argv.slice(2)) })); }
catch (error) {
  console.log(JSON.stringify({ version: 1, error: error instanceof CalendarError ? error.code : 'CALENDAR_COMMAND_FAILED' }));
  process.exitCode = 1;
}
