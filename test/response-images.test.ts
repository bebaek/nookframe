import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { ResponseImages } from '../server/response-images.js';
import { Workspace, type Agent } from '../server/workspace.js';
import { createApp } from '../server/http.js';

const fixture = async () => ({ type: 'image', mimeType: 'image/png', data: (await sharp({ create: { width: 40, height: 30, channels: 4, background: '#00000000' } }).png().toBuffer()).toString('base64') });
test('response images validate, deduplicate, bound, normalize and prune', async () => {
  const store = new ResponseImages();
  const image = await fixture();
  assert.deepEqual(store.collect([null, { ...image, mimeType: 'image/svg+xml' }, { ...image, data: '!' }, { ...image, data: 'A'.repeat(9 * 1024 * 1024) }]), []);
  const refs = store.collect([image, image]);
  assert.equal(refs.length, 1);
  const decoded = await store.read(refs[0].id);
  const metadata = await sharp(decoded).metadata();
  assert.equal(metadata.format, 'png'); assert.equal(metadata.hasAlpha, true);
  assert.equal(metadata.width, 40);
  const distinct = await Promise.all(['red', 'green', 'blue', 'white', 'black'].map(async background => ({ ...image, data: (await sharp({ create: { width: 16, height: 16, channels: 3, background } }).png().toBuffer()).toString('base64') })));
  const batch = store.collect(distinct);
  assert.equal(batch.length, 4, 'at most four images per message');
  assert.equal((await Promise.all(batch.map(ref => store.read(ref.id)))).length, 4, 'concurrent previews queue rather than fail');
  const invalid = store.collect([{ ...image, data: Buffer.from('<svg/>').toString('base64') }]);
  await assert.rejects(store.read(invalid[0].id));
  store.retain(new Set());
  await assert.rejects(store.read(refs[0].id));
});

test('response images: live results, history restoration, image-only assistant and authenticated delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-images-'));
  const image = await fixture();
  const messages = [
    { role: 'toolResult', toolCallId: 'read-image', toolName: 'read', content: [image] },
    { role: 'assistant', content: [image] },
  ];
  let emit: (event: any) => void = () => {};
  const agent = {
    onEvent(fn: typeof emit) { emit = fn; return () => {}; },
    async getState() { return {}; }, async getAvailableModels() { return []; },
    async getEntries() { return { entries: messages.map((message, i) => ({ type: 'message', id: String(i), parentId: i ? String(i - 1) : null, message })), leafId: '1' }; },
    async stop() {},
  } as unknown as Agent;
  const workspace = new Workspace(agent, dir);
  const origin = 'http://localhost:3000', token = 'image-test-'.repeat(8);
  const app = createApp(workspace, { token, origin, webDir: resolve('dist/web') });
  try {
    await workspace.initialize();
    assert.equal(workspace.state.messages.length, 2);
    const refs = workspace.state.messages[0].tool!.images!;
    assert.deepEqual(workspace.state.messages[1].images, refs);
    emit({ type: 'tool_execution_end', toolCallId: 'live', toolName: 'read', isError: false, result: { content: [image] } });
    assert.deepEqual(workspace.state.messages[2].tool!.images, refs);
    assert.ok(!JSON.stringify(workspace.state).includes(image.data));
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const address = app.server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(base + refs[0].url)).status, 401);
    const login = await fetch(base + '/auth/login', { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const result = await fetch(base + refs[0].url, { headers: { cookie } });
    assert.equal(result.status, 200); assert.equal(result.headers.get('content-type'), 'image/png');
    assert.match(result.headers.get('content-security-policy')!, /img-src 'self'/);
    assert.equal((await fetch(base + '/response-images/invalid', { headers: { cookie } })).status, 404);
    assert.equal((await fetch(base + '/response-images/' + '0'.repeat(64), { headers: { cookie } })).status, 404);
    assert.equal((await fetch(base + refs[0].url, { method: 'POST', headers: { cookie } })).status, 405);
    workspace.responseImages.clear();
    assert.equal((await fetch(base + refs[0].url, { headers: { cookie } })).status, 404);
  } finally { await app.close(); await workspace.close(); await rm(dir, { recursive: true, force: true }); }
});
