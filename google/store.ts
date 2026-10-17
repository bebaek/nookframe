import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface Credentials { clientId: string; refreshToken: string; accessToken: string; expiresAt: number }
export interface Connection { version: 1; alias: string; email: string; subject?: string; scopes: string[]; oauth: Credentials }
export interface Client { clientId: string; clientSecret: string }
const validAlias = (name: string) => /^[a-z][a-z0-9-]{0,31}$/.test(name);
const secret = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 8192 && !/[\x00-\x20\x7f]/.test(v);

// Capability stores retain metadata; this store owns credentials and shared locks.
// Callers must hold the shared credential lock when writing a connection, and
// the shared OAuth control lock when adding identities or configuring the client.
export class GoogleStore {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    for (const part of ['', 'accounts', '.locks/oauth', '.locks/credentials']) mkdirSync(this.path(part), { recursive: true, mode: 0o700 });
  }
  path(...parts: string[]) { return join(this.root, ...parts); }
  write(path: string, value: unknown) {
    const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    try { writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(tmp, path); }
    finally { if (existsSync(tmp)) unlinkSync(tmp); }
  }
  client(): Client | undefined {
    const path = this.path('oauth-client.json');
    if (!existsSync(path)) return undefined;
    const c = JSON.parse(readFileSync(path, 'utf8'));
    if (c.version !== 1 || typeof c.clientId !== 'string' || !/^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(c.clientId) || !secret(c.clientSecret)) throw new Error('INVALID_GOOGLE_CLIENT');
    return { clientId: c.clientId, clientSecret: c.clientSecret };
  }
  configure(client: Client) { this.write(this.path('oauth-client.json'), { version: 1, clientId: client.clientId, clientSecret: client.clientSecret }); }
  account(name: string): Connection | undefined {
    if (!validAlias(name)) throw new Error('INVALID_ACCOUNT_ALIAS');
    const path = this.path('accounts', name + '.json');
    if (!existsSync(path)) return undefined;
    const a = JSON.parse(readFileSync(path, 'utf8'));
    if (a.version !== 1 || a.alias !== name || typeof a.email !== 'string' || !Array.isArray(a.scopes) || !a.scopes.every(secret) || (a.subject !== undefined && !secret(a.subject)) || !secret(a.oauth?.clientId) || !secret(a.oauth?.refreshToken) || !secret(a.oauth?.accessToken) || !Number.isFinite(a.oauth?.expiresAt)) throw new Error('INVALID_GOOGLE_ACCOUNT');
    return a;
  }
  accounts(): Connection[] {
    return readdirSync(this.path('accounts')).filter(f => /^[a-z][a-z0-9-]{0,31}\.json$/.test(f)).map(f => this.account(f.slice(0, -5))!);
  }
  save(account: Connection) {
    if (!validAlias(account.alias)) throw new Error('INVALID_ACCOUNT_ALIAS');
    const previous = this.account(account.alias);
    if (previous && (previous.email.toLowerCase() !== account.email.toLowerCase() || (previous.subject && account.subject && previous.subject !== account.subject))) throw new Error('WRONG_ACCOUNT_FOR_ALIAS');
    if (this.accounts().some(a => a.alias !== account.alias && (a.email.toLowerCase() === account.email.toLowerCase() || (a.subject && a.subject === account.subject)))) throw new Error('ACCOUNT_ALREADY_CONNECTED');
    this.write(this.path('accounts', account.alias + '.json'), { ...account, subject: account.subject ?? previous?.subject });
  }
}
