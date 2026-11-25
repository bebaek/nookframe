import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, type Agent } from '../server/workspace.js';

test('drain refuses a new prompt without dispatch and releases after a cancelled restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'restart-'));
  let draining = true, sent = false;
  const agent = { onEvent: () => () => {}, prompt: async () => { sent = true; }, stop: async () => {} } as unknown as Agent;
  const ws = new Workspace(agent, dir, undefined, undefined, false, undefined, () => draining);
  try {
    await assert.rejects(ws.prompt('blocked'), /restart queued/);
    assert.equal(sent, false);
    assert.equal(ws.state.busy, false);
    draining = false;
    await ws.prompt('accepted');
    assert.equal(sent, true);
  } finally { await ws.close(); rmSync(dir, { recursive: true, force: true }); }
});
