import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Takeovers } from '../server/takeovers.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'nookframe-takeovers-'));
  let now = 100_000;
  const owner = new Takeovers(dir, 'a', () => now);
  const requester = new Takeovers(dir, 'b', () => now);
  const competitor = new Takeovers(dir, 'c', () => now);
  await owner.acquired('thread');
  return { owner, requester, competitor, advance(ms: number) { now += ms; }, close: () => rm(dir, { recursive: true, force: true }) };
}

test('approval is first-response-wins and ownership is reserved until ordinary acquisition', async () => {
  const f = await fixture();
  try {
    const r = await f.requester.request('thread');
    assert.equal(r.deadline, 130_000);
    assert.equal((await f.owner.incoming())[0].id, r.id);
    await assert.rejects(f.competitor.request('thread'), /already pending/);
    await assert.rejects(f.requester.decide('thread', r.id, 'allow'), /expired or already answered/);
    const decisions = await Promise.allSettled([
      f.owner.decide('thread', r.id, 'allow'), f.owner.decide('thread', r.id, 'keep'),
    ]);
    assert.equal(decisions.filter(r => r.status === 'fulfilled').length, 1);
    const result = await f.requester.status('thread', r.id);
    if (result.status === 'approved') {
      await assert.rejects(f.competitor.checkOpen('thread'), /in progress/);
      await assert.rejects(f.competitor.acquired('thread'), /in progress/);
      await f.owner.handoff(result, () => f.owner.relinquished('thread'));
      assert.equal((await f.requester.status('thread', r.id)).status, 'released');
      await f.requester.acquired('thread');
      assert.equal((await f.requester.status('thread', r.id)).status, 'completed');
    } else assert.equal(result.status, 'rejected');
  } finally { await f.close(); }
});

test('silence expires without approval; force is explicit, time bounded, and generation scoped', async () => {
  const f = await fixture();
  try {
    const r = await f.requester.request('thread');
    await assert.rejects(f.requester.decide('thread', r.id, 'force'), /deadline/);
    f.advance(30_000);
    assert.equal((await f.requester.status('thread', r.id)).status, 'expired');
    await assert.rejects(f.owner.decide('thread', r.id, 'allow'), /expired/);
    assert.equal((await f.owner.incoming())[0].status, 'expired');
    await assert.rejects(f.competitor.decide('thread', r.id, 'force'), /already answered/);
    await f.requester.decide('thread', r.id, 'force');
    let stops = 0;
    await f.owner.handoff(r, async () => { stops++; throw new Error('unconfirmed'); });
    assert.equal(stops, 1);
    assert.equal((await f.requester.status('thread', r.id)).status, 'failed');
    await f.owner.handoff(r, async () => { stops++; });
    assert.equal(stops, 1);
    const fresh = await f.requester.request('thread');
    await f.owner.acquired('thread'); // A new ownership generation supersedes the old request.
    f.advance(30_000);
    await assert.rejects(f.requester.decide('thread', fresh.id, 'force'), /owner changed/);
    await f.owner.handoff(fresh, async () => { stops++; });
    assert.equal(stops, 1);
  } finally { await f.close(); }
});

test('missing ownership metadata explains compatibility uncertainty without claiming an outdated version', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.requester.request('legacy-thread'), /has not published takeover information.*may need updating or may be unavailable/);
    await assert.rejects(f.owner.request('thread'), /already owns the thread/);
  } finally { await f.close(); }
});

test('stalled shutdown reports an unconfirmed outcome without authorizing a competing request', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let handoff: Promise<void> | undefined;
  try {
    const r = await f.requester.request('thread');
    await f.owner.decide('thread', r.id, 'allow');
    handoff = f.owner.handoff(r, async () => { entered(); await gate; throw new Error('unconfirmed shutdown'); });
    await started;
    f.advance(60_001);
    assert.equal((await f.requester.status('thread', r.id)).status, 'failed');
    await assert.rejects(f.competitor.request('thread'), /already pending/);
    release(); await handoff;
    assert.equal((await f.requester.status('thread', r.id)).status, 'failed');
  } finally { release(); await handoff; await f.close(); }
});

test('denial cannot be overridden and unreachable owner never yields a successful handoff', async () => {
  const f = await fixture();
  try {
    const r = await f.requester.request('thread');
    await f.owner.decide('thread', r.id, 'keep');
    f.advance(30_000);
    await assert.rejects(f.requester.decide('thread', r.id, 'force'), /already answered/);
    const next = await f.requester.request('thread');
    f.advance(30_000);
    await f.requester.decide('thread', next.id, 'force');
    f.advance(60_001);
    assert.equal((await f.requester.status('thread', next.id)).status, 'failed');
    let stopped = false;
    await f.owner.handoff(next, async () => { stopped = true; });
    assert.equal(stopped, false, 'a late owner cannot act on expired approval');
    const cancelled = await f.requester.request('thread');
    await f.requester.decide('thread', cancelled.id, 'cancel');
    await assert.rejects(f.owner.decide('thread', cancelled.id, 'allow'), /already answered/);
  } finally { await f.close(); }
});
