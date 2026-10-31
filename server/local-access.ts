import type { IncomingMessage } from 'node:http';

/** Tokenless access is intentionally IPv4-loopback only, never proxy-aware. */
export function validateLocalAccess(host: string, origin: string, allowedOrigins: string[]): void {
  const url = new URL(origin);
  if (host !== '127.0.0.1' || url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || allowedOrigins.some(value => value !== url.origin)) {
    throw new Error('Local access requires HOST=127.0.0.1, a localhost HTTP PUBLIC_ORIGIN, and no additional origins');
  }
}

export function acceptsLocalRequest(req: IncomingMessage, origin: string): boolean {
  const url = new URL(origin);
  return req.socket.remoteAddress === '127.0.0.1'
    && req.headers.host === url.host
    && (req.headers.origin === undefined || req.headers.origin === url.origin)
    && !Object.keys(req.headers).some(key => key === 'forwarded' || key.startsWith('x-forwarded-'))
    && (!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])));
}
