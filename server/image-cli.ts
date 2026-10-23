import { resolve } from 'node:path';
import { ArtifactStore } from './artifacts.js';

try {
  if (!process.env.NOOKFRAME_IMAGE_STATE_DIR) throw new Error('Run imagectl inside a Nookframe agent or terminal session');
  const argv = process.argv.slice(2);
  let thread = process.env.NOOKFRAME_IMAGE_THREAD_ID || undefined;
  if (argv[0] === '--thread') {
    argv.shift();
    const explicit = argv.shift();
    if (!explicit || (thread && explicit !== thread)) throw new Error('Explicit thread must match the agent image thread binding');
    thread = explicit;
  }
  const store = new ArtifactStore(resolve(process.env.NOOKFRAME_IMAGE_STATE_DIR), thread);
  const [command, ...args] = argv;
  if (command === 'context' && !args.length) console.log(JSON.stringify(await store.context()));
  else if (command === 'publish' && args.length === 3) console.log(JSON.stringify(await store.publish(args[0], args[1], args[2])));
  else throw new Error('Usage: imagectl [--thread THREAD] context | imagectl [--thread THREAD] publish THREAD FILE DESCRIPTION');
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error && !('code' in error) ? error.message : 'Image operation failed; check the source file and try again' }));
  process.exitCode = 1;
}
