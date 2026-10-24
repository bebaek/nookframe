import { useEffect, useState } from 'react';
import { parseClientContext, validTimezone, type ClientContext } from '../shared/client-context';

const storageKey = 'nookframe.client-context';
interface Preferences { shareTimezone: boolean; timezone: string; shareCity: boolean; city: string; shareLocation: boolean }
const defaults: Preferences = { shareTimezone: true, timezone: '', shareCity: false, city: '', shareLocation: true };
function load(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    return {
      shareTimezone: typeof saved.shareTimezone === 'boolean' ? saved.shareTimezone : true,
      timezone: typeof saved.timezone === 'string' && validTimezone(saved.timezone) ? saved.timezone : '',
      shareCity: saved.shareCity === true,
      shareLocation: saved.shareLocation !== false,
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
  const [location, setLocation] = useState<ClientContext['location']>();
  const [locationStatus, setLocationStatus] = useState('Requesting browser location… This may take up to 60 seconds.');
  const [locationPending, setLocationPending] = useState(false);
  const [locationAttempt, setLocationAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLocation(undefined);
    setLocationPending(false);
    if (!preferences.shareLocation) return;
    if (!navigator.geolocation || !window.isSecureContext) {
      setLocationStatus('Browser location unavailable. Use a manual city instead.');
      return;
    }
    setLocationPending(true);
    setLocationStatus('Requesting browser location… This may take up to 60 seconds.');
    navigator.geolocation.getCurrentPosition(position => {
      if (cancelled) return;
      setLocationPending(false);
      setLocation({
        latitude: Math.round(position.coords.latitude * 100) / 100,
        longitude: Math.round(position.coords.longitude * 100) / 100,
        source: 'browser',
      });
      setLocationStatus('Approximate location available for your next message.');
    }, error => {
      if (cancelled) return;
      setLocationPending(false);
      setLocationStatus(error.code === 1
        ? 'Location permission denied. Check browser and device permissions, then retry or use a manual city.'
        : error.code === 2
          ? 'Browser could not determine your location. Check device location services, then retry or use a manual city.'
          : error.code === 3
            ? 'Location lookup timed out after 60 seconds. Retry or use a manual city.'
            : 'Browser location unavailable. Retry or use a manual city.');
    }, { enableHighAccuracy: false, timeout: 60000, maximumAge: 300000 });
    return () => { cancelled = true; };
  }, [preferences.shareLocation, locationAttempt]);
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
      ...(preferences.shareLocation && location ? { location } : {}),
    });
  }
  const invalidTimezone = preferences.shareTimezone && !!preferences.timezone && !validTimezone(preferences.timezone);
  const settings = <section className="client-context-settings" aria-label="Client context">
    <h3>Client context</h3>
    <label><input type="checkbox" checked={preferences.shareTimezone} onChange={e => update({ shareTimezone: e.target.checked })} /> Share timezone</label>
    <label htmlFor="client-timezone">Timezone override (optional)</label>
    <input id="client-timezone" value={preferences.timezone} placeholder={browserTimezone() || 'Auto-detect'} maxLength={100} disabled={!preferences.shareTimezone} onChange={e => update({ timezone: e.target.value })} aria-invalid={invalidTimezone} />
    {invalidTimezone && <small role="alert">Enter an IANA timezone, such as Asia/Seoul, or leave blank for automatic detection.</small>}
    <label><input type="checkbox" checked={preferences.shareLocation} onChange={e => update({ shareLocation: e.target.checked })} /> Share approximate browser location</label>
    {preferences.shareLocation && <>
      <small role="status">{locationStatus}</small>
      <button type="button" disabled={locationPending} onClick={() => setLocationAttempt(attempt => attempt + 1)}>Retry location</button>
    </>}
    <label><input type="checkbox" checked={preferences.shareCity} onChange={e => update({ shareCity: e.target.checked })} /> Share approximate city</label>
    <label htmlFor="client-city">City (optional)</label>
    <input id="client-city" value={preferences.city} placeholder="City, country" maxLength={120} disabled={!preferences.shareCity} onChange={e => update({ city: e.target.value.replace(/[\x00-\x1f\x7f]/g, '') })} />
    <small>Preferences and manual city are saved in this browser. Automatic location requires browser permission; coordinates are rounded to two decimals (roughly 1 km latitude), kept only in page memory, and shared with the model on your next message. Not added as chat metadata; answers may mention it. Turn location sharing off to stop, or use Retry location to request it again.</small>
    {storageFailed && <small role="status">Browser storage unavailable; preferences apply only to this page.</small>}
  </section>;
  return { context, settings, invalidTimezone };
}
