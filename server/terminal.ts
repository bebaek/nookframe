import * as pty from 'node-pty';
import type { TerminalEvent } from '../shared/protocol.js';

// A single shared shell lives independently of browser connections and pi RPC.
// No replay buffer, logging, or conversation integration.
export class TerminalSession {
  private process?: pty.IPty;
  private listeners = new Set<(event: TerminalEvent) => void>();
  private closed = false;
  constructor(private cwd: string, private env: Record<string, string>) {}

  private emit(event: TerminalEvent) { for (const listener of this.listeners) listener(event); }
  attach(listener: (event: TerminalEvent) => void) {
    this.listeners.add(listener);
    try {
      if (!this.process) this.start();
      else listener({ type: 'terminal_ready' });
    } catch (error) { this.listeners.delete(listener); throw error; }
    return () => { this.listeners.delete(listener); };
  }
  start() {
    if (this.closed) throw new Error('Terminal is closed');
    if (this.process) return;
    const child = pty.spawn('/bin/bash', ['--noprofile', '--norc', '-i'], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: this.cwd,
      env: { ...this.env, TERM: 'xterm-256color', HISTFILE: '/dev/null', HISTSIZE: '0', HISTFILESIZE: '0', PS1: '\\u@workspace:\\w\\$ ' },
    });
    this.process = child;
    child.onData(data => this.emit({ type: 'terminal_data', data }));
    child.onExit(({ exitCode }) => {
      if (this.process === child) this.process = undefined;
      this.emit({ type: 'terminal_exit', code: exitCode });
    });
    this.emit({ type: 'terminal_ready' });
  }
  input(data: string) { if (!this.process) throw new Error('Shell exited'); this.process.write(data); }
  resize(cols: number, rows: number) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 2 || rows > 300) throw new Error('Invalid dimensions');
    this.process?.resize(cols, rows);
  }
  close() {
    this.closed = true;
    this.listeners.clear();
    this.process?.kill();
    this.process = undefined;
  }
}
