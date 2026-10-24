import type { ChildProcess } from 'node:child_process';
import { RpcClient } from '@earendil-works/pi-coding-agent';

// No extension discovery (including builtins), MCP, skills, context or prompts.
// Filesystem read access is NOT a sandbox: use only with trusted local prompts.
export const backgroundArgs = ['--no-approve', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--tools', 'read,grep,find,ls'];

// Pi 1.4.0's stop() resolves immediately after sending SIGKILL, without waiting
// for exit. Session ownership must not transfer on that promise alone. This
// adapter intentionally depends on the pinned client's process field and fails
// closed if its shape changes. Keep the compatibility test when upgrading Pi.
export class ConfirmedRpcClient extends RpcClient {
  private confirmedStop?: Promise<void>;
  override stop(): Promise<void> { return this.confirmedStop ??= this.stopConfirmed(); }
  private async stopConfirmed() {
    if (!Object.hasOwn(this, 'process')) throw new Error('Unsupported Pi client; process termination cannot be verified');
    const child = (this as unknown as { process: ChildProcess | null }).process;
    if (!child) return;
    if (typeof child.once !== 'function' || typeof child.kill !== 'function') throw new Error('Cannot verify Pi process termination');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = new Promise<void>((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      timer = setTimeout(() => reject(new Error('Pi process exit remains unconfirmed')), 5000);
    });
    // Attach rejection handling before stop(), which itself may take time.
    try { await Promise.all([super.stop(), exited]); }
    finally { clearTimeout(timer); }
  }
}
