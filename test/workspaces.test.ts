import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { ThreadStore } from '../server/threads.js';
import { Workspace, type Agent } from '../server/workspace.js';
import { Workspaces } from '../server/workspaces.js';
import { createApp } from '../server/http.js';
import { resolveModelSelection } from '../server/models.js';
import type { ServerMessage } from '../shared/protocol.js';

function fixture(max = 4, idleMs = 300_000) {
  const dir = mkdtempSync(join(tmpdir(), 'nookframe-workspaces-'));
  const store = new ThreadStore(join(dir, 'sessions'), dir, join(dir, 'state'));
  const first = store.id(store.create());
  const agents = new Map<string, { emit: (event: unknown) => void; prompts: number; stops: number; stateDir: string }>();
  const factory = (file: string, stateDir: string) => {
    let emit: (event: unknown) => void = () => {};
    const record = { emit: (event: unknown) => emit(event), prompts: 0, stops: 0, stateDir };
    let model = { provider: 'test', id: 'first' };
    const agent = {
      onEvent(fn: typeof emit) { emit = fn; return () => {}; },
      async getState() { return { sessionFile: file, model }; },
      async getAvailableModels() { return ['first', 'second'].map(id => ({ provider: 'test', id })); },
      async getEntries() { return { entries: [], leafId: null }; },
      async prompt() { record.prompts++; },
      async setModel(provider: string, id: string) { model = { provider, id }; },
      async clearQueue() {},
      async abort() { emit({ type: 'agent_settled' }); },
      async stop() { record.stops++; },
    } as unknown as Agent;
    agents.set(store.id(file), record);
    const workspace = new Workspace(agent, stateDir, resolveModelSelection(stateDir, dir, {}), store, true);
    return { workspace, async start() {} };
  };
  const pool = new Workspaces(store, first, factory, max, idleMs);
  return { dir, store, first, agents, pool, factory, async close() { await pool.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('one agent per thread; parallel runs, independent models/markers, same-thread serialization', async () => {
  const f = fixture();
  try {
    await f.pool.initialize();
    const [a, same] = await Promise.all([f.pool.connect(), f.pool.connect()]);
    assert.equal(a.workspace, same.workspace);
    const b = await f.pool.connect(undefined, true);
    await a.workspace.setModel('test', 'second');
    assert.equal(b.workspace.state.model, 'test/first');
    await Promise.all([a.workspace.prompt('a'), b.workspace.prompt('b')]);
    await assert.rejects(same.workspace.prompt('duplicate'), /already active/);
    assert.equal(f.pool.snapshot(b.workspace).threads.filter(t => t.busy).length, 2);
    const ar = f.agents.get(f.first)!;
    const br = f.agents.get(b.workspace.state.threadId)!;
    assert.notEqual(ar.stateDir, br.stateDir);
    assert.ok(existsSync(join(ar.stateDir, 'run-active')));
    await b.workspace.abort();
    assert.equal(a.workspace.state.busy, true);
    assert.ok(existsSync(join(ar.stateDir, 'run-active')));
    assert.equal(existsSync(join(br.stateDir, 'run-active')), false);
    a.release(); same.release(); b.release();
    const reconnected = await f.pool.connect(f.first);
    assert.equal(reconnected.workspace.state.busy, true);
    assert.equal(ar.prompts, 1);
    reconnected.release();
    assert.equal(existsSync(join(f.dir, 'state/active-thread.json')), false, 'selection is never persisted globally');
  } finally { await f.close(); }
});

test('session ownership blocks another server until stopped; invalid paths and startup failures release safely', async () => {
  const f = fixture();
  const other = new Workspaces(f.store, f.first, f.factory);
  try {
    const lease = await f.pool.connect();
    await lease.workspace.setModel('test', 'second');
    await assert.rejects(other.connect(), /another server/);
    await assert.rejects(f.pool.connect('../outside.jsonl'), /Invalid thread/);
    lease.release();
    await f.pool.close();
    const takeover = await other.connect();
    assert.notEqual(takeover.workspace, lease.workspace);
    assert.equal(takeover.workspace.state.model, 'test/second', 'thread preference survives ownership transfer');
    takeover.release();
    const failedId = f.store.id(f.store.create());
    const broken = new Workspaces(f.store, failedId, () => { throw new Error('startup failed'); });
    try { await assert.rejects(broken.connect(), /startup failed/); }
    finally { await broken.close(); }
    const recovered = await other.connect(failedId); recovered.release();
  } finally { await other.close(); await f.close(); }
});

test('explicit release transfers ownership immediately and preserves saved preferences and catalog', async () => {
  const f = fixture();
  const other = new Workspaces(f.store, f.first, f.factory);
  try {
    await f.pool.initialize();
    const lease = await f.pool.connect();
    await lease.workspace.setModel('test', 'second');
    await lease.releaseThread();
    assert.ok(existsSync(f.store.path(f.first)));
    assert.ok(f.pool.snapshot().threads.some(t => t.id === f.first));
    const takeover = await other.connect();
    assert.equal(takeover.workspace.state.model, 'test/second');
    await assert.rejects(lease.releaseThread(), /selected thread changed/);
    lease.release(); // Idempotent after explicit release.
    takeover.release();
  } finally { await other.close(); await f.close(); }
});

test('release rejects other viewers, busy/background/uncertain agents and detached leases', async () => {
  const f = fixture();
  try {
    const a = await f.pool.connect(), b = await f.pool.connect();
    await assert.rejects(a.releaseThread(), /other tabs/);
    assert.equal(a.workspace.state.available, true);
    b.release();
    await assert.rejects(b.releaseThread(), /selected thread changed/);
    await a.workspace.prompt('working');
    await assert.rejects(a.releaseThread(), /finishes running/);
    await a.workspace.abort();
    a.workspace.background('job', async () => {});
    await assert.rejects(a.releaseThread(), /finishes running/);
    a.workspace.state.available = false;
    await assert.rejects(a.releaseThread(), /uncertain/);
    a.release();
  } finally { await f.close(); }
});

test('release holds lock and blocks prompts until shutdown completes; failures retain ownership', async () => {
  const f = fixture();
  const other = new Workspaces(f.store, f.first, f.factory);
  let finish!: () => void;
  try {
    const a = await f.pool.connect();
    const close = a.workspace.close.bind(a.workspace);
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let entered!: () => void;
    const stopping = new Promise<void>(resolve => { entered = resolve; });
    a.workspace.close = async () => { const stopped = close(); entered(); await gate; await stopped; throw new Error('exit uncertain'); };
    const releasing = a.releaseThread();
    const rejected = assert.rejects(releasing, /exit uncertain/);
    await stopping;
    await assert.rejects(a.workspace.prompt('race'), /unavailable/i);
    await assert.rejects(other.connect(), /another server/);
    finish(); await rejected;
    await assert.rejects(other.connect(), /another server/);
    a.workspace.close = close;
    a.release();
  } finally { finish?.(); await other.close(); await f.close(); }
});

test('release serializes with a new viewer and tolerates requester disconnect during shutdown', async () => {
  const f = fixture();
  let finish!: () => void;
  try {
    const a = await f.pool.connect();
    const newViewer = f.pool.connect();
    await assert.rejects(a.releaseThread(), /other tabs/);
    (await newViewer).release();
    const close = a.workspace.close.bind(a.workspace);
    let entered!: () => void;
    const stopping = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    a.workspace.close = async () => { const stopped = close(); entered(); await gate; await stopped; };
    const releasing = a.releaseThread();
    await stopping;
    a.release(); // Socket disconnect while explicit shutdown is in flight.
    const reopening = f.pool.connect();
    finish(); await releasing;
    const b = await reopening;
    assert.notEqual(a.workspace, b.workspace);
    assert.equal(b.workspace.state.available, true);
    await b.releaseThread(); // No dangling/double-decremented references.
  } finally { finish?.(); await f.close(); }
});

test('deletion rejects busy/foreign-owned threads, stops idle writers and persists across restart', async () => {
  const f = fixture();
  const other = new Workspaces(f.store, f.first, f.factory);
  try {
    await f.pool.initialize();
    const a = await f.pool.connect();
    const file = f.store.path(f.first);
    f.store.remember(file);
    await assert.rejects(other.deleteThread(f.first), /another server/);
    await a.workspace.prompt('running');
    await assert.rejects(f.pool.deleteThread(f.first), /finishes running/);
    await a.workspace.abort();
    await a.workspace.setModel('test', 'second');
    const stateDir = f.agents.get(f.first)!.stateDir;
    await f.pool.deleteThread(f.first);
    assert.equal(f.agents.get(f.first)!.stops, 1);
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(stateDir), false);
    assert.equal(f.pool.snapshot().threads.length, 0);
    await assert.rejects(a.workspace.prompt('stale'), /unavailable/);
    await assert.rejects(f.pool.connect(f.first));
    await assert.rejects(f.pool.deleteThread('../outside.jsonl'), /Invalid thread/);
    a.release();
    const fresh = await f.store.initial();
    assert.notEqual(fresh, file, 'legacy preference does not prevent startup');
    const b = await f.pool.connect(undefined, true);
    const second = b.workspace.state.threadId;
    b.release();
    await f.pool.close();
    await other.initialize();
    await other.deleteThread(second); // Nonresident session uses the same lock.
    assert.equal((await f.store.list()).some(t => t.id === second), false);
  } finally { await other.close(); await f.close(); }
});

test('failed deletion retains the session and allows reopening without a second writer', async t => {
  const f = fixture();
  try {
    await f.pool.initialize();
    const a = await f.pool.connect();
    const file = f.store.path(f.first);
    const deletion = t.mock.method(f.store, 'delete', () => { throw new Error('unlink failed'); });
    await assert.rejects(f.pool.deleteThread(f.first), /unlink failed/);
    deletion.mock.restore();
    assert.ok(existsSync(file));
    assert.equal(f.pool.snapshot().threads.length, 1);
    assert.equal(f.agents.get(f.first)!.stops, 1);
    await assert.rejects(a.workspace.prompt('stale'), /unavailable/);
    const reopened = await f.pool.connect(f.first);
    assert.notEqual(reopened.workspace, a.workspace);
    a.release(); reopened.release();
  } finally { await f.close(); }
});

test('deletion serializes reconnects and blocks prompts while stopping the writer', async () => {
  const f = fixture();
  let finishStop!: () => void;
  const stopped = new Promise<void>(resolve => { finishStop = resolve; });
  try {
    const a = await f.pool.connect();
    const close = a.workspace.close.bind(a.workspace);
    let stopping!: () => void;
    const started = new Promise<void>(resolve => { stopping = resolve; });
    a.workspace.close = async () => { await close(); stopping(); await stopped; };
    const deletion = f.pool.deleteThread(f.first);
    await started;
    await assert.rejects(a.workspace.prompt('race'), /unavailable/);
    const reconnect = assert.rejects(f.pool.connect(f.first));
    finishStop();
    await deletion; await reconnect;
    assert.equal((await f.store.list()).length, 0);
    a.release();
  } finally { finishStop(); await f.close(); }
});

test('capacity never evicts subscribed or busy agents; disconnected idle agents are reaped', async () => {
  const f = fixture(1, 25);
  try {
    const a = await f.pool.connect();
    await assert.rejects(f.pool.connect(undefined, true), /slots are in use/);
    await a.workspace.prompt('keep running'); a.release();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(f.agents.get(f.first)!.stops, 0);
    await assert.rejects(f.pool.connect(undefined, true), /slots are in use/);
    await a.workspace.abort();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(f.agents.get(f.first)!.stops, 1);
    const b = await f.pool.connect(undefined, true); b.release();
  } finally { await f.close(); }
});

test('two websocket clients select independently; background runs, reconnect, catalog and stale request isolation', { timeout: 15_000 }, async () => {
  const f = fixture(); await f.pool.initialize();
  const origin = 'http://localhost:3000', token = 't'.repeat(64);
  const app = createApp(f.pool, { origin, token, webDir: resolve('dist/web') });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const sockets: WebSocket[] = [];
  async function open(threadId = f.first) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin }); sockets.push(ws);
    const messages: ServerMessage[] = [];
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
    async function wait(predicate: (m: ServerMessage) => boolean) {
      for (let i = 0; i < 500; i++) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0];
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Message timeout');
    }
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'auth', token, threadId }));
    await wait(m => m.type === 'snapshot');
    return { ws, messages, wait, send(command: object) { ws.send(JSON.stringify(command)); } };
  }
  try {
    const a = await open(), b = await open();
    a.send({ type: 'prompt', threadId: f.first, id: 'run-a', text: 'first' });
    await a.wait(m => m.type === 'ack' && m.id === 'run-a');
    b.send({ type: 'new_thread', threadId: f.first, id: 'new' });
    const reply = await b.wait(m => m.type === 'snapshot' && m.state.threadId !== f.first);
    assert.equal(reply.type, 'snapshot'); if (reply.type !== 'snapshot') return;
    const second = reply.state.threadId;
    await b.wait(m => m.type === 'ack' && m.id === 'new');
    b.send({ type: 'prompt', threadId: second, id: 'run-b', text: 'second' });
    await b.wait(m => m.type === 'ack' && m.id === 'run-b');
    await a.wait(m => m.type === 'threads' || (m.type === 'snapshot' && m.state.threads.length === 2));
    assert.ok(a.messages.every(m => m.type !== 'snapshot' || m.state.threadId === f.first));
    b.send({ type: 'stop', threadId: f.first, id: 'stale' });
    await b.wait(m => m.type === 'error' && m.id === 'stale');
    assert.equal(f.agents.get(f.first)!.prompts, 1);
    a.ws.close(); await once(a.ws, 'close');
    const resumed = await open();
    resumed.send({ type: 'stop', threadId: f.first, id: 'stop-a' });
    await resumed.wait(m => m.type === 'ack' && m.id === 'stop-a');
    const lease = await f.pool.connect(second);
    assert.equal(lease.workspace.state.busy, true); lease.release();
    b.send({ type: 'switch_thread', threadId: second, targetId: f.first, id: 'switch' });
    await b.wait(m => m.type === 'snapshot' && m.state.threadId === f.first);
    await b.wait(m => m.type === 'ack' && m.id === 'switch');
    b.send({ type: 'release_thread', threadId: second, id: 'stale-release' });
    await b.wait(m => m.type === 'error' && m.id === 'stale-release');
    b.send({ type: 'release_thread', threadId: f.first, id: 'shared-release' });
    await b.wait(m => m.type === 'error' && m.id === 'shared-release');
    resumed.ws.close(); await once(resumed.ws, 'close');
    b.send({ type: 'release_thread', threadId: f.first, id: 'release' });
    await b.wait(m => m.type === 'ack' && m.id === 'release');
    await b.wait(m => m.type === 'snapshot' && m.selected === true && m.state.threadId === '');
    b.send({ type: 'prompt', threadId: f.first, id: 'released-prompt', text: 'stale' });
    await b.wait(m => m.type === 'error' && m.id === 'released-prompt');
    b.send({ type: 'release_thread', threadId: '', id: 'no-selection-release' });
    await b.wait(m => m.type === 'error' && m.id === 'no-selection-release');
    const chooser = await open('');
    assert.equal(f.agents.get(f.first)!.stops, 1, 'empty selection must not reopen the default');
    chooser.ws.close(); await once(chooser.ws, 'close');
    b.send({ type: 'switch_thread', threadId: '', targetId: f.first, id: 'reopen' });
    await b.wait(m => m.type === 'ack' && m.id === 'reopen');
    const viewer = await open();
    b.send({ type: 'delete_thread', threadId: f.first, targetId: second, id: 'wrong-delete' });
    await b.wait(m => m.type === 'error' && m.id === 'wrong-delete');
    b.send({ type: 'delete_thread', threadId: f.first, targetId: f.first, id: 'delete' });
    await b.wait(m => m.type === 'ack' && m.id === 'delete');
    await viewer.wait(m => m.type === 'snapshot' && m.selected === true && m.state.threadId === '');
    assert.equal(f.pool.snapshot().threads.some(t => t.id === f.first), false);
    viewer.send({ type: 'prompt', threadId: f.first, id: 'deleted-prompt', text: 'stale' });
    await viewer.wait(m => m.type === 'error' && m.id === 'deleted-prompt');
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close(); await f.close();
  }
});
