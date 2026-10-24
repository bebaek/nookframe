import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import type { WorkspaceLease, Workspaces } from '../workspaces.js';
import { JobStore, type JobRun, type RunStatus } from './store.js';

export class JobRunner {
  private timer?: ReturnType<typeof setInterval>;
  private release?: () => Promise<void>;
  private pending?: Promise<void>;
  private closing = false;
  private compromised = false;
  private active?: { run: JobRun; lease: WorkspaceLease; deadline: number };
  constructor(private store: JobStore, private pool: Workspaces) {}
  async start() {
    const directory = join(this.store.directory, 'runner');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    this.release = await lockfile.lock(directory, { stale: 30_000, update: 10_000, retries: 0, onCompromised: () => {
      this.compromised = true; this.closing = true;
      if (this.timer) clearInterval(this.timer);
      void this.active?.lease.workspace.close().catch(() => {});
    } });
    try {
      for (const run of await this.store.runs()) if (['running', 'stopping'].includes(run.status)) {
        await this.store.transition(run.id, ['running', 'stopping'], { status: 'uncertain', summary: 'Server interrupted. No automatic retry; inspect the process and thread before recovery.' });
      }
      this.timer = setInterval(() => { void this.tick().catch(() => { /* Durable state stays blocked on failure. */ }); }, 500);
      this.timer.unref();
    } catch (error) { await this.release(); this.release = undefined; throw error; }
  }
  tick(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.step().catch(async error => {
      this.closing = true;
      if (this.timer) clearInterval(this.timer);
      if (this.active) {
        this.active.lease.workspace.stoppingBackground();
        await this.active.lease.workspace.close().catch(() => {});
        await this.store.transition(this.active.run.id, ['running', 'stopping'], { status: 'uncertain', summary: 'Runner failed; execution stopped or remains unconfirmed. Inspect before recovery.' }).catch(() => {});
      }
      throw error;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async step() {
    if (this.closing) return;
    const runs = await this.store.runs();
    if (this.active) {
      const { run, lease, deadline } = this.active;
      const current = runs.find(r => r.id === run.id);
      if (!current) throw new Error('Active run disappeared');
      if (current.cancelRequested) await this.finish('cancelled');
      else if (Date.now() >= deadline) await this.finish('timed_out');
      else if (!lease.workspace.state.available) await this.finish('failed');
      else if (!lease.workspace.state.busy) {
        const last = lease.workspace.state.messages.filter(m => m.role === 'assistant').at(-1);
        await this.finish(last?.error || !last ? 'failed' : 'completed');
      }
      return;
    }
    // An interrupted process may still exist. Never start another automatically.
    if (runs.some(r => ['uncertain', 'running', 'stopping'].includes(r.status))) return;
    const run = runs.find(r => r.status === 'queued');
    if (!run) return;
    let lease: WorkspaceLease | undefined;
    try {
      lease = await this.pool.connect(undefined, true, {
        id: run.id,
        cancel: async () => { await this.store.cancelRun(run.id); },
        beforeStart: async threadId => {
          if (this.closing) throw new Error('Runner stopping');
          await this.store.transition(run.id, ['queued'], { status: 'running', threadId, startedAt: new Date().toISOString() });
        },
      });
      this.active = { run, lease, deadline: Date.now() + run.job.timeoutSeconds * 1000 };
      if (this.compromised) { await lease.workspace.close(); return; }
      if (this.closing) return;
      const claimed = (await this.store.runs()).find(r => r.id === run.id);
      if (!claimed || claimed.status !== 'running' || !Number.isFinite(Date.parse(claimed.startedAt ?? ''))) throw new Error('Run claim changed');
      this.active.deadline = Date.parse(claimed.startedAt!) + run.job.timeoutSeconds * 1000;
      if (claimed.cancelRequested) { await this.finish('cancelled'); return; }
      if (Date.now() >= this.active.deadline) { await this.finish('timed_out'); return; }
      await lease.workspace.startBackground(run.job.prompt);
    } catch (error) {
      if (lease) { if (this.closing) throw error; await this.finish('failed'); return; }
      const current = (await this.store.runs()).find(r => r.id === run.id);
      // Capacity errors happen before durable dispatch; leave queued for later.
      if (current?.status === 'queued' && error instanceof Error && error.message.includes('slots are in use')) return;
      if (current && ['queued', 'running'].includes(current.status)) await this.store.transition(run.id, [current.status], {
        status: current.status === 'running' ? 'uncertain' : 'failed', summary: 'Agent startup failed; no automatic retry.', endedAt: new Date().toISOString(),
      });
    }
  }
  private async finish(status: RunStatus) {
    const active = this.active;
    if (!active) return;
    const workspace = active.lease.workspace;
    const threadId = workspace.state.threadId;
    const summary = workspace.state.messages.filter(m => m.role === 'assistant').at(-1)?.text.slice(0, 24000) ?? '';
    try {
      workspace.stoppingBackground();
      await this.store.transition(active.run.id, ['running', 'stopping'], { status: 'stopping' });
      await this.pool.finishBackground(threadId, async () => {
        if (this.compromised) throw new Error('Runner ownership lost');
        await this.store.transition(active.run.id, ['stopping'], { status, endedAt: new Date().toISOString(), summary });
      });
      active.lease.release(); this.active = undefined;
    } catch (error) {
      this.closing = true;
      // A failed ledger write must not leave the agent executing indefinitely.
      // Stop failures retain session ownership, including for current viewers.
      await workspace.close().catch(() => {});
      const current = (await this.store.runs()).find(r => r.id === active.run.id);
      if (current && ['running', 'stopping'].includes(current.status)) await this.store.transition(active.run.id, [current.status], { status: 'uncertain', summary: 'Termination or persistence unconfirmed. Interactive continuation is blocked.' });
      throw error;
    }
  }
  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.pending;
    // Shutdown does not open an interactive replacement. Leave an interruption
    // record rather than report successful completion or replay after restart.
    if (this.active) {
      await this.active.lease.workspace.close();
      const run = (await this.store.runs()).find(r => r.id === this.active!.run.id);
      if (run && ['running', 'stopping'].includes(run.status)) await this.store.transition(run.id, [run.status], { status: 'failed', endedAt: new Date().toISOString(), summary: 'Server shut down; background process exit confirmed.' });
      this.active.lease.release(); this.active = undefined;
    }
    if (!this.compromised) await this.release?.();
    this.release = undefined;
  }
}
