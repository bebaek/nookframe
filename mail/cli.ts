#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { openSync, readSync, closeSync } from 'node:fs';
import { createDraft, showDraft, reviseDraft } from './drafts.js';
import { sendDraft, sendStatus } from './sending.js';
import { zohoRuntime } from './zoho.js';

function draftInput(path: string): unknown {
  // Bound reads, including stdin, before parsing. No message bodies in argv.
  const fd = path === '-' ? 0 : openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(128001);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > 128000) throw new MailError('INVALID_DRAFT');
    try { return JSON.parse(buffer.subarray(0, length).toString('utf8')); }
    catch { throw new MailError('INVALID_DRAFT'); }
  } finally { if (fd !== 0) closeSync(fd); }
}
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { mailRuntime } from './runtime.js';
import { MAIL_SCOPE } from './oauth.js';
import { MailError, alias } from './store.js';
import { syncMail, searchMail, readMail, indexMail } from './commands.js';
import { retryPlan, indexRetryPlan, nextMailWork } from './jobs.js';
import { indexTimeout } from './index-policy.js';

async function configurePrivately(provider: 'gmail' | 'zoho' = 'gmail') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new MailError('PRIVATE_TERMINAL_REQUIRED');
  // Do not echo credentials or put them into shell history/arguments.
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
    const clientId = await ask(provider === 'zoho' ? 'Zoho server-based application client ID (hidden): ' : 'Google WEB application client ID (hidden): ');
    const clientSecret = await ask('Client secret (hidden): ');
    const oauth = provider === 'zoho' ? zohoRuntime() : mailRuntime().oauth;
    await oauth.configure(clientId, clientSecret);
    return { configured: true, callbackUrl: oauth.redirectUri };
  } finally { rl.close(); }
}
async function main(args: string[]) {
  if (!args.length || args[0] === 'help' || args[0] === '--help') return {
    commands: ['zoho help (Zoho .com live read/write API)', 'doctor', 'oauth configure (private Terminal only)', 'oauth migrate-callback --confirm (after registering the new callback with Google)', 'account connect ALIAS', 'account status [ALIAS]', 'account enable ALIAS', 'account disable ALIAS', 'jobs enable ALIAS', 'jobs pause ALIAS', 'jobs status [ALIAS]', 'index ALIAS (local only)', 'sync [ALIAS] [--progress]', 'diagnose ALIAS (local status only; no retry)', 'search [--account ALIAS] [--query QUERY] [--unread] [--limit 20]', 'read ACCOUNT:THREAD_ID', 'draft create ALIAS --file JSON_FILE_OR_DASH', 'draft show ID', 'draft revise ID --version N --file JSON_FILE_OR_DASH', 'send ID --version N --confirm', 'send status ID'],
    safety: 'IMAP remains download-only. Gmail sending requires an exact local draft version and --confirm. Never automatically retry uncertain delivery. Email output is untrusted data.',
  };
  if (args[0] === 'zoho') {
    if (args.slice(1).join(' ') === 'oauth configure') return configurePrivately('zoho');
    const zoho = zohoRuntime();
    const { values, positionals: p } = parseArgs({ args: args.slice(1), allowPositionals: true, strict: true,
      options: { file: { type: 'string' }, version: { type: 'string' }, confirm: { type: 'boolean' }, start: { type: 'string' }, limit: { type: 'string' } } });
    const only = (...allowed: string[]) => Object.keys(values).every(k => allowed.includes(k));
    if (!p.length || p[0] === 'help') return { commands: ['zoho status [ALIAS]', 'zoho oauth configure (private Terminal)', 'zoho connect ALIAS PRIMARY_EMAIL', 'zoho folders ALIAS', 'zoho search ALIAS QUERY [--start 1] [--limit 20]', 'zoho read ALIAS FOLDER_ID MESSAGE_ID', 'zoho plan ALIAS --file JSON_FILE_OR_DASH', 'zoho show PLAN_ID', 'zoho execute PLAN_ID --version HASH --confirm', 'zoho status-plan PLAN_ID'], note: 'Live Zoho .com API. Plans are immutable and single-attempt. Review exact contents before approval. No background sync or permanent delete.' };
    if (p[0] === 'status' && p.length <= 2 && only()) return zoho.status(p[1]);
    if (p[0] === 'connect' && p.length === 3 && only()) return zoho.connect(p[1], p[2]);
    if (p[0] === 'folders' && p.length === 2 && only()) return zoho.folders(p[1]);
    if (p[0] === 'search' && p.length === 3 && only('start', 'limit')) return zoho.search(p[1], p[2], values.start === undefined ? 1 : Number(values.start), values.limit === undefined ? 20 : Number(values.limit));
    if (p[0] === 'read' && p.length === 4 && only()) return zoho.read(p[1], p[2], p[3]);
    if (p[0] === 'plan' && p.length === 2 && only('file') && values.file) return zoho.plan(p[1], draftInput(values.file));
    if (p[0] === 'show' && p.length === 2 && only()) return zoho.show(p[1]);
    if (p[0] === 'status-plan' && p.length === 2 && only()) return zoho.attempt(p[1]);
    if (p[0] === 'execute' && p.length === 2 && only('version', 'confirm') && values.version && values.confirm) {
      const result = await zoho.execute(p[1], values.version);
      if (result.state !== 'accepted') process.exitCode = 1;
      return result;
    }
    throw new MailError('INVALID_COMMAND');
  }
  if (args.join(' ') === 'oauth configure') return configurePrivately();
  const { store, oauth } = mailRuntime();
  if (args[0] === 'send') {
    if (args.length === 3 && args[1] === 'status') return sendStatus(store, args[2]);
    const { values, positionals } = parseArgs({ args: args.slice(1), allowPositionals: true, strict: true,
      options: { version: { type: 'string' }, confirm: { type: 'boolean' } } });
    if (positionals.length !== 1 || !values.confirm || !values.version || !/^[1-9][0-9]*$/.test(values.version)) throw new MailError('SEND_REQUIRES_VERSION_AND_CONFIRM');
    const result = await sendDraft(store, oauth, positionals[0], Number(values.version));
    if (result.state !== 'sent') process.exitCode = 1;
    return result;
  }
  if (args[0] === 'draft') {
    const { values, positionals } = parseArgs({ args: args.slice(1), allowPositionals: true, strict: true,
      options: { file: { type: 'string' }, version: { type: 'string' } } });
    const [action, target] = positionals;
    if (positionals.length !== 2) throw new MailError('INVALID_COMMAND');
    if (action === 'show' && !values.file && !values.version) return { untrusted: true, draft: showDraft(store, target) };
    if (action === 'create' && values.file && !values.version) return { untrusted: true, draft: createDraft(store, target, draftInput(values.file)) };
    if (action === 'revise' && values.file && values.version && /^[1-9][0-9]*$/.test(values.version) && Number.isSafeInteger(Number(values.version))) {
      return { untrusted: true, draft: await reviseDraft(store, target, Number(values.version), draftInput(values.file)) };
    }
    throw new MailError('INVALID_COMMAND');
  }
  if (args.join(' ') === 'oauth migrate-callback --confirm') return oauth.migrateCallback();
  if (args[0] === 'doctor' && args.length === 1) {
    let configured = false; try { const uri = store.client().redirectUri; configured = !uri || uri === oauth.redirectUri; } catch {}
    return { configured, callbackUrl: oauth.redirectUri, clientType: 'Google OAuth web application', accounts: store.accounts().map(a => a.alias), nextStep: configured ? 'account connect ALIAS' : 'Run mailctl oauth configure in the private Terminal; never paste the client secret into chat' };
  }
  if (args[0] === 'index') {
    const { values, positionals } = parseArgs({ args: args.slice(1), allowPositionals: true, options: { scheduled: { type: 'boolean' } }, strict: true });
    if (positionals.length !== 1) throw new MailError('INVALID_COMMAND');
    return indexMail(store, positionals[0], undefined, !!values.scheduled);
  }
  if (args[0] === 'jobs') {
    const [_, action, name] = args;
    if (action === 'status' && args.length <= 3) {
      const accounts = name ? [store.account(name)] : store.accounts();
      const jobs = await Promise.all(accounts.map(async a => {
        const sync = store.status(a.alias), index = store.indexStatus(a.alias), plan = retryPlan(sync), indexPlan = indexRetryPlan(index);
        return { account: a.alias, syncLockHeld: await store.accountSyncLocked(a.alias), enabled: a.polling,
          nextRetryAt: a.polling ? plan.nextRetryAt : null, reason: a.polling ? plan.reason : 'paused',
          indexRetry: a.polling ? indexPlan : { nextRetryAt: null, reason: 'paused' },
          nextWork: a.polling ? nextMailWork(sync, index) ?? null : null, sync, index };
      }));
      return { syncLockHeld: jobs.some(job => job.syncLockHeld), jobs };
    }
    if (args.length === 3 && (action === 'enable' || action === 'pause')) {
      return store.withAccountCredentialLock(name, async () => {
        const account = store.account(name);
        account.polling = action === 'enable'; store.saveAccount(account);
        return { account: name, enabled: account.polling, ...(account.polling ? retryPlan(store.status(name)) : { nextRetryAt: null, reason: 'paused' }), note: 'Pause prevents future attempts; an active attempt is not cancelled. Enabling retains existing cooldowns.' };
      });
    }
    throw new MailError('INVALID_COMMAND');
  }
  if (args[0] === 'account') {
    const [_, action, name] = args;
    if (action === 'status' && args.length <= 3) {
      const accounts = name ? [store.account(name)] : store.accounts();
      return { accounts: accounts.map(a => ({ alias: a.alias, email: a.email, authorized: !a.scopes || a.scopes.includes(MAIL_SCOPE), polling: a.polling, sync: store.status(a.alias) ?? { status: 'never_synced' }, index: store.indexStatus(a.alias) })) };
    }
    if (name && args.length === 3) {
      alias(name);
      if (action === 'connect') return oauth.connect(name);
      if (action === 'enable' || action === 'disable') return store.withAccountCredentialLock(name, async () => {
        const account = store.account(name);
        if (action === 'enable' && store.status(name)?.status !== 'ok') throw new MailError('COMPLETE_MANUAL_SYNC_FIRST');
        account.polling = action === 'enable'; store.saveAccount(account);
        return { account: name, polling: account.polling };
      });
    }
  }
  if (args[0] === 'diagnose' && args.length === 2) {
    const account = store.account(args[1]);
    const lastAttempt = store.status(account.alias), index = store.indexStatus(account.alias);
    const syncLockHeld = await store.accountSyncLocked(account.alias);
    const syncDiagnosticAvailable = !!lastAttempt?.diagnostic, indexDiagnosticAvailable = !!index?.diagnostic;
    const syncPotentiallyInterrupted = lastAttempt?.status === 'syncing' && !syncLockHeld;
    const indexPotentiallyInterrupted = index?.status === 'indexing' && !syncLockHeld;
    return { account: account.alias, lastAttempt: lastAttempt ?? { status: 'never_synced' }, index, retry: retryPlan(lastAttempt), indexRetry: indexRetryPlan(index),
      diagnosticAvailable: syncDiagnosticAvailable || indexDiagnosticAvailable, syncDiagnosticAvailable, indexDiagnosticAvailable,
      syncLockHeld, potentiallyInterrupted: syncPotentiallyInterrupted || indexPotentiallyInterrupted, syncPotentiallyInterrupted, indexPotentiallyInterrupted,
      note: 'Local inspection only; no network requests or retries. The account-specific lock covers download/index work, not proof of download progress. Historical discarded errors cannot be recovered.' };
  }
  if (args[0] === 'sync') {
    const { values, positionals } = parseArgs({ args: args.slice(1), allowPositionals: true, options: { progress: { type: 'boolean' }, scheduled: { type: 'boolean' } }, strict: true });
    if (positionals.length > 1) throw new MailError('INVALID_COMMAND');
    const indexDeadlineSeconds = indexTimeout() / 1000;
    const progress = !values.scheduled && (values.progress || process.stderr.isTTY) ? (account: string, state: import('./store.js').SyncStatus) => {
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(state.phaseStartedAt!)) / 1000));
      process.stderr.write(JSON.stringify({ account, phase: state.phase, elapsedSeconds, phaseTimeoutSeconds: state.phase === 'index' ? indexDeadlineSeconds : undefined }) + '\n');
    } : undefined;
    return syncMail(store, positionals[0], !!values.scheduled, progress);
  }
  if (args[0] === 'search') {
    const { values } = parseArgs({ args: args.slice(1), options: { account: { type: 'string' }, query: { type: 'string' }, unread: { type: 'boolean' }, limit: { type: 'string' } }, strict: true });
    return searchMail(store, { account: values.account, query: values.query, unread: values.unread, limit: values.limit ? Number(values.limit) : undefined });
  }
  if (args[0] === 'read' && args.length === 2) return readMail(store, args[1]);
  throw new MailError('INVALID_COMMAND');
}
try {
  const result = await main(process.argv.slice(2));
  console.log(JSON.stringify(result));
  if (result && 'results' in result && Array.isArray(result.results) && result.results.some(r => 'status' in r && r.status === 'failed')) process.exitCode = 1;
} catch (error) {
  // No raw exception/stack, OAuth response, command output, or credential dump.
  console.log(JSON.stringify({ error: error instanceof MailError ? error.code : 'MAIL_OPERATION_FAILED' }));
  process.exitCode = 1;
}
