import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server/http.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Workspace, type Agent } from '../server/workspace.js';
import { ModelOperations, newThreadModel, selectThreadModel } from '../server/model-operations.js';
import { resolveModelSelection, saveModelSelection } from '../server/models.js';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'model-operations-'));
  let current = { provider: 'test', id: 'first' };
  let event: (value: unknown) => void = () => {};
  let switches = 0;
  const agent = {
    onEvent(fn: typeof event) { event = fn; return () => {}; },
    async getState() { return { model: current }; },
    async getEntries() { return { entries: [], leafId: null }; },
    async getAvailableModels() { return ['first', 'second'].map(id => ({ provider: 'test', id })); },
    async setModel(provider: string, id: string) { switches++; current = { provider, id }; return current; },
    async prompt() {}, async clearQueue() {}, async abort() { event({ type: 'agent_settled' }); }, async stop() {},
  } as unknown as Agent;
  const target = new Workspace(agent, join(dir, 'thread'));
  await target.initialize();
  let loaded = true;
  const env: NodeJS.ProcessEnv = {};
  const lookup = (id: string) => { if (id !== 'thread' || !loaded) throw new Error('Unavailable'); return target; };
  const ops = new ModelOperations(dir, dir, env, lookup);
  const propose = (scope: 'thread' | 'new-threads' = 'thread', deferUntilSettled = false) => ops.propose({ scope, threadId: 'thread', model: { provider: 'test', id: 'second' }, deferUntilSettled }, 'token');
  return { dir, target, agent, env, ops, propose, lookup, switches: () => switches, unload: () => { loaded = false; }, event: (value: unknown) => event(value),
    async clean() { ops.close(); await target.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('thread plans preview exact scope, verify activation, persist and deduplicate apply', async () => {
  const f = await fixture();
  try {
    const plan = f.propose();
    assert.equal(plan.before, 'test/first');
    assert.equal(plan.scope, 'thread');
    assert.equal(f.switches(), 0);
    assert.equal((await f.ops.apply(plan.id)).status, 'applied');
    assert.equal((await f.ops.apply(plan.id)).status, 'applied');
    assert.equal(f.switches(), 1);
    assert.equal(f.target.state.model, 'test/second');
    assert.equal(resolveModelSelection(join(f.dir, 'thread'), f.dir, {}).model?.id, 'second');
    const audit = JSON.parse(readFileSync(join(f.dir, 'model-operations', `${plan.id}.json`), 'utf8'));
    assert.equal(audit.status, 'applied');
    assert.equal(audit.requester, 'token');
    plan.after.id = 'tampered';
    assert.equal(f.ops.get(plan.id).after.id, 'second');
  } finally { await f.clean(); }
});

test('new-thread defaults do not mutate legacy selection or any existing agent', async () => {
  const f = await fixture();
  try {
    saveModelSelection(f.dir, { provider: 'test', id: 'first' });
    const plan = f.propose('new-threads');
    assert.equal((await f.ops.apply(plan.id)).status, 'applied');
    assert.equal(f.switches(), 0);
    assert.equal(f.target.state.model, 'test/first');
    assert.equal(newThreadModel(f.dir, f.dir, {}).model?.id, 'second');
    const newDir = join(f.dir, 'new-thread');
    assert.equal(selectThreadModel(f.dir, newDir, f.dir, {}, true).model?.id, 'second');
    const oldDir = join(f.dir, 'old-unpinned');
    assert.equal(selectThreadModel(f.dir, oldDir, f.dir, {}).model?.id, 'first');
    const next = f.ops.propose({ scope: 'new-threads', threadId: 'thread', model: { provider: 'test', id: 'first' } }, 'token');
    assert.equal((await f.ops.apply(next.id)).status, 'applied');
    assert.equal(selectThreadModel(f.dir, newDir, f.dir, {}).model?.id, 'second');
    assert.equal(selectThreadModel(f.dir, oldDir, f.dir, {}).model?.id, 'first');
    assert.equal(resolveModelSelection(f.dir, f.dir, {}).model?.id, 'first');
    assert.equal(newThreadModel(f.dir, f.dir, { AGENT_PROVIDER: 'test', AGENT_MODEL: 'first' }).source, 'environment');
  } finally { await f.clean(); }
});

test('stale thread/default plans, environment locks and invalid models fail closed', async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.ops.propose({ scope: 'thread', threadId: 'thread', model: { provider: 'test', id: 'missing' } }, 'token'), /catalog/);
    const old = f.propose();
    await f.target.setModel('test', 'second');
    await f.target.setModel('test', 'first'); // ABA is still stale.
    assert.equal((await f.ops.apply(old.id)).status, 'rejected');
    const one = f.propose('new-threads'), two = f.propose('new-threads');
    assert.equal((await f.ops.apply(one.id)).status, 'applied');
    assert.equal((await f.ops.apply(two.id)).status, 'rejected');
    f.env.AGENT_PROVIDER = 'test'; f.env.AGENT_MODEL = 'first';
    assert.throws(() => f.propose(), /locked/);
  } finally { await f.clean(); }
});

