import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as pty from 'node-pty';
import type { TerminalEvent } from '../shared/protocol.js';

export const terminalSocketPath = (stateDir: string) => join(stateDir, 'terminal.tmux.sock');

// A single shared shell lives independently of browser connections and pi RPC.
// No replay buffer, logging, or conversation integration.
export class TerminalSession {
  private process?: pty.IPty;
  private listeners = new Set<(event: TerminalEvent) => void>();
  private closed = false;
  private socket: string;
  constructor(private cwd: string, private env: Record<string, string>, stateDir = cwd) {
    this.socket = terminalSocketPath(stateDir);
  }

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
    const launch = `
      if command -v tmux >/dev/null; then
        unset TMUX TMUX_PANE
        tmux -S "$1" new-session -A -s shared && exit 0
        printf 'tmux could not start; using plain Bash.\\n'
      else
        printf 'tmux not found; using plain Bash.\\n'
      fi
      exec /bin/bash -i`;
    const child = pty.spawn('/bin/bash', ['--noprofile', '--norc', '-c', launch, 'terminal', this.socket], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: this.cwd,
      env: { ...this.env, NOOKFRAME_TMUX_SOCKET: this.socket, TERM: 'xterm-256color' },
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
    if (existsSync(this.socket)) spawnSync('tmux', ['-S', this.socket, 'kill-server'], { env: this.env, timeout: 1000 });
    this.process = undefined;
  }
}
