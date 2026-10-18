import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { CalendarStore, CalendarError, alias } from './store.js';
import { CALENDAR_WRITE_SCOPE } from './oauth.js';

type Body = Record<string, any>;
type Operation = { version: 1; id: string; account: string; subject: string; clientId: string; calendarId: string; eventId: string; action: 'create' | 'update' | 'delete'; before: Body | null; after: Body | null; patch: Body | null; etag?: string; expiresAt: number; confirmation: string; status: 'ready' | 'submitting' | 'complete' | 'rejected' | 'unknown' };
const fail = (code: string): never => { throw new CalendarError(code); };
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/[\x00-\x20\x7f]/.test(v);
const object = (v: unknown): v is Body => !!v && typeof v === 'object' && !Array.isArray(v);
const digest = (op: Operation) => {
  const { confirmation, status, ...content } = op;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
};

/** Writes never retry automatically. Every submission is durably recorded first. */
export class CalendarEvents {
  constructor(readonly store: CalendarStore, private oauth: { accessToken(name: string, write?: boolean): Promise<string> }, private request: typeof fetch = fetch, private now: () => number = Date.now) {}
  private configPath(name: string) { return this.store.path('writes', alias(name) + '.json'); }
  enabled(name: string): string[] {
    this.store.account(name);
    const path = this.configPath(name);
    if (!existsSync(path)) return [];
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.ids) || data.ids.length > 100 || !data.ids.every(id)) throw new Error();
      return data.ids;
    } catch { return fail('INVALID_WRITE_CONFIGURATION'); }
  }
  private async call(name: string, path: string, method = 'GET', body?: Body, etag?: string) {
    // Obtain/refresh credentials before the mutation is marked submitting by apply.
    const token = await this.oauth.accessToken(name, method !== 'GET');
    return this.send(token, path, method, body, etag);
  }
  private async send(token: string, path: string, method: string, body?: Body, etag?: string): Promise<Body> {
    let response: Response;
    try {
      response = await this.request('https://www.googleapis.com/calendar/v3/' + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(etag ? { 'If-Match': etag } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { return fail('CALENDAR_REQUEST_UNCERTAIN'); }
    if (!response.ok) return fail(response.status === 412 ? 'EVENT_CHANGED_REVIEW_AGAIN' : response.status === 409 ? 'EVENT_ID_CONFLICT' : [400, 401, 403, 404, 410, 422, 429].includes(response.status) ? 'CALENDAR_REQUEST_REJECTED' : 'CALENDAR_REQUEST_UNCERTAIN');
    if (method === 'DELETE') return response.status === 204 ? {} : fail('CALENDAR_REQUEST_UNCERTAIN');
    try {
      if (!response.body) throw new Error();
      const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length; if (size > 1024 * 1024) { await reader.cancel(); throw new Error(); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!object(result)) throw new Error();
      return result;
    } catch { return fail('CALENDAR_REQUEST_UNCERTAIN'); }
  }
  private calendarPath(calendar: string) {
    if (!id(calendar)) return fail('INVALID_CALENDAR_ID');
    return `calendars/${encodeURIComponent(calendar)}/events`;
  }
  private eventPath(calendar: string, event: string) {
    if (!id(event)) return fail('INVALID_EVENT_ID');
    return this.calendarPath(calendar) + '/' + encodeURIComponent(event);
  }
  private async owner(name: string, calendar: string) {
    this.calendarPath(calendar);
    const entry = await this.call(name, 'users/me/calendarList/' + encodeURIComponent(calendar));
    if (entry.id !== calendar || entry.accessRole !== 'owner') return fail('OWNED_CALENDAR_REQUIRED');
  }
  async enable(name: string, calendar: string) {
    return this.store.withWriteLock(name, async () => {
      await this.oauth.accessToken(name, true);
      if (!this.store.account(name).scopes.includes(CALENDAR_WRITE_SCOPE)) return fail('CALENDAR_WRITE_SCOPE_REQUIRED');
      await this.owner(name, calendar);
      const ids = [...new Set([...this.enabled(name), calendar])];
      if (ids.length > 100) return fail('INVALID_WRITE_CONFIGURATION');
      this.store.write(this.configPath(name), { version: 1, ids }); return ids;
    });
  }
  async disable(name: string, calendar: string) {
    return this.store.withWriteLock(name, async () => {
      const ids = this.enabled(name).filter(x => x !== calendar);
      this.store.write(this.configPath(name), { version: 1, ids });
      return ids;
    });
  }
  async get(name: string, calendar: string, event: string) {
    const value = await this.call(name, this.eventPath(calendar, event));
    if (value.id !== event) return fail('INVALID_CALENDAR_RESPONSE');
    // Return only event details, never raw provider errors or credential data.
    return { id: value.id, etag: value.etag, ...editable(value), status: value.status, recurring: !!(value.recurrence || value.recurringEventId || value.originalStartTime), hasAttendees: !!(value.attendees?.length || value.attendeesOmitted), organizerSelf: value.organizer?.self === true };
  }
  private async writable(name: string, calendar: string) {
    if (!this.enabled(name).includes(calendar)) return fail('CALENDAR_WRITES_NOT_ENABLED');
    await this.oauth.accessToken(name, true);
    if (!this.store.account(name).scopes.includes(CALENDAR_WRITE_SCOPE)) return fail('CALENDAR_WRITE_SCOPE_REQUIRED');
    await this.owner(name, calendar);
  }
  private async target(name: string, calendar: string, event: string) {
    const value = await this.call(name, this.eventPath(calendar, event));
    if (value.id !== event || typeof value.etag !== 'string' || !/^"[^"\r\n]{1,256}"$/.test(value.etag)) return fail('INVALID_CALENDAR_RESPONSE');
    if (value.recurrence || value.recurringEventId || value.originalStartTime || value.attendeesOmitted || value.attendees?.length || value.organizer?.self !== true || value.locked || value.status === 'cancelled' || (value.eventType && value.eventType !== 'default') || value.conferenceData || value.hangoutLink) return fail('UNSUPPORTED_EVENT_FOR_WRITE');
    return value;
  }
  async prepare(name: string, calendar: string, action: Operation['action'], event?: string, input?: unknown) {
    return this.store.withWriteLock(name, async () => {
      if (!['create', 'update', 'delete'].includes(action)) return fail('INVALID_EVENT_OPERATION');
      const patch = action === 'delete' ? null : validatePatch(input);
      await this.writable(name, calendar);
      const account = this.store.account(name);
      const before = action === 'create' ? null : await this.target(name, calendar, event ?? '');
      const after = action === 'delete' ? null : { ...(before ? editable(before) : {}), ...patch };
      // Google can omit timeZone on ordinary timed events. A title-only edit
      // preserves those times unchanged; changing either boundary requires a
      // fully explicit, validated pair in the preview.
      if (after && (action === 'create' || patch?.start !== undefined || patch?.end !== undefined)) validateEvent(after);
      else if (after && (typeof after.summary !== 'string' || !after.summary.trim())) return fail('EVENT_TITLE_REQUIRED');
      const op: Operation = { version: 1, id: randomBytes(16).toString('hex'), account: name, subject: account.subject, clientId: account.oauth.clientId, calendarId: calendar, eventId: before?.id ?? randomBytes(16).toString('hex'), action, before: before ? editable(before) : null, after, patch, ...(before ? { etag: before.etag } : {}), expiresAt: this.now() + 900000, confirmation: '', status: 'ready' };
      op.confirmation = digest(op); this.save(op); return op;
    });
  }
  private path(operation: string) {
    if (!/^[a-f0-9]{32}$/.test(operation)) return fail('INVALID_OPERATION_ID');
    return this.store.path('operations', operation + '.json');
  }
  status(operation: string): Operation {
    try {
      const op = JSON.parse(readFileSync(this.path(operation), 'utf8')) as Operation;
      if (op.version !== 1 || op.id !== operation || op.confirmation !== digest(op) || !['ready', 'submitting', 'complete', 'rejected', 'unknown'].includes(op.status)) throw new Error();
      return op;
    } catch { return fail('INVALID_OPERATION_RECORD'); }
  }
  private save(op: Operation) { this.store.write(this.path(op.id), op); }
  async apply(operation: string, confirmation: string) {
    const first = this.status(operation);
    return this.store.withWriteLock(first.account, async () => {
      const op = this.status(operation);
      if (op.confirmation !== confirmation) return fail('CONFIRMATION_MISMATCH');
      if (op.status !== 'ready') return fail('OPERATION_ALREADY_ATTEMPTED');
      if (op.expiresAt <= this.now()) return fail('PREVIEW_EXPIRED');
      const account = this.store.account(op.account);
      if (account.subject !== op.subject || account.oauth.clientId !== op.clientId) return fail('ACCOUNT_CHANGED_REVIEW_AGAIN');
      await this.writable(op.account, op.calendarId);
      if (op.action !== 'create') {
        const current = await this.target(op.account, op.calendarId, op.eventId);
        if (current.etag !== op.etag) return fail('EVENT_CHANGED_REVIEW_AGAIN');
      }
      const token = await this.oauth.accessToken(op.account, true);
      const fresh = this.store.account(op.account);
      if (fresh.subject !== op.subject || fresh.oauth.clientId !== op.clientId) return fail('ACCOUNT_CHANGED_REVIEW_AGAIN');
      if (op.expiresAt <= this.now()) return fail('PREVIEW_EXPIRED');
      op.status = 'submitting'; this.save(op);
      try {
        const path = op.action === 'create' ? this.calendarPath(op.calendarId) : this.eventPath(op.calendarId, op.eventId);
        const result = await this.send(token, path + '?sendUpdates=none', op.action === 'create' ? 'POST' : op.action === 'update' ? 'PATCH' : 'DELETE', op.action === 'create' ? { ...op.after, id: op.eventId } : op.patch ?? undefined, op.etag);
        if (op.action !== 'delete' && result.id !== op.eventId) return fail('CALENDAR_REQUEST_UNCERTAIN');
        op.status = 'complete'; this.save(op); return op;
      } catch (error) {
        op.status = error instanceof CalendarError && ['EVENT_CHANGED_REVIEW_AGAIN', 'EVENT_ID_CONFLICT', 'CALENDAR_REQUEST_REJECTED'].includes(error.code) ? 'rejected' : 'unknown';
        try { this.save(op); }
        catch { return fail('OPERATION_OUTCOME_UNKNOWN_CHECK_STATUS'); }
        throw new CalendarError(op.status === 'unknown' ? 'OPERATION_OUTCOME_UNKNOWN_CHECK_STATUS' : 'OPERATION_REJECTED_REVIEW_AGAIN');
      }
    });
  }
}
function editable(value: Body) {
  return Object.fromEntries(['summary', 'description', 'location', 'start', 'end'].filter(k => value[k] !== undefined).map(k => [k, value[k]]));
}
function validatePatch(input: unknown): Body {
  if (!object(input) || !Object.keys(input).length || Object.keys(input).some(k => !['summary', 'description', 'location', 'start', 'end'].includes(k))) return fail('INVALID_EVENT_INPUT');
  for (const key of ['summary', 'description', 'location']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > (key === 'description' ? 10000 : 1000) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input[key]))) return fail('INVALID_EVENT_INPUT');
  return input;
}
function validateEvent(input: Body) {
  if (typeof input.summary !== 'string' || !input.summary.trim()) return fail('EVENT_TITLE_REQUIRED');
  const start = time(input.start), end = time(input.end);
  if (start.kind !== end.kind || start.zone !== end.zone || start.value >= end.value) return fail('INVALID_EVENT_RANGE');
}
function time(value: unknown): { kind: string; value: number; zone?: string } {
  if (!object(value)) return fail('INVALID_EVENT_TIME');
  if (typeof value.date === 'string' && Object.keys(value).every(k => k === 'date') && /^\d{4}-\d{2}-\d{2}$/.test(value.date)) {
    const n = Date.parse(value.date);
    if (Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === value.date) return { kind: 'date', value: n };
  }
  if (typeof value.dateTime === 'string' && typeof value.timeZone === 'string' && Object.keys(value).every(k => ['dateTime', 'timeZone'].includes(k)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.dateTime)) {
    const n = Date.parse(value.dateTime);
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: value.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
      const p = Object.fromEntries(fmt.formatToParts(n).map(x => [x.type, x.value]));
      if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}` === value.dateTime.slice(0, 19)) return { kind: 'dateTime', value: n, zone: value.timeZone };
    } catch { /* Invalid zone/date. */ }
  }
  return fail('INVALID_EVENT_TIME');
}
