import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { PresenceStore, PRESENCE_STALE_MS } from '../server/agent-presence.js';
import extension from '../server/agent-presence-extension.js';
import { createApp } from '../server/http.js';
import { Workspace, type Agent } from '../server/workspace.js';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'presence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('independent registries see advisory claims, canonical path overlaps, release, and stale uncertainty', t => {
  const dir = fixture(t); let now = 1000;
  const a = new PresenceStore(join(dir, 'presence'), () => now);
  const b = new PresenceStore(a.directory, () => now);
  assert.deepEqual(a.list(), { runs: [], conflicts: [], partial: false });
  mkdirSync(join(dir, 'repo')); symlinkSync(join(dir, 'repo'), join(dir, 'alias'));
  const first = a.start({ threadId: 'one', slot: 'main', cwd: dir });
  const second = b.start({ threadId: 'two', slot: 'fallback', cwd: dir });
  first.publish('Editing source', [{ kind: 'path', value: './alias/new' }]);
  second.publish('Editing child', [{ kind: 'path', value: './repo/new/file.ts' }]);
  assert.equal(a.list().conflicts.length, 1);
  assert.equal(a.list().runs.find(run => run.id === first.id)?.claims[0].value, join(dir, 'repo/new'));
  second.publish('Different worktree', [{ kind: 'path', value: './repo/new-other' }]);
  assert.equal(a.list().conflicts.length, 0, 'path boundaries, not arbitrary string prefixes');
  first.publish('Deploying', [{ kind: 'resource', value: 'deploy:main' }]);
  second.publish('Also deploying', [{ kind: 'resource', value: 'deploy:main' }]);
  assert.equal(b.list().conflicts.length, 1);
  now += PRESENCE_STALE_MS; first.heartbeat();
  assert.equal(a.list().runs.find(run => run.id === first.id)?.stale, false);
  assert.equal(a.list().runs.find(run => run.id === second.id)?.stale, true);
  assert.equal(a.list().conflicts[0].stale, true, 'stale claims still warn, never grant ownership');
  second.publish('Finished deployment', []);
  assert.equal(a.list().conflicts.length, 0);
  assert.throws(() => first.publish('a\nb', []), /Invalid/);
  assert.equal(a.list().runs.find(run => run.id === first.id)?.summary, 'Deploying');
  second.close(); second.close(); second.heartbeat();
  assert.equal(a.list().runs.length, 1, 'late heartbeat cannot resurrect settled runs');
  assert.throws(() => second.publish('late', []), /settled/);
  now += 24 * 60 * 60_000 + 1;
  assert.equal(a.list().runs.length, 0, 'abandoned records age out of the recent view');
  first.heartbeat(); assert.equal(a.list().runs.length, 1, 'expiry is not fencing against a suspended writer');
  first.close(); assert.equal(a.list().runs.length, 0);
});

test('invalid records and payload limits are explicit; only allowlisted metadata is shared', t => {
  const dir = fixture(t); const store = new PresenceStore(dir);
  const run = store.start({ threadId: 'fixture', slot: '', cwd: dir });
  const file = join(dir, `${run.id}.json`);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...data, prompt: 'private fixture prompt', messages: ['private fixture chat'], token: 'fixture-secret' }));
  assert.doesNotMatch(JSON.stringify(store.list()), /private|fixture-secret|messages|token/);
  writeFileSync(file, '{'); assert.equal(store.list().partial, true);
  assert.equal(store.list().runs.length, 0);
  writeFileSync(file, JSON.stringify({ ...data, updatedAt: Date.now() + 100_000 }));
  assert.equal(store.list().partial, true);
  run.close();
  const other = new PresenceStore(join(dir, 'unrelated-owner'));
  assert.equal(other.list().runs.length, 0);
  for (let i = 0; i < 50; i++) {
    const entry = store.start({ threadId: String(i), slot: '', cwd: dir });
    entry.publish('A bounded summary', Array.from({ length: 16 }, (_, index) => ({ kind: 'resource', value: `${index}:` + 'x'.repeat(1000) })));
  }
  const view = store.list();
  assert.equal(view.partial, true);
  assert.ok(Buffer.byteLength(JSON.stringify(view)) < 64_000);
});

