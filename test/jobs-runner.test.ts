import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Workspace, type Agent } from '../server/workspace.js';
import { Workspaces } from '../server/workspaces.js';
import { ThreadStore } from '../server/threads.js';
import { JobStore, activeRun, type JobInput } from '../server/jobs/store.js';
import { JobRunner } from '../server/jobs/runner.js';
const input: JobInput = { name: 'Review', prompt: 'Review the supplied report.', schedule: { kind: 'once', at: '2030-01-01T00:00:00Z' }, notify: 'attention', timeoutSeconds: 300 };
async function fixture(max = 4) {
  const dir = await mkdtemp(join(tmpdir(), 'nookframe-runner-'));
  const store = new JobStore(join(dir, 'jobs'));
  const threads = new ThreadStore(join(dir, 'sessions'), dir, join(dir, 'state'));
  const records: { background: boolean; prompts: number; stops: number; emit: (e: any) => void; stop?: () => Promise<void> }[] = [];
  const pool = new Workspaces(threads, threads.id(threads.create()), (file, stateDir, background) => {
    const listeners = new Set<(e: any) => void>();
    const record = { background: !!background, prompts: 0, stops: 0, emit: (e: any) => { for (const fn of listeners) fn(e); }, stop: undefined as (() => Promise<void>) | undefined };
    records.push(record);
    const agent = {
      onEvent(fn: (e: any) => void) { listeners.add(fn); return () => listeners.delete(fn); },
      async getState() { return { sessionFile: file, model: { provider: 'test', id: 'model' } }; },
      async getAvailableModels() { return [{ provider: 'test', id: 'model' }]; },
      async getEntries() { return { entries: [], leafId: null }; },
      async prompt() { record.prompts++; return 'started'; },
      async clearQueue() {},
      async abort() { record.emit({ type: 'agent_settled', aborted: true }); },
      async stop() { record.stops++; await record.stop?.(); },
    } as unknown as Agent;
    return { workspace: new Workspace(agent, stateDir, { source: 'pi' }, threads, true), async start() {} };
  }, max, 300_000, async id => {
    if ((await store.runs()).some(r => r.threadId === id && activeRun(r))) throw new Error('Background ownership uncertain');
  });
  await pool.initialize();
  const runner = new JobRunner(store, pool);
  const job = await store.create(input);
  const request = () => store.requestRun(job.id, job.revision, randomUUID());
  return { dir, store, threads, records, pool, runner, job, request, async close() { await runner.close(); await pool.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('durable requests deduplicate, snapshot revisions, cancel queues and guard deletion', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    const run = await f.store.requestRun(f.job.id, 1, id);
    assert.deepEqual(await f.store.requestRun(f.job.id, 1, id), run);
    await assert.rejects(f.request(), /active/);
    await assert.rejects(f.store.delete(f.job.id, 1), /active/);
    await f.store.update(f.job.id, 1, { prompt: 'Changed instructions' });
    assert.equal((await f.store.runs())[0].job.prompt, input.prompt);
    await f.store.cancelRun(run.id);
    await f.runner.tick();
    assert.equal(f.records.length, 0);
    assert.equal((await f.store.runs())[0].status, 'cancelled');
  } finally { await f.close(); }
});

test('view running thread, Stop, wait for exit, then continue using replacement agent', async () => {
  const f = await fixture();
  try {
    const run = await f.request();
    await f.runner.tick();
    const running = (await f.store.runs())[0];
    assert.equal(running.status, 'running');
    const view = await f.pool.connect(running.threadId);
    assert.equal(f.records.length, 1, 'view does not start another process');
    assert.equal(f.records[0].background, true);
    await assert.rejects(view.workspace.prompt('Change something'), /view-only/);
    await assert.rejects(view.workspace.setModel('test', 'model'), /view-only/);
    await assert.rejects(f.pool.deleteThread(running.threadId!), /finishes running/);
    let confirmExit!: () => void;
    let enteredStop!: () => void;
    const stopping = new Promise<void>(resolve => { enteredStop = resolve; });
    f.records[0].stop = () => { enteredStop(); return new Promise<void>(resolve => { confirmExit = resolve; }); };
    await view.workspace.abort();
    assert.equal((await f.store.runs())[0].cancelRequested, true);
    assert.equal(view.workspace.state.backgroundRun?.stopping, true);
    const finish = f.runner.tick();
    await stopping;
    assert.equal((await f.store.runs())[0].status, 'stopping');
    assert.equal(f.records.length, 1);
    await assert.rejects(view.workspace.prompt('too soon'), /view-only/);
    confirmExit(); await finish;
    assert.equal((await f.store.runs())[0].status, 'cancelled');
    assert.equal(f.records.length, 2);
    assert.equal(f.records[1].background, false);
    assert.equal(view.workspace.state.backgroundRun, undefined);
    assert.equal(view.workspace.state.threadId, running.threadId);
    await view.workspace.prompt('Follow up');
    assert.equal(f.records[1].prompts, 1);
    assert.equal((await f.store.runs())[0].status, 'cancelled');
    assert.equal((await f.store.get(f.job.id)).enabled, false);
    assert.equal((await f.store.runs())[0].id, run.id);
    view.release();
  } finally { await f.close(); }
});

test('completion is recorded separately from interactive follow-up', async () => {
  const f = await fixture();
  try {
    await f.request(); await f.runner.tick();
    f.records[0].emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Original findings' }] } });
    f.records[0].emit({ type: 'agent_end' });
    await f.runner.tick();
    assert.equal((await f.store.runs())[0].status, 'running', 'agent_end is not settlement');
    f.records[0].emit({ type: 'agent_settled', aborted: false });
    await f.runner.tick();
    assert.equal((await f.store.runs())[0].status, 'completed');
    f.records[1].emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Later discussion' }] } });
    assert.equal((await f.store.runs())[0].summary, 'Original findings');
  } finally { await f.close(); }
});

test('full interactive capacity leaves request queued without dispatch', async () => {
  const f = await fixture(1);
  try {
    const interactive = await f.pool.connect();
    await f.request(); await f.runner.tick();
    assert.equal((await f.store.runs())[0].status, 'queued');
    assert.equal(f.records.length, 1);
    interactive.release();
    await f.runner.tick();
    assert.equal((await f.store.runs())[0].status, 'running');
    assert.equal(f.records[0].stops, 1);
  } finally { await f.close(); }
});

test('timeout stops the background process before marking timed_out', async t => {
  const f = await fixture();
  try {
    await f.request(); await f.runner.tick();
    const clock = Date.now();
    t.mock.method(Date, 'now', () => clock + 400_000);
    await f.runner.tick();
    assert.equal((await f.store.runs())[0].status, 'timed_out');
    assert.equal(f.records[0].stops, 1);
  } finally { t.mock.restoreAll(); await f.close(); }
});

test('failed exit blocks handoff and marks outcome uncertain', async () => {
  const f = await fixture();
  try {
    const run = await f.request(); await f.runner.tick();
    const view = await f.pool.connect((await f.store.runs())[0].threadId);
    f.records[0].stop = async () => { throw new Error('exit unconfirmed'); };
    await f.store.cancelRun(run.id);
    await assert.rejects(f.runner.tick(), /exit unconfirmed/);
    assert.equal((await f.store.runs())[0].status, 'uncertain');
    assert.equal(f.records.length, 1);
    await assert.rejects(view.workspace.prompt('unsafe'), /view-only/);
    await assert.rejects(f.request(), /uncertain/);
    view.release();
  } finally {
    // Rejected stop intentionally retains the lock for the process lifetime.
    await f.runner.close().catch(() => {}); await f.pool.close().catch(() => {});
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('final persistence failure blocks interactive handoff after confirmed stop', async t => {
  const f = await fixture();
  try {
    const run = await f.request(); await f.runner.tick();
    const transition = f.store.transition.bind(f.store);
    t.mock.method(f.store, 'transition', async (...args: Parameters<JobStore['transition']>) => {
      if (args[2].status === 'cancelled') throw new Error('disk failure');
      return transition(...args);
    });
    await f.store.cancelRun(run.id);
    await assert.rejects(f.runner.tick(), /disk failure/);
    assert.equal(f.records[0].stops, 1);
    assert.equal(f.records.length, 1, 'no unrestricted process starts');
    assert.equal((await f.store.runs())[0].status, 'uncertain');
  } finally { t.mock.restoreAll(); await f.close(); }
});

test('ledger read failure during execution stops rather than abandoning the timeout', async t => {
  const f = await fixture();
  try {
    await f.request(); await f.runner.tick();
    t.mock.method(f.store, 'runs', async () => { throw new Error('read failure'); }, { times: 1 });
    await assert.rejects(f.runner.tick(), /read failure/);
    assert.equal(f.records[0].stops, 1);
    assert.equal(f.records.length, 1);
    assert.equal((await f.store.runs())[0].status, 'uncertain');
  } finally { t.mock.restoreAll(); await f.close(); }
});

test('provider failure is not reported as successful completion', async () => {
  const f = await fixture();
  try {
    await f.request(); await f.runner.tick();
    f.records[0].emit({ type: 'message_end', message: { role: 'assistant', content: [], errorMessage: 'Provider rejected request' } });
    f.records[0].emit({ type: 'agent_settled', aborted: false });
    await f.runner.tick();
    assert.equal((await f.store.runs())[0].status, 'failed');
    assert.equal(f.records[0].stops, 1);
  } finally { await f.close(); }
});

test('single runner ownership and restart recovery never replay dispatched work', async () => {
  const f = await fixture();
  const other = new JobRunner(f.store, f.pool);
  try {
    const run = await f.request();
    const file = f.threads.create();
    await f.store.transition(run.id, ['queued'], { status: 'running', threadId: f.threads.id(file) });
    await f.runner.start();
    await assert.rejects(other.start(), /lock/i);
    assert.equal((await f.store.runs())[0].status, 'uncertain');
    await f.runner.tick();
    assert.equal(f.records.length, 0);
    await assert.rejects(f.pool.connect(f.threads.id(file)), /uncertain/);
  } finally { await other.close(); await f.close(); }
});
