import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import type { Snapshot, ThreadChoice } from '../shared/protocol.js';
import { Workspace } from './workspace.js';
import { Takeovers } from './takeovers.js';
import type { ThreadStore } from './threads.js';

export class ThreadOwnedError extends Error {
  constructor(readonly threadId: string) { super('This thread is owned by another server. Request takeover to open it here.'); }
}

export interface WorkspaceLease { workspace: Workspace; release(): void; releaseThread(): Promise<void> }
export interface BackgroundOpen { id: string; cancel(): Promise<void>; beforeStart(threadId: string): Promise<void> }
type Entry = { workspace: Workspace; pendingWorkspace?: Workspace; refs: number; used: number; ownsLock: () => boolean; releaseLock: () => Promise<void>; unsubscribe: () => void };

// One writer per session file, and one selection per connection. Opening/evicting
// is serialized, but independent agents run concurrently after acquisition.
export class Workspaces {
  readonly takeovers: Takeovers;
  private handoffs = new Set<string>();
  private entries = new Map<string, Entry>();
  private listeners = new Set<(workspace?: Workspace) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private catalog: ThreadChoice[] = [];
  private timer: ReturnType<typeof setInterval>;
  constructor(readonly threads: ThreadStore, public defaultId: string,
    private factory: (file: string, stateDir: string, background?: boolean, newlyCreated?: boolean) => { workspace: Workspace; start(): Promise<void> },
    private maxAgents = 4, private idleMs = 5 * 60_000, private guardThread?: (id: string) => Promise<void>) {
    this.takeovers = new Takeovers(threads.directory, process.env.NOOKFRAME_SLOT ?? 'unknown');
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
      return { ...thread, ...live, busy: !!state?.backgroundRun || (state?.busy ?? false) };
    });
    return workspace ? { ...workspace.state, threads } : {
      messages: [], liveText: '', tools: {}, busy: false, available: false,
      model: '', models: [], modelSource: 'pi', modelChanging: false,
      notice: 'Choose a thread or create a new one. Threads share files, not running agents.',
      threadId: '', threads, threadChanging: false,
    };
  }
  operationWorkspace(id: string): Workspace {
    const entry = this.entries.get(id);
    if (this.closing || !entry || !entry.ownsLock() || entry.pendingWorkspace || !entry.workspace.state.available) {
      throw new Error('Target must be a loaded, available thread owned by this instance');
    }
    return entry.workspace;
  }
  operationSessions() {
    return {
      scope: 'this-instance-loaded-agents',
      count: this.entries.size,
      capacity: this.maxAgents,
      closing: this.closing,
      sessions: [...this.entries].map(([id, entry]) => ({
        id, busy: entry.workspace.state.busy, available: entry.workspace.state.available,
        model: entry.workspace.state.model, modelSource: entry.workspace.state.modelSource,
        connections: entry.refs, ownsLock: entry.ownsLock(),
      })),
    };
  }
  connect(id?: string, create = false, background?: BackgroundOpen): Promise<WorkspaceLease> {
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
        if (!background) await this.guardThread?.(key);
        await this.takeovers.checkOpen(key);
        let compromised = false;
        let workspace: Workspace | undefined;
        let releaseLock: () => Promise<void>;
        try {
          releaseLock = await lockfile.lock(file, { retries: 0, stale: 30_000, update: 10_000,
            onCompromised: () => { compromised = true; (entry?.pendingWorkspace ?? entry?.workspace ?? workspace)?.ownershipLost(); },
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ELOCKED') throw new ThreadOwnedError(key);
          throw error;
        }
        try {
          await this.takeovers.acquired(key);
          const stateDir = join(this.threads.directory, '.nookframe', createHash('sha256').update(key).digest('hex'));
          if (background) await background.beforeStart(key);
          const agent = this.factory(file, stateDir, !!background, create);
          workspace = agent.workspace;
          await agent.start();
          await workspace.initialize();
          if (workspace.state.threadId !== key) throw new Error('Thread load was not confirmed');
          if (compromised) { workspace.ownershipLost(); throw new Error('Thread ownership was lost'); }
          if (background) workspace.background(background.id, background.cancel);
          this.catalog = await this.threads.list();
          entry = { workspace, refs: 0, used: Date.now(), ownsLock: () => !compromised, releaseLock, unsubscribe: workspace.subscribe(() => {
            if (entry) entry.used = Date.now();
            this.changed(workspace);
          }) };
          this.entries.set(key, entry);
        } catch (error) {
          // A failed stop deliberately retains the lock until process exit/stale expiry.
          if (workspace) await workspace.close();
          await this.takeovers.relinquished(key);
          await releaseLock();
          throw error;
        }
      }
      if (this.handoffs.has(key!)) throw new Error('Thread takeover is in progress');
      entry.refs++;
      this.changed();
      let released = false;
      const release = () => {
        if (released) return;
        released = true; entry.refs--; entry.used = Date.now();
      };
      return { get workspace() { return entry!.workspace; }, release, releaseThread: () => this.serial(async () => {
        if (this.closing) throw new Error('Workspace is shutting down');
        if (released || this.entries.get(key!) !== entry) throw new Error('The selected thread changed. Review it before retrying.');
        if (!entry.ownsLock() || !entry.workspace.state.available || entry.pendingWorkspace) throw new Error('Thread ownership or run status is uncertain. Inspect it before releasing it.');
        if (!entry.workspace.idle) throw new Error('Wait until the thread finishes running before releasing it');
        if (entry.refs !== 1) throw new Error('Close other tabs viewing this thread on this slot before releasing it');
        // close() synchronously blocks prompts; keep ownership until exit is confirmed.
        await this.remove(key!, entry);
        release();
      }) };
    });
  }
  async pollTakeovers() {
    const incoming = await this.takeovers.incoming();
    for (const request of incoming) {
      if (request.status !== 'approved' || this.handoffs.has(request.threadId)) continue;
      this.handoffs.add(request.threadId);
      // Notifications stay responsive while pool lifecycle changes remain serialized.
      void this.takeovers.handoff(request, () => this.serial(async () => {
        await this.takeovers.assertStopping(request);
        const entry = this.entries.get(request.threadId);
        if (this.closing || !entry || !entry.ownsLock() || !entry.workspace.state.available || entry.pendingWorkspace || entry.workspace.state.backgroundRun || entry.workspace.state.modelChanging || entry.workspace.state.threadChanging) throw new Error('Thread cannot safely be handed off');
        entry.workspace.state.notice = `Thread is moving to slot ${request.requesterSlot}. Stopping the agent…`;
        const closing = entry.workspace.close();
        this.changed(entry.workspace);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([closing, new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Shutdown unconfirmed')), 15_000);
          })]);
        } catch (error) {
          entry.workspace.state.notice = 'Takeover failed: shutdown was not confirmed. Thread remains unavailable and its lock is retained.';
          this.changed(entry.workspace);
          throw error;
        } finally { clearTimeout(timeout); }
        if (!entry.ownsLock()) throw new Error('Ownership lost during handoff');
        await this.remove(request.threadId, entry);
        entry.workspace.state.notice = `Thread moved to slot ${request.requesterSlot}. Open it on that slot to continue.`;
        entry.workspace.state.movedTo = { slot: request.requesterSlot, url: request.requesterUrl };
        this.changed(entry.workspace);
      })).catch(() => { /* Failed coordination never authorizes another writer. */ }).finally(() => this.handoffs.delete(request.threadId));
    }
    return incoming;
  }
  // Keep the same session lock across handoff; no second writer can enter the
  // gap between confirmed background exit and interactive startup. Leases follow
  // the entry, so already-open browsers see the replacement controller.
  finishBackground(id: string, persist: () => Promise<void>) {
    return this.serial(async () => {
      const entry = this.entries.get(id);
      if (!entry?.workspace.state.backgroundRun || !entry.ownsLock()) throw new Error('Background ownership unavailable');
      entry.workspace.stoppingBackground();
      await entry.workspace.close();
      if (!entry.ownsLock()) throw new Error('Background ownership lost');
      await persist();
      if (!entry.ownsLock()) throw new Error('Background ownership lost');
      const file = this.threads.path(id);
      const stateDir = join(this.threads.directory, '.nookframe', createHash('sha256').update(id).digest('hex'));
      const agent = this.factory(file, stateDir, false);
      entry.pendingWorkspace = agent.workspace;
      try {
        await agent.start(); await agent.workspace.initialize();
        if (agent.workspace.state.threadId !== id || !entry.ownsLock()) throw new Error('Handoff not confirmed');
      } catch (error) { await agent.workspace.close(); entry.pendingWorkspace = undefined; throw error; }
      entry.pendingWorkspace = undefined;
      entry.unsubscribe();
      entry.workspace = agent.workspace;
      entry.unsubscribe = agent.workspace.subscribe(() => { entry.used = Date.now(); this.changed(agent.workspace); });
      entry.used = Date.now();
      this.catalog = await this.threads.list();
      this.changed(agent.workspace);
    });
  }
  deleteThread(id: string): Promise<void> {
    return this.serial(async () => {
      if (this.closing) throw new Error('Workspace is shutting down');
      const file = this.threads.path(id);
      const entry = this.entries.get(id);
      if (entry && (!entry.workspace.state.available || !entry.ownsLock())) throw new Error('Thread ownership or run status is uncertain. Restart and inspect it before deleting it.');
      if (entry && !entry.workspace.idle) throw new Error('Wait until the thread finishes running before deleting it');
      // Retain exclusive ownership through stop and unlink. close() marks the
      // workspace unavailable synchronously, preventing new prompts in other tabs.
      let release: () => Promise<void>;
      if (entry) {
        await entry.workspace.close();
        if (!entry.ownsLock()) throw new Error('Thread ownership was lost; deletion cancelled');
        release = entry.releaseLock;
      } else {
        await this.guardThread?.(id);
        try { release = await lockfile.lock(file, { retries: 0, stale: 30_000, update: 10_000 }); }
        catch { throw new Error('This thread is owned by another server. Close it there before deleting it.'); }
      }
      try {
        this.threads.delete(id);
        // Only per-thread preferences/markers; shared uploads and workspace
        // files are deliberately untouched.
        rmSync(join(this.threads.directory, '.nookframe', createHash('sha256').update(id).digest('hex')), { recursive: true, force: true });
      } finally {
        await this.takeovers.relinquished(id);
        await release();
        if (entry) { entry.unsubscribe(); this.entries.delete(id); }
        this.catalog = await this.threads.list();
        if (!this.catalog.some(thread => thread.id === this.defaultId)) this.defaultId = this.catalog[0]?.id ?? '';
        this.changed();
      }
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
    await entry.pendingWorkspace?.close();
    await entry.workspace.close();
    await this.takeovers.relinquished(id);
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
