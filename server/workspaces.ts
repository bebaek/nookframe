import { createHash } from 'node:crypto';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import type { Snapshot, ThreadChoice } from '../shared/protocol.js';
import { Workspace } from './workspace.js';
import type { ThreadStore } from './threads.js';

export interface WorkspaceLease { workspace: Workspace; release(): void }
type Entry = { workspace: Workspace; refs: number; used: number; releaseLock: () => Promise<void>; unsubscribe: () => void };

// One writer per session file, and one selection per connection. Opening/evicting
// is serialized, but independent agents run concurrently after acquisition.
export class Workspaces {
  private entries = new Map<string, Entry>();
  private listeners = new Set<(workspace?: Workspace) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private catalog: ThreadChoice[] = [];
  private timer: ReturnType<typeof setInterval>;
  constructor(readonly threads: ThreadStore, readonly defaultId: string,
    private factory: (file: string, stateDir: string) => { workspace: Workspace; start(): Promise<void> },
    private maxAgents = 4, private idleMs = 5 * 60_000) {
    this.timer = setInterval(() => { void this.serial(async () => {
      for (const [id, entry] of this.entries) if (this.idle(entry) && Date.now() - entry.used >= this.idleMs) await this.remove(id, entry);
    }).catch(() => { /* Failed stops retain ownership; never start a second writer. */ }); }, Math.min(idleMs, 60_000));
    this.timer.unref();
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  private idle(entry: Entry) {
    return !entry.refs && entry.workspace.idle;
  }
  private changed(workspace?: Workspace) { for (const listener of this.listeners) listener(workspace); }
  subscribe(listener: (workspace?: Workspace) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async initialize() { this.catalog = await this.threads.list(); }
  snapshot(workspace?: Workspace): Snapshot {
    const threads = this.catalog.map(thread => {
      const state = this.entries.get(thread.id)?.workspace.state;
      const live = state?.threads.find(t => t.id === thread.id);
      return { ...thread, ...live, busy: state?.busy ?? false };
    });
    return workspace ? { ...workspace.state, threads } : {
      messages: [], liveText: '', tools: {}, busy: false, available: false,
      model: '', models: [], modelSource: 'pi', modelChanging: false,
      notice: 'Choose a thread or create a new one. Threads share files, not running agents.',
      threadId: '', threads, threadChanging: false,
    };
  }
  connect(id?: string, create = false): Promise<WorkspaceLease> {
    return this.serial(async () => {
      if (this.closing) throw new Error('Workspace is shutting down');
      let file = create ? undefined : this.threads.path(id ?? this.defaultId);
      let key = file ? this.threads.id(file) : undefined;
      let entry = key ? this.entries.get(key) : undefined;
      if (!entry) {
        if (this.entries.size >= this.maxAgents) {
          const candidate = [...this.entries].filter(([, e]) => this.idle(e)).sort((a, b) => a[1].used - b[1].used)[0];
          if (!candidate) throw new Error(`All ${this.maxAgents} agent slots are in use. Close an idle thread tab or wait for a run to finish.`);
          await this.remove(...candidate);
        }
        file ??= this.threads.create();
        key = this.threads.id(file);
        let compromised = false;
        let workspace: Workspace | undefined;
        let releaseLock: () => Promise<void>;
        try {
          releaseLock = await lockfile.lock(file, { retries: 0, stale: 30_000, update: 10_000,
            onCompromised: () => { compromised = true; workspace?.ownershipLost(); },
          });
        } catch { throw new Error('This thread is owned by another server. Choose a different thread or close it there first.'); }
        try {
          const stateDir = join(this.threads.directory, '.nookframe', createHash('sha256').update(key).digest('hex'));
          const agent = this.factory(file, stateDir);
          workspace = agent.workspace;
          await agent.start();
          await workspace.initialize();
          if (workspace.state.threadId !== key) throw new Error('Thread load was not confirmed');
          if (compromised) { workspace.ownershipLost(); throw new Error('Thread ownership was lost'); }
          this.catalog = await this.threads.list();
          entry = { workspace, refs: 0, used: Date.now(), releaseLock, unsubscribe: workspace.subscribe(() => {
            if (entry) entry.used = Date.now();
            this.changed(workspace);
          }) };
          this.entries.set(key, entry);
        } catch (error) {
          // A failed stop deliberately retains the lock until process exit/stale expiry.
          if (workspace) await workspace.close();
          await releaseLock();
          throw error;
        }
      }
      entry.refs++;
      this.changed();
      let released = false;
      return { workspace: entry.workspace, release: () => {
        if (released) return;
        released = true; entry.refs--; entry.used = Date.now();
      } };
    });
  }
  assertThread(id: unknown) {
    if (typeof id !== 'string') throw new Error('Thread is required');
    this.threads.path(id);
  }
  photo(id: string) {
    for (const entry of this.entries.values()) { const data = entry.workspace.photo(id); if (data) return data; }
  }
  readonly responseImages = { read: async (id: string): Promise<Buffer> => {
    for (const entry of this.entries.values()) {
      try { return await entry.workspace.responseImages.read(id); } catch { /* Try the other resident threads. */ }
    }
    throw new Error('Image unavailable');
  } };
  private async remove(id: string, entry: Entry) {
    await entry.workspace.close();
    await entry.releaseLock();
    entry.unsubscribe(); this.entries.delete(id);
    this.catalog = await this.threads.list();
    this.changed();
  }
  async close() {
    this.closing = true; clearInterval(this.timer);
    await this.serial(async () => {
      const results = await Promise.allSettled([...this.entries].map(([id, entry]) => this.remove(id, entry)));
      const failed = results.find(r => r.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    });
  }
}
