#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { googleStore } from './runtime.js';
import { migrateMail } from './migrate.js';
try {
  if (process.argv.slice(2).join(' ') !== 'migrate-mail --confirm') throw new Error('USAGE: googlectl migrate-mail --confirm');
  const google = googleStore();
  if (!google) throw new Error('SET_GOOGLE_DIR_FIRST');
  const mailRoot = resolve(process.env.MAIL_DIR ?? join(resolve(process.env.STATE_DIR ?? '.local/state'), '..', 'mail'));
  console.log(JSON.stringify({ version: 1, ...await migrateMail(mailRoot, google) }));
} catch (error) {
  const known = new Set(['SET_GOOGLE_DIR_FIRST', 'USAGE: googlectl migrate-mail --confirm', 'GOOGLE_CLIENT_CONFLICT', 'RECONNECT_ACCOUNT', 'MAIL_CONSENT_REQUIRED', 'ACCOUNT_ALREADY_CONNECTED', 'PAUSE_MAIL_JOBS_FIRST', 'MAIL_BUSY', 'OAUTH_CLIENT_NOT_CONFIGURED', 'ACCOUNT_NOT_CONNECTED']);
  console.log(JSON.stringify({ version: 1, error: error instanceof Error && known.has(error.message) ? error.message : 'GOOGLE_MIGRATION_FAILED' }));
  process.exitCode = 1;
}
