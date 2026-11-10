import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { MailError, type MailStore } from './store.js';
import { nextMailWork, retryPlan, indexRetryPlan } from './jobs.js';
import { mailLog, safeMailError, type MailLog } from './logging.js';

export function mailConcurrency(value = process.env.MAIL_SYNC_CONCURRENCY): number {
  if (value === undefined) return 2;
  if (!/^[1-8]$/.test(value)) throw new MailError('INVALID_MAIL_CONFIG');
  return Number(value);
}

export class MailScheduler {
  private children = new Map<string, ChildProcess>();
  private timer: ReturnType<typeof setInterval>;
  private closing = false;
  private ticking = false;
  private lastHealth = 0;
  private firstDue = new Map<string, number>();
  private blocked = new Map<string, { reason: 'locked' | 'capacity'; since: number; lastLogged?: number }>();
  private noteBlocked(accountId: string, work: 'sync' | 'index', reason: 'locked' | 'capacity', now: number) {
    let state = this.blocked.get(accountId);
    if (!state || state.reason !== reason) {
      state = { reason, since: now }; this.blocked.set(accountId, state);
    }
    if (now - state.since >= 5 * 60000 && (state.lastLogged === undefined || now - state.lastLogged >= 5 * 60000)) {
      this.log('mail.job.blocked', { accountId, work, reason, durationMs: now - state.since }, 'warn');
      state.lastLogged = now;
    }
  }
  private clearBlocked(accountId: string, now: number) {
    const state = this.blocked.get(accountId);
    if (state?.lastLogged !== undefined) this.log('mail.job.unblocked', { accountId, reason: state.reason, durationMs: now - state.since });
    this.blocked.delete(accountId);
  }
  constructor(private store: MailStore, private cli: string, private origin: string,
    private concurrency = mailConcurrency(), private launch: typeof spawn = spawn,
    private log: MailLog = mailLog, private now: () => number = Date.now) {
    this.timer = setInterval(() => { void this.tick(); }, 60000);
    this.timer.unref();
    this.log('mail.scheduler.started', { checkIntervalMs: 60000, concurrency });
  }
  async tick() {
    if (this.closing || this.ticking) return;
    this.ticking = true;
    const now = this.now();
    let enabledAccounts = 0, overdueAccounts = 0, oldestOverdueMs = 0, lockedAccounts = 0, capacityBlockedAccounts = 0;
    try {
      const accounts = this.store.accounts();
      const present = new Set(accounts.map(account => account.alias));
      for (const id of this.firstDue.keys()) if (!present.has(id)) { this.firstDue.delete(id); this.blocked.delete(id); }
      for (const account of accounts) {
        if (this.closing) break;
        if (!account.polling) { this.firstDue.delete(account.alias); this.blocked.delete(account.alias); continue; }
        enabledAccounts++;
        const sync = this.store.status(account.alias), index = this.store.indexStatus(account.alias);
        const work = nextMailWork(sync, index, now);
        if (!work) { this.firstDue.delete(account.alias); this.clearBlocked(account.alias, now); continue; }
        if (!this.firstDue.has(account.alias)) this.firstDue.set(account.alias, now);
        const deadline = work === 'sync' ? (sync ? retryPlan(sync, now).nextRetryAt : null) : indexRetryPlan(index).nextRetryAt;
        const latenessMs = Math.max(0, now - (deadline ? Date.parse(deadline) : this.firstDue.get(account.alias)!));
        // Active work is not overdue; durable status may still be from its predecessor.
        if (this.children.has(account.alias)) { this.clearBlocked(account.alias, now); continue; }
        if (await this.store.accountSyncLocked(account.alias)) {
          this.noteBlocked(account.alias, work, 'locked', now);
          lockedAccounts++; overdueAccounts++; oldestOverdueMs = Math.max(oldestOverdueMs, latenessMs); continue;
        }
        if (this.children.size >= this.concurrency) {
          this.noteBlocked(account.alias, work, 'capacity', now);
          capacityBlockedAccounts++; overdueAccounts++; oldestOverdueMs = Math.max(oldestOverdueMs, latenessMs); continue;
        }
        if (this.closing) break;
        this.clearBlocked(account.alias, now);
        const attemptId = randomUUID(), started = this.now();
        const fields = { accountId: account.alias, attemptId, work, scheduled: true };
        // stdout remains private CLI result data. Scheduled CLI stderr contains
        // only our structured lifecycle records, never raw mbsync/notmuch output.
        let child: ChildProcess;
        try {
          child = this.launch(process.execPath, [this.cli, work, account.alias, '--scheduled'], {
            detached: true, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, NOOKFRAME_MAIL_ATTEMPT_ID: attemptId,
              MAIL_DIR: this.store.root, GOOGLE_DIR: this.store.google?.root ?? '', PUBLIC_ORIGIN: this.origin },
          });
        } catch {
          this.log('mail.job.failed', { ...fields, errorCode: 'WORKER_SPAWN_FAILED', durationMs: Math.max(0, this.now() - started) }, 'error');
          continue;
        }
        this.children.set(account.alias, child);
        this.log('mail.job.dispatched', { ...fields, latenessMs });
        let spawnFailed = false;
        child.on('error', () => {
          spawnFailed = true;
          this.log('mail.job.failed', { ...fields, errorCode: 'WORKER_SPAWN_FAILED', durationMs: Math.max(0, this.now() - started) }, 'error');
          if (this.children.get(account.alias) === child) this.children.delete(account.alias);
        });
        child.on('close', (code, signal) => {
          if (this.children.get(account.alias) === child) this.children.delete(account.alias);
          this.log('mail.worker.exited', { ...fields, exitCode: code, signal,
            durationMs: Math.max(0, this.now() - started), reason: this.closing ? 'shutdown' : spawnFailed ? 'spawn_failed' : code === 0 ? 'completed' : 'unexpected_exit' },
          !this.closing && (spawnFailed || code !== 0) ? 'warn' : 'info');
        });
      }
      if (!this.lastHealth || now - this.lastHealth >= 5 * 60000) {
        this.log('mail.scheduler.health', { enabledAccounts, activeWorkers: this.children.size, overdueAccounts,
          oldestOverdueMs, lockedAccounts, capacityBlockedAccounts }, oldestOverdueMs >= 15 * 60000 ? 'warn' : 'info');
        this.lastHealth = now;
      }
    } catch (error) {
      this.log('mail.scheduler.error', { errorCode: safeMailError(error, 'SCHEDULER_FAILED') }, 'error');
    } finally { this.ticking = false; }
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.timer);
    this.log('mail.scheduler.stopping', { reason: 'shutdown', activeWorkers: this.children.size });
    await Promise.all([...this.children.values()].map(child => new Promise<void>(resolve => {
      if (!child.pid) { resolve(); return; }
      const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} resolve(); }, 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      try { process.kill(-child.pid, 'SIGTERM'); } catch { clearTimeout(timer); resolve(); }
    })));
    this.log('mail.scheduler.stopped', { reason: 'shutdown', activeWorkers: this.children.size });
  }
}
