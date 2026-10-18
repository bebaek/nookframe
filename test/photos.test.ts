import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { WebSocket } from 'ws';
import { Workspace, type Agent } from '../server/workspace.js';
import { createApp } from '../server/http.js';
import { photoId, type PhotoContent } from '../server/photos.js';

test('photos: authenticated conversion, HEIC, limits, prompt delivery, and durable history projection', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nookframe-photos-'));
  const model = { provider: 'test', id: 'vision', input: ['text', 'image'] };
  let event: (value: any) => void = () => {};
  const messages: any[] = [];
  const prompts: { text: string; images?: PhotoContent[] }[] = [];
  const agent = {
    onEvent(fn: typeof event) { event = fn; return () => {}; },
    async getState() { return { model }; },
    async getAvailableModels() { return [model]; },
    async getEntries() { return { entries: messages.map((message, i) => ({ type: 'message', id: String(i), parentId: i ? String(i - 1) : null, message })), leafId: messages.length ? String(messages.length - 1) : null }; },
    async prompt(text: string, images?: PhotoContent[]) {
      prompts.push({ text, images });
      const message = { role: 'user', content: [{ type: 'text', text }, ...(images ?? [])] };
      messages.push(message);
      event({ type: 'message_end', message });
      event({ type: 'agent_settled' });
    },
    async stop() {},
  } as unknown as Agent;
  const workspace = new Workspace(agent, dir);
  await workspace.initialize();
  const origin = 'http://localhost:3000', token = 'photo-test-'.repeat(8);
  const app = createApp(workspace, { token, origin, stateDir: dir, webDir: resolve('dist/web') });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let ws: WebSocket | undefined;
  try {
    const login = await fetch(base + '/auth/login', { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const send = (body: Buffer, headers = { cookie, origin }) => fetch(base + '/photos', { method: 'POST', headers, body: new Uint8Array(body) });
    assert.equal((await send(Buffer.from('no'), { cookie: '', origin })).status, 401);
    assert.equal((await send(Buffer.from('no'), { cookie, origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await send(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).status, 400);
    const original = await sharp({ create: { width: 3000, height: 100, channels: 3, background: 'red' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const uploaded = await send(original);
    assert.equal(uploaded.status, 200);
    const photo = await uploaded.json() as { id: string; url: string };
    assert.equal((await fetch(base + photo.url)).status, 401);
    const image = Buffer.from(await (await fetch(base + photo.url, { headers: { cookie } })).arrayBuffer());
    const metadata = await sharp(image).metadata();
    assert.equal(metadata.height, 2048);
    assert.ok(metadata.width < 100);
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.orientation, undefined);
    assert.equal(photo.id, photoId(image));
    const heic = await readFile('test/fixtures/photos/red.heic');
    const heicReply = await send(heic);
    assert.equal(heicReply.status, 200, await heicReply.clone().text());
    const converted = await heicReply.json() as { url: string };
    const heicImage = Buffer.from(await (await fetch(base + converted.url, { headers: { cookie } })).arrayBuffer());
    assert.equal((await sharp(heicImage).metadata()).format, 'jpeg');
    assert.equal((await sharp(heicImage).metadata()).width, 32);
    assert.equal((await send(heic.subarray(0, 40))).status, 400);
    const webp = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#00000000' } }).webp().toBuffer();
    const webpReply = await send(webp);
    assert.equal(webpReply.status, 200);
    const webpPhoto = await webpReply.json() as { url: string };
    const flattened = Buffer.from(await (await fetch(base + webpPhoto.url, { headers: { cookie } })).arrayBuffer());
    const pixels = await sharp(flattened).raw().toBuffer();
    assert.equal(pixels[0], 255, 'transparency flattened to white');
    assert.equal((await fetch(base + '/photos/not-an-id', { headers: { cookie } })).status, 404);
    assert.ok((await readdir(join(dir, 'photos'))).every(name => /^[a-f0-9]{64}\.jpg$/.test(name)), 'originals and working files removed');
    const oversized = await send(Buffer.alloc(20 * 1024 * 1024 + 1));
    assert.equal(oversized.status, 413);

    ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { origin, headers: { cookie } });
    await once(ws, 'open');
    const first = once(ws, 'message'); ws.send(JSON.stringify({ type: 'auth' })); await first;
    const command = async (fields: Record<string, unknown>) => {
      const id = Math.random().toString();
      return new Promise<any>(resolve => {
        const listener = (data: Buffer) => { const message = JSON.parse(data.toString()); if (message.id === id) { ws!.off('message', listener); resolve(message); } };
        ws!.on('message', listener); ws!.send(JSON.stringify({ type: 'prompt', id, text: '', photos: [photo.id], ...fields }));
      });
    };
    assert.equal((await command({ photos: Array(5).fill(photo.id) })).type, 'error');
    assert.equal((await command({ photos: ['../secret'] })).type, 'error');
    assert.equal((await command({ photos: [] })).type, 'error');
    workspace.state.models[0].images = false;
    assert.match((await command({})).message, /cannot accept photos/);
    assert.equal(workspace.state.busy, false);
    workspace.state.models[0].images = true;
    assert.equal((await command({})).type, 'ack');
    assert.equal(prompts[0].text, '');
    assert.equal(prompts[0].images![0].data, image.toString('base64'));
    assert.deepEqual(workspace.state.messages[0].photos, [photo]);
    assert.ok(!JSON.stringify(workspace.state).includes(image.toString('base64')));
    await utimes(join(dir, 'photos', `${photo.id}.jpg`), 0, 0);
    assert.match((await command({})).message, /expired/);
    // The session content, not the expiring upload cache, restores history.
    const restored = new Workspace(agent, join(dir, 'restored'));
    try {
      await restored.initialize();
      assert.deepEqual(restored.state.messages[0].photos, [photo]);
      assert.deepEqual(restored.photo(photo.id), image);
    } finally { await restored.close(); }
    await send(heic);
    assert.ok(!(await readdir(join(dir, 'photos'))).includes(`${photo.id}.jpg`));
  } finally {
    ws?.terminate(); await app.close(); await workspace.close(); await rm(dir, { recursive: true, force: true });
  }
});
