import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SESSION_SECONDS = 30 * 24 * 60 * 60;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

// Opaque browser credentials, separate from the bootstrap access token. Store
// only hashes; bind the store to that token so rotation revokes every login.
export class BrowserSessions {
  private sessions = new Map<string, number>();
  private binding: string;
  private file?: string;
  constructor(token: string, stateDir?: string, private now: () => number = Date.now) {
    this.binding = digest(token);
    if (!stateDir) return; // Isolated tests may use an ephemeral store.
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.file = join(stateDir, 'browser-sessions.json');
    if (!existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (saved.binding !== this.binding) return;
      if (!Array.isArray(saved.sessions) || saved.sessions.length > 64) throw new Error();
      for (const { hash, expires } of saved.sessions) {
        if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(expires)) throw new Error();
        if (expires > this.now()) this.sessions.set(hash, expires);
      }
    } catch { throw new Error('Cannot load browser sessions; repair browser-sessions.json before starting'); }
  }
  verifyToken(value: unknown): boolean {
    return typeof value === 'string' && timingSafeEqual(Buffer.from(this.binding, 'hex'), Buffer.from(digest(value), 'hex'));
  }
  valid(hash: string): boolean { return (this.sessions.get(hash) ?? 0) > this.now(); }
  identify(cookie: string | undefined, name: string): string | undefined {
    const matches = (cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(name + '='));
    if (matches.length !== 1) return;
    const value = matches[0].slice(name.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return;
    const hash = digest(value);
    return this.valid(hash) ? hash : undefined;
  }
  issue(): string {
    const value = randomBytes(32).toString('base64url');
    const next = new Map([...this.sessions].filter(([, expires]) => expires > this.now()));
    while (next.size >= 64) next.delete(next.keys().next().value!);
    next.set(digest(value), this.now() + SESSION_SECONDS * 1000);
    this.save(next);
    return value;
  }
  revoke(hash: string) {
    const next = new Map(this.sessions); next.delete(hash); this.save(next);
  }
  private save(next: Map<string, number>) {
    if (this.file) {
      const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ binding: this.binding, sessions: [...next].map(([hash, expires]) => ({ hash, expires })) }) + '\n', { flag: 'wx', mode: 0o600 });
        renameSync(temporary, this.file);
      } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    }
    this.sessions = next;
  }
}
