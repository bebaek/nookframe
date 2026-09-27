import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { MailError, MailStore, alias, validEmail, type OAuthClient } from './store.js';

export const MAIL_SCOPE = 'https://mail.google.com/';
export const CALLBACK_PATH = '/mail/oauth/callback';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const INFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
interface Pending { alias: string; verifier: string; expiresAt: number; clientId: string }
const secret = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\x00-\x20\x7f]/.test(value);

export class MailOAuth {
  readonly redirectUri: string;
  constructor(readonly store: MailStore, origin: string, private request: typeof fetch = fetch, private now: () => number = Date.now) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new MailError('INVALID_PUBLIC_ORIGIN'); }
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new MailError('HTTPS_ORIGIN_REQUIRED');
    this.redirectUri = url.origin + CALLBACK_PATH;
  }
  async configure(clientId: string, clientSecret: string) {
    if (!/^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(clientId) || !secret(clientSecret)) throw new MailError('INVALID_OAUTH_CLIENT');
    await this.store.locked('oauth', async () => this.store.write(this.store.path('oauth-client.json'), { clientId, clientSecret, redirectUri: this.redirectUri } satisfies OAuthClient));
  }
  private client() {
    const client = this.store.client();
    if (client.redirectUri !== this.redirectUri) throw new MailError('OAUTH_CALLBACK_CHANGED_RECONFIGURE');
    return client;
  }
  async connect(name: string) {
    alias(name);
    return this.store.locked('oauth', async () => {
      const client = this.client();
      // Pending authorizations expire after 15 minutes and are never replayable.
      for (const file of readdirSync(this.store.path('pending'))) {
        if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
        try { if (JSON.parse(readFileSync(this.store.path('pending', file), 'utf8')).expiresAt <= this.now()) unlinkSync(this.store.path('pending', file)); } catch { /* Never print pending state. */ }
      }
      const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
      this.store.write(this.store.path('pending', hash(state) + '.json'), { alias: name, verifier, expiresAt: this.now() + 15 * 60000, clientId: client.clientId } satisfies Pending);
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({ client_id: client.clientId, redirect_uri: this.redirectUri, response_type: 'code', scope: `${MAIL_SCOPE} openid email`, access_type: 'offline', prompt: 'consent select_account', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
      return { account: name, status: 'authorization_pending', authorizationUrl: url.href, expiresInSeconds: 900 };
    });
  }
  private async json(url: string, options: RequestInit): Promise<any> {
    try {
      const response = await this.request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (!response.ok) throw new MailError(data?.error === 'invalid_grant' ? 'RECONNECT_ACCOUNT' : 'OAUTH_REQUEST_FAILED');
      return data;
    } catch (error) {
      // Provider bodies, URLs, and transport errors may contain credentials.
      if (error instanceof MailError) throw error;
      throw new MailError('OAUTH_REQUEST_FAILED');
    }
  }
  private async exchange(client: OAuthClient, fields: Record<string, string>) {
    const data = await this.json(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...fields }) });
    if (!secret(data.access_token) || !Number.isFinite(data.expires_in) || data.expires_in < 60) throw new MailError('INVALID_TOKEN_RESPONSE');
    if (typeof data.scope === 'string' && !data.scope.split(' ').includes(MAIL_SCOPE)) throw new MailError('GMAIL_IMAP_SCOPE_REQUIRED');
    return data;
  }
  async callback(url: URL) {
    const state = url.searchParams.get('state');
    if (!state || !/^[a-zA-Z0-9_-]{43}$/.test(state) || url.searchParams.getAll('state').length !== 1) throw new MailError('INVALID_OR_EXPIRED_AUTHORIZATION');
    await this.store.locked('oauth', async () => {
      const path = this.store.path('pending', hash(state) + '.json');
      let pending: Pending;
      try { pending = JSON.parse(readFileSync(path, 'utf8')); unlinkSync(path); } catch { throw new MailError('INVALID_OR_EXPIRED_AUTHORIZATION'); }
      if (pending.expiresAt <= this.now()) throw new MailError('INVALID_OR_EXPIRED_AUTHORIZATION');
      alias(pending.alias);
      if (url.searchParams.has('error')) throw new MailError('AUTHORIZATION_DENIED');
      const code = url.searchParams.get('code');
      if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) throw new MailError('INVALID_OR_EXPIRED_AUTHORIZATION');
      const client = this.client();
      if (pending.clientId !== client.clientId) throw new MailError('OAUTH_CLIENT_CHANGED_RETRY');
      const data = await this.exchange(client, { grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: pending.verifier });
      if (typeof data.scope !== 'string' || !data.scope.split(' ').includes(MAIL_SCOPE)) throw new MailError('GMAIL_IMAP_SCOPE_REQUIRED');
      const identity = await this.json(INFO_URL, { headers: { Authorization: `Bearer ${data.access_token}` } });
      if (!validEmail(identity.email) || identity.email_verified !== true) throw new MailError('VERIFIED_EMAIL_REQUIRED');
      const existing = existsSync(this.store.path('accounts', pending.alias + '.json')) ? this.store.account(pending.alias) : undefined;
      if (existing && existing.email.toLowerCase() !== identity.email.toLowerCase()) throw new MailError('WRONG_ACCOUNT_FOR_ALIAS');
      if (this.store.accounts().some(a => a.alias !== pending.alias && a.email.toLowerCase() === identity.email.toLowerCase())) throw new MailError('ACCOUNT_ALREADY_CONNECTED');
      const refreshToken = data.refresh_token ?? (existing?.oauth.clientId === client.clientId ? existing.oauth.refreshToken : undefined);
      if (!secret(refreshToken)) throw new MailError('REFRESH_TOKEN_REQUIRED_REAUTHORIZE');
      this.store.saveAccount({ alias: pending.alias, provider: 'gmail', email: identity.email, polling: existing?.polling ?? false,
        oauth: { clientId: client.clientId, refreshToken, accessToken: data.access_token, expiresAt: this.now() + data.expires_in * 1000 } });
    });
  }
  // Called only by the mbsync password helper, never by public CLI commands.
  async accessToken(name: string): Promise<string> {
    return this.store.locked('oauth', async () => {
      const account = this.store.account(name), client = this.client();
      if (account.oauth.clientId !== client.clientId) throw new MailError('RECONNECT_ACCOUNT');
      if (account.oauth.expiresAt > this.now() + 120000 && secret(account.oauth.accessToken)) return account.oauth.accessToken;
      const data = await this.exchange(client, { grant_type: 'refresh_token', refresh_token: account.oauth.refreshToken });
      if (data.refresh_token !== undefined && !secret(data.refresh_token)) throw new MailError('INVALID_TOKEN_RESPONSE');
      account.oauth = { clientId: client.clientId, refreshToken: data.refresh_token ?? account.oauth.refreshToken, accessToken: data.access_token, expiresAt: this.now() + data.expires_in * 1000 };
      this.store.saveAccount(account);
      return account.oauth.accessToken;
    });
  }
}
