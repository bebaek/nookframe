import { useState } from 'react';
import { parseClientContext, validTimezone, type ClientContext } from '../shared/client-context';

const storageKey = 'nookframe.client-context';
interface Preferences { shareTimezone: boolean; timezone: string; shareCity: boolean; city: string }
const defaults: Preferences = { shareTimezone: true, timezone: '', shareCity: false, city: '' };
function load(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    return {
      shareTimezone: typeof saved.shareTimezone === 'boolean' ? saved.shareTimezone : true,
      timezone: typeof saved.timezone === 'string' && validTimezone(saved.timezone) ? saved.timezone : '',
      shareCity: saved.shareCity === true,
      city: typeof saved.city === 'string' ? saved.city.slice(0, 120).replace(/[\x00-\x1f\x7f]/g, '') : '',
    };
  } catch { return defaults; }
}
export function browserTimezone(): string {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timezone && validTimezone(timezone) ? timezone : '';
  }
  catch { return ''; }
}
export function useClientContext() {
  const [preferences, setPreferences] = useState(load);
  const [storageFailed, setStorageFailed] = useState(false);
  function update(changes: Partial<Preferences>) {
    const next = { ...preferences, ...changes };
    setPreferences(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); setStorageFailed(false); }
    catch { setStorageFailed(true); }
  }
  function context(): ClientContext | undefined {
    const timezone = preferences.timezone || browserTimezone();
    return parseClientContext({
      ...(preferences.shareTimezone && timezone ? { timezone, timezoneSource: preferences.timezone ? 'manual' : 'browser' } : {}),
      ...(preferences.shareCity && preferences.city.trim() ? { city: preferences.city.trim() } : {}),
    });
  }
  const invalidTimezone = preferences.shareTimezone && !!preferences.timezone && !validTimezone(preferences.timezone);
  const settings = <section className="client-context-settings" aria-label="Client context">
    <h3>Client context</h3>
    <label><input type="checkbox" checked={preferences.shareTimezone} onChange={e => update({ shareTimezone: e.target.checked })} /> Share timezone</label>
    <label htmlFor="client-timezone">Timezone override (optional)</label>
    <input id="client-timezone" value={preferences.timezone} placeholder={browserTimezone() || 'Auto-detect'} maxLength={100} disabled={!preferences.shareTimezone} onChange={e => update({ timezone: e.target.value })} aria-invalid={invalidTimezone} />
    {invalidTimezone && <small role="alert">Enter an IANA timezone, such as Asia/Seoul, or leave blank for automatic detection.</small>}
    <label><input type="checkbox" checked={preferences.shareCity} onChange={e => update({ shareCity: e.target.checked })} /> Share approximate city</label>
    <label htmlFor="client-city">City (optional)</label>
    <input id="client-city" value={preferences.city} placeholder="City, country" maxLength={120} disabled={!preferences.shareCity} onChange={e => update({ city: e.target.value.replace(/[\x00-\x1f\x7f]/g, '') })} />
    <small>Saved in this browser. Shared with the model on your next message, not added as chat metadata. Answers may mention it. No GPS or location permission.</small>
    {storageFailed && <small role="status">Browser storage unavailable; preferences apply only to this page.</small>}
  </section>;
  return { context, settings, invalidTimezone };
}
