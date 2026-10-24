import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcClient, SessionManager } from '@earendil-works/pi-coding-agent';
import { ThreadStore } from '../server/threads.js';
import { Workspace } from '../server/workspace.js';
import { clientContextCommand } from '../server/client-context-extension.js';

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
    env: { NOOKFRAME_PRESENCE_DIR: join(dir, 'presence'), NOOKFRAME_PRESENCE_THREAD_ID: 'workspace', PI_CODING_AGENT_DIR: join(dir, 'agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0' },
    args: ['--session-id', 'workspace', '--session-dir', join(dir, 'sessions'), '--no-extensions', '--extension', join(process.cwd(), 'dist/server/client-context-extension.js'), '--extension', join(process.cwd(), 'dist/server/agent-presence-extension.js'), '--extension', join(process.cwd(), 'test/fixtures/presence-probe.ts'), '--no-approve', '--skill', join(process.cwd(), 'skills/mail/SKILL.md'), '--skill', join(process.cwd(), 'skills/calendar/SKILL.md'), '--skill', join(process.cwd(), 'skills/jobs/SKILL.md')],
  };
  let client = new RpcClient(options);
  try {
    await client.start();
    assert.ok((await client.getCommands()).some(command => command.name === 'skill:mail'), 'Mail skill is discoverable with extensions/project resources disabled');
    assert.ok((await client.getCommands()).some(command => command.name === 'skill:calendar'), 'Calendar skill is discoverable');
    assert.ok((await client.getCommands()).some(command => command.name === 'skill:jobs'), 'Jobs skill is available to interactive agents');
    assert.ok((await client.getCommands()).some(command => command.name === clientContextCommand));
    assert.equal(await client.prompt('/presence-probe'), 'handled');
    assert.equal(JSON.parse(await readFile(join(cwd, 'presence-probe.json'), 'utf8')).registered, true, 'Presence tool loads through the real Pi extension loader');
    const beforeContext = await client.getEntries();
    assert.equal(await client.prompt(`/${clientContextCommand} ${JSON.stringify({ city: 'Private fixture city' })}`), 'handled');
    assert.deepEqual(await client.getEntries(), beforeContext, 'client metadata command is not persisted');
    assert.equal(await client.prompt(`/${clientContextCommand} null`), 'handled');
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
    const store = new ThreadStore(join(dir, 'sessions'), cwd, join(dir, 'state'));
    const workspace = new Workspace(client, join(dir, 'state'), undefined, store);
    try {
      await workspace.initialize();
      const originalId = workspace.state.threadId;
      await workspace.switchThread();
      const emptyId = workspace.state.threadId;
      assert.equal(workspace.state.messages.length, 0);
      await workspace.switchThread(originalId);
      assert.ok(workspace.state.messages.some(m => m.text.includes('hello from pi')));
      await workspace.switchThread(emptyId);
    } finally { await workspace.close(); }
    const selected = await store.initial();
    client = new RpcClient({ ...options, args: ['--session', selected, '--session-dir', store.directory, '--no-extensions', '--no-approve'] });
    await client.start();
    assert.equal((await client.getState()).sessionFile, selected);
    assert.equal((await client.getMessages()).length, 0, 'Empty selected thread survives a real RPC restart');
  } finally { await client.stop(); await rm(dir, { recursive: true, force: true }); }
});
