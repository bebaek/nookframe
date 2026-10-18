import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { CalendarError, CalendarStore, alias, secret, validEmail, type OAuthClient } from './store.js';

export const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly'];
export const CALENDAR_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned';
export const CALLBACK_PATH = '/calendar/oauth/callback';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
interface Pending { version: 1; alias: string; verifier: string; expiresAt: number; clientId: string; write?: boolean }
export class CalendarOAuth {
  readonly redirectUri: string;
  constructor(readonly store: CalendarStore, origin: string, private request: typeof fetch = fetch, private now: () => number = Date.now) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new CalendarError('INVALID_PUBLIC_ORIGIN'); }
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new CalendarError('HTTPS_ORIGIN_REQUIRED');
    this.redirectUri = url.origin + CALLBACK_PATH;
  }
  async configure(clientId: string, clientSecret: string) {
    if (!/^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(clientId) || !secret(clientSecret)) throw new CalendarError('INVALID_OAUTH_CLIENT');
    await this.store.withConfigurationLock(async () => {
      for (const file of readdirSync(this.store.path('pending'))) if (/^[a-f0-9]{64}\.json$/.test(file)) unlinkSync(this.store.path('pending', file));
      this.store.write(this.store.path('oauth-client.json'), { version: 1, clientId, clientSecret, redirectUri: this.redirectUri } satisfies OAuthClient);
    });
  }
  private client() {
    const client = this.store.client();
    if (client.redirectUri && client.redirectUri !== this.redirectUri) throw new CalendarError('OAUTH_CALLBACK_CHANGED_RECONFIGURE');
    return client;
  }
  connect(name: string, write = false) {
    alias(name);
    return this.store.locked(async () => {
      const client = this.client();
      for (const file of readdirSync(this.store.path('pending'))) {
        if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
        try { if (JSON.parse(readFileSync(this.store.path('pending', file), 'utf8')).expiresAt <= this.now()) unlinkSync(this.store.path('pending', file)); } catch { /* Never log pending state. */ }
      }
      const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
      this.store.write(this.store.path('pending', hash(state) + '.json'), { version: 1, alias: name, verifier, expiresAt: this.now() + 900000, clientId: client.clientId, write } satisfies Pending);
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({ client_id: client.clientId, redirect_uri: this.redirectUri, response_type: 'code', scope: [...new Set([...CALENDAR_SCOPES, ...(write ? [CALENDAR_WRITE_SCOPE] : []), 'openid', 'email', ...(this.store.google?.account(name)?.scopes ?? [])])].join(' '), include_granted_scopes: 'true', access_type: 'offline', prompt: 'consent select_account', state, code_challenge: hashBase64(verifier), code_challenge_method: 'S256' }).toString();
      return { account: name, status: 'authorization_pending', authorizationUrl: url.href, expiresInSeconds: 900 };
    });
  }
  private async json(url: string, options: RequestInit): Promise<any> {
    try {
      const response = await this.request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
      // Bound provider bodies before decoding, including unsuccessful responses.
      if (!response.body) throw new CalendarError('OAUTH_REQUEST_FAILED');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length;
          if (size > 65536) { await reader.cancel(); throw new CalendarError('OAUTH_REQUEST_FAILED'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) throw new CalendarError(data?.error === 'invalid_grant' ? 'RECONNECT_ACCOUNT' : 'OAUTH_REQUEST_FAILED');
      return data;
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      throw new CalendarError('OAUTH_REQUEST_FAILED');
    }
  }
  private scopes(value: unknown): string[] {
    if (typeof value !== 'string' || !CALENDAR_SCOPES.every(s => value.split(' ').includes(s))) throw new CalendarError('CALENDAR_READ_SCOPES_REQUIRED');
    return value.split(' ').filter(Boolean);
  }
  private async exchange(client: OAuthClient, fields: Record<string, string>) {
    const data = await this.json('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...fields }) });
    if (!secret(data?.access_token) || !Number.isFinite(data.expires_in) || data.expires_in < 60 || data.expires_in > 86400 || (data.refresh_token !== undefined && !secret(data.refresh_token))) throw new CalendarError('INVALID_TOKEN_RESPONSE');
    if (data.scope !== undefined) this.scopes(data.scope);
    return data;
  }
  async callback(url: URL) {
    const state = url.searchParams.get('state');
    if (!state || !/^[a-zA-Z0-9_-]{43}$/.test(state) || url.searchParams.getAll('state').length !== 1) throw new CalendarError('INVALID_OR_EXPIRED_AUTHORIZATION');
    await this.store.locked(async () => {
      let pending: Pending;
      try {
        const path = this.store.path('pending', hash(state) + '.json');
        pending = JSON.parse(readFileSync(path, 'utf8')); unlinkSync(path);
        if (pending.version !== 1 || !Number.isFinite(pending.expiresAt) || pending.expiresAt <= this.now() || !secret(pending.verifier)) throw new Error();
      } catch { throw new CalendarError('INVALID_OR_EXPIRED_AUTHORIZATION'); }
      alias(pending.alias);
      if (url.searchParams.has('error')) throw new CalendarError('AUTHORIZATION_DENIED');
      const code = url.searchParams.get('code');
      if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) throw new CalendarError('INVALID_OR_EXPIRED_AUTHORIZATION');
      await this.store.withAccountCredentialLock(pending.alias, async () => {
        const client = this.client();
        if (pending.clientId !== client.clientId) throw new CalendarError('OAUTH_CLIENT_CHANGED_RETRY');
        const data = await this.exchange(client, { grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: pending.verifier });
        const scopes = this.scopes(data.scope);
        const identity = await this.json('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${data.access_token}` } });
        if (!secret(identity?.sub) || !validEmail(identity.email) || identity.email_verified !== true) throw new CalendarError('VERIFIED_IDENTITY_REQUIRED');
        const existing = existsSync(this.store.path('accounts', pending.alias + '.json')) ? this.store.account(pending.alias) : undefined;
        if (existing && existing.subject !== identity.sub) throw new CalendarError('WRONG_ACCOUNT_FOR_ALIAS');
        if (this.store.accounts().some(a => a.alias !== pending.alias && a.subject === identity.sub) || this.store.google?.accounts().some(a => a.alias !== pending.alias && (a.email.toLowerCase() === identity.email.toLowerCase() || a.subject === identity.sub))) throw new CalendarError('ACCOUNT_ALREADY_CONNECTED');
        const shared = this.store.google?.account(pending.alias);
        if (shared && (shared.email.toLowerCase() !== identity.email.toLowerCase() || (shared.subject && shared.subject !== identity.sub))) throw new CalendarError('WRONG_ACCOUNT_FOR_ALIAS');
        const previous = shared ?? existing;
        const refreshToken = data.refresh_token ?? (previous?.oauth.clientId === client.clientId ? previous.oauth.refreshToken : undefined);
        if (!secret(refreshToken)) throw new CalendarError('REFRESH_TOKEN_REQUIRED_REAUTHORIZE');
        this.store.saveAccount({ version: 1, alias: pending.alias, provider: 'google', subject: identity.sub, email: identity.email, scopes,
          oauth: { clientId: client.clientId, refreshToken, accessToken: data.access_token, expiresAt: this.now() + data.expires_in * 1000 } });
        if (pending.write && !scopes.includes(CALENDAR_WRITE_SCOPE)) throw new CalendarError('CALENDAR_WRITE_SCOPE_REQUIRED');
      }, true);
    });
  }
  // Internal only. Never expose credentials through CLI or HTTP output.
  accessToken(name: string, write = false): Promise<string> {
    return this.store.withAccountCredentialLock(name, async () => {
      const account = this.store.account(name), client = this.client();
      if (account.oauth.clientId !== client.clientId) throw new CalendarError('RECONNECT_ACCOUNT');
      this.scopes(account.scopes.join(' '));
      if (write && !account.scopes.includes(CALENDAR_WRITE_SCOPE)) throw new CalendarError('CALENDAR_WRITE_SCOPE_REQUIRED');
      if (account.oauth.expiresAt > this.now() + 120000) return account.oauth.accessToken;
      const data = await this.exchange(client, { grant_type: 'refresh_token', refresh_token: account.oauth.refreshToken });
      if (data.scope !== undefined) account.scopes = this.scopes(data.scope);
      account.oauth = { clientId: client.clientId, refreshToken: data.refresh_token ?? account.oauth.refreshToken, accessToken: data.access_token, expiresAt: this.now() + data.expires_in * 1000 };
      this.store.saveAccount(account);
      if (write && !account.scopes.includes(CALENDAR_WRITE_SCOPE)) throw new CalendarError('CALENDAR_WRITE_SCOPE_REQUIRED');
      return account.oauth.accessToken;
    }, true);
  }
}
function hashBase64(value: string) { return createHash('sha256').update(value).digest('base64url'); }
