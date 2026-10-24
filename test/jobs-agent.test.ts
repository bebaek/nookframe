import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { ConfirmedRpcClient, backgroundArgs } from '../server/jobs/agent.js';

test('real RPC background profile declares only read tools and rejects model-requested writes', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nookframe-job-agent-'));
  const agentDir = join(dir, 'agent');
  await mkdir(agentDir);
  const forbidden = join(dir, 'must-not-exist');
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const first = requests.length === 1;
    const delta = first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'blocked-write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: forbidden, content: 'unsafe' }) } }] } : { role: 'assistant', content: 'Read-only review complete.' };
    for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [choice] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'fixture', models: [{ id: 'fixture', contextWindow: 16000, maxTokens: 1000 }] } } }));
  // Configured tools and executable resources must not widen the profile.
  const extension = join(dir, 'unexpected-extension.js');
  await writeFile(extension, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(forbidden)}, 'loaded'); export default () => {};`);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultTools: ['bash', 'write', 'edit'], extensions: [extension], skills: [resolve('skills/jobs/SKILL.md')] }));
  const client = new ConfirmedRpcClient({ cliPath: resolve('dist/server/jobs/pi-worker.js'), cwd: dir, env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0' }, provider: 'fixture', model: 'fixture', args: ['--no-session', ...backgroundArgs] });
  try {
    await client.start();
    assert.deepEqual(await client.getCommands(), []);
    await client.promptAndWait('Review the report.');
    assert.ok(requests.length >= 2);
    for (const request of requests) assert.deepEqual(request.tools.map((t: any) => t.function.name).sort(), ['find', 'grep', 'ls', 'read']);
    await assert.rejects(access(forbidden));
    assert.ok((await client.getMessages()).some(m => m.role === 'toolResult' && m.isError));
    const child = (client as unknown as { process: ChildProcess }).process;
    await client.stop();
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'stop confirms actual process exit');
  } finally {
    await client.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('confirmed stop waits for SIGKILL exit when graceful termination is ignored', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nookframe-stop-'));
  const script = join(dir, 'child.js');
  await writeFile(script, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");
  const client = new ConfirmedRpcClient({ cliPath: script, cwd: dir });
  try {
    await client.start();
    const child = (client as unknown as { process: ChildProcess }).process;
    await client.stop();
    assert.equal(child.signalCode, 'SIGKILL');
  } finally { await client.stop(); await rm(dir, { recursive: true, force: true }); }
});
