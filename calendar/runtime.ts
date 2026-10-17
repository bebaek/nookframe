import { resolve, join } from 'node:path';
import { googleStore } from '../google/runtime.js';
import { CalendarStore } from './store.js';
import { CalendarOAuth } from './oauth.js';
import { CalendarAPI } from './api.js';

export function calendarRuntime() {
  const stateDir = resolve(process.env.STATE_DIR ?? '.local/state');
  const store = new CalendarStore(resolve(process.env.CALENDAR_DIR ?? join(stateDir, '..', 'calendar')), googleStore());
  const oauth = new CalendarOAuth(store, process.env.PUBLIC_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`);
  return { store, oauth, api: new CalendarAPI(store, oauth) };
}