test('extension publishes no prompt/history, preserves claims through agent_end, clears at settled/shutdown', async t => {
  const dir = fixture(t);
  const before = { directory: process.env.NOOKFRAME_PRESENCE_DIR, thread: process.env.NOOKFRAME_PRESENCE_THREAD_ID };
  process.env.NOOKFRAME_PRESENCE_DIR = dir; process.env.NOOKFRAME_PRESENCE_THREAD_ID = 'fixture-thread';
  t.after(() => {
    for (const [key, value] of [['NOOKFRAME_PRESENCE_DIR', before.directory], ['NOOKFRAME_PRESENCE_THREAD_ID', before.thread]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  let tool: any;
  extension({ on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); }, registerTool(value: any) { tool = value; } } as unknown as ExtensionAPI);
  const invoke = (name: string) => handlers.get(name)?.({ prompt: 'NEVER SHARE THIS PROMPT' }, { cwd: dir });
  t.after(() => invoke('session_shutdown'));
  invoke('agent_start');
  const first = await tool.execute('test', {});
  assert.equal(first.details.runs.length, 1);
  assert.equal(first.details.runs[0].summary, '');
  assert.doesNotMatch(JSON.stringify(first), /NEVER SHARE/);
  await tool.execute('test', { summary: 'Implementation', claims: [{ kind: 'path', value: dir }] });
  invoke('agent_end'); invoke('agent_start');
  const continued = (await tool.execute('test', {})).details;
  assert.equal(continued.self, first.details.self);
  assert.equal(continued.runs[0].claims.length, 1);
  await assert.rejects(tool.execute('test', { summary: 'Incomplete' }), /together/);
  invoke('agent_settled');
  assert.equal(new PresenceStore(dir).list().runs.length, 0);
  await assert.rejects(tool.execute('test', {}), /unavailable/);
  invoke('agent_start');
  assert.notEqual((await tool.execute('test', {})).details.self, first.details.self);
  invoke('session_shutdown');
  assert.equal(new PresenceStore(dir).list().runs.length, 0);
  const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
  handlers.get('before_agent_start')!(event);
  assert.match(event.systemPromptOptions.sections.nookframe_coordination, /untrusted data/);
  assert.match(event.systemPromptOptions.sections.nookframe_coordination, /advisory/);
});

test('presence HTTP endpoint requires browser authentication and never accepts mutations', async t => {
  const dir = fixture(t); const store = new PresenceStore(join(dir, 'presence'));
  const run = store.start({ threadId: 'one', slot: '', cwd: dir });
  run.publish('Fixture intent', []);
  const workspace = new Workspace({ onEvent() { return () => {}; }, async stop() {} } as unknown as Agent, join(dir, 'workspace'));
  const origin = 'http://localhost:3000'; const token = 'presence-test-token'.repeat(3);
  const app = createApp(workspace, { token, origin, webDir: dir, stateDir: join(dir, 'state'), presence: store });
  t.after(async () => { await app.close(); await workspace.close(); });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(url + '/agent-presence')).status, 401);
  const login = await fetch(url + '/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const response = await fetch(url + '/agent-presence', { headers: { cookie } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).runs[0].summary, 'Fixture intent');
  assert.equal((await fetch(url + '/agent-presence', { method: 'POST', headers: { cookie } })).status, 405);
  rmSync(store.directory, { recursive: true }); writeFileSync(store.directory, 'not a directory');
  const failed = await fetch(url + '/agent-presence', { headers: { cookie } });
  assert.equal(failed.status, 503);
  assert.match((await failed.json()).error, /do not assume/);
  await fetch(url + '/auth/logout', { method: 'POST', headers: { cookie, origin } });
  assert.equal((await fetch(url + '/agent-presence', { headers: { cookie } })).status, 401);
});
