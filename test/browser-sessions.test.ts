import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { BrowserSessions, SESSION_SECONDS } from '../server/browser-sessions.js';
import { createApp } from '../server/http.js';
import { Workspace, type Agent } from '../server/workspace.js';
import { TerminalSession } from '../server/terminal.js';

const token = 'test-only-bootstrap-token-'.repeat(3);
test('browser credentials persist only as hashes; expiry, logout, token rotation, and failed saves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-browser-auth-'));
  let now = Date.now();
  try {
    let sessions = new BrowserSessions(token, dir, () => now);
    const value = sessions.issue(), cookie = `session=${value}`;
    const id = sessions.identify(cookie, 'session')!; assert.ok(id);
    const stored = readFileSync(join(dir, 'browser-sessions.json'), 'utf8');
    assert.ok(!stored.includes(value) && !stored.includes(token));
    assert.equal(statSync(join(dir, 'browser-sessions.json')).mode & 0o777, 0o600);
    sessions = new BrowserSessions(token, dir, () => now);
    assert.equal(sessions.identify(cookie, 'session'), id);
    assert.equal(sessions.identify(`${cookie}; ${cookie}`, 'session'), undefined);
    assert.equal(new BrowserSessions('rotated-token', dir, () => now).identify(cookie, 'session'), undefined);
    now += SESSION_SECONDS * 1000;
    assert.equal(sessions.identify(cookie, 'session'), undefined);
    const newer = sessions.issue(), newerId = sessions.identify(`session=${newer}`, 'session')!;
    sessions.revoke(newerId);
    assert.equal(new BrowserSessions(token, dir, () => now).identify(`session=${newer}`, 'session'), undefined);
    const keep = sessions.issue(), keepId = sessions.identify(`session=${keep}`, 'session')!;
    rmSync(join(dir, 'browser-sessions.json')); mkdirSync(join(dir, 'browser-sessions.json'));
    assert.throws(() => sessions.revoke(keepId));
    assert.equal(sessions.valid(keepId), true, 'Failed durable revocation must not claim success');
    assert.throws(() => sessions.issue());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HTTPS cookie flags, login/logout CSRF checks, cookie-backed chat and terminal, revoked connections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-auth-http-'));
  const workspace = new Workspace({ onEvent() { return () => {}; }, async stop() {} } as unknown as Agent, dir);
  const origin = 'https://workspace.example';
  const app = createApp(workspace, { token, origin, stateDir: dir, webDir: resolve('dist/web'),
    terminal: new TerminalSession(dir, { PATH: process.env.PATH!, HOME: dir }),
  });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const sockets: WebSocket[] = [];
  const post = (path: string, requestOrigin: string, body: unknown = {}, cookie = '') => fetch(url + path, {
    method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
  });
  try {
    assert.deepEqual(await (await fetch(url + '/auth/session')).json(), { authenticated: false });
    assert.equal((await post('/auth/login', 'https://evil.example', { token })).status, 403);
    assert.equal((await post('/auth/login', '', { token })).status, 403);
    assert.equal((await post('/auth/login', origin, { token: 'wrong' })).status, 401);
    const login = await post('/auth/login', origin, { token });
    assert.equal(login.status, 200);
    const header = login.headers.get('set-cookie')!;
    assert.match(header, /^__Host-pi-workspace-session=/);
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/', `Max-Age=${SESSION_SECONDS}`]) assert.ok(header.includes(flag));
    const cookie = header.split(';')[0];
    assert.deepEqual(await (await fetch(url + '/auth/session', { headers: { Cookie: cookie } })).json(), { authenticated: true });
    for (const path of ['/ws', '/terminal']) {
      const ws = new WebSocket(url.replace('http:', 'ws:') + path, { origin, headers: { Cookie: cookie } }); sockets.push(ws);
      await once(ws, 'open');
      const response = once(ws, 'message');
      ws.send(JSON.stringify({ type: 'auth' }));
      const [data] = await response;
      assert.equal(JSON.parse(data.toString()).type, path === '/ws' ? 'snapshot' : 'terminal_ready');
    }
    assert.equal((await post('/auth/logout', 'https://evil.example', {}, cookie)).status, 403);
    const closed = sockets.map(ws => once(ws, 'close'));
    const logout = await post('/auth/logout', origin, {}, cookie);
    assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/);
    for (const [code] of await Promise.all(closed)) assert.equal(code, 1008);
    assert.deepEqual(await (await fetch(url + '/auth/session', { headers: { Cookie: cookie } })).json(), { authenticated: false });
  } finally { for (const ws of sockets) ws.terminate(); await app.close(); await workspace.close(); rmSync(dir, { recursive: true, force: true }); }
});
