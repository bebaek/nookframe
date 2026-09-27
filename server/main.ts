import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcClient } from '@earendil-works/pi-coding-agent';
import lockfile from 'proper-lockfile';
import { Workspace } from './workspace.js';
import { createApp } from './http.js';
import { resolveModelSelection } from './models.js';
import { TerminalSession } from './terminal.js';
import { ThreadStore } from './threads.js';
import { MailStore } from '../mail/store.js';
import { MailOAuth } from '../mail/oauth.js';
import { MailScheduler } from '../mail/scheduler.js';

const root = process.cwd();
const workspaceDir = resolve(process.env.WORKSPACE_DIR ?? join(root, '.local/workspace'));
const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(root, '.local/agent'));
const stateDir = resolve(process.env.STATE_DIR ?? join(root, '.local/state'));
const port = Number(process.env.PORT ?? 3000);
const publicOrigin = process.env.PUBLIC_ORIGIN ?? `http://localhost:${port}`;
const mailStore = new MailStore(resolve(process.env.MAIL_DIR ?? join(stateDir, '..', 'mail')));
const mailOAuth = new MailOAuth(mailStore, publicOrigin);
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
const threads = new ThreadStore(join(agentDir, 'workspace-sessions'), workspaceDir, stateDir);
const initialThread = await threads.initial();
const client = new RpcClient({
  cliPath, cwd: workspaceDir,
  env: { PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: '0', MAIL_DIR: mailStore.root, PUBLIC_ORIGIN: publicOrigin },
  provider: selection.model?.provider,
  model: selection.model?.id,
  args: ['--session', initialThread, '--session-dir', threads.directory, '--no-extensions', '--no-approve', '--skill', join(root, 'skills/mail/SKILL.md')],
});
const workspace = new Workspace(client, stateDir, selection, threads);
try {
  await client.start();
  await workspace.initialize();
} catch (error) {
  await client.stop();
  await releaseLock();
  throw error;
}
const mailScheduler = new MailScheduler(mailStore, join(root, 'dist/mail/cli.js'), publicOrigin);
const app = createApp(workspace, {
  token, origin: publicOrigin, mail: mailOAuth,
  webDir: resolve(root, 'dist/web'), stateDir,
  terminal: new TerminalSession(workspaceDir, {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    PI_CODING_AGENT_DIR: agentDir, MAIL_DIR: mailStore.root, PUBLIC_ORIGIN: publicOrigin,
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
  try { await app.close(); await mailScheduler.close(); await workspace.close(); await releaseLock(); }
  finally { clearTimeout(deadline); process.exit(0); }
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
