import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcClient, SessionManager } from '@earendil-works/pi-coding-agent';

test('real pi RPC writes a file and restores persisted session after replacement (no LLM)', { timeout: 45000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-workspace-rpc-'));
  const cwd = join(dir, 'workspace');
  await mkdir(cwd);
  // Pi defers saving a brand-new session until its first assistant message.
  // Seed a synthetic completed turn to exercise persistence without an API call.
  const manager = SessionManager.create(cwd, join(dir, 'sessions'), { id: 'workspace' });
  manager.appendMessage({
    role: 'assistant', content: [{ type: 'text', text: 'Offline test fixture' }],
    api: 'openai-completions', provider: 'test', model: 'test', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const options = {
    cliPath: join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'))), 'cli.js'),
    cwd,
    env: { PI_CODING_AGENT_DIR: join(dir, 'agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0' },
    args: ['--session-id', 'workspace', '--session-dir', join(dir, 'sessions'), '--no-extensions', '--no-approve'],
  };
  let client = new RpcClient(options);
  try {
    await client.start();
    const state = await client.getState();
    assert.equal(state.sessionId, 'workspace');
    const result = await client.bash("printf 'hello from pi\\n' > hello.txt; printf 'hello from pi\\n'");
    assert.equal(result.exitCode, 0);
    assert.equal(await readFile(join(cwd, 'hello.txt'), 'utf8'), 'hello from pi\n');
    await client.stop();
    client = new RpcClient(options);
    await client.start();
    const restored = await client.getMessages();
    assert.ok(restored.some(m => m.role === 'bashExecution' && m.output.includes('hello from pi')));
  } finally { await client.stop(); await rm(dir, { recursive: true, force: true }); }
});
