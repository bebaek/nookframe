import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { GoogleStore } from '../google/store.js';

export class CalendarError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function alias(value: string) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(value)) throw new CalendarError('INVALID_ACCOUNT_ALIAS');
  return value;
}
export const secret = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\x00-\x20\x7f]/.test(value);
export const validEmail = (value: unknown): value is string => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
export interface OAuthClient { version: 1; clientId: string; clientSecret: string; redirectUri: string }
export interface Account {
  version: 1; alias: string; provider: 'google'; subject: string; email: string; scopes: string[];
  oauth: { clientId: string; refreshToken: string; accessToken: string; expiresAt: number };
}
export class CalendarStore {
  readonly root: string;
  constructor(root: string, readonly google?: GoogleStore) {
    this.root = resolve(root);
    if (google?.root === this.root) throw new CalendarError('SEPARATE_GOOGLE_DIR_REQUIRED');
    for (const part of ['', 'accounts', 'pending', '.locks/oauth', '.locks/credentials']) mkdirSync(this.path(part), { recursive: true, mode: 0o700 });
  }
  path(...parts: string[]) { return join(this.root, ...parts); }
  write(path: string, value: unknown) {
    if (this.google && path === this.path('oauth-client.json')) { this.google.configure(value as OAuthClient); return; }
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  client(): OAuthClient {
    try {
      const shared = this.google?.client();
      if (shared) return { version: 1, ...shared, redirectUri: '' };
      const c = JSON.parse(readFileSync(this.path('oauth-client.json'), 'utf8'));
      if (c.version !== 1 || typeof c.clientId !== 'string' || !/^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(c.clientId) || !secret(c.clientSecret) || typeof c.redirectUri !== 'string') throw new Error();
      return c;
    } catch { throw new CalendarError('OAUTH_CLIENT_NOT_CONFIGURED'); }
  }
  account(name: string): Account {
    alias(name);
    try {
      const a = JSON.parse(readFileSync(this.path('accounts', name + '.json'), 'utf8'));
      const shared = this.google?.account(name);
      if (shared) {
        if (shared.email.toLowerCase() !== a.email.toLowerCase()) throw new Error();
        a.oauth = shared.oauth; a.scopes = shared.scopes;
      }
      if (a.version !== 1 || a.alias !== name || a.provider !== 'google' || !secret(a.subject) || !validEmail(a.email) || !Array.isArray(a.scopes) || !a.scopes.every(secret) || !secret(a.oauth?.clientId) || !secret(a.oauth?.refreshToken) || !secret(a.oauth?.accessToken) || !Number.isFinite(a.oauth?.expiresAt)) throw new Error();
      return a;
    } catch { throw new CalendarError('ACCOUNT_NOT_CONNECTED'); }
  }
  accounts() { return readdirSync(this.path('accounts')).filter(f => /^[a-z][a-z0-9-]{0,31}\.json$/.test(f)).map(f => this.account(f.slice(0, -5))); }
  saveAccount(account: Account) {
    if (this.google) {
      this.google.save({ version: 1, alias: account.alias, email: account.email, subject: account.subject, scopes: account.scopes, oauth: account.oauth });
      const { oauth, scopes, ...metadata } = account;
      this.write(this.path('accounts', alias(account.alias) + '.json'), { ...metadata, googleAccount: account.alias });
    } else this.write(this.path('accounts', alias(account.alias) + '.json'), account);
  }
  private async lock<T>(target: string, action: () => Promise<T>, wait = false): Promise<T> {
    let release: () => Promise<void>;
    try { release = await lockfile.lock(target, { stale: 60000, update: 10000, retries: wait ? { retries: 60, factor: 1, minTimeout: 500, maxTimeout: 500, randomize: false } : 0 }); }
    catch { throw new CalendarError('CALENDAR_BUSY'); }
    try { return await action(); } finally { await release(); }
  }
  locked<T>(action: () => Promise<T>) { return this.lock(this.google?.path('.locks/oauth') ?? this.path('.locks/oauth'), action); }
  withAccountCredentialLock<T>(name: string, action: () => Promise<T>, wait = false) {
    const target = this.google?.path('.locks/credentials', alias(name)) ?? this.path('.locks/credentials', alias(name));
    mkdirSync(target, { recursive: true, mode: 0o700 });
    return this.lock(target, action, wait);
  }
  // Control-plane lock first, then credential locks in alias order. Refresh only
  // takes its account lock, never the control-plane lock.
  withConfigurationLock<T>(action: () => Promise<T>) {
    return this.locked(async () => {
      const accounts = [...new Set([...this.accounts().map(a => a.alias), ...(this.google?.accounts().map(a => a.alias) ?? [])])].sort();
      const next = (i: number): Promise<T> => i === accounts.length ? action() : this.withAccountCredentialLock(accounts[i], () => next(i + 1));
      return next(0);
    });
  }
}
