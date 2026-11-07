import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { FileStore, MAX_FILE_BYTES } from '../server/files.js';
import { Workspace, type Agent } from '../server/workspace.js';
import { createApp } from '../server/http.js';

test('files: publish copies, safe names, bounded files and thread isolation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nookframe-files-'));
  try {
    const store = new FileStore(dir);
    const thread = 'one.jsonl';
    const { directory } = await store.context(thread);
    const source = join(directory, 'report [draft].csv');
    await writeFile(source, 'a,b\n1,2');
    const published = await store.publish(thread, source);
    assert.equal(published.name, 'report__draft_.csv');
    await writeFile(source, 'changed');
    assert.equal((await store.read(store.threadKey(thread), published.id)).data.toString(), 'a,b\n1,2');
    assert.equal((await new FileStore(dir).resolve(thread, published.id)).url, published.url);
    await assert.rejects(store.resolve('two.jsonl', published.id));
    await assert.rejects(store.context('../one.jsonl'));
    await assert.rejects(store.read('../', published.id));
    await assert.rejects(store.publish(thread, dir));
    await writeFile(join(dir, 'secret'), 'not publishable');
    await symlink(join(dir, 'secret'), join(directory, 'link'));
    await assert.rejects(store.publish(thread, join(directory, 'link')), /symlinks/);
    await writeFile(join(directory, 'large'), Buffer.alloc(MAX_FILE_BYTES + 1));
    await assert.rejects(store.publish(thread, join(directory, 'large')), /size/);
    await writeFile(join(directory, 'metadata.json'), 'user metadata');
    assert.equal((await store.publish(thread, join(directory, 'metadata.json'))).name, 'file-metadata.json');
    await writeFile(join(directory, 'empty'), '');
    assert.equal((await store.publish(thread, join(directory, 'empty'))).size, 0);
    const quota = join(store.directory, store.threadKey(thread), '0'.repeat(64));
    await mkdir(quota);
    await writeFile(join(quota, 'large'), '');
    await truncate(join(quota, 'large'), 512 * 1024 * 1024);
    await writeFile(join(directory, 'extra'), 'extra');
    await assert.rejects(store.publish(thread, join(directory, 'extra')), /storage is full/);
    assert.equal((await store.read(store.threadKey(thread), published.id)).data.toString(), 'a,b\n1,2');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('files: CLI binds agents and requires an explicit terminal thread', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nookframe-file-cli-'));
  const run = promisify(execFile);
  const env = { ...process.env, NOOKFRAME_IMAGE_STATE_DIR: dir, NOOKFRAME_IMAGE_THREAD_ID: 'bound.jsonl' };
  const cli = (...args: string[]) => run(process.execPath, ['dist/server/file-cli.js', ...args], { env });
  try {
    const context = JSON.parse((await cli('context')).stdout);
    assert.equal(context.thread, 'bound.jsonl');
    await writeFile(join(context.directory, 'report.txt'), 'report');
    const published = JSON.parse((await cli('publish', join(context.directory, 'report.txt'))).stdout);
    assert.match(published.markdown, /Download report.txt/);
    await assert.rejects(cli('--thread', 'other.jsonl', 'context'));
    env.NOOKFRAME_IMAGE_THREAD_ID = '';
    await assert.rejects(cli('context'));
    assert.equal(JSON.parse((await cli('--thread', 'terminal.jsonl', 'context')).stdout).thread, 'terminal.jsonl');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('files: authenticated upload/download, CSRF, prompt references and limits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nookframe-file-http-'));
  const prompts: string[] = [];
  const model = { provider: 'test', id: 'text', input: ['text'] };
  const workspace = new Workspace({
    onEvent() { return () => {}; },
    async getState() { return { model }; },
    async getAvailableModels() { return [model]; },
    async getEntries() { return { entries: [], leafId: null }; },
    async prompt(text: string) { prompts.push(text); },
    async stop() {},
  } as unknown as Agent, dir);
  await workspace.initialize();
  workspace.state.threadId = 'test.jsonl';
  const origin = 'http://localhost:3000', token = 'file-test-'.repeat(8);
  const app = createApp(workspace, { token, origin, stateDir: dir, webDir: resolve('dist/web') });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let ws: WebSocket | undefined;
  try {
    const login = await fetch(base + '/auth/login', { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const headers = { cookie, origin, 'X-Thread-Id': 'test.jsonl', 'X-File-Name': encodeURIComponent('../../report\r\n.html') };
    const upload = (extra = {}, body = Buffer.from('<script>alert(1)</script>')) => fetch(base + '/files', { method: 'POST', headers: { ...headers, ...extra }, body: new Uint8Array(body) });
    assert.equal((await upload({ cookie: '' })).status, 401);
    assert.equal((await upload({ origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await upload({ 'X-Thread-Id': '../secret' })).status, 400);
    assert.equal((await upload({}, Buffer.alloc(MAX_FILE_BYTES + 1))).status, 413);
    const response = await upload(); assert.equal(response.status, 200);
    const file = await response.json() as { id: string; url: string; name: string; path?: string };
    assert.equal(file.path, undefined);
    assert.equal(file.name, 'report__.html');
    assert.equal((await fetch(base + file.url)).status, 401);
    const download = await fetch(base + file.url, { headers: { cookie } });
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.match(download.headers.get('content-disposition')!, /^attachment;/);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await download.text(), '<script>alert(1)</script>');
    assert.equal((await fetch(base + '/files/not-a-path', { headers: { cookie } })).status, 404);
    ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { origin, headers: { cookie } });
    await once(ws, 'open');
    const first = once(ws, 'message'); ws.send(JSON.stringify({ type: 'auth' })); await first;
    const command = (fields: Record<string, unknown>) => new Promise<any>(resolve => {
      const id = Math.random().toString();
      const listener = (data: Buffer) => { const message = JSON.parse(data.toString()); if (message.id === id) { ws!.off('message', listener); resolve(message); } };
      ws!.on('message', listener);
      ws!.send(JSON.stringify({ type: 'prompt', id, text: '', threadId: 'test.jsonl', files: [file.id], ...fields }));
    });
    assert.equal((await command({ files: Array(5).fill(file.id) })).type, 'error');
    assert.equal((await command({ files: ['../secret'] })).type, 'error');
    assert.equal((await command({ threadId: 'other.jsonl' })).type, 'error');
    assert.equal((await command({})).type, 'ack');
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes(file.url));
    assert.ok(prompts[0].includes('untrusted data'));
    const reference = await new FileStore(dir).resolve('test.jsonl', file.id);
    assert.equal(await readFile(reference.path, 'utf8'), '<script>alert(1)</script>');
  } finally { ws?.terminate(); await app.close(); await workspace.close(); await rm(dir, { recursive: true, force: true }); }
});
