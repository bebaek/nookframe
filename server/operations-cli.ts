import { readFile } from 'node:fs/promises';

const [command, ...extra] = process.argv.slice(2);
try {
  let path: string;
  let body: string | undefined;
  if (command && ['status', 'config', 'sessions'].includes(command) && !extra.length) path = `/api/operations/${command}`;
  else if (command === 'models' && extra.length === 1) path = `/api/operations/models?threadId=${encodeURIComponent(extra[0])}`;
  else if (command === 'model-plan' && extra.length === 4 && ['thread', 'new-threads'].includes(extra[0])) {
    path = '/api/operations/models/plans';
    body = JSON.stringify({ scope: extra[0], threadId: extra[1], model: { provider: extra[2], id: extra[3] } });
  } else if (command === 'model-plan-after-run' && extra.length === 3) {
    path = '/api/operations/models/plans';
    body = JSON.stringify({ scope: 'thread', threadId: extra[0], model: { provider: extra[1], id: extra[2] }, deferUntilSettled: true });
  } else if (['model-apply', 'model-result', 'model-cancel'].includes(command ?? '') && extra.length === 1 && /^[0-9a-f-]{36}$/.test(extra[0])) {
    path = `/api/operations/models/plans/${extra[0]}${command === 'model-apply' ? '/apply' : command === 'model-cancel' ? '/cancel' : ''}`;
    if (command !== 'model-result') body = '{}';
  } else throw new Error('Usage: nookctl status|config|sessions; models THREAD; model-plan thread|new-threads THREAD PROVIDER MODEL; model-plan-after-run THREAD PROVIDER MODEL; model-apply|model-result|model-cancel PLAN');
  const url = new URL(process.env.NOOKFRAME_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !['http:', 'https:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) {
    throw new Error('NOOKFRAME_API_URL must be an HTTPS origin or loopback HTTP origin');
  }
  if (!process.env.ACCESS_TOKEN_FILE) throw new Error('ACCESS_TOKEN_FILE is required');
  const token = (await readFile(process.env.ACCESS_TOKEN_FILE, 'utf8')).trim();
  if (token.length < 32) throw new Error('Invalid access token file');
  const response = await fetch(new URL(path, url), {
    method: body === undefined ? 'GET' : 'POST', body,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Operations request failed (HTTP ${response.status})`);
  console.log(JSON.stringify(await response.json(), null, 2));
} catch (error) {
  // Never print request headers, token contents, or fetch causes.
  console.error(error instanceof Error && !['TypeError', 'AbortError', 'TimeoutError'].includes(error.name) ? error.message : 'Operations request failed');
  process.exitCode = 1;
}
