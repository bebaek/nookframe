import { resolve } from 'node:path';
import { FileStore } from './files.js';

try {
  // Share the existing agent/terminal artifact binding and state root.
  const state = process.env.NOOKFRAME_IMAGE_STATE_DIR;
  if (!state) throw new Error('Run filectl inside a Nookframe agent or terminal session');
  const args = process.argv.slice(2);
  let thread = process.env.NOOKFRAME_IMAGE_THREAD_ID || undefined;
  if (args[0] === '--thread') {
    args.shift();
    const explicit = args.shift();
    if (!explicit || (thread && explicit !== thread)) throw new Error('Explicit thread must match the agent thread binding');
    thread = explicit;
  }
  if (!thread) throw new Error('A thread binding is required; use --thread in the terminal');
  const store = new FileStore(resolve(state));
  if (args[0] === 'context' && args.length === 1) console.log(JSON.stringify(await store.context(thread)));
  else if (args[0] === 'publish' && args.length === 2) console.log(JSON.stringify(await store.publish(thread, args[1])));
  else throw new Error('Usage: filectl [--thread THREAD] context | filectl [--thread THREAD] publish FILE');
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error && !('code' in error) ? error.message : 'File operation failed; check the source and try again' }));
  process.exitCode = 1;
}
