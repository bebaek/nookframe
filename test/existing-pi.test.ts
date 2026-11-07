import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { ThreadStore } from '../server/threads.js';
import { fileURLToPath } from 'node:url';
import { ConfirmedRpcClient } from '../server/jobs/agent.js';
import { existingPiRuntime } from '../server/existing-pi.js';

function fixture() { return mkdtempSync(join(tmpdir(), 'existing-pi-')); }
function session(cwd: string, dir: string) {
  const manager = SessionManager.create(cwd, dir);
  manager.appendMessage({ role: 'user', content: 'Native conversation', timestamp: Date.now() });
  return manager.getSessionFile()!;
}

test('native catalog resumes original files across projects, preserves cwd and bytes, rejects unknown paths', async () => {
  const root = fixture();
  try {
    const sessions = join(root, 'sessions');
    const cwd = join(root, 'project-one');
    const other = join(root, 'project-two');
    mkdirSync(cwd); mkdirSync(other);
    const a = session(cwd, join(sessions, '--one--'));
    const b = session(other, join(sessions, '--two--'));
    const original = readFileSync(a, 'utf8');
    const store = new ThreadStore(join(root, 'ui'), cwd, join(root, 'state'), { root: sessions, flat: false });
    const catalog = await store.list();
    assert.equal(catalog.length, 2);
    assert.equal(store.path(store.id(a)), a);
    assert.equal(store.workingDirectory(b), other);
    assert.equal(store.sessionDirectory(b), dirname(b));
    assert.throws(() => store.livePath('../other.jsonl'));
    assert.throws(() => store.livePath('unknown.jsonl'));
    store.remember(a);
    const reopened = new ThreadStore(join(root, 'ui'), cwd, join(root, 'state'), { root: sessions, flat: false });
    assert.equal(await reopened.initial(), a);
    assert.equal(readFileSync(a, 'utf8'), original);
    symlinkSync(a, join(sessions, '--two--', 'linked.jsonl'));
    symlinkSync(join(sessions, '--one--'), join(sessions, '--linked--'));
    assert.equal((await store.list()).length, 2);
    rmSync(b);
    assert.throws(() => store.livePath(store.id(b)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native creation uses normal cwd grouping and flat overrides, without persisting empty chats', async () => {
  const root = fixture();
  try {
    for (const flat of [true, false]) {
      const sessions = join(root, flat ? 'flat' : 'grouped');
      const store = new ThreadStore(join(root, 'ui'), root, join(root, 'state'), { root: sessions, flat });
      const file = await store.initial();
      assert.equal(existsSync(file), false);
      assert.equal(store.livePath(store.id(file)), file);
      assert.equal(dirname(file), flat ? sessions : join(sessions, `--${root.slice(1).replace(/\//g, '-')}--`));
      const manager = SessionManager.open(file, dirname(file), root);
      manager.appendMessage({ role: 'user', content: 'Created in browser', timestamp: Date.now() });
      assert.equal((await SessionManager.list(root, dirname(file))).length, 1);
      assert.equal((await store.list()).length, 1);
      assert.equal(store.path(store.id(file)), file);
      rmSync(file);
      assert.throws(() => store.livePath(store.id(file)));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('external CLI resumes an original session and uses its project cwd over RPC without a provider call', { timeout: 30000 }, async () => {
  const root = fixture();
  let client: ConfirmedRpcClient | undefined;
  try {
    const cwd = join(root, 'project'); mkdirSync(cwd);
    const agentDir = join(root, 'agent');
    const sessionRoot = join(agentDir, 'sessions');
    const file = session(cwd, join(sessionRoot, '--project--'));
    const store = new ThreadStore(join(root, 'ui'), root, join(root, 'state'), { root: sessionRoot, flat: false });
    await store.list();
    const cli = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'))), 'cli.js');
    const runtime = existingPiRuntime({ NOOKFRAME_PI_BIN: cli, PI_CODING_AGENT_DIR: agentDir, WORKSPACE_DIR: root }, root);
    const options = {
      cliPath: runtime.cliPath, cwd: store.workingDirectory(file),
      env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0' },
      args: ['--session', file, '--session-dir', store.sessionDirectory(file), '--no-extensions', '--no-approve'],
    };
    client = new ConfirmedRpcClient(options);
    await client.start();
    assert.equal((await client.getState()).sessionFile, file);
    assert.ok((await client.getMessages()).some(message => message.role === 'user'));
    const result = await client.bash('pwd');
    assert.equal(result.output.trim(), cwd);
    await client.stop();
    client = new ConfirmedRpcClient(options);
    await client.start();
    assert.ok((await client.getMessages()).some(message => message.role === 'bashExecution'));
  } finally { await client?.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('external runtime resolves installed CLI/profile, fails closed on incompatible versions and settings', () => {
  const root = fixture();
  try {
    const pkg = join(root, 'package');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    const cli = join(pkg, 'dist', 'cli.js');
    writeFileSync(cli, '#!/usr/bin/env node\n'); chmodSync(cli, 0o700);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.5.0', bin: { pi: 'dist/cli.js' } }));
    const bin = join(root, 'bin'); mkdirSync(bin); symlinkSync(cli, join(bin, 'pi'));
    const env = { PATH: bin, WORKSPACE_DIR: root };
    const runtime = existingPiRuntime(env, root);
    assert.equal(runtime.cliPath, cli);
    assert.equal(runtime.agentDir, join(root, '.pi/agent'));
    assert.equal(runtime.flatSessions, false);
    assert.equal(existingPiRuntime({ ...env, PI_CODING_AGENT_DIR: '~/profile', PI_CODING_AGENT_SESSION_DIR: join(root, 'custom') }, root).flatSessions, true);
    assert.throws(() => existingPiRuntime({ PATH: '' }, root), /not found/);
    assert.throws(() => existingPiRuntime({ ...env, PI_CODING_AGENT_SESSION_DIR: 'relative' }, root), /absolute/);
    mkdirSync(runtime.agentDir, { recursive: true });
    writeFileSync(join(runtime.agentDir, 'settings.json'), JSON.stringify({ sessionDir: '/custom' }));
    assert.throws(() => existingPiRuntime(env, root), /explicitly/);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.1.0' }));
    assert.throws(() => existingPiRuntime(env, root), /1\.5\.0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
