import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { ThreadChoice } from '../shared/protocol.js';

// Pi JSONL files remain authoritative. Only the selected filename is stored here.
export class ThreadStore {
  readonly directory: string;
  private preference: string;
  constructor(directory: string, private cwd: string, stateDir: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(directory);
    this.cwd = resolve(cwd);
    this.preference = join(stateDir, 'active-thread.json');
  }
  path(id: string): string {
    if (!id || basename(id) !== id || !id.endsWith('.jsonl')) throw new Error('Invalid thread');
    const path = join(this.directory, id);
    if (!lstatSync(path).isFile() || dirname(realpathSync(path)) !== this.directory) throw new Error('Invalid thread');
    const header = JSON.parse(readFileSync(path, 'utf8').split('\n', 1)[0]);
    if (header.type !== 'session' || typeof header.id !== 'string' || header.cwd !== this.cwd) throw new Error('Invalid thread');
    return path;
  }
  id(path: string): string {
    const id = basename(path);
    if (resolve(path) !== this.path(id)) throw new Error('Session is outside web threads');
    return id;
  }
  create(): string {
    const manager = SessionManager.create(this.cwd, this.directory);
    const path = manager.getSessionFile()!;
    // Pi normally defers persistence until an assistant response. A header-only
    // file keeps an empty thread durable without synthetic conversation messages.
    writeFileSync(path, JSON.stringify(manager.getHeader()) + '\n', { flag: 'wx', mode: 0o600 });
    return path;
  }
  async initial(): Promise<string> {
    if (existsSync(this.preference)) {
      try { return this.path(JSON.parse(readFileSync(this.preference, 'utf8')).file); }
      catch { throw new Error('Cannot restore selected thread. Repair active-thread.json or restore its session file; refusing to start another thread silently.'); }
    }
    // Upgrade the original fixed session without modifying its conversation.
    const legacy = SessionManager.findById(this.cwd, 'workspace', this.directory);
    if (legacy) return this.path(basename(legacy));
    const existing = await this.list();
    return existing.length ? this.path(existing[0].id) : this.create();
  }
  remember(path: string) {
    const file = this.id(path);
    const temporary = `${this.preference}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ file }) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.preference);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  async list(): Promise<ThreadChoice[]> {
    const sessions = await SessionManager.list(this.cwd, this.directory);
    return sessions.flatMap(session => {
      try {
        const id = this.id(session.path);
        const title = (session.name || (session.firstMessage === '(no messages)' ? 'New thread' : session.firstMessage)).replace(/\s+/g, ' ').slice(0, 100);
        return [{ id, title, updatedAt: session.modified.toISOString() }];
      } catch { return []; } // Never expose foreign-workspace files or symlinks.
    });
  }
}
