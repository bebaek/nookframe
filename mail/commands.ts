import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { MailError, MailStore, alias, type Account, type SyncStatus, type IndexStatus } from './store.js';
import { prepareConfig, DOWNLOAD_SCOPE } from './config.js';
import { downloadTimeout } from './download-policy.js';
import { indexTimeout } from './index-policy.js';
import { nextMailWork, indexRetryPlan } from './jobs.js';
import { classifyFailure, diagnosticErrorCode, type Diagnostic } from './diagnostics.js';

export class MailCommandError extends MailError {
  constructor(readonly diagnostic: Diagnostic) { super(diagnosticErrorCode(diagnostic.category)); }
}

export function privateCommand(file: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeout = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let timedOut = false;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(file, args, { env, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', killSignal: 'SIGTERM' }, (error, stdout, stderr) => {
      clearTimeout(deadline); clearTimeout(hardKill);
      if (error || timedOut) reject(new MailCommandError(classifyFailure(error ?? {}, stdout + '\n' + stderr, timedOut, Date.now() - started, timeout)));
      else resolve(stdout);
    });
    // Track our own deadline: error.killed alone does not prove a timeout.
    const deadline = setTimeout(() => {
      timedOut = true; child.kill('SIGTERM');
      hardKill = setTimeout(() => child.kill('SIGKILL'), 5000);
      hardKill.unref();
    }, timeout);
    deadline.unref();
  });
}
export async function syncMail(store: MailStore, name?: string, scheduled = false, progress?: (account: string, state: SyncStatus) => void, run: typeof privateCommand = privateCommand) {
  if (name) alias(name);
  const accounts = name ? [store.account(name)] : store.accounts();
  const results: Array<({ account: string } & SyncStatus) | { account: string; status: 'busy'; error: string }> = [];
  for (const selected of accounts) {
    try {
      await store.withAccountSyncLock(selected.alias, async () => {
      const account = store.account(selected.alias);
      const previous = store.status(account.alias);
      // Re-read opt-in state immediately before each account: pausing a queued
      // account does not wait for the currently running account to finish.
      if (scheduled && (!account.polling || nextMailWork(previous, store.indexStatus(account.alias)) !== 'sync')) return;
      const state: SyncStatus = { status: 'syncing', attemptedAt: new Date().toISOString(), lastSuccess: previous?.lastSuccess, completedDownloadScope: previous?.completedDownloadScope };
      const phase = (next: SyncStatus['phase']) => {
        state.phase = next; state.phaseStartedAt = new Date().toISOString();
        store.write(store.path('state', account.alias + '.json'), state);
        progress?.(account.alias, { ...state });
      };
      phase('preparing');
      const heartbeat = progress ? setInterval(() => progress(account.alias, { ...state }), 30000) : undefined;
      heartbeat?.unref();
      try {
        const timeout = downloadTimeout(previous);
        const files = prepareConfig(store, account);
        // Persist before launching mbsync: even an interrupted/partial download
        // needs local indexing. A held account lock excludes retry workers.
        const previousIndex = store.indexStatus(account.alias);
        store.write(store.path('state', account.alias, 'index-status.json'), {
          status: 'pending', attemptedAt: new Date().toISOString(),
          lastSuccess: previousIndex?.lastSuccess, failures: previousIndex?.failures,
          // Keep an existing index retry deadline even as new mail is downloaded.
          retryNotBefore: indexRetryPlan(previousIndex).nextRetryAt ?? undefined,
          diagnostic: previousIndex?.diagnostic,
        } satisfies IndexStatus);
        phase('download');
        const downloadStartedAt = state.phaseStartedAt;
        let downloadError: unknown;
        try {
          await run('/usr/bin/mbsync', ['-q', '-c', files.mbsync, '-a'], { ...process.env, MAIL_DIR: store.root }, timeout);
          state.downloadCompletedAt = new Date().toISOString();
          state.completedDownloadScope = DOWNLOAD_SCOPE;
        } catch (error) {
          downloadError = error;
          state.status = 'failed'; state.error = error instanceof MailError ? error.code : 'SYNC_FAILED';
          if (error instanceof MailCommandError) state.diagnostic = error.diagnostic;
          state.completedAt = new Date().toISOString();
        }
        // The awaited child has exited before indexing starts. Scheduled syncs
        // respect index backoff; manual sync/index remain explicit overrides.
        const indexPlan = indexRetryPlan(store.indexStatus(account.alias));
        state.indexDeferred = scheduled && !!indexPlan.nextRetryAt && Date.parse(indexPlan.nextRetryAt) > Date.now() ? true : undefined;
        let indexError: unknown;
        if (!state.indexDeferred) {
          phase('index');
          try { await indexUnlocked(store, account, run, state.downloadCompletedAt); } catch (error) { indexError = error; }
        }
        if (downloadError) { state.phase = 'download'; state.phaseStartedAt = downloadStartedAt; throw downloadError; }
        if (indexError) throw indexError;
        state.status = 'ok'; state.phase = 'complete';
        // Do not advance the last fully successful sync when indexing was deferred.
        if (!state.indexDeferred) state.lastSuccess = new Date().toISOString();
      } catch (error) {
        state.status = 'failed'; state.error = error instanceof MailError ? error.code : 'SYNC_FAILED';
        if (error instanceof MailCommandError) state.diagnostic = error.diagnostic;
      } finally { clearInterval(heartbeat); }
      state.failures = state.status === 'ok' || state.downloadCompletedAt ? 0 : Math.min(1000, (previous?.failures ?? 0) + 1);
      state.completedAt = new Date().toISOString();
      store.write(store.path('state', account.alias + '.json'), state);
      results.push({ account: account.alias, ...state });
      });
    } catch (error) {
      if (!(error instanceof MailError) || error.code !== 'MAIL_BUSY') throw error;
      if (name && !scheduled) throw error;
      // Busy accounts do not block other accounts or overwrite active status.
      results.push({ account: selected.alias, status: 'busy' as const, error: 'MAIL_BUSY' });
    }
  }
  return { results };
}
async function indexUnlocked(store: MailStore, account: Account, run: typeof privateCommand, completeThrough?: string) {
  const previous = store.indexStatus(account.alias);
  const state: IndexStatus = { status: 'indexing', failures: previous?.failures, attemptedAt: new Date().toISOString(), lastSuccess: previous?.lastSuccess, completeThrough: previous?.completeThrough };
  const path = store.path('state', account.alias, 'index-status.json');
  mkdirSync(store.path('state', account.alias), { recursive: true, mode: 0o700 });
  store.write(path, state);
  try {
    const files = prepareConfig(store, account);
    await run('/usr/bin/notmuch', [`--config=${files.notmuch}`, 'new', '--quiet'], undefined, indexTimeout());
    state.status = 'ok'; state.failures = 0; state.lastSuccess = new Date().toISOString(); state.completeThrough = completeThrough;
  } catch (error) {
    state.status = 'failed'; state.failures = Math.min(1000, (previous?.failures ?? 0) + 1);
    if (error instanceof MailCommandError) state.diagnostic = error.diagnostic;
    throw error;
  } finally { state.completedAt = new Date().toISOString(); store.write(path, state); }
  return state;
}
export async function indexMail(store: MailStore, name: string, run: typeof privateCommand = privateCommand, scheduled = false) {
  return store.withAccountSyncLock(name, async () => {
    const account = store.account(name), sync = store.status(name);
    if (scheduled && (!account.polling || nextMailWork(sync, store.indexStatus(name)) !== 'index')) return { account: name, skipped: true };
    const state = await indexUnlocked(store, account, run, sync?.downloadCompletedAt);
    return { account: name, index: state, partial: !state.completeThrough };
  });
}
export function freshness(store: MailStore, name: string) {
  const sync = store.status(name), index = store.indexStatus(name);
  const downloadComplete = sync?.status === 'ok' || (sync?.phase === 'index' && !!sync.downloadCompletedAt);
  return { account: name, indexedAt: index?.lastSuccess ?? sync?.lastSuccess ?? null,
    partial: index ? !index.completeThrough || !downloadComplete || index.status !== 'ok' : sync?.status !== 'ok',
    lastDownload: sync?.downloadCompletedAt ?? sync?.lastSuccess ?? null };
}
function indexArgs(store: MailStore, account: Account) {
  if (!freshness(store, account.alias).indexedAt) throw new MailError('INDEX_ACCOUNT_FIRST');
  return [`--config=${store.path('state', alias(account.alias), 'notmuch-config')}`];
}
const short = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : '';
export async function searchMail(store: MailStore, options: { account?: string; query?: string; unread?: boolean; limit?: number }) {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (options.query?.length ?? 0) > 2000) throw new MailError('INVALID_SEARCH');
  const accounts = options.account ? [store.account(options.account)] : store.accounts();
  const results: Array<{ account: string; ref: string; subject: string; authors: string; timestamp: number; unread: boolean; messages: number }> = [];
  const errors: Array<{ account: string; error: string }> = [];
  for (const account of accounts) {
    try {
      const supplied = options.query?.trim() || '*';
      // Notmuch treats '*' as match-all only when it is the entire query.
      const query = options.unread ? (supplied === '*' ? 'tag:unread' : `tag:unread AND (${supplied})`) : supplied;
      const raw = await privateCommand('/usr/bin/notmuch', [...indexArgs(store, account), 'search', '--format=json', '--output=summary', `--limit=${limit}`, '--', query]);
      const found = JSON.parse(raw);
      if (!Array.isArray(found)) throw new Error();
      for (const item of found.slice(0, limit)) {
        if (typeof item.thread !== 'string' || !/^[a-f0-9]{16,64}$/.test(item.thread)) continue;
        results.push({ account: account.alias, ref: `${account.alias}:${item.thread}`, subject: short(item.subject, 500), authors: short(item.authors, 500), timestamp: Number(item.timestamp) || 0, unread: Array.isArray(item.tags) && item.tags.includes('unread'), messages: Number(item.total) || 0 });
      }
    } catch (error) { errors.push({ account: account.alias, error: error instanceof MailError ? error.code : 'SEARCH_FAILED' }); }
  }
  return { untrustedEmail: true, scope: 'Downloaded IMAP folder archive; remote removals are not mirrored', freshness: accounts.map(a => freshness(store, a.alias)), results: results.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit), errors };
}
export function projectThread(tree: unknown) {
  const messages: Array<Record<string, unknown>> = [];
  let remaining = 20000, truncated = false;
  function walk(value: any, depth = 0) {
    if (depth > 40) { truncated = true; return; }
    if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1); return; }
    if (!value || typeof value !== 'object') return;
    if (typeof value.id === 'string' && value.headers && Array.isArray(value.body)) {
      if (messages.length >= 20 || remaining <= 0) { truncated = true; return; }
      const plain: string[] = [], html: string[] = [], attachments: Array<Record<string, unknown>> = [];
      function parts(body: any[], level = 0) {
        if (level > 30) { truncated = true; return; }
        for (const part of body.slice(0, 200)) {
          if (part.filename || part['content-disposition'] === 'attachment') {
            if (attachments.length < 20) attachments.push({ name: short(part.filename, 200), type: short(part['content-type'], 100) });
          } else if (Array.isArray(part.content)) parts(part.content, level + 1);
          else if (typeof part.content === 'string') {
            if (part['content-type'] === 'text/plain') plain.push(part.content);
            else if (part['content-type'] === 'text/html') html.push(part.content);
          }
        }
      }
      parts(value.body);
      const text = (plain.length ? plain : html).join('\n');
      const budget = Math.min(remaining, 10000);
      if (text.length > budget) truncated = true;
      remaining -= Math.min(text.length, budget);
      messages.push({ id: short(value.id, 1000), from: short(value.headers.From, 500), to: short(value.headers.To, 500), subject: short(value.headers.Subject, 500), date: short(value.headers.Date, 100), format: plain.length ? 'text' : 'html-as-inert-text', text: text.slice(0, budget), attachments });
    }
  }
  walk(tree);
  return { messages, truncated };
}
export async function readMail(store: MailStore, ref: string) {
  const match = /^([a-z][a-z0-9-]{0,31}):([a-f0-9]{16,64})$/.exec(ref);
  if (!match) throw new MailError('INVALID_MAIL_REFERENCE');
  const account = store.account(match[1]);
  const raw = await privateCommand('/usr/bin/notmuch', [...indexArgs(store, account), 'show', '--format=json', '--body=true', '--include-html', '--decrypt=false', '--entire-thread=true', '--', `thread:${match[2]}`]);
  try { return { untrustedEmail: true, account: account.alias, freshness: freshness(store, account.alias), ref, ...projectThread(JSON.parse(raw)) }; }
  catch { throw new MailError('MESSAGE_UNAVAILABLE_OR_TOO_LARGE'); }
}