test('busy changes require explicit deferral and execute only after settled, not agent_end', async () => {
  const f = await fixture();
  try {
    await f.target.prompt('fixture');
    assert.equal((await f.ops.apply(f.propose().id)).status, 'rejected');
    const pending = f.propose('thread', true);
    assert.equal((await f.ops.apply(pending.id)).status, 'pending');
    assert.equal((await f.ops.apply(pending.id)).status, 'pending');
    f.event({ type: 'agent_end' });
    await setImmediate();
    assert.equal(f.switches(), 0);
    f.event({ type: 'agent_settled' });
    await assert.rejects(f.target.prompt('race'), /already active/);
    await setImmediate();
    assert.equal(f.ops.get(pending.id).status, 'applied');
    assert.equal(f.switches(), 1);
  } finally { await f.clean(); }
});

test('deferred changes settle after confirmed abort; shutdown never replays pending plans', async () => {
  const f = await fixture();
  try {
    await f.target.prompt('fixture');
    const pending = f.propose('thread', true);
    await f.ops.apply(pending.id);
    await f.target.abort();
    await setImmediate();
    assert.equal(f.ops.get(pending.id).status, 'applied');
    await f.target.prompt('fixture');
    const second = f.propose('thread', true);
    await f.ops.apply(second.id);
    f.ops.close();
    assert.throws(() => f.propose(), /shutting down/);
    f.event({ type: 'agent_settled' });
    await setImmediate();
    assert.equal(f.ops.get(second.id).status, 'rejected');
    const replacement = new ModelOperations(f.dir, f.dir, {}, f.lookup);
    await assert.rejects(replacement.apply(second.id), /previous server/);
    replacement.close();
    assert.equal(f.switches(), 1);
  } finally { await f.clean(); }
});

test('unloaded target, audit failure and RPC ambiguity do not silently retry', async () => {
  const f = await fixture();
  try {
    const plan = f.propose();
    f.agent.setModel = async () => { throw new Error('private provider error'); };
    assert.equal((await f.ops.apply(plan.id)).status, 'uncertain');
    assert.equal((await f.ops.apply(plan.id)).status, 'uncertain');
    assert.equal(f.target.state.available, false);
  } finally { await f.clean(); }
  const g = await fixture();
  try {
    const plan = g.propose(); g.unload();
    assert.equal((await g.ops.apply(plan.id)).status, 'rejected');
    assert.equal(g.switches(), 0);
  } finally { await g.clean(); }
  const h = await fixture();
  try {
    const plan = h.propose();
    const path = join(h.dir, 'model-operations', `${plan.id}.json`);
    rmSync(path); mkdirSync(path);
    assert.equal((await h.ops.apply(plan.id)).status, 'uncertain');
    assert.equal(h.switches(), 0);
  } finally { await h.clean(); }
});

test('HTTP writes enforce cookie CSRF and bound bodies; CLI previews and applies via existing token', async () => {
  const f = await fixture();
  const token = 'fixture-token-'.repeat(5);
  const tokenFile = join(f.dir, 'token');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const origin = 'http://localhost:3000';
  const app = createApp(f.target, { token, origin, webDir: f.dir, modelOperations: f.ops });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const body = JSON.stringify({ scope: 'thread', threadId: 'thread', model: { provider: 'test', id: 'second' } });
  const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, ['dist/server/operations-cli.js', ...args], {
    env: { ...process.env, ACCESS_TOKEN_FILE: tokenFile, NOOKFRAME_API_URL: base },
  })).stdout);
  try {
    const path = `${base}/api/operations/models/plans`;
    assert.equal((await fetch(path, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })).status, 401);
    assert.equal((await fetch(path, { method: 'POST', body, headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    const login = await fetch(`${base}/auth/login`, { method: 'POST', body: JSON.stringify({ token }), headers: { Origin: origin, 'Content-Type': 'application/json' } });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const cookieHeaders = { Cookie: cookie, 'Content-Type': 'application/json' };
    assert.equal((await fetch(path, { method: 'POST', body, headers: cookieHeaders })).status, 403);
    assert.equal((await fetch(path, { method: 'POST', body, headers: { ...cookieHeaders, Origin: origin } })).status, 200);
    assert.equal((await fetch(path, { method: 'POST', body: 'x'.repeat(5000), headers })).status, 409);
    assert.equal((await fetch(path, { method: 'POST', body: '{', headers })).status, 409);
    assert.equal((await fetch(path, { method: 'POST', body, headers: { Authorization: headers.Authorization } })).status, 415);
    const models = await cli('models', 'thread');
    assert.equal(models.current, 'test/first');
    const plan = await cli('model-plan', 'thread', 'thread', 'test', 'second');
    assert.equal(plan.status, 'proposed');
    assert.equal((await cli('model-apply', plan.id)).status, 'applied');
    assert.equal((await cli('model-result', plan.id)).status, 'applied');
    assert.equal(f.switches(), 1);
    const cancelled = await cli('model-plan', 'thread', 'thread', 'test', 'first');
    assert.equal((await cli('model-cancel', cancelled.id)).status, 'rejected');
    assert.equal((await cli('model-apply', cancelled.id)).status, 'rejected');
    assert.equal(f.switches(), 1);
    assert.equal((await fetch(`${path}/${plan.id}/apply`, { method: 'POST', body: '{}', headers: cookieHeaders })).status, 403);
    const invalid = await fetch(`${base}/api/operations/models?threadId=unknown`, { headers });
    assert.equal(invalid.status, 409);
    assert.doesNotMatch(await invalid.text(), new RegExp(token));
  } finally { await app.close(); await f.clean(); }
});
