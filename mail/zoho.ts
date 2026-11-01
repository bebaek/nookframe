import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MailError, MailStore, alias, validEmail } from './store.js';
import { MailAccountRegistry } from './account-registry.js';

// Zoho .com only. Never trust callback accounts-server/api_domain as an endpoint.
export const ZOHO_CALLBACK = '/mail/zoho/oauth/callback';
export const ZOHO_SCOPES = ['ZohoMail.accounts.READ', 'ZohoMail.folders.READ', 'ZohoMail.messages.ALL'];
const AUTH = 'https://accounts.zoho.com/oauth/v2';
const API = 'https://mail.zoho.com/api/accounts';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const secret = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 8192 && !/[\x00-\x20\x7f]/.test(s);
function fail(code: string): never { throw new MailError(code); }
function id(v: unknown): string {
  if (typeof v !== 'string' || !/^[1-9][0-9]{0,29}$/.test(v)) fail('INVALID_ZOHO_ID');
  return v;
}
function record(v: unknown): Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('INVALID_ZOHO_DATA');
  return v as Record<string, any>;
}
// Node 24's source-aware reviver prevents rounding Zoho's 19-digit message IDs.
export function parseZohoJson(text: string): any {
  return JSON.parse(text, (_key, value, context?: { source: string }) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!context || !/^-?[0-9]+$/.test(context.source)) fail('INVALID_ZOHO_DATA');
      return context.source;
    }
    return value;
  });
}
function rawId(value: string): unknown {
  return (JSON as typeof JSON & { rawJSON(s: string): unknown }).rawJSON(id(value));
}
interface Client { clientId: string; clientSecret: string; redirectUri: string }
interface Account { alias: string; email: string; accountId: string; clientId: string; refreshToken: string; accessToken: string; expiresAt: number }
interface Pending { alias: string; email: string; clientId: string; expiresAt: number }
export type ZohoAction =
  | { action: 'send' | 'reply'; to: string[]; cc: string[]; subject: string; body: string; messageId?: string }
  | { action: 'read' | 'unread' | 'archive' | 'unarchive' | 'move' | 'trash'; messageId: string; folderId?: string; destination?: string };
interface Plan { id: string; account: string; accountId: string; from: string; createdAt: string; operation: ZohoAction }
interface Attempt { id: string; state: 'accepted' | 'rejected' | 'uncertain'; attemptedAt: string }
export function validateZohoAction(input: unknown): ZohoAction {
  const v = record(input);
  const keys = (allowed: string[]) => { if (Object.keys(v).some(k => !allowed.includes(k))) fail('INVALID_ZOHO_ACTION'); };
  if (v.action === 'send' || v.action === 'reply') {
    keys(['action', 'to', 'cc', 'subject', 'body', ...(v.action === 'reply' ? ['messageId'] : [])]);
    const recipients = (list: unknown, required: boolean) => {
      if (!Array.isArray(list) || list.length > 50 || (required && !list.length) || list.some(x => !validEmail(x))) fail('INVALID_RECIPIENTS');
      return list as string[];
    };
    if (typeof v.subject !== 'string' || v.subject.length > 998 || /[\r\n\0]/.test(v.subject) || typeof v.body !== 'string' || v.body.length > 100000 || v.body.includes('\0')) fail('INVALID_ZOHO_ACTION');
    return { action: v.action, to: recipients(v.to, true), cc: recipients(v.cc ?? [], false), subject: v.subject, body: v.body,
      ...(v.action === 'reply' ? { messageId: id(v.messageId) } : {}) };
  }
  if (!['read', 'unread', 'archive', 'unarchive', 'move', 'trash'].includes(v.action)) fail('INVALID_ZOHO_ACTION');
  keys(['action', 'messageId', ...(v.action === 'trash' ? ['folderId'] : []), ...(v.action === 'move' ? ['destination'] : [])]);
  return { action: v.action, messageId: id(v.messageId), ...(v.action === 'trash' ? { folderId: id(v.folderId) } : {}), ...(v.action === 'move' ? { destination: id(v.destination) } : {}) };
}

