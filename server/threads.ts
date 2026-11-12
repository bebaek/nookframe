import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { ThreadChoice } from '../shared/protocol.js';

// Pi JSONL files remain authoritative. Only the selected filename is stored here.
export class ThreadStore {
  readonly directory: string;
  get sessionSharingWarning() { return this.native ? 'Shared Pi sessions (PoC): close terminal Pi before opening a chat here. Stop Nookframe before resuming in Pi; closing this tab does not stop agents.' : undefined; }
  private preference: string;
  private nativePaths = new Map<string, string>();
  private nativeId(path: string) { return `${createHash('sha256').update(resolve(path)).digest('hex')}.jsonl`; }
  private validateNative(path: string) {
    const root = realpathSync(this.native!.root);
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid thread');
    let current = root;
    for (const part of rel.split('/')) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error('Invalid thread');
    }
    if (!lstatSync(path).isFile()) throw new Error('Invalid thread');
    const header = JSON.parse(readFileSync(path, 'utf8').split('\n', 1)[0]);
    if (header.type !== 'session' || typeof header.id !== 'string' || !isAbsolute(header.cwd ?? '')) throw new Error('Invalid thread');
    return header as { cwd: string };
  }
  workingDirectory(file: string) {
    if (!this.native || this.drafts.has(file)) return this.cwd;
    return this.validateNative(file).cwd;
  }
  sessionDirectory(file: string) { return this.native ? dirname(file) : this.directory; }
  // Only paths allocated by this process may exist before Pi persists them.
  private drafts = new Set<string>();
  livePath(id: string): string {
    if (!id || basename(id) !== id || !id.endsWith('.jsonl')) throw new Error('Invalid thread');
    const path = this.native ? this.nativePaths.get(id) : join(this.directory, id);
    if (!path) throw new Error('Unknown thread; refresh the session list');
    if (this.drafts.has(path) && !lstatSync(path, { throwIfNoEntry: false })) return path;
    return this.path(id);
  }
  forget(path: string) { this.drafts.delete(path); }
  constructor(directory: string, private cwd: string, stateDir: string, private native?: { root: string; flat: boolean }) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(directory);
    this.cwd = resolve(cwd);
    this.preference = join(stateDir, native ? 'active-pi-thread.json' : 'active-thread.json');
  }
  path(id: string): string {
    if (!id || basename(id) !== id || !id.endsWith('.jsonl')) throw new Error('Invalid thread');
    if (this.native) {
      const path = this.nativePaths.get(id);
      if (!path) throw new Error('Unknown thread; refresh the session list');
      this.validateNative(path);
      this.drafts.delete(path);
      return path;
    }
    const path = join(this.directory, id);
    if (!lstatSync(path).isFile() || dirname(realpathSync(path)) !== this.directory) throw new Error('Invalid thread');
    const header = JSON.parse(readFileSync(path, 'utf8').split('\n', 1)[0]);
    if (header.type !== 'session' || typeof header.id !== 'string' || header.cwd !== this.cwd) throw new Error('Invalid thread');
    this.drafts.delete(path); // Once persisted, a missing file must fail closed.
    return path;
  }
  id(path: string): string {
    const id = this.native ? this.nativeId(path) : basename(path);
    if (resolve(path) !== this.livePath(id)) throw new Error('Session is outside web threads');
    return id;
  }
  create(): string {
    const directory = this.native
      ? this.native.flat ? this.native.root : join(this.native.root, `--${this.cwd.replace(/^[/\\\\]/, '').replace(/[/\\\\:]/g, '-')}--`)
      : this.directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (this.native && realpathSync(directory) !== resolve(directory)) throw new Error('Symlink session directories are not supported');
    const manager = SessionManager.create(this.cwd, directory);
    const path = manager.getSessionFile()!;
    // Reserve an identity, not a file. Pi owns the first write and its timing.
    this.drafts.add(path);
    if (this.native) this.nativePaths.set(this.nativeId(path), path);
    return path;
  }
  async initial(): Promise<string> {
    if (this.native) await this.list();
    if (existsSync(this.preference)) {
      try { return this.path(JSON.parse(readFileSync(this.preference, 'utf8')).file); }
      catch { throw new Error('Cannot restore selected thread. Repair active-thread.json or restore its session file; refusing to start another thread silently.'); }
    }
    // Upgrade the original fixed session without modifying its conversation.
    const legacy = this.native ? undefined : SessionManager.findById(this.cwd, 'workspace', this.directory);
    if (legacy) return this.path(basename(legacy));
    const existing = await this.list();
    return existing.length ? this.path(existing[0].id) : this.create();
  }
  remember(path: string) {
    const file = this.id(path);
    if (!existsSync(path)) return; // Never persist a dangling selection.
    const temporary = `${this.preference}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ file }) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.preference);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  delete(id: string) {
    const file = this.livePath(id);
    // Clear legacy selection first: a failed unlink must not leave a dangling
    // preference that prevents startup. Other sessions remain discoverable.
    if (existsSync(this.preference) && JSON.parse(readFileSync(this.preference, 'utf8')).file === id) unlinkSync(this.preference);
    if (existsSync(file)) unlinkSync(file);
    this.forget(file);
  }
  async list(query = ''): Promise<(ThreadChoice & { excerpt?: string })[]> {
    // Bound query work and require every word/quoted phrase, case-insensitively.
    const terms = (query.slice(0, 256).match(/"[^"]+"|\S+/g) ?? [])
      .map(term => term.replace(/^"|"$/g, '').toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean);
    let sessions;
    if (this.native) {
      const root = resolve(this.native.root);
      if (!existsSync(root)) return [];
      if (realpathSync(root) !== root) throw new Error('Symlink session roots are not supported');
      const directories = this.native.flat ? [root] : readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory()).map(entry => join(root, entry.name));
      sessions = (await Promise.all(directories.map(dir => SessionManager.listAll(dir)))).flat();
      for (const session of sessions) {
        try { this.validateNative(session.path); this.nativePaths.set(this.nativeId(session.path), session.path); }
        catch { /* Never register symlinks or malformed files. */ }
      }
      sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    } else sessions = await SessionManager.list(this.cwd, this.directory);
    return sessions.flatMap(session => {
      try {
        const id = this.id(session.path);
        const title = (session.name || (session.firstMessage === '(no messages)' ? 'New thread' : session.firstMessage)).replace(/\s+/g, ' ').slice(0, 100);
        const displayTitle = this.native ? `${session.cwd} — ${title}` : title;
        if (!terms.length) return [{ id, title: displayTitle, updatedAt: session.modified.toISOString() }];
        const text = session.allMessagesText.replace(/\s+/g, ' ');
        const lower = text.toLowerCase();
        const heading = displayTitle.toLowerCase();
        if (!terms.every(term => heading.includes(term) || lower.includes(term))) return [];
        const match = terms.map(term => lower.indexOf(term)).filter(index => index >= 0).sort((a, b) => a - b)[0];
        const start = Math.max(0, (match ?? 0) - 60);
        const excerpt = `${start ? '…' : ''}${text.slice(start, start + 220)}${text.length > start + 220 ? '…' : ''}`;
        return [{ id, title: displayTitle, updatedAt: session.modified.toISOString(), excerpt }];
      } catch { return []; } // Never expose foreign-workspace files or symlinks.
    });
  }
}
