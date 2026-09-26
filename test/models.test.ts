import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, type Agent } from '../server/workspace.js';
import { resolveModelSelection, saveModelSelection } from '../server/models.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-model-test-'));
  let current = { provider: 'test', id: 'first' };
  const agent = {
    onEvent() { return () => {}; },
    async getState() { return { model: current }; },
    async getEntries() { return { entries: [], leafId: null }; },
    async getAvailableModels() { return ['first', 'second'].map(id => ({ provider: 'test', id })); },
    async setModel(provider: string, id: string) { current = { provider, id }; return current; },
    async stop() {},
  } as unknown as Agent;
  return { dir, agent, clean() { rmSync(dir, { recursive: true, force: true }); } };
}

test('precedence: environment > saved web selection > pi default; incomplete env rejected', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'settings.json'), JSON.stringify({ defaultProvider: 'test', defaultModel: 'first' }));
    assert.deepEqual(resolveModelSelection(f.dir, f.dir, {}), { model: { provider: 'test', id: 'first' }, source: 'pi' });
    saveModelSelection(f.dir, { provider: 'test', id: 'second' });
    assert.equal(resolveModelSelection(f.dir, f.dir, {}).model?.id, 'second');
    assert.equal(resolveModelSelection(f.dir, f.dir, { AGENT_PROVIDER: 'test', AGENT_MODEL: 'first' }).source, 'environment');
    assert.throws(() => resolveModelSelection(f.dir, f.dir, { AGENT_MODEL: 'first' }), /requires both/);
    writeFileSync(join(f.dir, 'model.json'), 'invalid');
    assert.throws(() => resolveModelSelection(f.dir, f.dir, {}), /Cannot read/);
    assert.equal(resolveModelSelection(f.dir, f.dir, { AGENT_PROVIDER: 'test', AGENT_MODEL: 'first' }).model?.id, 'first');
  } finally { f.clean(); }
});

test('model choice persists across a fresh controller and restores exact model', async () => {
  const f = fixture();
  const first = new Workspace(f.agent, f.dir);
  let second: Workspace | undefined;
  try {
    await first.initialize();
    await first.setModel('test', 'second');
    assert.equal(first.state.model, 'test/second');
    assert.equal(first.state.modelSource, 'saved');
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'model.json'), 'utf8')), { provider: 'test', id: 'second' });
    await first.close();
    await f.agent.setModel('test', 'first');
    second = new Workspace(f.agent, f.dir, resolveModelSelection(f.dir, f.dir, {}));
    await second.initialize();
    assert.equal(second.state.model, 'test/second');
  } finally { await first.close(); await second?.close(); f.clean(); }
});

test('environment locks selector without overwriting saved web preference', async () => {
  const f = fixture();
  saveModelSelection(f.dir, { provider: 'test', id: 'second' });
  const workspace = new Workspace(f.agent, f.dir, { model: { provider: 'test', id: 'first' }, source: 'environment' });
  try {
    await workspace.initialize();
    await assert.rejects(workspace.setModel('test', 'second'), /locked/);
    assert.equal(resolveModelSelection(f.dir, f.dir, {}).model?.id, 'second');
  } finally { await workspace.close(); f.clean(); }
});

test('reject unavailable model and busy switches; serialize switches across tabs with prompts', async () => {
  const f = fixture();
  const workspace = new Workspace(f.agent, f.dir);
  try {
    await workspace.initialize();
    await assert.rejects(workspace.setModel('test', 'missing'), /catalog/);
    workspace.state.busy = true;
    await assert.rejects(workspace.setModel('test', 'second'), /current operation/);
    workspace.state.busy = false;
    let release!: () => void;
    const actual = f.agent.setModel.bind(f.agent);
    f.agent.setModel = async (provider, id) => {
      await new Promise<void>(resolve => { release = resolve; });
      return actual(provider, id);
    };
    const pending = workspace.setModel('test', 'second');
    await assert.rejects(workspace.prompt('race'), /already active/);
    await assert.rejects(workspace.setModel('test', 'first'), /current operation/);
    release(); await pending;
    assert.equal(workspace.state.modelChanging, false);
    assert.equal(workspace.state.model, 'test/second');
  } finally { await workspace.close(); f.clean(); }
});

test('unavailable saved model fails startup instead of silently falling back', async () => {
  const f = fixture();
  const workspace = new Workspace(f.agent, f.dir, { model: { provider: 'test', id: 'missing' }, source: 'saved' });
  try { await assert.rejects(workspace.initialize(), /Selected model is unavailable/); }
  finally { await workspace.close(); f.clean(); }
});

test('RPC failure or persistence failure fails closed and preserves last preference', async () => {
  for (const failure of ['rpc', 'disk']) {
    const f = fixture();
    const workspace = new Workspace(f.agent, f.dir);
    try {
      await workspace.initialize();
      if (failure === 'rpc') {
        saveModelSelection(f.dir, { provider: 'test', id: 'first' });
        f.agent.setModel = async () => { throw new Error('timeout'); };
      } else mkdirSync(join(f.dir, 'model.json'));
      await assert.rejects(workspace.setModel('test', 'second'), /confirm and save/);
      assert.equal(workspace.state.available, false);
      assert.equal(workspace.state.modelChanging, false);
      await assert.rejects(workspace.prompt('unsafe'), /unavailable/);
      if (failure === 'rpc') assert.equal(resolveModelSelection(f.dir, f.dir, {}).model?.id, 'first');
    } finally { await workspace.close(); f.clean(); }
  }
});
