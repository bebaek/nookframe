import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { GoogleStore } from '../google/store.js';
import { sanitizeDiagnostic, diagnosticErrorCodes, type Diagnostic } from './diagnostics.js';

export class MailError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function alias(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(value)) throw new MailError('INVALID_ACCOUNT_ALIAS');
  return value;
}
export function validEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
}
export interface OAuthClient { clientId: string; clientSecret: string; redirectUri: string }
export interface Account {
  alias: string; provider: 'gmail'; email: string; polling: boolean; scopes?: string[]; subject?: string;
  oauth: { clientId: string; refreshToken: string; accessToken: string; expiresAt: number };
}
export interface IndexStatus { retryNotBefore?: string; failures?: number; status: 'pending' | 'indexing' | 'ok' | 'failed'; attemptedAt: string; completedAt?: string; lastSuccess?: string; completeThrough?: string; diagnostic?: Diagnostic }
export interface SyncStatus { indexDeferred?: boolean; completedDownloadScope?: string; failures?: number; downloadCompletedAt?: string; status: 'syncing' | 'ok' | 'failed'; attemptedAt: string; completedAt?: string; lastSuccess?: string; error?: string; phase?: 'preparing' | 'download' | 'index' | 'complete'; phaseStartedAt?: string; diagnostic?: Diagnostic }
export class MailStore {
  readonly root: string;
  constructor(root: string, readonly google?: GoogleStore) {
    this.root = resolve(root);
    if (google?.root === this.root) throw new MailError('SEPARATE_GOOGLE_DIR_REQUIRED');
    for (const part of ['', 'accounts', 'pending', 'maildir', 'index', 'state', '.locks/oauth', '.locks/sync', '.locks/credentials']) mkdirSync(join(this.root, part), { recursive: true, mode: 0o700 });
  }
  path(...parts: string[]) { return join(this.root, ...parts); }
  write(path: string, value: unknown) {
    if (this.google && path === this.path('oauth-client.json')) { this.google.configure(value as OAuthClient); return; }
    this.writeText(path, JSON.stringify(value) + '\n');
  }
  writeText(path: string, value: string) {
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    try { writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  client(): OAuthClient {
    try {
      const shared = this.google?.client();
      if (shared) return { ...shared, redirectUri: '' };
      const client = JSON.parse(readFileSync(this.path('oauth-client.json'), 'utf8')) as OAuthClient;
      if (typeof client.clientId !== 'string' || !/^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(client.clientId) || typeof client.clientSecret !== 'string' || !client.clientSecret || typeof client.redirectUri !== 'string') throw new Error();
      return client;
    } catch { throw new MailError('OAUTH_CLIENT_NOT_CONFIGURED'); }
  }
  account(name: string): Account {
    alias(name);
    try {
      const account = JSON.parse(readFileSync(this.path('accounts', name + '.json'), 'utf8')) as Account;
      const shared = this.google?.account(name);
      if (shared) {
        if (shared.email.toLowerCase() !== account.email.toLowerCase()) throw new Error();
        account.oauth = shared.oauth; account.scopes = shared.scopes; account.subject = shared.subject;
      }
      if (account.alias !== name || account.provider !== 'gmail' || !validEmail(account.email) || typeof account.polling !== 'boolean' || typeof account.oauth?.refreshToken !== 'string' || !account.oauth.refreshToken || typeof account.oauth.clientId !== 'string' || typeof account.oauth.accessToken !== 'string' || !Number.isFinite(account.oauth.expiresAt)) throw new Error();
      return account;
    } catch { throw new MailError('ACCOUNT_NOT_CONNECTED'); }
  }
  saveAccount(account: Account) {
    if (this.google) {
      this.google.save({ version: 1, alias: account.alias, email: account.email, subject: account.subject, scopes: account.scopes ?? ['https://mail.google.com/'], oauth: account.oauth });
      const { oauth, scopes, ...metadata } = account;
      this.write(this.path('accounts', alias(account.alias) + '.json'), { ...metadata, googleAccount: account.alias });
    } else this.write(this.path('accounts', alias(account.alias) + '.json'), account);
  }
  accounts(): Account[] {
    return readdirSync(this.path('accounts')).filter(f => /^[a-z][a-z0-9-]{0,31}\.json$/.test(f)).map(f => this.account(f.slice(0, -5)));
  }
  private async lock<T>(target: string, action: () => Promise<T>, waitForCredentials = false): Promise<T> {
    let release: () => Promise<void>;
    try { release = await lockfile.lock(target, { stale: 60000, update: 10000,
      retries: waitForCredentials ? { retries: 60, factor: 1, minTimeout: 500, maxTimeout: 500, randomize: false } : 0 }); }
    catch { throw new MailError('MAIL_BUSY'); }
    try { return await action(); } finally { await release(); }
  }
  async locked<T>(kind: 'oauth', action: () => Promise<T>): Promise<T> {
    return this.lock(this.google?.path('.locks', kind) ?? this.path('.locks', kind), action);
  }
  async withDraftLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new MailError('INVALID_DRAFT_ID');
    const target = this.path('.locks', 'drafts', id);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    return this.lock(target, action);
  }
  async withAccountCredentialLock<T>(name: string, action: () => Promise<T>, wait = false): Promise<T> {
    const target = this.google?.path('.locks', 'credentials', alias(name)) ?? this.path('.locks', 'credentials', alias(name));
    mkdirSync(target, { recursive: true, mode: 0o700 });
    return this.lock(target, action, wait);
  }
  async withOAuthConfigurationLock<T>(action: () => Promise<T>, ifUnchanged?: () => T | undefined): Promise<T> {
    // The global control-plane lock prevents concurrent consent/account creation.
    // Routine workers never take it. Acquire sync before credentials, matching
    // workers, and fail fast rather than waiting for active jobs to drain.
    return this.locked('oauth', async () => {
      // A read-only no-op check still excludes other configuration writers, but
      // need not disturb active jobs or acquire every account lock.
      const unchanged = ifUnchanged?.();
      if (unchanged !== undefined) return unchanged;
      const accounts = this.accounts().sort((a, b) => a.alias.localeCompare(b.alias));
      const names = [...new Set([...accounts.map(a => a.alias), ...(this.google?.accounts().map(a => a.alias) ?? [])])].sort();
      if (accounts.some(a => a.polling)) throw new MailError('PAUSE_MAIL_JOBS_FIRST');
      const acquire = async (index: number): Promise<T> => {
        if (index === names.length) return action();
        const name = names[index];
        return this.withAccountSyncLock(name, () => this.withAccountCredentialLock(name, async () => {
          // Recheck under the credential lock: jobs enable/pause use this lock too.
          if (accounts.some(a => a.alias === name) && this.account(name).polling) throw new MailError('PAUSE_MAIL_JOBS_FIRST');
          return acquire(index + 1);
        }));
      };
      return acquire(0);
    });
  }
  private syncTarget(name: string) {
    const target = this.path('.locks', 'sync', alias(name));
    mkdirSync(target, { recursive: true, mode: 0o700 });
    return target;
  }
  async withAccountSyncLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    return this.lock(this.syncTarget(name), action);
  }
  async accountSyncLocked(name: string) {
    return lockfile.check(this.syncTarget(name), { stale: 60000 });
  }
  indexStatus(name: string): IndexStatus | undefined {
    try {
      const value = JSON.parse(readFileSync(this.path('state', alias(name), 'index-status.json'), 'utf8'));
      const time = (v: unknown) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) && Number.isFinite(Date.parse(v)) ? v : undefined;
      const attemptedAt = time(value.attemptedAt);
      if (!attemptedAt || !['pending', 'indexing', 'ok', 'failed'].includes(value.status)) return undefined;
      return { status: value.status, retryNotBefore: time(value.retryNotBefore), failures: Number.isSafeInteger(value.failures) && value.failures >= 0 ? Math.min(value.failures, 1000) : undefined, attemptedAt, completedAt: time(value.completedAt), lastSuccess: time(value.lastSuccess), completeThrough: time(value.completeThrough), diagnostic: sanitizeDiagnostic(value.diagnostic) };
    } catch { return undefined; }
  }
  status(name: string): SyncStatus | undefined {
    try {
      const value = JSON.parse(readFileSync(this.path('state', alias(name) + '.json'), 'utf8'));
      const time = (v: unknown) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) && Number.isFinite(Date.parse(v)) ? v : undefined;
      const attemptedAt = time(value.attemptedAt);
      if (!['syncing', 'ok', 'failed'].includes(value.status) || !attemptedAt) return undefined;
      const errors = new Set(['RECONNECT_ACCOUNT', 'MAIL_COMMAND_FAILED', 'SYNC_FAILED', 'INVALID_MAIL_CONFIG', 'INVALID_EMAIL', ...diagnosticErrorCodes]);
      return { status: value.status, indexDeferred: value.indexDeferred === true ? true : undefined, completedDownloadScope: typeof value.completedDownloadScope === 'string' && /^sha256:[0-9a-f]{64}$/.test(value.completedDownloadScope) ? value.completedDownloadScope : undefined, failures: Number.isSafeInteger(value.failures) && value.failures >= 0 ? Math.min(value.failures, 1000) : undefined, downloadCompletedAt: time(value.downloadCompletedAt), attemptedAt, completedAt: time(value.completedAt), lastSuccess: time(value.lastSuccess), phase: ['preparing', 'download', 'index', 'complete'].includes(value.phase) ? value.phase : undefined, phaseStartedAt: time(value.phaseStartedAt), diagnostic: value.status === 'failed' ? sanitizeDiagnostic(value.diagnostic) : undefined, error: value.status === 'failed' ? (errors.has(value.error) ? value.error : 'SYNC_FAILED') : undefined };
    } catch { return undefined; }
  }
}
