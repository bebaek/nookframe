import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { JobStore } from './store.js';
import { nextOccurrence } from './schedules.js';

const usage = 'Usage: nookframe jobs list | show ID | create --file FILE | update ID --revision N --file FILE | delete ID --revision N | preview ID | run ID --revision N --request-id UUID | runs [ID] | cancel RUN_ID';
async function main() {
  const [group, command, ...args] = process.argv.slice(2);
  if (group !== 'jobs') throw new Error(usage);
  const store = new JobStore(resolve(process.env.NOOKFRAME_JOBS_DIR ?? join(process.env.STATE_DIR ?? '.local/state', 'jobs')));
  let result: unknown;
  if (command === 'list' && !args.length) result = await store.list();
  else if (command === 'show' && args.length === 1) result = await store.get(args[0]);
  else if (command === 'preview' && args.length === 1) {
    const job = await store.get(args[0]);
    result = { id: job.id, enabled: job.enabled, nextScheduledOccurrence: nextOccurrence(job.schedule, new Date()), schedulingAvailable: false, manualExecutionConfigured: !!process.env.NOOKFRAME_JOBS_SLOT };
  } else if (command === 'create' && args.length === 2 && args[0] === '--file') result = await store.create(JSON.parse(await readFile(args[1], 'utf8')));
  else if (command === 'update' && args.length === 5 && args[1] === '--revision' && /^[1-9]\d*$/.test(args[2]) && args[3] === '--file') result = await store.update(args[0], Number(args[2]), JSON.parse(await readFile(args[4], 'utf8')));
  else if (command === 'delete' && args.length === 3 && args[1] === '--revision' && /^[1-9]\d*$/.test(args[2])) result = await store.delete(args[0], Number(args[2]));
  else if (command === 'runs' && args.length <= 1) result = await store.runs(args[0]);
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
