import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';

export class AccountRegistryError extends Error {
  constructor(readonly code: string) { super(code); }
}
const fail = (code: string): never => { throw new AccountRegistryError(code); };
const validKey = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(v);
const validId = (v: unknown): v is string => typeof v === 'string' && /^m[a-f0-9]{31}$/.test(v);
export interface LocalMailAccount {
  id: string;
  alias: string;
  provider: string;
  // Immutable adapter connection/storage reference. Legacy directories stay in
  // place; the spelling of this reference is never a user-facing alias again.
  storageRef: string;
  connectionRef: string;
}
interface Registry { version: 1; accounts: LocalMailAccount[] }
export interface MailProviderAdapter {
  id: string;
  capabilities: readonly string[];
  discover(): { storageRef: string; connectionRef?: string; suggestedAlias: string }[];
  describe(storageRef: string): { email: string; connected: boolean; details?: Record<string, unknown> };
  withMigrationLock<T>(action: () => Promise<T>): Promise<T>;
}
export type MigrationAliases = Record<string, Record<string, string>>;

export class MailAccountRegistry {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  get file() { return join(this.root, 'account-registry.json'); }
  get enabled() { return existsSync(this.file); }
  private read(): Registry {
    if (!this.enabled) return fail('ACCOUNT_REGISTRY_MIGRATION_REQUIRED');
    let data: Registry;
    try { data = JSON.parse(readFileSync(this.file, 'utf8')); } catch { return fail('INVALID_ACCOUNT_REGISTRY'); }
    if (data?.version !== 1 || !Array.isArray(data.accounts)) return fail('INVALID_ACCOUNT_REGISTRY');
    const ids = new Set(), aliases = new Set(), refs = new Set(), connections = new Set();
    for (const a of data.accounts) {
      if (!a || !validId(a.id) || !validKey(a.alias) || validId(a.alias) || !validKey(a.provider) || !validKey(a.storageRef) || !validKey(a.connectionRef)
        || connections.has(`${a.provider}:${a.connectionRef}`) || ids.has(a.id) || aliases.has(a.alias) || refs.has(`${a.provider}:${a.storageRef}`)) return fail('INVALID_ACCOUNT_REGISTRY');
      ids.add(a.id); aliases.add(a.alias); refs.add(`${a.provider}:${a.storageRef}`); connections.add(`${a.provider}:${a.connectionRef}`);
    }
    return data;
  }
  accounts() { return this.read().accounts; }
  resolve(name: string, provider?: string): LocalMailAccount {
    const found = this.accounts().find(a => a.alias === name || a.id === name);
    if (!found) return fail('ACCOUNT_NOT_CONNECTED');
    if (provider && found.provider !== provider) return fail('ACCOUNT_PROVIDER_MISMATCH');
    return found;
  }
  // Only backend code uses immutable references. CLI input MUST use resolve().
  findBinding(provider: string, reference: string) {
    return this.accounts().find(a => a.provider === provider && (a.id === reference || a.storageRef === reference));
  }
  binding(provider: string, reference: string): LocalMailAccount {
    return this.findBinding(provider, reference) ?? fail('ACCOUNT_NOT_REGISTERED');
  }
  private async locked<T>(action: () => Promise<T>) {
    const target = join(this.root, '.locks', 'account-registry');
    mkdirSync(target, { recursive: true, mode: 0o700 });
    let release: () => Promise<void>;
    try { release = await lockfile.lock(target, { stale: 60000, update: 10000, retries: 0 }); }
    catch { return fail('MAIL_BUSY'); }
    try { return await action(); } finally { await release(); }
  }
  private save(data: Registry) {
    const tmp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const fd = openSync(tmp, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(data) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, this.file);
      const directory = openSync(this.root, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally { if (existsSync(tmp)) unlinkSync(tmp); }
  }
  private validateAlias(name: string) {
    if (!validKey(name) || validId(name)) fail('INVALID_ACCOUNT_ALIAS');
  }
  async rename(from: string, to: string) {
    this.validateAlias(to);
    return this.locked(async () => {
      const data = this.read(), account = this.resolve(from);
      if (account.alias === to) return { renamed: false, account };
      if (data.accounts.some(a => a.alias === to)) return fail('ACCOUNT_ALIAS_IN_USE');
      const previousAlias = account.alias;
      account.alias = to;
      data.accounts = data.accounts.map(a => a.id === account.id ? account : a);
      this.save(data);
      return { renamed: true, previousAlias, account };
    });
  }
  async reserve(provider: string, name: string, connectionRef?: string) {
    if (validId(name)) return this.resolve(name, provider);
    this.validateAlias(name);
    if (!validKey(provider)) return fail('INVALID_MAIL_PROVIDER');
    return this.locked(async () => {
      const data = this.read(), existing = data.accounts.find(a => a.alias === name);
      if (existing) {
        if (existing.provider !== provider) return fail('ACCOUNT_ALIAS_IN_USE');
        return existing;
      }
      const id = 'm' + randomBytes(16).toString('hex').slice(0, 31);
      if (connectionRef !== undefined && !validKey(connectionRef)) return fail('INVALID_ACCOUNT_REFERENCE');
      if (connectionRef && data.accounts.some(a => a.provider === provider && a.connectionRef === connectionRef)) return fail('ACCOUNT_CONNECTION_IN_USE');
      const account = { id, alias: name, provider, storageRef: id, connectionRef: connectionRef ?? id };
      data.accounts.push(account); this.save(data); return account;
    });
  }
  preview(providers: readonly MailProviderAdapter[], aliases: MigrationAliases = {}) {
    const providerIds = new Set<string>();
    for (const p of providers) {
      if (!validKey(p.id) || providerIds.has(p.id)) return fail('INVALID_MAIL_PROVIDER');
      providerIds.add(p.id);
    }
    if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return fail('INVALID_MIGRATION_ALIASES');
    const accounts = providers.flatMap(p => p.discover().map(connection => {
      if (!validKey(connection.storageRef)) return fail('INVALID_ACCOUNT_REFERENCE');
      const name = aliases[p.id]?.[connection.storageRef] ?? connection.suggestedAlias;
      this.validateAlias(name);
      const connectionRef = connection.connectionRef ?? connection.storageRef;
      if (!validKey(connectionRef)) return fail('INVALID_ACCOUNT_REFERENCE');
      return { provider: p.id, storageRef: connection.storageRef, connectionRef, alias: name };
    }));
    for (const [provider, mappings] of Object.entries(aliases)) {
      if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) return fail('INVALID_MIGRATION_ALIASES');
      for (const reference of Object.keys(mappings)) if (!accounts.some(a => a.provider === provider && a.storageRef === reference)) return fail('INVALID_MIGRATION_ALIASES');
    }
    if (new Set(accounts.map(a => `${a.provider}:${a.storageRef}`)).size !== accounts.length
      || new Set(accounts.map(a => `${a.provider}:${a.connectionRef}`)).size !== accounts.length) return fail('ACCOUNT_CONNECTION_IN_USE');
    const collisions = [...new Set(accounts.filter((a, i) => accounts.some((b, j) => i !== j && a.alias === b.alias)).map(a => a.alias))];
    return { migrationRequired: !this.enabled, accounts, collisions, canApply: collisions.length === 0 };
  }
  async migrate(providers: readonly MailProviderAdapter[], aliases: MigrationAliases = {}) {
    // Provider control/worker locks are acquired before the registry lock, just
    // like connection reservation. Rename takes only the registry lock.
    const ordered = [...providers].sort((a, b) => a.id.localeCompare(b.id));
    this.preview(ordered, aliases);
    const apply = async () => this.locked(async () => {
      if (this.enabled) { this.read(); return { migrated: false, accounts: this.accounts() }; }
      const plan = this.preview(ordered, aliases);
      if (!plan.canApply) return fail('AMBIGUOUS_ACCOUNT_ALIAS');
      const accounts = plan.accounts.map(a => ({ ...a, id: 'm' + randomBytes(16).toString('hex').slice(0, 31) }));
      // One atomic publication is the entire migration. No provider state,
      // credentials, approvals, history, or data directories are rewritten.
      this.save({ version: 1, accounts });
      return { migrated: true, accounts };
    });
    const next = (i: number): ReturnType<typeof apply> => i === ordered.length ? apply() : ordered[i].withMigrationLock(() => next(i + 1));
    return next(0);
  }
}

