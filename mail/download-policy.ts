import { DOWNLOAD_SCOPE } from './config.js';
import { MailError, type SyncStatus } from './store.js';

export function downloadTimeout(previous: SyncStatus | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const override = env.MAIL_SYNC_TIMEOUT_MINUTES;
  if (override !== undefined) {
    // No zero/infinite deadline; cap at a day and stay within Node timer limits.
    if (!/^[1-9][0-9]*$/.test(override) || Number(override) > 1440) throw new MailError('INVALID_MAIL_CONFIG');
    return Number(override) * 60000;
  }
  return previous?.completedDownloadScope === DOWNLOAD_SCOPE ? 15 * 60000 : 6 * 60 * 60000;
}
