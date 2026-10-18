import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const launcher = resolve('scripts/run-tests.mjs');
const blocked = ['GOOGLE_DIR', 'MAIL_DIR', 'CALENDAR_DIR', 'STATE_DIR', 'WORKSPACE_DIR',
  'PI_CODING_AGENT_DIR', 'ACCESS_TOKEN_FILE', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'NOOKFRAME_SLOT',
  'KUBECONFIG', 'GH_TOKEN', 'GITHUB_TOKEN', 'SOPS_AGE_KEY', 'SOPS_AGE_KEY_FILE', 'SSH_AUTH_SOCK',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'NODE_OPTIONS', 'AGENT_MODEL'];
function fixture(mode: 'pass' | 'fail' | 'signal', container = false) {
  const root = mkdtempSync(join(tmpdir(), 'test-launcher-regression-'));
  const home = join(root, 'live-home'); mkdirSync(home);
  const sentinel = join(home, 'oauth-client.json'); writeFileSync(sentinel, 'untouched');
  const report = join(root, 'report.json');
  const file = join(root, 'fixture.test.mjs');
  writeFileSync(file, `
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
test('fixture', async () => {
  for (const key of ${JSON.stringify(blocked)}) assert.equal(process.env[key], undefined, key);
  assert.notEqual(process.env.HOME, ${JSON.stringify(home)});
  for (const key of ['XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','TMPDIR'])
    assert.ok(process.env[key].startsWith(process.env.HOME.replace(/home$/, '')));
  assert.equal(process.env.BROWSER_EXECUTABLE_PATH, '/fixture/chromium');
  assert.equal(process.env.TEST_IMAGE, 'fixture-image');
  const child = JSON.parse(execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], {encoding:'utf8'}));
  for (const key of ${JSON.stringify(blocked)}) assert.equal(child[key], undefined);
  assert.equal(child.HOME, process.env.HOME);
  ${container ? `const { containerEnvironment } = await import(${JSON.stringify(resolve('test/container-runtime.ts'))});
  assert.equal(containerEnvironment().HOME, ${JSON.stringify(home)});
  assert.equal(containerEnvironment().KUBECONFIG, undefined);
  assert.equal(containerEnvironment().GH_TOKEN, undefined);` : 'assert.equal(process.env.NOOKFRAME_TEST_CONTAINER_ENV, undefined);'}
  writeFileSync(${JSON.stringify(report)}, JSON.stringify({home:process.env.HOME}));
  ${mode === 'fail' ? 'assert.fail("intentional failure");' : mode === 'signal' ? 'await new Promise(() => { setInterval(() => {}, 1000); });' : ''}
});
`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home,
    BROWSER_EXECUTABLE_PATH: '/fixture/chromium', TEST_IMAGE: 'fixture-image',
    NOOKFRAME_TEST_CONTAINER_ENV: '{"HOME":"untrusted-inherited-value"}' };
  for (const key of blocked) env[key] = key === 'NODE_OPTIONS' ? '--no-warnings' : sentinel;
  return { root, home, sentinel, report, file, env };
}
for (const mode of ['pass', 'fail'] as const) {
  test(`test launcher isolates parent/subprocess environment and cleans up after ${mode}`, { timeout: 20000 }, () => {
    const f = fixture(mode);
    try {
      const result = spawnSync(process.execPath, [launcher, f.file], { env: f.env, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, mode === 'pass' ? 0 : 1, result.stdout + result.stderr);
      const report = JSON.parse(readFileSync(f.report, 'utf8'));
      assert.equal(existsSync(dirname(report.home)), false);
      assert.equal(readFileSync(f.sentinel, 'utf8'), 'untouched');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}
test('container mode restores runtime storage paths only for Docker/Podman invocations', { timeout: 20000 }, () => {
  const f = fixture('pass', true);
  try {
    const result = spawnSync(process.execPath, [launcher, '--container', f.file], { env: f.env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(dirname(JSON.parse(readFileSync(f.report, 'utf8')).home)), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test('test launcher forwards termination and removes temporary home', { timeout: 20000, skip: process.platform === 'win32' }, async () => {
  const f = fixture('signal');
  const child = spawn(process.execPath, [launcher, f.file], { env: f.env, stdio: 'ignore' });
  const closed = once(child, 'close');
  try {
    for (let n = 0; n < 500 && !existsSync(f.report) && child.exitCode === null; n++)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(existsSync(f.report), 'fixture must start before interruption');
    child.kill('SIGTERM');
    const [code] = await closed;
    assert.equal(code, 143);
    assert.equal(existsSync(dirname(JSON.parse(readFileSync(f.report, 'utf8')).home)), false);
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await closed; }
    rmSync(f.root, { recursive: true, force: true });
  }
});
