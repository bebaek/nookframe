import { CalendarStore, CalendarError, alias } from './store.js';
import { existsSync, readFileSync } from 'node:fs';

export class CalendarAPI {
  constructor(readonly store: CalendarStore, private oauth: { accessToken(name: string): Promise<string> }, private request: typeof fetch = fetch, private now: () => number = Date.now) {}
  private selectionPath(name: string) { return this.store.path('selections', alias(name) + '.json'); }
  selected(name: string): string[] {
    this.store.account(name);
    const path = this.selectionPath(name);
    if (!existsSync(path)) return [];
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.ids) || data.ids.length > 100 || !data.ids.every(validId)) throw new Error();
      return data.ids;
    } catch { throw new CalendarError('INVALID_CALENDAR_SELECTION'); }
  }
  private async pages(name: string, path: string, params: Record<string, string>) {
    const token = await this.oauth.accessToken(name);
    const items: Record<string, any>[] = [];
    const seen = new Set<string>();
    let pageToken = '';
    for (let page = 0; page < 200; page++) {
      const url = new URL('https://www.googleapis.com/calendar/v3/' + path);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      let response: Response;
      try { response = await this.request(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
      catch { throw new CalendarError('CALENDAR_REQUEST_FAILED'); }
      if (!response.ok) throw new CalendarError(response.status === 401 ? 'RECONNECT_ACCOUNT' : response.status === 403 ? 'CALENDAR_ACCESS_DENIED' : response.status === 429 ? 'CALENDAR_RATE_LIMITED' : 'CALENDAR_REQUEST_FAILED');
      let data;
      try { data = await response.json(); } catch { throw new CalendarError('INVALID_CALENDAR_RESPONSE'); }
      if (!data || typeof data !== 'object' || Array.isArray(data) || (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string') || (data.items !== undefined && (!Array.isArray(data.items) || data.items.some((x: unknown) => !x || typeof x !== 'object' || Array.isArray(x))))) throw new CalendarError('INVALID_CALENDAR_RESPONSE');
      items.push(...(data.items ?? []));
      if (items.length > 50000) throw new CalendarError('CALENDAR_RESULT_LIMIT');
      if (!data.nextPageToken) return items;
      if (typeof data.nextPageToken !== 'string' || seen.has(data.nextPageToken)) throw new CalendarError('INVALID_CALENDAR_RESPONSE');
      pageToken = data.nextPageToken; seen.add(pageToken);
    }
    throw new CalendarError('CALENDAR_RESULT_LIMIT');
  }
  async calendars(name: string) {
    const selected = this.selected(name);
    const items = await this.pages(name, 'users/me/calendarList', { maxResults: '250', showHidden: 'true' });
    return items.filter(c => !c.deleted).map(c => {
      if (!validId(c.id)) throw new CalendarError('INVALID_CALENDAR_RESPONSE');
      return { id: c.id as string, summary: text(c.summaryOverride) ?? text(c.summary), timeZone: text(c.timeZone), primary: c.primary === true, accessRole: text(c.accessRole), selected: selected.includes(c.id) };
    });
  }
  async select(name: string, ids: string[]) {
    if (!ids.length || ids.length > 100 || !ids.every(validId)) throw new CalendarError('INVALID_CALENDAR_SELECTION');
    const available = await this.calendars(name);
    if (ids.some(id => !available.some(c => c.id === id && ['owner', 'writer', 'reader'].includes(c.accessRole ?? '')))) throw new CalendarError('CALENDAR_NOT_READABLE');
    const selected = [...new Set(ids)];
    this.store.write(this.selectionPath(name), { version: 1, ids: selected });
    return selected;
  }
  clear(name: string) {
    this.store.account(name);
    this.store.write(this.selectionPath(name), { version: 1, ids: [] });
    return [];
  }
  async agenda(name: string, days = 7) {
    if (!Number.isInteger(days) || days < 1 || days > 31) throw new CalendarError('INVALID_AGENDA_DAYS');
    const ids = this.selected(name);
    if (!ids.length) throw new CalendarError('NO_CALENDARS_SELECTED');
    const timeMin = new Date(this.now()).toISOString();
    const timeMax = new Date(Date.parse(timeMin) + days * 86400000).toISOString();
    const events = [];
    for (const id of ids) {
      const items = await this.pages(name, `calendars/${encodeURIComponent(id)}/events`, { timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', showDeleted: 'false', maxResults: '2500' });
      for (const event of items) {
        if (event.status === 'cancelled') continue;
        if (!validId(event.id)) throw new CalendarError('INVALID_CALENDAR_RESPONSE');
        events.push({ calendarId: id, id: text(event.id), summary: text(event.summary), status: text(event.status), start: eventTime(event.start), end: eventTime(event.end), location: text(event.location) });
        if (events.length > 50000) throw new CalendarError('CALENDAR_RESULT_LIMIT');
      }
    }
    // Preserve date-only all-day boundaries and provider time zones, never convert
    // them into misleading UTC appointments. Date-only entries sort by date.
    events.sort((a, b) => sortTime(a.start) - sortTime(b.start) || a.calendarId.localeCompare(b.calendarId));
    return { timeMin, timeMax, events };
  }
}
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x20\x7f]/.test(value); }
function text(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function eventTime(value: any): { date?: string; dateTime?: string; timeZone?: string } {
  if (typeof value?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.date) && Number.isFinite(Date.parse(value.date))) return { date: value.date };
  if (typeof value?.dateTime === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value.dateTime) && Number.isFinite(Date.parse(value.dateTime))) return { dateTime: value.dateTime, timeZone: text(value.timeZone) };
  throw new CalendarError('INVALID_CALENDAR_RESPONSE');
}
function sortTime(value: { date?: string; dateTime?: string }) { return Date.parse(value.dateTime ?? value.date!); }
