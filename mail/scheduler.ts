import { spawn, type ChildProcess } from 'node:child_process';
import type { MailStore } from './store.js';
import { jobDue } from './jobs.js';

export class MailScheduler {
  private child?: ChildProcess;
  private timer: ReturnType<typeof setInterval>;
  constructor(private store: MailStore, private cli: string, private origin: string) {
    this.timer = setInterval(() => this.tick(), 60000);
    this.timer.unref();
  }
  private tick() {
    if (this.child) return;
    try { if (!this.store.accounts().some(a => a.polling && jobDue(this.store.status(a.alias)))) return; } catch { return; }
    // Group the worker and its mbsync/helper children for shutdown. Do not relay
    // subprocess streams into application logs or model context.
    const child = spawn(process.execPath, [this.cli, 'sync', '--scheduled'], {
      detached: true, stdio: 'ignore', env: { ...process.env, MAIL_DIR: this.store.root, PUBLIC_ORIGIN: this.origin },
    });
    this.child = child;
    const done = () => { if (this.child === child) this.child = undefined; };
    child.on('error', done); child.on('close', done);
  }
  async close() {
    clearInterval(this.timer);
    const child = this.child;
    if (!child?.pid) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} resolve(); }, 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      try { process.kill(-child.pid!, 'SIGTERM'); } catch { clearTimeout(timer); resolve(); }
    });
  }
}
