import { MailError } from './store.js';

// A large local archive can need much longer than five minutes, even when the
// remote download failed. Use the same policy for automatic and index-only work.
export function indexTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = env.MAIL_INDEX_TIMEOUT_MINUTES;
  if (minutes === undefined) return 60 * 60000;
  if (!/^[1-9][0-9]*$/.test(minutes) || Number(minutes) > 1440) throw new MailError('INVALID_MAIL_CONFIG');
  return Number(minutes) * 60000;
}
