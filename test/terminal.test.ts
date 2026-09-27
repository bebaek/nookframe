import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { TerminalSession } from '../server/terminal.js';
import { Workspace, type Agent } from '../server/workspace.js';
import { createApp } from '../server/http.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) { if (check()) return; await delay(20); }
  assert.fail('Timed out waiting for terminal event');
}

test('terminal auth, shell persistence, resizing, exit/restart, no chat leakage', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-terminal-'));
  const terminal = new TerminalSession(dir, { PATH: process.env.PATH!, HOME: dir });
  let attaches = 0;
  const attach = terminal.attach.bind(terminal);
  terminal.attach = listener => { attaches++; return attach(listener); };
  const workspace = new Workspace({ onEvent() { return () => {}; }, async stop() {} } as unknown as Agent, dir);
  const token = 'a'.repeat(64), origin = 'http://localhost:3000';
  const app = createApp(workspace, { token, origin, webDir: resolve('dist/web'), terminal });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `ws://127.0.0.1:${address.port}`;
  const sockets: WebSocket[] = [];
  async function open(path = '/terminal', credential = token) {
    const ws = new WebSocket(base + path, { origin }); sockets.push(ws);
    const messages: any[] = [];
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'auth', token: credential }));
    return { ws, messages, output: () => messages.filter(m => m.type === 'terminal_data').map(m => m.data).join('') };
  }
  try {
    const forbidden = new WebSocket(base + '/terminal', { origin: 'https://evil.example' });
    const [error] = await once(forbidden, 'error'); assert.match(error.message, /403/);
    const wrong = await open('/terminal', 'wrong');
    const [code] = await once(wrong.ws, 'close'); assert.equal(code, 1008); assert.equal(attaches, 0);
    const chat = await open('/ws'); await until(() => chat.messages.some(m => m.type === 'snapshot'));
    const first = await open(); await until(() => first.messages.some(m => m.type === 'terminal_ready'));
    const secret = 'PRIVATE_TERMINAL_CANARY';
    first.ws.send(JSON.stringify({ type: 'terminal_input', data: `export KEEP=${secret}\r` }));
    await until(() => first.output().includes(secret));
    first.ws.close(); await once(first.ws, 'close');
    const second = await open(); await until(() => second.messages.some(m => m.type === 'terminal_ready'));
    assert.equal(second.output().includes(secret), false, 'No server replay of prior terminal output');
    second.ws.send(JSON.stringify({ type: 'terminal_resize', cols: 101, rows: 39 }));
    second.ws.send(JSON.stringify({ type: 'terminal_input', data: 'printf "saved=%s\\n" "$KEEP"; stty size\r' }));
    await until(() => second.output().includes(`saved=${secret}`) && second.output().includes('39 101'));
    second.ws.send(JSON.stringify({ type: 'terminal_resize', cols: -1, rows: 999999 }));
    await until(() => second.messages.some(m => m.type === 'error'));
    assert.equal(JSON.stringify(chat.messages).includes(secret), false);
    assert.equal(JSON.stringify(workspace.state).includes(secret), false);
    assert.ok(second.messages.every(m => m.type !== 'snapshot'));
    second.ws.send(JSON.stringify({ type: 'terminal_input', data: 'exit\r' }));
    await until(() => second.messages.some(m => m.type === 'terminal_exit'));
    second.messages.length = 0;
    second.ws.send(JSON.stringify({ type: 'terminal_start' }));
    await until(() => second.messages.some(m => m.type === 'terminal_ready'));
    second.ws.send(JSON.stringify({ type: 'terminal_input', data: 'test -z "$KEEP" && printf "fresh_%s\\n" shell\r' }));
    await until(() => second.output().includes('fresh_shell'));
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close(); await workspace.close(); rmSync(dir, { recursive: true, force: true });
  }
});
