import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { JobStore } from './store.js';
import { nextOccurrence } from './schedules.js';

async function readInput(path: string): Promise<unknown> {
  let text = '';
  if (path === '-') {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      text += chunk.toString();
      if (Buffer.byteLength(text) > 65536) throw new Error('Job input exceeds 64 KiB');
    }
  } else text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > 65536) throw new Error('Job input exceeds 64 KiB');
  try { return JSON.parse(text); } catch { throw new Error('Invalid job JSON'); }
}

const usage = 'Usage: nookframe jobs status | list | show ID | create --file FILE | update ID --revision N --file FILE | delete ID --revision N | preview ID | run ID --revision N --request-id UUID | runs [ID] | run-show RUN_ID | cancel RUN_ID';
async function main() {
  const [group, command, ...args] = process.argv.slice(2);
  if (group !== 'jobs') throw new Error(usage);
  const store = new JobStore(resolve(process.env.NOOKFRAME_JOBS_DIR ?? join(process.env.STATE_DIR ?? '.local/state', 'jobs')));
  let result: unknown;
  if (command === 'status' && !args.length) result = {
    schedulingAvailable: false, notificationsAvailable: false,
    manualExecutionConfigured: !!process.env.NOOKFRAME_JOBS_SLOT,
    configuredRunnerSlot: process.env.NOOKFRAME_JOBS_SLOT || null,
    currentSlot: process.env.NOOKFRAME_SLOT || null,
    runnerLiveness: 'unknown',
    toolProfile: 'filesystem-read-only', tools: ['read', 'grep', 'find', 'ls'],
  };
  else if (command === 'list' && !args.length) result = await store.list();
  else if (command === 'show' && args.length === 1) result = await store.get(args[0]);
  else if (command === 'preview' && args.length === 1) {
    const job = await store.get(args[0]);
    result = { id: job.id, enabled: job.enabled, nextScheduledOccurrence: nextOccurrence(job.schedule, new Date()), schedulingAvailable: false, manualExecutionConfigured: !!process.env.NOOKFRAME_JOBS_SLOT };
  } else if (command === 'create' && args.length === 2 && args[0] === '--file') result = await store.create(await readInput(args[1]));
  else if (command === 'update' && args.length === 5 && args[1] === '--revision' && /^[1-9]\d*$/.test(args[2]) && args[3] === '--file') result = await store.update(args[0], Number(args[2]), await readInput(args[4]));
  else if (command === 'delete' && args.length === 3 && args[1] === '--revision' && /^[1-9]\d*$/.test(args[2])) result = await store.delete(args[0], Number(args[2]));
  else if (command === 'runs' && args.length <= 1) result = await store.runs(args[0]);
  else if (command === 'run-show' && args.length === 1) result = await store.getRun(args[0]);
  else if (command === 'cancel' && args.length === 1) result = await store.cancelRun(args[0]);
  else if (command === 'run' && args.length === 5 && args[1] === '--revision' && /^[1-9]\d*$/.test(args[2]) && args[3] === '--request-id') {
    if (!process.env.NOOKFRAME_JOBS_SLOT) throw new Error('Configure NOOKFRAME_JOBS_SLOT on the server and CLI before requesting background work');
    result = await store.requestRun(args[0], Number(args[2]), args[4]);
  }
  else if (['resume', 'pause'].includes(command)) throw new Error('Scheduling is not implemented yet; definitions remain paused. Use run for manual execution.');
  else throw new Error(usage);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
main().catch(error => { process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : 'Job command failed' }) + '\n'); process.exitCode = 1; });