export class ZohoMail {
  readonly store: MailStore;
  readonly redirectUri: string;
  constructor(root: string, origin: string, private request: typeof fetch = fetch, private now: () => number = Date.now, registry?: MailAccountRegistry) {
    const url = new URL(origin);
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) fail('HTTPS_ORIGIN_REQUIRED');
    this.redirectUri = url.origin + ZOHO_CALLBACK;
    // No GoogleStore: Zoho credentials cannot enter shared Google connections.
    this.store = new MailStore(root, undefined, registry, 'zoho');
    for (const dir of ['plans', 'attempts']) mkdirSync(this.store.path(dir), { recursive: true, mode: 0o700 });
  }
  private load(path: string): any {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fail('ZOHO_LOCAL_STATE_UNAVAILABLE'); }
  }
  private client(): Client {
    const c = this.load(this.store.path('client.json'));
    if (!secret(c?.clientId) || !secret(c?.clientSecret) || c.redirectUri !== this.redirectUri) fail('ZOHO_CLIENT_NOT_CONFIGURED');
    return c;
  }
  private account(name: string): Account {
    const a = this.load(this.store.path('accounts', alias(name) + '.json'));
    if (a?.alias !== this.store.connectionKey(name) || !validEmail(a.email) || !secret(a.clientId) || !secret(a.refreshToken) || !secret(a.accessToken) || !Number.isFinite(a.expiresAt)) fail('ZOHO_ACCOUNT_NOT_CONNECTED');
    id(a.accountId);
    return { ...a, alias: this.store.accountId(name) };
  }
  private names(): string[] { return readdirSync(this.store.path('accounts')).filter(f => /^[a-z][a-z0-9-]{0,31}\.json$/.test(f)).map(f => f.slice(0, -5)); }
  connections() { return this.names().map(storageRef => ({ storageRef, suggestedAlias: storageRef })); }
  status(name?: string) {
    let configured = false; try { this.client(); configured = true; } catch {}
    return { provider: 'zoho', region: 'com', configured, callbackUrl: this.redirectUri,
      accounts: (name ? [alias(name)] : this.names()).map(n => { const a = this.account(n); return { alias: this.store.accountLabel(a.alias), ...(this.store.registry?.enabled ? { localAccountId: a.alias } : {}), email: a.email, accountId: a.accountId }; }) };
  }
  async configure(clientId: string, clientSecret: string) {
    if (!/^1000\.[A-Za-z0-9]+$/.test(clientId) || !secret(clientSecret)) fail('INVALID_OAUTH_CLIENT');
    return this.store.locked('oauth', async () => {
      // Rotation/migration of connected clients needs its own explicit workflow.
      if (this.names().length) fail('ZOHO_CLIENT_IN_USE');
      for (const file of readdirSync(this.store.path('pending'))) if (/^[a-f0-9]{64}\.json$/.test(file)) unlinkSync(this.store.path('pending', file));
      this.store.write(this.store.path('client.json'), { clientId, clientSecret, redirectUri: this.redirectUri });
      return { configured: true, callbackUrl: this.redirectUri };
    });
  }
  async connect(name: string, email: string) {
    alias(name); if (!validEmail(email)) fail('INVALID_EMAIL');
    return this.store.locked('oauth', async () => {
      const c = this.client();
      if (this.store.registry?.enabled) name = (await this.store.registry.reserve(this.store.provider, name)).id;
      const existing = existsSync(this.store.path('accounts', name + '.json')) ? this.account(name) : undefined;
      if (existing && existing.email.toLowerCase() !== email.toLowerCase()) fail('WRONG_ACCOUNT_FOR_ALIAS');
      for (const file of readdirSync(this.store.path('pending'))) {
        if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
        const p = this.load(this.store.path('pending', file));
        if (p.expiresAt <= this.now() || p.alias === name) unlinkSync(this.store.path('pending', file));
      }
      const state = randomBytes(32).toString('base64url');
      this.store.write(this.store.path('pending', digest(state) + '.json'), { alias: name, email, clientId: c.clientId, expiresAt: this.now() + 900000 } satisfies Pending);
      const url = new URL(AUTH + '/auth');
      url.search = new URLSearchParams({ client_id: c.clientId, redirect_uri: this.redirectUri, response_type: 'code', scope: ZOHO_SCOPES.join(','), access_type: 'offline', prompt: 'consent', state }).toString();
      return { account: this.store.accountLabel(name), localAccountId: this.store.accountId(name), email, authorizationUrl: url.href, expiresInSeconds: 900 };
    });
  }
  private async response(url: string, options: RequestInit): Promise<{ status: number; data: any }> {
    try {
      const r = await this.request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
      // Bound provider bodies, including streamed responses. Never expose errors.
      if (!r.body) fail('ZOHO_REQUEST_FAILED');
      const reader = r.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2_000_000) fail('ZOHO_RESPONSE_TOO_LARGE'); chunks.push(value); }
      } finally { await reader.cancel().catch(() => {}); }
      return { status: r.status, data: parseZohoJson(Buffer.concat(chunks).toString('utf8')) };
    } catch { return fail('ZOHO_REQUEST_FAILED'); }
  }
  private async exchange(c: Client, fields: Record<string, string>) {
    const r = await this.response(AUTH + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...fields }) });
    const d = r.data;
    if (r.status !== 200 || d?.error || !secret(d?.access_token) || !Number.isFinite(d.expires_in) || d.expires_in < 60) fail('ZOHO_REAUTHORIZE');
    if (d.api_domain !== undefined && d.api_domain !== 'https://www.zohoapis.com') fail('ZOHO_REGION_MISMATCH');
    if (d.scope !== undefined && (typeof d.scope !== 'string' || ZOHO_SCOPES.some(s => !d.scope.split(/[ ,]+/).includes(s)))) fail('ZOHO_SCOPES_REQUIRED');
    return d;
  }
  async callback(url: URL) {
    const state = url.searchParams.get('state');
    if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || url.searchParams.getAll('state').length !== 1) fail('INVALID_OR_EXPIRED_AUTHORIZATION');
    await this.store.locked('oauth', async () => {
      const file = this.store.path('pending', digest(state) + '.json');
      const p: Pending = this.load(file); unlinkSync(file);
      if (!Number.isFinite(p.expiresAt) || p.expiresAt <= this.now() || !validEmail(p.email)) fail('INVALID_OR_EXPIRED_AUTHORIZATION');
      alias(p.alias);
      if (url.searchParams.has('error')) fail('AUTHORIZATION_DENIED');
      const code = url.searchParams.get('code');
      if (!secret(code) || url.searchParams.getAll('code').length !== 1) fail('INVALID_OR_EXPIRED_AUTHORIZATION');
      if ((url.searchParams.has('location') && url.searchParams.get('location') !== 'us') || (url.searchParams.has('accounts-server') && url.searchParams.get('accounts-server') !== 'https://accounts.zoho.com')) fail('ZOHO_REGION_MISMATCH');
      await this.store.withAccountCredentialLock(p.alias, async () => {
        const c = this.client(); if (c.clientId !== p.clientId) fail('OAUTH_CLIENT_CHANGED_RETRY');
        const d = await this.exchange(c, { grant_type: 'authorization_code', code, redirect_uri: this.redirectUri });
        const response = await this.api(d.access_token, '');
        if (!Array.isArray(response)) fail('INVALID_ZOHO_DATA');
        const matches = response.filter(a => a?.type === 'ZOHO_ACCOUNT' && typeof a.primaryEmailAddress === 'string' && a.primaryEmailAddress.toLowerCase() === p.email.toLowerCase());
        if (matches.length !== 1) fail('WRONG_ACCOUNT_FOR_ALIAS');
        const accountId = id(String(matches[0].accountId));
        const previous = existsSync(this.store.path('accounts', p.alias + '.json')) ? this.account(p.alias) : undefined;
        if (previous && (previous.accountId !== accountId || previous.email.toLowerCase() !== p.email.toLowerCase())) fail('WRONG_ACCOUNT_FOR_ALIAS');
        if (this.names().some(n => this.store.accountId(n) !== this.store.accountId(p.alias) && this.account(n).accountId === accountId)) fail('ACCOUNT_ALREADY_CONNECTED');
        const refreshToken = d.refresh_token ?? (previous?.clientId === c.clientId ? previous.refreshToken : undefined);
        if (!secret(refreshToken)) fail('REFRESH_TOKEN_REQUIRED_REAUTHORIZE');
        this.store.write(this.store.path('accounts', p.alias + '.json'), { alias: this.store.connectionKey(p.alias), email: p.email, accountId, clientId: c.clientId, refreshToken, accessToken: d.access_token, expiresAt: this.now() + d.expires_in * 1000 } satisfies Account);
      }, true);
    });
  }
  private async token(name: string) {
    return this.store.withAccountCredentialLock(name, async () => {
      const a = this.account(name), c = this.client();
      if (a.clientId !== c.clientId) fail('ZOHO_REAUTHORIZE');
      if (a.expiresAt > this.now() + 120000) return a.accessToken;
      const d = await this.exchange(c, { grant_type: 'refresh_token', refresh_token: a.refreshToken });
      if (d.refresh_token !== undefined && !secret(d.refresh_token)) fail('ZOHO_REAUTHORIZE');
      a.accessToken = d.access_token; a.expiresAt = this.now() + d.expires_in * 1000; a.refreshToken = d.refresh_token ?? a.refreshToken;
      this.store.write(this.store.path('accounts', name + '.json'), { ...a, alias: this.store.connectionKey(name) });
      return a.accessToken;
    }, true);
  }
  private async api(token: string, path: string) {
    const r = await this.response(API + path, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    if (r.status !== 200 || r.data?.status?.code !== 200) fail('ZOHO_API_REQUEST_FAILED');
    return r.data.data;
  }
  async folders(name: string) {
    const a = this.account(name); const data = await this.api(await this.token(name), `/${a.accountId}/folders`);
    if (!Array.isArray(data) || data.length > 1000) fail('INVALID_ZOHO_DATA');
    return { untrusted: true, account: this.store.accountLabel(name), localAccountId: this.store.accountId(name), folders: data.map(f => ({ folderId: id(String(f.folderId)), name: String(f.folderName ?? '').slice(0, 500), type: String(f.folderType ?? '').slice(0, 100) })) };
  }
  async search(name: string, query: string, start = 1, limit = 20) {
    if (!query || query.length > 2000 || !Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_SEARCH');
    const a = this.account(name);
    const params = new URLSearchParams({ searchKey: query, start: String(start), limit: String(limit), includeto: 'true', receivedTime: String(this.now()) });
    const data = await this.api(await this.token(name), `/${a.accountId}/messages/search?${params}`);
    if (!Array.isArray(data) || data.length > limit) fail('INVALID_ZOHO_DATA');
    return { untrusted: true, source: 'live_zoho', account: this.store.accountLabel(name), localAccountId: this.store.accountId(name), start, limit, possiblyMore: data.length === limit,
      nextStart: data.length === limit ? start + limit : null,
      messages: data.map(m => ({ messageId: id(String(m.messageId)), folderId: id(String(m.folderId)),
        ...Object.fromEntries(['fromAddress', 'toAddress', 'ccAddress', 'subject', 'summary', 'status', 'receivedTime', 'receivedtime'].filter(k => m[k] !== undefined).map(k => [k, String(m[k]).slice(0, 4000)])) })) };
  }
  async read(name: string, folderId: string, messageId: string) {
    const a = this.account(name);
    const data = await this.api(await this.token(name), `/${a.accountId}/folders/${id(folderId)}/messages/${id(messageId)}/content?includeBlockContent=true`);
    if (typeof data?.content !== 'string') fail('INVALID_ZOHO_DATA');
    // Inert serialized text, never rendered as HTML or fetched for remote images.
    return { untrusted: true, account: this.store.accountLabel(name), localAccountId: this.store.accountId(name), folderId, messageId, format: 'inert_html', content: data.content.slice(0, 50000), truncated: data.content.length > 50000 };
  }
  plan(name: string, input: unknown) {
    const a = this.account(name);
    name = a.alias;
    const plan: Plan = { id: randomBytes(16).toString('hex'), account: name, accountId: a.accountId, from: a.email, createdAt: new Date(this.now()).toISOString(), operation: validateZohoAction(input) };
    this.store.write(this.store.path('plans', plan.id + '.json'), plan);
    return this.show(plan.id);
  }
  show(planId: string) {
    if (!/^[a-f0-9]{32}$/.test(planId)) fail('INVALID_PLAN_ID');
    const p: Plan = this.load(this.store.path('plans', planId + '.json'));
    if (p.id !== planId || !validEmail(p.from) || !Number.isFinite(Date.parse(p.createdAt))) fail('INVALID_ZOHO_PLAN');
    alias(p.account); id(p.accountId); p.operation = validateZohoAction(p.operation);
    return { untrusted: true, plan: p, version: digest(JSON.stringify(p)),
      ...(this.store.registry?.enabled ? { accountIdentity: this.store.registry.findBinding(this.store.provider, p.account) ?? null } : {}) };
  }
  attempt(planId: string): Attempt | { id: string; state: 'not_attempted' } {
    this.show(planId);
    const file = this.store.path('attempts', planId + '.json');
    if (!existsSync(file)) return { id: planId, state: 'not_attempted' };
    const a = this.load(file);
    if (a?.id !== planId || !['accepted', 'rejected', 'uncertain'].includes(a.state) || !Number.isFinite(Date.parse(a.attemptedAt))) fail('INVALID_ZOHO_ATTEMPT_DO_NOT_RETRY');
    return { id: a.id, state: a.state, attemptedAt: a.attemptedAt };
  }
  private persist(a: Attempt) {
    const file = this.store.path('attempts', a.id + '.json'), tmp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
    const syncDir = (dir: string) => { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
    syncDir(this.store.root);
    try {
      const fd = openSync(tmp, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(a)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, file); syncDir(this.store.path('attempts'));
    } finally { if (existsSync(tmp)) unlinkSync(tmp); }
  }
  async execute(planId: string, version: string) {
    this.show(planId);
    return this.store.withAccountSyncLock(this.show(planId).plan.account, () => this.store.withDraftLock(planId, async () => {
      const shown = this.show(planId), p = shown.plan;
      if (version !== shown.version) fail('PLAN_VERSION_CONFLICT');
      if (existsSync(this.store.path('attempts', planId + '.json'))) fail('ZOHO_ALREADY_ATTEMPTED_CHECK_STATUS');
      const a = this.account(p.account);
      if (a.accountId !== p.accountId || a.email !== p.from) fail('PLAN_ACCOUNT_CHANGED');
      const token = await this.token(p.account), op = p.operation;
      let path = `/${a.accountId}`, method = 'PUT', body: Record<string, unknown> | undefined;
      if (op.action === 'send' || op.action === 'reply') {
        method = 'POST'; path += '/messages' + (op.action === 'reply' ? '/' + id(op.messageId) : '');
        body = { fromAddress: p.from, toAddress: op.to.join(','), ccAddress: op.cc.join(','), subject: op.subject, content: op.body, mailFormat: 'plaintext', encoding: 'UTF-8', askReceipt: 'no', ...(op.action === 'reply' ? { action: 'reply' } : {}) };
      } else if (op.action === 'trash') {
        method = 'DELETE'; path += `/folders/${id(op.folderId)}/messages/${op.messageId}?expunge=false`;
      } else {
        path += '/updatemessage';
        const modes = { read: 'markAsRead', unread: 'markAsUnread', archive: 'archiveMails', unarchive: 'unArchiveMails', move: 'moveMessage' };
        body = { mode: modes[op.action], messageId: [rawId(op.messageId!)], ...(op.action === 'move' ? { destfolderId: rawId(op.destination!) } : {}) };
      }
      const serialized = body ? JSON.stringify(body) : undefined;
      const attempt: Attempt = { id: planId, state: 'uncertain', attemptedAt: new Date(this.now()).toISOString() };
      this.persist(attempt); // Must be durable before the first network side effect.
      try {
        const r = await this.response(API + path, { method, headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' }, body: serialized });
        if (r.status >= 200 && r.status < 300 && r.data?.status?.code === 200) attempt.state = 'accepted';
        else if (r.status >= 400 && r.status < 500 && r.status !== 408) attempt.state = 'rejected';
      } catch { /* An unknown write outcome is never automatically retried. */ }
      this.persist(attempt);
      return attempt;
    }));
  }
}
export function zohoRuntime() {
  const mailRoot = resolve(process.env.MAIL_DIR ?? join(resolve(process.env.STATE_DIR ?? '.local/state'), '..', 'mail'));
  return new ZohoMail(join(mailRoot, 'zoho'), process.env.PUBLIC_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`, fetch, Date.now, new MailAccountRegistry(mailRoot));
}
