import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { Workspace, type Agent } from '../server/workspace.js';
import { Workspaces } from '../server/workspaces.js';
import { ThreadStore } from '../server/threads.js';
import { createApp } from '../server/http.js';
import { JobStore } from '../server/jobs/store.js';
import { JobRunner } from '../server/jobs/runner.js';

test('background thread: two viewers, Stop, confirmed shutdown and same-thread continuation', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-browser-'));
  const threads = new ThreadStore(join(dir, 'sessions'), dir, join(dir, 'state'));
  const store = new JobStore(join(dir, 'jobs'));
  let releaseStops = false;
  let finishStop!: () => void;
  let startedStop!: () => void;
  const stopping = new Promise<void>(resolve => { startedStop = resolve; });
  const prompts: string[] = [];
  const profiles: boolean[] = [];
  const pool = new Workspaces(threads, threads.id(threads.create()), (file, stateDir, background) => {
    profiles.push(!!background);
    let emit: (e: any) => void = () => {};
    const model = { provider: 'fixture', id: 'fixture' };
    const agent = {
      onEvent(fn: typeof emit) { emit = fn; return () => {}; },
      async getState() { return { model, sessionFile: file }; },
      async getAvailableModels() { return [model]; },
      async getEntries() { return { entries: [], leafId: null }; },
      async prompt(text: string) { prompts.push(text); },
      async clearQueue() {},
      async abort() { emit({ type: 'agent_settled', aborted: true }); },
      async stop() { if (background && !releaseStops) { startedStop(); await new Promise<void>(resolve => { finishStop = resolve; }); } },
    } as unknown as Agent;
    return { workspace: new Workspace(agent, stateDir, undefined, threads, true), async start() {} };
  });
  await pool.initialize();
  const runner = new JobRunner(store, pool);
  const job = await store.create({ name: 'Review', prompt: 'Background review', schedule: { kind: 'once', at: '2030-01-01T00:00:00Z' }, notify: 'attention', timeoutSeconds: 300 });
  await store.requestRun(job.id, 1, randomUUID()); await runner.tick();
  const threadId = (await store.runs())[0].threadId!;
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, token = 'background-fixture-'.repeat(4);
  const app = createApp(pool, { token, origin, webDir: resolve('dist/web') });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, headless: true });
  try {
    const context = await browser.newContext();
    const a = await context.newPage(), b = await context.newPage();
    await a.goto(`${origin}/#thread=${encodeURIComponent(threadId)}`);
    await a.getByLabel('Access token').fill(token);
    await a.getByRole('button', { name: 'Connect', exact: true }).click();
    await a.getByRole('button', { name: 'Stop', exact: true }).waitFor();
    await b.goto(a.url());
    await b.getByRole('button', { name: 'Stop', exact: true }).waitFor();
    for (const page of [a, b]) {
      await page.getByLabel('Message', { exact: true }).fill('Follow up');
      assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
    }
    assert.deepEqual(profiles, [true]);
    await a.getByRole('button', { name: 'Stop', exact: true }).click();
    await b.getByRole('button', { name: 'Stopping…', exact: true }).waitFor();
    const finishing = runner.tick(); await stopping;
    assert.equal((await store.runs())[0].status, 'stopping');
    assert.equal(await b.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
    finishStop(); await finishing;
    for (const page of [a, b]) {
      await page.getByText('Ready', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Thread', { exact: true }).inputValue(), threadId);
      assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled(), true);
    }
    assert.deepEqual(profiles, [true, false]);
    await b.getByRole('button', { name: 'Workspace controls', exact: true }).click();
    await b.getByRole('button', { name: 'Release thread', exact: true }).click();
    await b.getByText('Close other tabs viewing this thread on this slot before releasing it', { exact: true }).waitFor();
    assert.equal(await b.getByLabel('Thread', { exact: true }).inputValue(), threadId);
    await b.getByRole('button', { name: 'Close controls', exact: true }).click();
    await a.close();
    await b.getByRole('button', { name: 'Send', exact: true }).click();
    await b.waitForFunction(() => document.querySelector('textarea')?.value === '');
    assert.deepEqual(prompts, ['Background review', 'Follow up']);
    assert.equal((await store.runs())[0].status, 'cancelled');
    await b.getByRole('button', { name: 'Stop', exact: true }).click();
    await b.getByText('Ready', { exact: true }).waitFor();
    await b.getByRole('button', { name: 'Workspace controls', exact: true }).click();
    await b.getByRole('button', { name: 'Release thread', exact: true }).click();
    await b.getByText('Thread released. You can open it on another slot now.', { exact: true }).waitFor();
    assert.equal(await b.getByLabel('Thread', { exact: true }).inputValue(), '');
    assert.equal(new URL(b.url()).hash, '');
    await b.reload();
    await b.getByText('Ready', { exact: true }).waitFor();
    assert.equal(await b.getByLabel('Thread', { exact: true }).inputValue(), '');
    assert.deepEqual(profiles, [true, false], 'refresh must not reacquire the released thread');
    await b.getByRole('button', { name: 'Workspace controls', exact: true }).click();
    await b.getByLabel('Thread', { exact: true }).selectOption(threadId);
    await b.waitForFunction(() => document.querySelector<HTMLSelectElement>('#thread')?.value !== '');
    assert.deepEqual(profiles, [true, false, false]);
  } finally {
    releaseStops = true; finishStop?.(); await browser.close(); await app.close(); await runner.close(); await pool.close(); await rm(dir, { recursive: true, force: true });
  }
});
