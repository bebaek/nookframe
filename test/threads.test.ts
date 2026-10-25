import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { ThreadStore } from '../server/threads.js';
import { persistSession } from './session-fixture.js';
import { Workspace, type Agent } from '../server/workspace.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-threads-'));
  const store = new ThreadStore(join(dir, 'sessions'), dir, join(dir, 'state'));
  let manager = SessionManager.create(dir, store.directory, { id: 'workspace' });
  manager.appendMessage({ role: 'user', content: 'Original conversation', timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Original answer' }],
    api: 'openai-completions', provider: 'test', model: 'first', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const original = manager.getSessionFile()!;
  let model = { provider: 'test', id: 'first' };
  const agent = {
    onEvent() { return () => {}; },
    async getState() { return { model, sessionFile: manager.getSessionFile() }; },
    async getEntries() { return { entries: manager.getEntries(), leafId: manager.getLeafId() }; },
    async getAvailableModels() { return ['first', 'second'].map(id => ({ provider: 'test', id })); },
    async setModel(provider: string, id: string) { model = { provider, id }; return model; },
    async switchSession(path: string) { manager = SessionManager.open(path, store.directory, dir); model = { provider: 'test', id: 'first' }; return { cancelled: false }; },
    async stop() {},
  } as unknown as Agent;
  const workspace = new Workspace(agent, join(dir, 'state'), undefined, store);
  return { dir, store, original, agent, workspace, async close() { await workspace.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('startup and repeated allocation leave no session files; Pi owns the first write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-drafts-'));
  try {
    const store = new ThreadStore(join(dir, 'sessions'), dir, join(dir, 'state'));
    const file = await store.initial();
    const id = store.id(file);
    for (let i = 0; i < 10; i++) assert.equal(existsSync(store.create()), false);
    assert.equal(existsSync(file), false);
    store.remember(file);
    assert.equal(existsSync(join(dir, 'state/active-thread.json')), false);
    assert.deepEqual(await store.list(), []);
    assert.throws(() => store.path(id));
    assert.throws(() => store.livePath(`../sessions/${id}`), /Invalid thread/);
    assert.throws(() => store.livePath('unknown.jsonl'));
    const reopened = new ThreadStore(store.directory, dir, join(dir, 'state'));
    assert.throws(() => reopened.livePath(id), 'draft identity is not restored from disk');
    const pi = SessionManager.open(file, store.directory, dir);
    pi.appendMessage({ role: 'user', content: 'Pending prompt', timestamp: Date.now() });
    assert.equal(existsSync(file), true, 'Pi persists the submitted prompt before an assistant reply');
    assert.equal(store.id(file), id, 'identity does not change when persisted');
    assert.equal((await store.list())[0].title, 'Pending prompt');
    store.remember(file);
    assert.equal(await reopened.initial(), file);
    rmSync(file);
    assert.throws(() => store.livePath(id), 'a missing saved file must not become a new draft');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('upgrade original session, unsaved drafts, separate histories, saved model and selected thread', async () => {
  const f = fixture();
  try {
    const originalBytes = readFileSync(f.original, 'utf8');
    assert.equal(await f.store.initial(), f.original);
    await f.workspace.initialize();
    assert.equal(f.workspace.state.messages.length, 2);
    assert.equal(f.workspace.state.threads[0].title, 'Original conversation');
    await f.workspace.setModel('test', 'second');
    await f.workspace.switchThread();
    const emptyId = f.workspace.state.threadId;
    assert.notEqual(emptyId, basename(f.original));
    assert.equal(f.workspace.state.messages.length, 0);
    assert.equal(f.workspace.state.model, 'test/second');
    assert.equal(f.workspace.state.threads.length, 1);
    assert.equal(existsSync(f.store.livePath(emptyId)), false);
    assert.throws(() => f.store.path(emptyId));
    assert.equal(await new ThreadStore(f.store.directory, f.dir, join(f.dir, 'state')).initial(), f.original);
    await f.workspace.switchThread(basename(f.original));
    assert.deepEqual(f.workspace.state.messages.map(m => m.text), ['Original conversation', 'Original answer']);
    assert.equal(f.workspace.state.model, 'test/second');
    assert.equal(readFileSync(f.original, 'utf8'), originalBytes, 'Legacy transcript not rewritten by the bridge');
    assert.throws(() => f.workspace.assertThread(emptyId), /active thread changed/);
    await assert.rejects(f.workspace.switchThread(emptyId), /unavailable/);
    assert.throws(() => f.store.livePath(emptyId));
  } finally { await f.close(); }
});

test('thread switching rejects busy/stale requests, traversal, symlinks, foreign cwd; serializes all operations', async () => {
  const f = fixture();
  try {
    await f.workspace.initialize();
    f.workspace.state.busy = true;
    await assert.rejects(f.workspace.switchThread(), /current operation/);
    f.workspace.state.busy = false;
    await assert.rejects(f.workspace.switchThread('../outside.jsonl'), /unavailable/);
    symlinkSync(f.original, join(f.store.directory, 'link.jsonl'));
    await assert.rejects(f.workspace.switchThread('link.jsonl'), /unavailable/);
    writeFileSync(join(f.store.directory, 'foreign.jsonl'), JSON.stringify({ type: 'session', id: 'foreign', cwd: '/other' }) + '\n');
    await assert.rejects(f.workspace.switchThread('foreign.jsonl'), /unavailable/);
    assert.equal((await f.store.list()).length, 1);
    assert.equal(f.workspace.state.available, true);
    let release!: () => void;
    const actual = f.agent.switchSession.bind(f.agent);
    f.agent.switchSession = async path => { await new Promise<void>(resolve => { release = resolve; }); return actual(path); };
    const pending = f.workspace.switchThread();
    await assert.rejects(f.workspace.prompt('racing prompt'), /already active/);
    await assert.rejects(f.workspace.setModel('test', 'second'), /current operation/);
    await assert.rejects(f.workspace.switchThread(), /current operation/);
    await assert.rejects(f.workspace.abort(), /switching/);
    release(); await pending;
    assert.equal(f.workspace.state.threadChanging, false);
  } finally { await f.close(); }
});

test('missing/corrupt selected thread and uncertain switch/save fail closed', async () => {
  for (const failure of ['rpc', 'disk']) {
    const f = fixture();
    try {
      await f.workspace.initialize();
      const preference = join(f.dir, 'state/active-thread.json');
      if (failure === 'rpc') f.agent.switchSession = async () => { throw new Error('Timeout'); };
      else { rmSync(preference); mkdirSync(preference); }
      const target = f.store.create();
      persistSession(target, f.dir);
      await assert.rejects(f.workspace.switchThread(basename(target)), /confirm and save/);
      assert.equal(f.workspace.state.available, false);
      assert.equal(f.workspace.state.threadChanging, false);
      await assert.rejects(f.workspace.prompt('unsafe'), /unavailable/);
      if (failure === 'rpc') {
        assert.equal(await f.store.initial(), f.original);
        rmSync(f.original);
        await assert.rejects(f.store.initial(), /Cannot restore selected thread/);
        writeFileSync(preference, 'invalid');
        await assert.rejects(f.store.initial(), /Cannot restore selected thread/);
      }
    } finally { await f.close(); }
  }
});
