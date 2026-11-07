import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// The host RPC adapter and session reader are pinned to this Pi contract.
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
  // RpcClient launches node <cliPath>; shell wrappers and standalone binaries are not supported.
  let directory = dirname(cliPath);
  let compatible = false;
  while (dirname(directory) !== directory) {
    try {
      const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (pkg.name === '@earendil-works/pi-coding-agent') {
        const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
        compatible = pkg.version === '1.5.0' && typeof bin === 'string' && bin.endsWith('.js')
          && cliPath === realpathSync(join(directory, bin));
        break;
      }
    } catch { /* Not a package root. */ }
    directory = dirname(directory);
  }
  if (!compatible) throw new Error('Existing-Pi PoC requires the npm-installed Pi 1.5.0 CLI (not a shell wrapper). Set NOOKFRAME_PI_BIN to that CLI; no bundled fallback is used.');
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
  return { cliPath, agentDir, sessionRoot: custom || join(agentDir, 'sessions'), flatSessions: !!custom };
}
