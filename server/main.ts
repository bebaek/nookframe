import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfirmedRpcClient, backgroundArgs } from './jobs/agent.js';
import { JobStore, activeRun } from './jobs/store.js';
import { JobRunner } from './jobs/runner.js';
import { Workspace } from './workspace.js';
import { Workspaces } from './workspaces.js';
import { existsSync } from 'node:fs';
import { createApp } from './http.js';
import { resolveModelSelection } from './models.js';
import { TerminalSession } from './terminal.js';
import { ThreadStore } from './threads.js';
import { MailStore } from '../mail/store.js';
import { MailOAuth } from '../mail/oauth.js';
import { MailScheduler } from '../mail/scheduler.js';
import { calendarRuntime } from '../calendar/runtime.js';
import { googleStore } from '../google/runtime.js';
import { allowedBrowserOrigins } from './origins.js';
import { piExtensionArgs } from './pi-extensions.js';
import { parsePromptExamples } from './prompt-examples.js';
import { clientContextCommand } from './client-context-extension.js';
import { PresenceStore } from './agent-presence.js';

const extensionArgs = piExtensionArgs(process.env.NOOKFRAME_PI_EXTENSIONS);
const promptExamples = parsePromptExamples(process.env.NOOKFRAME_PROMPT_EXAMPLES);
const root = process.cwd();
const workspaceDir = resolve(process.env.WORKSPACE_DIR ?? join(root, '.local/workspace'));
const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(root, '.local/agent'));
const stateDir = resolve(process.env.STATE_DIR ?? join(root, '.local/state'));
const port = Number(process.env.PORT ?? 3000);
const publicOrigin = process.env.PUBLIC_ORIGIN ?? `http://localhost:${port}`;
const allowedOrigins = [...allowedBrowserOrigins(publicOrigin, process.env.ALLOWED_ORIGINS?.split(','))];
const mailStore = new MailStore(resolve(process.env.MAIL_DIR ?? join(stateDir, '..', 'mail')), googleStore());
const mailOAuth = new MailOAuth(mailStore, publicOrigin);
const calendar = calendarRuntime();
const tokenFile = process.env.ACCESS_TOKEN_FILE;
if (!tokenFile) throw new Error('Set ACCESS_TOKEN_FILE to a file containing a random token (at least 32 characters)');
const token = (await readFile(tokenFile, 'utf8')).trim();
if (token.length < 32) throw new Error('Access token must be at least 32 characters');
for (const dir of [workspaceDir, agentDir, stateDir]) await mkdir(dir, { recursive: true, mode: 0o700 });
// Validate the default configuration now; agents are opened lazily under a session lock.
resolveModelSelection(stateDir, agentDir, process.env);
// The published CLI lives beside the exported bundled RPC entry, not dist/cli.js.
const cliPath = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'))), 'cli.js');
const threads = new ThreadStore(join(agentDir, 'workspace-sessions'), workspaceDir, stateDir);
// The shared agent directory is the existing single-owner trust boundary, not
// the per-slot state directory. Never share this registry across tenants.
const presenceDir = process.env.NOOKFRAME_AGENT_PRESENCE === '0' ? '' : join(agentDir, 'agent-presence');
const presence = presenceDir ? new PresenceStore(presenceDir) : undefined;
const initialThread = await threads.initial();
const jobStore = new JobStore(resolve(process.env.NOOKFRAME_JOBS_DIR ?? join(stateDir, 'jobs')));
const workspace = new Workspaces(threads, threads.id(initialThread), (file, threadStateDir, background) => {
  const selection = resolveModelSelection(existsSync(join(threadStateDir, 'model.json')) ? threadStateDir : stateDir, agentDir, process.env);
  const client = new ConfirmedRpcClient({
    cliPath: background ? fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './jobs/pi-worker.ts' : './jobs/pi-worker.js', import.meta.url)) : cliPath, cwd: workspaceDir,
    env: { NOOKFRAME_PRESENCE_DIR: background ? '' : presenceDir, NOOKFRAME_PRESENCE_THREAD_ID: threads.id(file), NOOKFRAME_JOBS_DIR: jobStore.directory, NOOKFRAME_IMAGE_STATE_DIR: stateDir, NOOKFRAME_IMAGE_THREAD_ID: threads.id(file), PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: '0', MAIL_DIR: mailStore.root, CALENDAR_DIR: calendar.store.root, GOOGLE_DIR: calendar.store.google?.root ?? '', PUBLIC_ORIGIN: publicOrigin },
    provider: selection.model?.provider,
    model: selection.model?.id,
    args: ['--session', file, '--session-dir', threads.directory, ...(background ? backgroundArgs : [...extensionArgs, '--extension', fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './agent-presence-extension.ts' : './agent-presence-extension.js', import.meta.url)), '--extension', fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './client-context-extension.ts' : './client-context-extension.js', import.meta.url)), '--no-approve', '--skill', join(root, 'skills/mail/SKILL.md'), '--skill', join(root, 'skills/calendar/SKILL.md'), '--skill', join(root, 'skills/images/SKILL.md'), '--skill', join(root, 'skills/jobs/SKILL.md')])],
  });
  const controller = new Workspace(client, threadStateDir, selection, threads, true, background ? undefined : async context => {
    const disposition = await client.prompt(`/${clientContextCommand} ${JSON.stringify(context ?? null)}`);
    if (disposition !== 'handled') throw new Error('Client context command was not handled');
  });
  return { workspace: controller, start: async () => {
    await client.start();
    if (!background && !(await client.getCommands()).some(command => command.name === clientContextCommand && command.source === 'extension')) {
      throw new Error('Client context extension unavailable');
    }
  } };
}, 4, 5 * 60_000, async id => {
  if ((await jobStore.runs()).some(run => run.threadId === id && activeRun(run))) throw new Error('Background run is owned by its runner or termination is uncertain. Open it on the owning slot; do not start another writer.');
});
await workspace.initialize();
const jobRunner = process.env.NOOKFRAME_JOBS_SLOT && process.env.NOOKFRAME_JOBS_SLOT === process.env.NOOKFRAME_SLOT ? new JobRunner(jobStore, workspace) : undefined;
await jobRunner?.start();
const mailScheduler = new MailScheduler(mailStore, join(root, 'dist/mail/cli.js'), publicOrigin);
const app = createApp(workspace, {
  token, origin: publicOrigin, allowedOrigins, promptExamples, presence,
  mail: mailOAuth, calendar: calendar.oauth,
  webDir: resolve(root, 'dist/web'), stateDir,
  terminal: new TerminalSession(workspaceDir, {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    NOOKFRAME_JOBS_DIR: jobStore.directory, NOOKFRAME_IMAGE_STATE_DIR: stateDir, NOOKFRAME_IMAGE_THREAD_ID: '', PI_CODING_AGENT_DIR: agentDir, MAIL_DIR: mailStore.root, CALENDAR_DIR: calendar.store.root, GOOGLE_DIR: calendar.store.google?.root ?? '', PUBLIC_ORIGIN: publicOrigin,
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
  try { await app.close(); await mailScheduler.close(); await jobRunner?.close(); await workspace.close(); }
  finally { clearTimeout(deadline); process.exit(0); }
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
