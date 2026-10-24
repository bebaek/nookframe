import type { Schedule } from './store.js';

// Preview only. Missing local minutes (spring DST) are skipped; repeated local
// minutes (fall DST) fire only at their first occurrence. Sunday = 0.
export function nextOccurrence(schedule: Schedule, after: Date): string | null {
  if (!Number.isFinite(after.getTime())) throw new Error('Invalid reference date');
  if (schedule.kind === 'once') return Date.parse(schedule.at) > after.getTime() ? new Date(schedule.at).toISOString() : null;
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = (ms: number) => Object.fromEntries(formatter.formatToParts(ms).map(p => [p.type, p.value]));
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const start = Math.floor(after.getTime() / 60000) * 60000 + 60000;
  for (let ms = start; ms < start + 15 * 86400000; ms += 60000) {
    const p = parts(ms);
    if (`${p.hour}:${p.minute}` !== schedule.time || !schedule.days.includes(weekdays.indexOf(p.weekday))) continue;
    // Inspect the preceding day for an earlier instant with the same local date
    // and minute. This also handles non-hour timezone transitions.
    let repeated = false;
    for (let earlier = ms - 86400000; earlier < ms; earlier += 60000) {
      const q = parts(earlier);
      if (['year', 'month', 'day', 'hour', 'minute'].every(k => p[k] === q[k])) { repeated = true; break; }
    }
    if (!repeated) return new Date(ms).toISOString();
  }
  return null;
}
