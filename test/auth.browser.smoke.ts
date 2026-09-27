import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { Workspace, type Agent } from '../server/workspace.js';
import { createApp } from '../server/http.js';

test('browser login survives page reload and server replacement; logout locks all device tabs', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-auth-browser-'));
  const workspace = new Workspace({ onEvent() { return () => {}; }, async stop() {} } as unknown as Agent, dir);
  const token = 'fixture-auth-token-'.repeat(4);
  // First listener reserves the origin port; the replacement reuses it.
  const { createServer } = await import('node:net');
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const address = reservation.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const config = { token, origin, stateDir: dir, webDir: resolve('dist/web') };
  let app = createApp(workspace, config);
  const listen = async () => { app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening'); };
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, headless: true });
  try {
    await listen();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    const a = await context.newPage();
    const frames: string[] = [];
    a.on('websocket', ws => ws.on('framesent', event => frames.push(String(event.payload))));
    await a.goto(origin); await a.getByLabel('Access token').fill(token);
    await a.getByRole('button', { name: 'Connect', exact: true }).click(); await a.getByText('Ready', { exact: true }).waitFor();
    assert.equal(await a.evaluate(() => document.cookie), '', 'Cookie is hidden from JavaScript');
    assert.deepEqual(await a.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
    const cookie = (await context.cookies())[0];
    assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, 'Strict');
    assert.ok(cookie.expires > Date.now() / 1000 + 29 * 86400);
    await a.reload(); await a.getByText('Ready', { exact: true }).waitFor();
    assert.equal(await a.getByLabel('Access token').count(), 0);
    await app.close(); app = createApp(workspace, config); await listen();
    await a.reload(); await a.getByText('Ready', { exact: true }).waitFor();
    assert.equal(await a.getByLabel('Access token').count(), 0, 'No repeated login after server replacement');
    const b = await context.newPage(); await b.goto(origin); await b.getByText('Ready', { exact: true }).waitFor();
    await a.getByRole('button', { name: 'Sign out', exact: true }).click();
    await a.getByLabel('Access token').waitFor(); await b.getByLabel('Access token').waitFor();
    assert.equal((await context.cookies()).length, 0);
    await a.reload(); await a.getByLabel('Access token').waitFor();
    assert.ok(frames.length > 0 && frames.every(frame => !frame.includes(token)), 'Bootstrap token never sent in browser WebSocket frames');
    // Rotation also invalidates a persisted login, without needing to delete files.
    await a.getByLabel('Access token').fill(token); await a.getByRole('button', { name: 'Connect', exact: true }).click();
    await a.getByText('Ready', { exact: true }).waitFor();
    await app.close(); app = createApp(workspace, { ...config, token: 'rotated-access-token-'.repeat(4) }); await listen();
    await a.reload(); await a.getByLabel('Access token').waitFor();
  } finally { await browser.close(); await app.close(); await workspace.close(); await rm(dir, { recursive: true, force: true }); }
});
