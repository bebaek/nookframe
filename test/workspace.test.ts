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
    async abort() { calls.push('abort'); listener({ type: 'agent_settled', aborted: true }); },
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
    fake.emit({ type: 'agent_settled', aborted: false });
    assert.equal(workspace.state.busy, false);
    assert.equal(existsSync(join(dir, 'run-active')), false);
    await workspace.prompt('again');
    await workspace.abort();
    assert.deepEqual(fake.calls.slice(-2), ['clear', 'abort']);
    assert.equal(workspace.state.busy, false);
    assert.equal(existsSync(join(dir, 'run-active')), false);
  } finally { await workspace.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tool cards retain arguments, reconcile results, and mark unfinished calls interrupted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tools-test-'));
  const fake = fakeAgent();
  const workspace = new Workspace(fake.agent, dir);
  try {
    await workspace.initialize();
    const args = { path: 'example.ts', edits: [{ oldText: 'before', newText: 'after' }] };
    fake.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'edit-1', name: 'edit', arguments: args }] } });
    assert.equal(workspace.state.messages.length, 1, 'no empty assistant card');
    fake.emit({ type: 'tool_execution_start', toolCallId: 'edit-1', toolName: 'edit', args });
    fake.emit({ type: 'tool_execution_update', toolCallId: 'edit-1', toolName: 'edit', partialResult: { content: [{ type: 'text', text: 'editing' }] } });
    const tool = workspace.state.messages[0].tool!;
    assert.deepEqual(tool.args, args);
    assert.equal(tool.output, 'editing');
    assert.equal(tool.status, 'running');
    fake.emit({ type: 'tool_execution_end', toolCallId: 'edit-1', toolName: 'edit', isError: false, result: { content: [{ type: 'text', text: 'Done' }] } });
    fake.emit({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'edit-1', toolName: 'edit', content: [{ type: 'text', text: 'Done' }] } });
    assert.equal(workspace.state.messages.length, 1);
    assert.equal(tool.status, 'succeeded');
    assert.ok(tool.endedAt! >= tool.startedAt!);
    assert.deepEqual(workspace.state.tools, {});
    fake.emit({ type: 'tool_execution_start', toolCallId: 'bash-1', toolName: 'bash', args: { command: 'sleep 10' } });
    fake.emit({ type: 'agent_settled', aborted: true });
    assert.equal(workspace.state.messages[1].tool?.status, 'interrupted');
    assert.equal(tool.status, 'succeeded');
    fake.emit({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'orphan', toolName: 'custom', isError: true, content: [{ type: 'text', text: 'Failed' }] } });
    assert.equal(workspace.state.messages[2].tool?.status, 'failed');
  } finally { await workspace.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('history reconstructs joined tool cards without inventing execution times', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tool-history-test-'));
  const fake = fakeAgent();
  fake.agent.getEntries = async () => ({ leafId: 'b', entries: [
    { id: 'a', parentId: null, type: 'message', message: { role: 'assistant', content: [
      { type: 'toolCall', id: 'complete', name: 'read', arguments: { path: 'file.ts' } },
      { type: 'toolCall', id: 'unfinished', name: 'custom', arguments: {} },
    ] } },
    { id: 'b', parentId: 'a', type: 'message', message: { role: 'toolResult', toolCallId: 'complete', toolName: 'read', content: [{ type: 'text', text: 'file content' }] } },
  ] }) as Awaited<ReturnType<Agent['getEntries']>>;
  const workspace = new Workspace(fake.agent, dir);
  try {
    await workspace.initialize();
    assert.equal(workspace.state.messages.length, 2);
    const tool = workspace.state.messages[0].tool!;
    assert.equal(tool.status, 'succeeded');
    assert.equal(tool.output, 'file content');
    assert.equal(tool.args.path, 'file.ts');
    assert.equal(tool.startedAt, undefined);
    assert.equal(tool.endedAt, undefined);
    assert.equal(workspace.state.messages[1].tool?.status, 'interrupted');
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
