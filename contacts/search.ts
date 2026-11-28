import { CalendarError } from '../calendar/store.js';

export async function searchContacts(query: string, token: () => Promise<string>, request: typeof fetch = fetch) {
  const q = query.trim();
  if (!q || q.length > 256 || /[\x00-\x1f\x7f]/.test(q)) throw new CalendarError('INVALID_CONTACT_QUERY');
  const bearer = await token();
  async function lookup(value: string) {
    const url = new URL('https://people.googleapis.com/v1/people:searchContacts');
    url.search = new URLSearchParams({ query: value, readMask: 'names,emailAddresses', pageSize: '10', sources: 'READ_SOURCE_TYPE_CONTACT' }).toString();
    try {
      const response = await request(url, { headers: { Authorization: `Bearer ${bearer}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new CalendarError(({ 401: 'RECONNECT_ACCOUNT', 403: 'CONTACTS_ACCESS_DENIED', 429: 'CONTACTS_RATE_LIMITED' } as Record<number,string>)[response.status] ?? 'CONTACTS_REQUEST_FAILED');
      }
      if (!response.body) throw new Error();
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { value: bytes, done } = await reader.read(); if (done) break;
          if ((size += bytes.length) > 256 * 1024) { await reader.cancel(); throw new Error(); }
          chunks.push(bytes);
        }
      } finally { reader.releaseLock(); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body) || (body.results !== undefined && !Array.isArray(body.results))) throw new Error();
      return body.results ?? [];
    } catch (e) { throw e instanceof CalendarError ? e : new CalendarError('CONTACTS_REQUEST_FAILED'); }
  }
  // People API requires an empty-query warmup for its per-user search cache.
  await lookup('');
  const rows = await lookup(q);
  const fields = (values: unknown, key: string) => Array.isArray(values) ? values.flatMap(v => typeof v?.[key] === 'string' ? [v[key].slice(0, 512)] : []).slice(0, 10) : [];
  return { untrusted: true, limit: 10, results: rows.slice(0, 10).map((r: any) => ({ names: fields(r?.person?.names, 'displayName'), emails: fields(r?.person?.emailAddresses, 'value') })) };
}
