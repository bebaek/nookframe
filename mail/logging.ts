import pino from 'pino';
import { createHash, randomUUID } from 'node:crypto';
import type { DestinationStream } from 'pino';
import { diagnosticErrorCodes } from './diagnostics.js';

export type MailEvent = 'mail.scheduler.started' | 'mail.scheduler.stopping' | 'mail.scheduler.stopped' | 'mail.scheduler.error'
  | 'mail.scheduler.health' | 'mail.job.dispatched' | 'mail.job.started' | 'mail.job.phase_changed'
  | 'mail.job.succeeded' | 'mail.job.failed' | 'mail.job.skipped' | 'mail.worker.exited'
  | 'mail.polling.changed' | 'mail.job.blocked' | 'mail.job.unblocked';
export interface MailLogFields {
  accountId?: string; attemptId?: string; work?: 'sync' | 'index'; scheduled?: boolean;
  phase?: string; durationMs?: number; nextRetryAt?: string | null; indexNextRetryAt?: string | null; failures?: number;
  indexDeferred?: boolean; downloadCompleted?: boolean;
  errorCode?: string; enabled?: boolean; reason?: string; exitCode?: number | null; signal?: string | null;
  activeWorkers?: number; enabledAccounts?: number; overdueAccounts?: number; oldestOverdueMs?: number;
  lockedAccounts?: number; capacityBlockedAccounts?: number; checkIntervalMs?: number; concurrency?: number;
  latenessMs?: number;
}
export type MailLog = (event: MailEvent, fields?: MailLogFields, level?: 'info' | 'warn' | 'error') => void;
const errors = new Set([...diagnosticErrorCodes, 'MAIL_BUSY', 'SYNC_FAILED', 'INDEX_FAILED', 'MAIL_COMMAND_FAILED', 'MAIL_OPERATION_FAILED', 'SCHEDULER_FAILED', 'WORKER_SPAWN_FAILED']);
export function safeMailError(error: unknown, fallback = 'MAIL_OPERATION_FAILED') {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && errors.has(code) ? code : fallback;
}
export function logAccountId(id: string) {
  return /^m[a-f0-9]{31}$/.test(id) ? id : `legacy-${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
}
export function mailAttemptId() {
  const id = process.env.NOOKFRAME_MAIL_ATTEMPT_ID;
  return id && /^[a-f0-9-]{36}$/.test(id) ? id : randomUUID();
}
// Finite field projection is intentional: never serialize errors, account objects,
// subprocess output, command arguments, diagnostic text or environment mappings.
export function createMailLog(destination: DestinationStream = process.stderr): MailLog {
  const logger = pino({ base: { service: 'nookframe', component: 'mail', slot: ['a', 'b'].includes(process.env.NOOKFRAME_SLOT ?? '') ? process.env.NOOKFRAME_SLOT : 'unknown' },
    timestamp: pino.stdTimeFunctions.isoTime, formatters: { level: label => ({ level: label }) } }, destination);
  const numeric = ['durationMs', 'failures', 'activeWorkers', 'enabledAccounts', 'overdueAccounts', 'oldestOverdueMs', 'lockedAccounts', 'capacityBlockedAccounts', 'checkIntervalMs', 'concurrency', 'latenessMs'] as const;
  return (event, fields = {}, level = 'info') => {
    const safe: Record<string, unknown> = { event };
    if (fields.accountId) safe.accountId = logAccountId(fields.accountId);
    if (fields.attemptId && /^[a-f0-9-]{36}$/.test(fields.attemptId)) safe.attemptId = fields.attemptId;
    if (fields.work === 'sync' || fields.work === 'index') safe.work = fields.work;
    for (const key of ['scheduled', 'enabled', 'indexDeferred', 'downloadCompleted'] as const) if (typeof fields[key] === 'boolean') safe[key] = fields[key];
    for (const key of numeric) if (Number.isSafeInteger(fields[key]) && fields[key]! >= 0) safe[key] = fields[key];
    if (fields.errorCode) safe.errorCode = errors.has(fields.errorCode) ? fields.errorCode : 'MAIL_OPERATION_FAILED';
    if (['preparing', 'download', 'index', 'complete'].includes(fields.phase ?? '')) safe.phase = fields.phase;
    if (['paused', 'not_due', 'locked', 'capacity', 'shutdown', 'completed', 'spawn_failed', 'unexpected_exit'].includes(fields.reason ?? '')) safe.reason = fields.reason;
    for (const key of ['nextRetryAt', 'indexNextRetryAt'] as const) {
      const value = fields[key];
      if (value === null || (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))) safe[key] = value;
    }
    if (fields.exitCode === null || (Number.isInteger(fields.exitCode) && fields.exitCode! >= 0 && fields.exitCode! <= 255)) safe.exitCode = fields.exitCode;
    if (['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV'].includes(fields.signal ?? '')) safe.signal = fields.signal;
    logger[level](safe);
  };
}
export const mailLog = createMailLog();
