#!/usr/bin/env node
// Environment isolation for accidental leakage, NOT a filesystem/network sandbox.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir, constants } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const containerMode = args[0] === '--container';
if (containerMode) args.shift();
if (!args.length) throw new Error('Specify test files');
const root = mkdtempSync(join(tmpdir(), 'nookframe-tests-'));
const env = {};
// Deliberately allowlist rather than chase every future app/provider credential.
for (const [key, value] of Object.entries(process.env)) {
  if (/^(PATH|SystemRoot|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|LANG|LC_.*|TZ|TERM|COLORTERM|CI|NO_COLOR|FORCE_COLOR|BROWSER_EXECUTABLE_PATH|PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD|TEST_IMAGE|CONTAINER_RUNTIME)$/.test(key)) {
    env[key] = value;
  }
}
for (const [key, directory] of Object.entries({ HOME: 'home', TMPDIR: 'tmp', XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', XDG_DATA_HOME: 'data' })) {
  env[key] = join(root, directory);
  mkdirSync(env[key], { mode: 0o700 });
}
env.USERPROFILE = env.HOME;
env.TMP = env.TEMP = env.TMPDIR;
env.NODE_ENV = 'test';
// Browser binaries are a shared tool cache, not user configuration/credentials.
const browserCache = process.platform === 'darwin' ? join(homedir(), 'Library/Caches') :
  process.platform === 'win32' ? (process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local')) :
  (process.env.XDG_CACHE_HOME || join(homedir(), '.cache'));
env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || join(browserCache, 'ms-playwright');
if (containerMode) {
  // Only the external runtime gets its normal storage/config paths. Otherwise
  // rootless Podman would look for images inside the disposable test home.
  const runtime = { HOME: homedir() };
  for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'DOCKER_HOST', 'DOCKER_CONTEXT',
    'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'CONTAINER_HOST', 'CONTAINER_CONNECTION',
    'CONTAINERS_STORAGE_CONF', 'CONTAINERS_CONF', 'REGISTRY_AUTH_FILE']) {
    if (process.env[key] !== undefined) runtime[key] = process.env[key];
  }
  env.NOOKFRAME_TEST_CONTAINER_ENV = JSON.stringify(runtime);
}
let child;
let killTimer;
let receivedSignal;
const signals = ['SIGINT', 'SIGTERM'];
const signalChild = signal => {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
};
const handlers = new Map(signals.map(signal => [signal, () => {
  receivedSignal = signal;
  signalChild(signal);
  killTimer ??= setTimeout(() => signalChild('SIGKILL'), 5000);
}]));
try {
  child = spawn(process.execPath, ['--import', 'tsx', '--test', ...args], {
    env, stdio: 'inherit', detached: process.platform !== 'win32',
  });
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const signal = receivedSignal || result.signal;
  process.exitCode = signal ? 128 + (constants.signals[signal] || 1) : result.code ?? 1;
} finally {
  clearTimeout(killTimer);
  for (const [signal, handler] of handlers) process.off(signal, handler);
  rmSync(root, { recursive: true, force: true });
}