export class MailAccounts {
  private readonly providers: Map<string, MailProviderAdapter>;
  constructor(readonly registry: MailAccountRegistry, adapters: readonly MailProviderAdapter[]) {
    this.providers = new Map();
    for (const adapter of adapters) {
      if (this.providers.has(adapter.id)) fail('INVALID_MAIL_PROVIDER');
      this.providers.set(adapter.id, adapter);
    }
  }
  provider(id: string) { return this.providers.get(id) ?? fail('UNSUPPORTED_MAIL_PROVIDER'); }
  list() {
    return this.registry.accounts().map(account => {
      const provider = this.provider(account.provider);
      return { ...account, ...provider.describe(account.storageRef), capabilities: provider.capabilities };
    });
  }
  resolve(name: string, capability?: string) {
    const account = this.registry.resolve(name), provider = this.provider(account.provider);
    if (capability && !provider.capabilities.includes(capability)) fail('MAIL_CAPABILITY_UNSUPPORTED');
    return { account, provider };
  }
  rename(from: string, to: string) { return this.registry.rename(this.resolve(from).account.id, to); }
  preview(aliases?: MigrationAliases) { return this.registry.preview([...this.providers.values()], aliases); }
  migrate(aliases?: MigrationAliases) { return this.registry.migrate([...this.providers.values()], aliases); }
}
