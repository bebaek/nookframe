import { resolve, join } from 'node:path';
import { CalendarStore } from './store.js';
import { CalendarOAuth } from './oauth.js';

export function calendarRuntime() {
  const stateDir = resolve(process.env.STATE_DIR ?? '.local/state');
  const store = new CalendarStore(resolve(process.env.CALENDAR_DIR ?? join(stateDir, '..', 'calendar')));
  const oauth = new CalendarOAuth(store, process.env.PUBLIC_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`);
  return { store, oauth };
}
