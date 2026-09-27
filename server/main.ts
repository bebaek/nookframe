import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcClient } from '@earendil-works/pi-coding-agent';
import lockfile from 'proper-lockfile';
import { Workspace } from './workspace.js';
import { createApp } from './http.js';
import { resolveModelSelection } from './models.js';
import { TerminalSession } from './terminal.js';

const root = process.cwd();
const workspaceDir = resolve(process.env.WORKSPACE_DIR ?? join(root, '.local/workspace'));
const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(root, '.local/agent'));
const stateDir = resolve(process.env.STATE_DIR ?? join(root, '.local/state'));
const tokenFile = process.env.ACCESS_TOKEN_FILE;
if (!tokenFile) throw new Error('Set ACCESS_TOKEN_FILE to a file containing a random token (at least 32 characters)');
const token = (await readFile(tokenFile, 'utf8')).trim();
if (token.length < 32) throw new Error('Access token must be at least 32 characters');
for (const dir of [workspaceDir, agentDir, stateDir]) await mkdir(dir, { recursive: true, mode: 0o700 });
// Reject a second server using this profile, including during overlapping restarts.
const releaseLock = await lockfile.lock(agentDir, { stale: 30000, update: 10000, retries: 0 });
const selection = resolveModelSelection(stateDir, agentDir, process.env);
// The published CLI lives beside the exported bundled RPC entry, not dist/cli.js.
const cliPath = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'))), 'cli.js');
const client = new RpcClient({
  cliPath, cwd: workspaceDir,
  env: { PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: '0' },
  provider: selection.model?.provider,
  model: selection.model?.id,
  args: ['--session-id', 'workspace', '--session-dir', join(agentDir, 'workspace-sessions'), '--no-extensions', '--no-approve'],
});
const workspace = new Workspace(client, stateDir, selection);
try {
  await client.start();
  await workspace.initialize();
} catch (error) {
  await client.stop();
  await releaseLock();
  throw error;
}
const port = Number(process.env.PORT ?? 3000);
const app = createApp(workspace, {
  token, origin: process.env.PUBLIC_ORIGIN ?? `http://localhost:${port}`,
  webDir: resolve(root, 'dist/web'),
  terminal: new TerminalSession(workspaceDir, {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    PI_CODING_AGENT_DIR: agentDir,
    PATH: `${join(root, 'node_modules/.bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
  }),
});
app.server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
  console.log(`Pi workspace listening on port ${port}; workspace: ${workspaceDir}`);
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 15000);
  try { await app.close(); await workspace.close(); await releaseLock(); }
  finally { clearTimeout(deadline); process.exit(0); }
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
