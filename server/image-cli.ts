import { resolve } from 'node:path';
import { ArtifactStore } from './artifacts.js';

try {
  if (!process.env.NOOKFRAME_IMAGE_STATE_DIR) throw new Error('Run imagectl inside a Nookframe agent or terminal session');
  const store = new ArtifactStore(resolve(process.env.NOOKFRAME_IMAGE_STATE_DIR));
  const [command, ...args] = process.argv.slice(2);
  if (command === 'context' && !args.length) console.log(JSON.stringify(await store.context()));
  else if (command === 'publish' && args.length === 3) console.log(JSON.stringify(await store.publish(args[0], args[1], args[2])));
  else throw new Error('Usage: imagectl context | imagectl publish THREAD FILE DESCRIPTION');
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error && !('code' in error) ? error.message : 'Image operation failed; check the source file and try again' }));
  process.exitCode = 1;
}
