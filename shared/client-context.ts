export interface ClientContext {
  timezone?: string;
  timezoneSource?: 'browser' | 'manual';
  city?: string;
}

export function validTimezone(value: string): boolean {
  if (!value || value.length > 100 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
}

// Allowlist and bound untrusted browser metadata. Never echo invalid values.
export function parseClientContext(value: unknown): ClientContext | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid client context');
  const raw = value as Record<string, unknown>;
  const result: ClientContext = {};
  if (raw.timezone !== undefined) {
    if (typeof raw.timezone !== 'string' || !validTimezone(raw.timezone)) throw new Error('Invalid client timezone');
    if (raw.timezoneSource !== 'browser' && raw.timezoneSource !== 'manual') throw new Error('Invalid timezone source');
    result.timezone = raw.timezone;
    result.timezoneSource = raw.timezoneSource;
  }
  if (raw.city !== undefined) {
    if (typeof raw.city !== 'string' || raw.city.length > 120 || /[\x00-\x1f\x7f]/.test(raw.city)) throw new Error('Invalid client city');
    if (raw.city.trim()) result.city = raw.city.trim();
  }
  return Object.keys(result).length ? result : undefined;
}
