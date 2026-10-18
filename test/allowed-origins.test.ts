import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { Workspace, type Agent } from '../server/workspace.js';
import { createApp } from '../server/http.js';
import { TerminalSession } from '../server/terminal.js';

test('explicit origins allow auth and both sockets; missing/foreign origins stay rejected', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nookframe-origins-'));
  const agent = { onEvent() { return () => {}; }, async stop() {} } as unknown as Agent;
  const workspace = new Workspace(agent, dir);
  const token = 'a'.repeat(64);
  const origin = 'http://main.example';
  const fallback = 'http://fallback.example';
  const app = createApp(workspace, { token, origin, allowedOrigins: [fallback],
    stateDir: dir, webDir: resolve('dist/web'), terminal: new TerminalSession(dir, { PATH: process.env.PATH ?? '/usr/bin:/bin' }) });
  const sockets: WebSocket[] = [];
  try {
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    for (const allowed of [origin, fallback]) {
      const response = await fetch(base + '/auth/login', { method: 'POST',
        headers: { origin: allowed, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      const cookie = response.headers.get('set-cookie')!;
      assert.doesNotMatch(cookie, /domain=/i);
      for (const path of ['/ws', '/terminal']) {
        const ws = new WebSocket(base.replace('http:', 'ws:') + path, {
          origin: allowed, headers: { Cookie: cookie.split(';')[0] } });
        sockets.push(ws);
        await once(ws, 'open');
        ws.close();
        await once(ws, 'close');
      }
      assert.equal((await fetch(base + '/auth/logout', { method: 'POST', headers: { origin: allowed,
        Cookie: cookie.split(';')[0] } })).status, 200);
    }
    for (const rejected of [undefined, 'null', 'http://attacker.example', fallback + '.attacker.example']) {
      const headers: Record<string, string> = rejected ? { origin: rejected } : {};
      for (const path of ['/auth/login', '/auth/logout']) {
        assert.equal((await fetch(base + path, { method: 'POST', headers })).status, 403);
      }
      for (const path of ['/ws', '/terminal']) {
        const ws = new WebSocket(base.replace('http:', 'ws:') + path, { headers });
        sockets.push(ws);
        const [error] = await once(ws, 'error');
        assert.match(error.message, /403/);
      }
    }
  } finally {
    for (const ws of sockets) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    await app.close(); await workspace.close(); rmSync(dir, { recursive: true, force: true });
  }
});
