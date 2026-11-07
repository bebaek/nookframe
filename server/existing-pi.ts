import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { RpcClient } from '@earendil-works/pi-coding-agent';

/** Read-only startup probes before the UI can submit work to an external Pi. */
export async function verifyExistingPiRpc(client: Pick<RpcClient, 'getState' | 'getEntries' | 'getAvailableModels'>, file: string) {
  try {
    const [state, tree, models] = await Promise.all([client.getState(), client.getEntries(), client.getAvailableModels()]);
    if (typeof state?.sessionFile !== 'string' || resolve(state.sessionFile) !== resolve(file)
      || !Array.isArray(tree?.entries) || !Array.isArray(models)) throw new Error('Invalid RPC response');
  } catch {
    throw new Error('Installed Pi RPC is incompatible: expected get_state, get_entries and get_available_models with the requested session. Update Pi or select another executable with NOOKFRAME_PI_BIN.');
  }
}

// The host adapter stays pinned; external Pi may use compatible stable 1.x
// releases. Required RPC commands are additionally checked when opening a chat.
export function existingPiRuntime(env: NodeJS.ProcessEnv, home = homedir()) {
  const requested = env.NOOKFRAME_PI_BIN || 'pi';
  const candidates = requested.includes('/') || requested.includes('\\')
    ? [resolve(requested)]
    : (env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => resolve(dir, requested));
  let cliPath: string | undefined;
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) { cliPath = realpathSync(candidate); break; } }
    catch { /* Try the next PATH entry. */ }
  }
  if (!cliPath) throw new Error('Existing Pi not found. Install Pi or set NOOKFRAME_PI_BIN to its executable. Use --isolated for a separate profile.');
  if (process.platform === 'win32' || typeof process.execve !== 'function') throw new Error('Existing Pi requires Node.js 24+ on a POSIX host.');
  // The official installer supplies a shell launcher that sets its managed
  // runtime environment. Execute it, rather than guessing its package layout
  // or interpreting it as JavaScript. Never run through a shell command string.
  let version: string;
  try {
    version = execFileSync(cliPath, ['--version'], {
      env: { ...process.env, ...env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
      encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch { throw new Error('Could not run Pi --version. Check NOOKFRAME_PI_BIN and that your Pi installation starts successfully.'); }
  const parsed = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!parsed || Number(parsed[1]) !== 1 || Number(parsed[2]) < 5) {
    throw new Error('Existing-Pi mode requires a stable Pi >=1.5.0 and <2.0.0 (official installer or npm). Check pi --version; no bundled fallback is used.');
  }
  const executable = cliPath;
  cliPath = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './pi-executable-entry.ts' : './pi-executable-entry.js', import.meta.url));
  const profile = env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent');
  const agentDir = resolve(profile.startsWith('~/') ? join(home, profile.slice(2)) : profile);
  const custom = env.PI_CODING_AGENT_SESSION_DIR;
  // Settings-based overrides are deliberately rejected rather than silently storing elsewhere.
  for (const settings of [join(agentDir, 'settings.json'), join(env.WORKSPACE_DIR || process.cwd(), '.pi', 'settings.json')]) {
    try {
      const parsed = JSON.parse(readFileSync(settings, 'utf8'));
      if (parsed.sessionDir && !custom) throw new Error('Set PI_CODING_AGENT_SESSION_DIR explicitly when using a sessionDir setting with the existing-Pi PoC.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (custom && !isAbsolute(custom)) throw new Error('PI_CODING_AGENT_SESSION_DIR must be absolute for the existing-Pi PoC.');
  return { cliPath, executable, agentDir, sessionRoot: custom || join(agentDir, 'sessions'), flatSessions: !!custom };
}
