import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

test('isolated container: read-only non-root PTY and real offline pi TUI', { timeout: 60000 }, async () => {
  const image = process.env.TEST_IMAGE;
  assert.ok(image, 'Set TEST_IMAGE to a locally built image');
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const address = reservation.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const name = `pi-terminal-test-${process.pid}`;
  const container = (...args: string[]) => execFileSync(process.env.CONTAINER_RUNTIME || 'podman', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
  const token = 'terminal-smoke-fixture-not-a-real-token';
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    container('run', '-d', '--name', name, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--memory=512m', '--pids-limit=256', '-p', `127.0.0.1:${port}:3000`, '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,mode=1777',
      '--tmpfs', '/data:rw,mode=1777', '--tmpfs', '/workspace:rw,exec,nosuid,nodev,mode=1777', '--tmpfs', '/home/node:rw,mode=1777',
      '-e', `PUBLIC_ORIGIN=${origin}`, '-e', 'ACCESS_TOKEN_FILE=/tmp/test-token', '-e', 'PI_OFFLINE=1',
      '--entrypoint', '/bin/bash', image, '-c', `umask 077; printf %s ${token} > /tmp/test-token; exec node dist/server/main.js`);
    for (let n = 0; n < 100; n++) {
      try { if ((await fetch(origin + '/healthz')).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal((await fetch(origin + '/healthz')).status, 200);
    container('exec', name, 'sh', '-ec',
      'for tool in git gh node npm python3 make g++ kubectl sops ssh age jq rsync chromium; do command -v "$tool"; done; ' +
      'python3 -c "import yaml"; kubectl version --client; sops --version; gh --version; ' +
      'test "$BROWSER_EXECUTABLE_PATH" = /usr/bin/chromium; ' +
      'printf "int main() { return 0; }\\n" > /tmp/compiler-smoke.cpp; g++ /tmp/compiler-smoke.cpp -o /workspace/compiler-smoke; /workspace/compiler-smoke');
    assert.match(container('exec', name, 'chromium', '--headless', '--no-sandbox', '--disable-dev-shm-usage',
      '--dump-dom', 'data:text/html,<title>workstation-smoke</title>'), /<title>workstation-smoke<\/title>/);
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) errors.push(message.text()); });
    await page.goto(origin);
    await page.getByLabel('Access token').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
    await page.getByText('Connected', { exact: true }).waitFor();
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('printf "private_%s\\n" terminal_canary'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent?.includes('private_terminal_canary'));
    await page.keyboard.type('pi --no-session --no-extensions --no-approve'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent?.includes('No models available'));
    await mkdir('.local', { recursive: true });
    await page.screenshot({ path: '.local/terminal-container-mobile.png', fullPage: false });
    assert.ok(!container('logs', name).includes('private_terminal_canary'), 'Terminal output must not enter application logs');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    try { container('rm', '-f', name); } catch {}
  }
});
