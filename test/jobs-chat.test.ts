import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const input = { name: 'Report review', prompt: 'Review only the approved report. 한글 🌱', schedule: { kind: 'weekly', time: '08:00', timezone: 'Europe/Berlin', days: [1] }, notify: 'attention', timeoutSeconds: 300 };
test('chat CLI: capabilities, JSON data input, revision conflicts and exact run lookup', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-chat-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  async function call(args: string[], stdin = '', configured = true) {
    const child = spawn(process.execPath, [resolve('dist/server/jobs/cli.js'), 'jobs', ...args], {
      env: { ...process.env, NOOKFRAME_JOBS_DIR: dir, NOOKFRAME_JOBS_SLOT: configured ? 'b' : '', NOOKFRAME_SLOT: 'a' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => { stdout += text; }); child.stderr.on('data', text => { stderr += text; });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    return { code, stdout, stderr };
  }
  const capabilities = JSON.parse((await call(['status'])).stdout);
  assert.deepEqual(capabilities, { schedulingAvailable: false, notificationsAvailable: false, manualExecutionConfigured: true, configuredRunnerSlot: 'b', currentSlot: 'a', runnerLiveness: 'unknown', toolProfile: 'filesystem-read-only', tools: ['read', 'grep', 'find', 'ls'] });
  assert.equal(JSON.parse((await call(['status'], '', false)).stdout).manualExecutionConfigured, false);
  const created = await call(['create', '--file', '-'], JSON.stringify(input));
  assert.equal(created.code, 0, created.stderr);
  const job = JSON.parse(created.stdout);
  assert.equal(job.prompt, input.prompt);
  assert.equal(job.enabled, false);
  const updated = await call(['update', job.id, '--revision', '1', '--file', '-'], JSON.stringify({ name: 'New name' }));
  assert.equal(JSON.parse(updated.stdout).revision, 2);
  assert.equal((await call(['update', job.id, '--revision', '1', '--file', '-'], '{}')).code, 1);
  const requestId = randomUUID();
  const args = ['run', job.id, '--revision', '2', '--request-id', requestId];
  assert.equal((await call(args, '', false)).code, 1);
  assert.equal(JSON.parse((await call(args)).stdout).status, 'queued');
  const run = JSON.parse((await call(['run-show', requestId])).stdout);
  assert.equal(run.job.name, 'New name');
  assert.equal(run.job.revision, 2);
  assert.equal((await call(['run-show', randomUUID()])).code, 1);
  assert.equal(JSON.parse((await call(['cancel', requestId])).stdout).status, 'cancelled');
  assert.equal(JSON.parse((await call(['run-show', requestId])).stdout).status, 'cancelled');
  assert.equal(JSON.parse((await call(args)).stdout).status, 'cancelled', 'same approved UUID never launches again');
  const malformed = await call(['create', '--file', '-'], '{"prompt":"PRIVATE_PROMPT_SENTINEL",broken');
  assert.equal(malformed.code, 1);
  assert.doesNotMatch(malformed.stderr, /PRIVATE_PROMPT_SENTINEL/);
  assert.match(malformed.stderr, /Invalid job JSON/);
  const oversized = await call(['create', '--file', '-'], JSON.stringify({ ...input, prompt: 'x'.repeat(70000) }));
  assert.equal(oversized.code, 1);
  assert.match(oversized.stderr, /64 KiB/);
});
