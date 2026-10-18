// This is an Origin-header allowlist, not a CORS policy. Public origin remains
// canonical for OAuth redirects; cookies remain host-only.
export function allowedBrowserOrigins(publicOrigin: string, configured?: string[]): Set<string> {
  const parse = (value: string): URL => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.hostname.includes('*') || url.pathname !== '/' || value.includes('?') || value.includes('#')) {
      throw new Error('Allowed origins must be HTTP(S) origins without credentials, paths, queries, or fragments');
    }
    return url;
  };
  const canonical = parse(publicOrigin);
  const origins = new Set([canonical.origin]);
  for (const value of configured ?? []) {
    const url = parse(value.trim());
    if (url.protocol !== canonical.protocol) throw new Error('Allowed origins must use the PUBLIC_ORIGIN scheme');
    origins.add(url.origin);
  }
  return origins;
}
