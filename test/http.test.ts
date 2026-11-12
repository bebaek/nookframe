import { test } from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { Workspace, type Agent } from '../server/workspace.js';
import { createApp } from '../server/http.js';
import type { ServerMessage } from '../shared/protocol.js';

test('local access bootstraps cookie auth and rejects foreign HTTP and WebSocket hosts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nookframe-local-'));
  const agent = { onEvent() { return () => {}; }, async stop() {} } as unknown as Agent;
  const workspace = new Workspace(agent, dir);
  const origin = 'http://localhost:3000';
  const app = createApp(workspace, { token: 'a'.repeat(64), localAccess: true, origin, webDir: resolve('dist/web') });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  // node:http preserves an explicit Host for virtual-origin guard tests.
  const fetch = (url: string, init: { headers?: Record<string, string>; method?: string } = {}) => new Promise<Response>((resolve, reject) => {
    const req = request(url, init, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(new Response(body, { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])) })));
    });
    req.on('error', reject); req.end();
  });
  try {
    assert.equal((await fetch(`${base}/auth/session`)).status, 403);
    const headers = { Host: 'localhost:3000' };
    for (const extra of [{ Origin: 'https://evil.example' }, { 'X-Forwarded-For': '127.0.0.1' }] as Record<string, string>[]) {
      assert.equal((await fetch(`${base}/auth/session`, { headers: { ...headers, ...extra } })).status, 403);
    }
    const response = await fetch(`${base}/auth/session`, { headers });
    assert.deepEqual(await response.json(), { authenticated: true });
    const cookie = response.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/);
    const resumed = await fetch(`${base}/auth/session`, { headers: { ...headers, Cookie: cookie.split(';')[0] } });
    assert.equal(resumed.headers.get('set-cookie'), null);
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws`, { origin });
    await assert.rejects(once(ws, 'open'));
    const logout = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { ...headers, Origin: origin, Cookie: cookie.split(';')[0] } });
    assert.equal(logout.status, 200);
  } finally { await app.close(); await workspace.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('thread search requires browser auth, rejects foreign origins and bounds requests/results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nookframe-search-http-'));
  const workspace = new Workspace({ onEvent() { return () => {}; }, async stop() {} } as unknown as Agent, dir);
  const queries: string[] = [];
  workspace.searchThreads = async query => {
    queries.push(query);
    return Array.from({ length: 51 }, (_, i) => ({ id: `${i}.jsonl`, title: 'Result', updatedAt: '', excerpt: 'Matched message' }));
  };
  const origin = 'http://localhost:3000', token = 's'.repeat(64);
  const app = createApp(workspace, { token, origin, webDir: resolve('dist/web') });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const url = `${base}/api/threads/search?q=rollback`;
    assert.equal((await fetch(url)).status, 401);
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const headers = { Cookie: cookie, Origin: origin };
    assert.equal((await fetch(url, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(url, { headers, method: 'POST' })).status, 405);
    for (const q of ['', ' '.repeat(5), 'x'.repeat(257)]) {
      assert.equal((await fetch(`${base}/api/threads/search?q=${encodeURIComponent(q)}`, { headers })).status, 400);
    }
    assert.deepEqual(queries, []);
    const response = await fetch(url, { headers });
    assert.match(response.headers.get('cache-control')!, /no-store/);
    const result = await response.json();
    assert.equal(result.threads.length, 50);
    assert.equal(result.truncated, true);
    assert.equal(result.threads[0].excerpt, 'Matched message');
    assert.deepEqual(queries, ['rollback']);
    await fetch(`${base}/auth/logout`, { method: 'POST', headers });
    assert.equal((await fetch(url, { headers })).status, 401);
  } finally { await app.close(); await workspace.close(); rmSync(dir, { recursive: true, force: true }); }
});

function inbox(ws: WebSocket) {
  const queue: ServerMessage[] = [];
  let pending: ((value: ServerMessage) => void) | undefined;
  ws.on('message', data => {
    const value = JSON.parse(data.toString());
    if (pending) { const resolve = pending; pending = undefined; resolve(value); }
    else queue.push(value);
  });
  return async function next(): Promise<ServerMessage> {
    if (queue.length) return queue.shift()!;
    return new Promise(resolve => { pending = resolve; });
  };
}

test('origin and token checks; disconnect preserves task; reconnect snapshot; stop', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-workspace-http-'));
  let aborts = 0;
  let prompts = 0;
  let event: (value: unknown) => void = () => {};
  const agent = {
    onEvent(fn: typeof event) { event = fn; return () => {}; },
    async getState() { return {}; },
    async getEntries() { return { entries: [], leafId: null }; },
    async prompt() { prompts++; },
    async clearQueue() { return { steering: [], followUp: [] }; },
    async abort() { aborts++; event({ type: 'agent_settled', aborted: true }); },
    async stop() {},
  } as unknown as Agent;
  const workspace = new Workspace(agent, dir);
  const token = 'a'.repeat(64);
  const origin = 'http://localhost:3000';
  const app = createApp(workspace, { token, origin, webDir: resolve('dist/web') });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const sockets: WebSocket[] = [];
  const open = async (tokenValue: string) => {
    const ws = new WebSocket(url, { origin }); sockets.push(ws);
    const next = inbox(ws);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'auth', token: tokenValue }));
    return { ws, next };
  };
  try {
    const base = `http://127.0.0.1:${address.port}`;
    const worker = await fetch(`${base}/notification-worker.js`);
    assert.equal(worker.status, 200);
    assert.match(worker.headers.get('content-type') ?? '', /text\/javascript/);
    assert.equal(worker.headers.get('cache-control'), 'no-cache');
    assert.match(await worker.text(), /notificationclick/);
    assert.equal((await fetch(`${base}/other-worker.js`)).status, 404);
    const forbidden = new WebSocket(url, { origin: 'https://attacker.example' });
    const [error] = await once(forbidden, 'error');
    assert.match(error.message, /403/);
    const wrong = await open('wrong');
    const [code] = await once(wrong.ws, 'close');
    assert.equal(code, 1008);
    const first = await open(token);
    assert.equal((await first.next()).type, 'snapshot');
    first.ws.send(JSON.stringify({ type: 'prompt', id: 'one', text: 'hello' }));
    let reply = await first.next();
    while (reply.type !== 'ack') reply = await first.next();
    assert.equal(prompts, 1);
    first.ws.close();
    await once(first.ws, 'close');
    assert.equal(aborts, 0);
    assert.equal(workspace.state.busy, true);
    const second = await open(token);
    const snapshot = await second.next();
    assert.equal(snapshot.type, 'snapshot');
    if (snapshot.type === 'snapshot') assert.equal(snapshot.state.busy, true);
    second.ws.send(JSON.stringify({ type: 'prompt', id: 'two', text: 'duplicate' }));
    reply = await second.next();
    while (reply.type !== 'error') reply = await second.next();
    assert.equal(prompts, 1);
    second.ws.send(JSON.stringify({ type: 'stop', id: 'three' }));
    reply = await second.next();
    while (reply.type !== 'ack') reply = await second.next();
    assert.equal(aborts, 1);
    assert.equal(workspace.state.busy, false);
    assert.equal((await fetch(base + '/healthz')).status, 200);
    assert.equal((await fetch(base + '/.env')).status, 404);
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close(); await workspace.close(); rmSync(dir, { recursive: true, force: true });
  }
});
