import { spawn, type ChildProcess } from 'node:child_process';
import { MailError, type MailStore } from './store.js';
import { nextMailWork } from './jobs.js';

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
  constructor(private store: MailStore, private cli: string, private origin: string,
    private concurrency = mailConcurrency(), private launch: typeof spawn = spawn) {
    this.timer = setInterval(() => { void this.tick(); }, 60000);
    this.timer.unref();
  }
  async tick() {
    if (this.closing || this.ticking) return;
    this.ticking = true;
    try {
      for (const account of this.store.accounts()) {
        if (this.closing || this.children.size >= this.concurrency) break;
        if (this.children.has(account.alias) || !account.polling) continue;
        const work = nextMailWork(this.store.status(account.alias), this.store.indexStatus(account.alias));
        if (!work) continue;
        if (await this.store.accountSyncLocked(account.alias)) continue;
        if (this.closing) break;
        // The worker rechecks opt-in/eligibility under its account lock. Each
        // group contains mbsync/token-helper children; never relay their output.
        const child = this.launch(process.execPath, [this.cli, work, account.alias, '--scheduled'], {
          detached: true, stdio: 'ignore', env: { ...process.env, MAIL_DIR: this.store.root, PUBLIC_ORIGIN: this.origin },
        });
        this.children.set(account.alias, child);
        const done = () => { if (this.children.get(account.alias) === child) this.children.delete(account.alias); };
        child.on('error', done); child.on('close', done);
      }
    } catch { /* Retry on the next tick; do not leak subprocess/account errors. */ }
    finally { this.ticking = false; }
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    await Promise.all([...this.children.values()].map(child => new Promise<void>(resolve => {
      if (!child.pid) { resolve(); return; }
      const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} resolve(); }, 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      try { process.kill(-child.pid, 'SIGTERM'); } catch { clearTimeout(timer); resolve(); }
    })));
  }
}
