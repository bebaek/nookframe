// RPC child entry point. Background agents must not outlive a crashed server.
// This is a crash guard, not fencing against arbitrary process suspension.
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const parent = process.ppid;
const timer = setInterval(() => {
  if (process.ppid !== parent) process.exit(1);
  try { process.kill(parent, 0); } catch { process.exit(1); }
}, 1000);
timer.unref();
const cli = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'))), 'cli.js');
await import(pathToFileURL(cli).href);
