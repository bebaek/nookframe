import { join } from 'node:path';
import { CalendarOAuth } from '../calendar/oauth.js';
import { CalendarStore } from '../calendar/store.js';
import { googleStore } from '../google/runtime.js';

export function contactsRuntime() {
  const google = googleStore();
  if (!google) return undefined;
  // Independent pending state and enrollment; shared client, tokens and refresh locks.
  const store = new CalendarStore(join(google.root, 'contacts'), google);
  return new CalendarOAuth(store, process.env.PUBLIC_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`, fetch, Date.now, 'contacts');
}
