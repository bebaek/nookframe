import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, copyFile, symlink, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import sharp from 'sharp';
import { ArtifactStore, type PublishedImage } from '../server/artifacts.js';
import { photoId } from '../server/photos.js';
import { Workspace, type Agent } from '../server/workspace.js';
import { createApp } from '../server/http.js';

const fixture = resolve('test/fixtures/images/apollo17-earth.jpg');
const exec = promisify(execFile);
test('public image publishing: CLI, exact original, preview, authentication and persistence', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nookframe-artifacts-'));
  const store = new ArtifactStore(dir);
  await writeFile(join(dir, 'active-thread.json'), JSON.stringify({ file: 'thread-a.jsonl' }));
  const cli = (...args: string[]) => exec(process.execPath, ['dist/server/image-cli.js', ...args], { env: { ...process.env, NOOKFRAME_IMAGE_STATE_DIR: dir } });
  const workspace = new Workspace({ onEvent() { return () => {}; }, async stop() {} } as unknown as Agent, dir);
  const origin = 'http://localhost:3000', token = 'artifact-test-'.repeat(4);
  let app = createApp(workspace, { token, origin, stateDir: dir, webDir: resolve('dist/web') });
  const listen = async () => {
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const address = app.server.address(); assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  };
  try {
    let base = await listen();
    const context = JSON.parse((await cli('context')).stdout);
    await copyFile(fixture, join(context.directory, 'earth.jpg'));
    const published: PublishedImage = JSON.parse((await cli('publish', context.thread, join(context.directory, 'earth.jpg'), 'Earth — NASA / Apollo 17')).stdout);
    assert.equal(published.width, 330); assert.equal(published.height, 330);
    assert.equal(published.id, '27f1e962b444029c0f0924161c486ccad397f4011dbeedcad3355a0049b121be');
    assert.ok(published.markdown.includes(published.previewUrl));
    const again = await store.publish(context.thread, join(context.directory, 'earth.jpg'), 'Same image');
    assert.equal(again.previewUrl, published.previewUrl, 'deduplicated');
    for (const url of [published.previewUrl, published.fullUrl, published.downloadUrl]) assert.equal((await fetch(base + url)).status, 401);
    const login = await fetch(base + '/auth/login', { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const get = (url: string) => fetch(base + url, { headers: { cookie } });
    const preview = await get(published.previewUrl);
    assert.equal(preview.status, 200); assert.equal(preview.headers.get('content-type'), 'image/webp');
    assert.match(preview.headers.get('content-security-policy')!, /img-src 'self'/);
    const metadata = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
    assert.equal(Math.max(metadata.width!, metadata.height!), 330, 'small images are not upscaled');
    assert.equal(metadata.exif, undefined);
    const original = await get(published.downloadUrl);
    assert.equal(original.headers.get('content-type'), 'image/jpeg');
    assert.match(original.headers.get('content-disposition')!, /^attachment;/);
    assert.equal(photoId(Buffer.from(await original.arrayBuffer())), published.id);
    assert.equal((await get(published.fullUrl)).headers.get('content-disposition'), null);
    assert.equal((await get(published.previewUrl.replace(published.id, '0'.repeat(64)))).status, 404);
    assert.equal((await get('/artifacts/invalid')).status, 404);
    assert.equal((await fetch(base + published.previewUrl, { method: 'POST', headers: { cookie } })).status, 405);
    // Neither source lifetime nor current thread determines artifact lifetime.
    await rm(context.directory, { recursive: true });
    await writeFile(join(dir, 'active-thread.json'), JSON.stringify({ file: 'thread-b.jsonl' }));
    await app.close();
    app = createApp(workspace, { token, origin, stateDir: dir, webDir: resolve('dist/web') });
    base = await listen();
    assert.equal((await get(published.previewUrl)).status, 200);
    assert.equal(photoId(Buffer.from(await (await get(published.downloadUrl)).arrayBuffer())), published.id);
    await fetch(base + '/auth/logout', { method: 'POST', headers: { cookie, origin } });
    assert.equal((await get(published.previewUrl)).status, 401);
  } finally { await app.close(); await workspace.close(); await rm(dir, { recursive: true, force: true }); }
});

test('high-resolution preview resizes while original dimensions and transparency are preserved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nookframe-image-resize-'));
  try {
    const store = new ArtifactStore(dir);
    await writeFile(join(dir, 'active-thread.json'), JSON.stringify({ file: 'resize.jsonl' }));
    const context = await store.context();
    const source = join(context.directory, 'large.png');
    // Highly compressible runtime fixture: no large binary needs tracking.
    const original = await sharp({ create: { width: 3000, height: 2400, channels: 4, background: '#33669980' } }).png().toBuffer();
    await writeFile(source, original);
    const published = await store.publish(context.thread, source, 'Resize fixture');
    assert.equal(published.width, 3000); assert.equal(published.height, 2400);
    const key = photoId(Buffer.from(context.thread));
    const preview = await store.read(key, published.id, 'preview');
    const metadata = await sharp(preview.data).metadata();
    assert.equal(metadata.width, 2048); assert.equal(metadata.height, 1638);
    assert.equal(metadata.hasAlpha, true);
    assert.deepEqual((await store.read(key, published.id, 'download')).data, original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('publishing rejects stale threads, path escapes, symlinks, invalid images and full stores', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nookframe-artifact-security-'));
  try {
    const store = new ArtifactStore(dir);
    await assert.rejects(store.context());
    await writeFile(join(dir, 'active-thread.json'), JSON.stringify({ file: 'thread.jsonl' }));
    const context = await store.context();
    await assert.rejects(store.publish('stale.jsonl', fixture, 'Earth'), /thread changed/);
    await assert.rejects(store.publish(context.thread, fixture, 'Earth'), /inside the directory/);
    await symlink(fixture, join(context.directory, 'linked.jpg'));
    await assert.rejects(store.publish(context.thread, join(context.directory, 'linked.jpg'), 'Earth'), /Symlinks/);
    await symlink(resolve('test/fixtures/images'), join(context.directory, 'linked-directory'));
    await assert.rejects(store.publish(context.thread, join(context.directory, 'linked-directory/apollo17-earth.jpg'), 'Earth'), /Symlinks/);
    const bad = join(context.directory, 'bad.png');
    for (const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('not a PNG'), (await readFile(fixture)).subarray(0, 1000)]) {
      await writeFile(bad, bytes);
      await assert.rejects(store.publish(context.thread, bad, 'Bad'), /Cannot publish image/);
    }
    await writeFile(bad, Buffer.alloc(20 * 1024 * 1024 + 1));
    await assert.rejects(store.publish(context.thread, bad, 'Too big'), /Invalid image size/);
    await assert.rejects(store.publish(context.thread, bad, ''), /description/);
    await assert.rejects(store.read('../escape', '0'.repeat(64), 'preview'));
    await copyFile(fixture, join(context.directory, 'earth.jpg'));
    const publishing = store.publish(context.thread, join(context.directory, 'earth.jpg'), 'Earth');
    const rejected = assert.rejects(publishing, /thread changed/);
    for (let i = 0; i < 100; i++) {
      if ((await readdir(store.directory)).some(name => name.startsWith('.publishing-'))) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await writeFile(join(dir, 'active-thread.json'), JSON.stringify({ file: 'other-thread.jsonl' }));
    await rejected;
    await writeFile(join(dir, 'active-thread.json'), JSON.stringify({ file: context.thread }));
    const key = photoId(Buffer.from(context.thread));
    for (let i = 0; i < 256; i++) await mkdir(join(store.directory, key, i.toString(16).padStart(64, '0')), { recursive: true });
    await assert.rejects(store.publish(context.thread, join(context.directory, 'earth.jpg'), 'Earth'), /store is full/);
    assert.ok(!(await readdir(store.directory)).some(name => name.startsWith('.publishing-')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
