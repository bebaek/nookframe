import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, type Agent } from '../server/workspace.js';
import type { JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';

export function fakeAgent() {
  let listener: (event: JsonAgentSessionEvent) => void = () => {};
  const calls: string[] = [];
  let model = { provider: 'test', id: 'first' };
  const agent = {
    onEvent(fn: typeof listener) { listener = fn; return () => {}; },
    async getState() { return { model }; },
    async getAvailableModels() { return ['first', 'second'].map(id => ({ provider: 'test', id })); },
    async setModel(provider: string, id: string) { calls.push(`model:${provider}/${id}`); model = { provider, id }; return model; },
    async getEntries() { return { entries: [], leafId: null }; },
    async prompt(text: string) { calls.push(text); },
    async clearQueue() { calls.push('clear'); return { steering: [], followUp: [] }; },
    async abort() { calls.push('abort'); listener({ type: 'agent_settled' }); },
    async stop() { calls.push('stop'); },
  } as unknown as Agent;
  return { agent, calls, emit: (event: unknown) => listener(event as JsonAgentSessionEvent) };
}

test('one run, streamed blocks, authoritative final message, settled not agent_end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-workspace-test-'));
  const fake = fakeAgent();
  const workspace = new Workspace(fake.agent, dir);
  try {
    await workspace.initialize();
    await workspace.prompt('hello');
    await assert.rejects(workspace.prompt('second'), /already active/);
    assert.equal(existsSync(join(dir, 'run-active')), true);
    fake.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hel' } });
    fake.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'lo' } });
    assert.equal(workspace.state.liveText, 'hello');
    fake.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] } });
    assert.equal(workspace.state.liveText, '');
    assert.equal(workspace.state.messages[0].text, 'final');
    fake.emit({ type: 'agent_end', messages: [], willRetry: true });
    assert.equal(workspace.state.busy, true);
    fake.emit({ type: 'agent_settled' });
    assert.equal(workspace.state.busy, false);
    assert.equal(existsSync(join(dir, 'run-active')), false);
    await workspace.prompt('again');
    await workspace.abort();
    assert.deepEqual(fake.calls.slice(-2), ['clear', 'abort']);
  } finally { await workspace.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('restart exposes interruption marker without resubmitting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-workspace-test-'));
  const first = new Workspace(fakeAgent().agent, dir);
  const fake = fakeAgent();
  let second: Workspace | undefined;
  try {
    await first.prompt('do work');
    second = new Workspace(fake.agent, dir);
    await second.initialize();
    assert.match(second.state.notice, /interrupted/);
    assert.deepEqual(fake.calls, []);
  } finally { await first.close(); await second?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('ambiguous prompt failure prevents duplicate work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-workspace-test-'));
  const fake = fakeAgent();
  fake.agent.prompt = async () => { throw new Error('timeout'); };
  const workspace = new Workspace(fake.agent, dir);
  try {
    await assert.rejects(workspace.prompt('hello'), /uncertain/);
    assert.equal(workspace.state.available, false);
    assert.equal(existsSync(join(dir, 'run-active')), true);
    await assert.rejects(workspace.prompt('retry'), /unavailable/);
  } finally { await workspace.close(); rmSync(dir, { recursive: true, force: true }); }
});
