import { readFile } from 'node:fs/promises';

const [command, ...extra] = process.argv.slice(2);
try {
  if (!command || !['status', 'config', 'sessions'].includes(command) || extra.length) {
    throw new Error('Usage: nookctl status|config|sessions');
  }
  const url = new URL(process.env.NOOKFRAME_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !['http:', 'https:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) {
    throw new Error('NOOKFRAME_API_URL must be an HTTPS origin or loopback HTTP origin');
  }
  if (!process.env.ACCESS_TOKEN_FILE) throw new Error('ACCESS_TOKEN_FILE is required');
  const token = (await readFile(process.env.ACCESS_TOKEN_FILE, 'utf8')).trim();
  if (token.length < 32) throw new Error('Invalid access token file');
  const response = await fetch(new URL(`/api/operations/${command}`, url), {
    headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Operations request failed (HTTP ${response.status})`);
  console.log(JSON.stringify(await response.json(), null, 2));
} catch (error) {
  // Never print request headers, token contents, or fetch causes.
  console.error(error instanceof Error && !['TypeError', 'AbortError', 'TimeoutError'].includes(error.name) ? error.message : 'Operations request failed');
  process.exitCode = 1;
}
