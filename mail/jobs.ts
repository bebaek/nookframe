import type { SyncStatus, IndexStatus } from './store.js';

// Derived from persisted attempt records: enabling a job never resets cooldowns.
export function retryPlan(state: SyncStatus | undefined, now = Date.now()) {
  if (!state) return { nextRetryAt: new Date(now).toISOString(), reason: 'ready' };
  // Indexing is a separate retry domain. A completed download followed by an
  // index failure/running index still uses the ordinary download cadence.
  if (state.downloadCompletedAt && state.phase === 'index') {
    return { nextRetryAt: new Date(Date.parse(state.downloadCompletedAt) + 10 * 60000).toISOString(), reason: 'periodic_sync' };
  }
  if (state.error === 'RECONNECT_ACCOUNT') return { nextRetryAt: null, reason: 'authorization_required' };
  const base = Date.parse(state.completedAt ?? state.attemptedAt);
  const reason = state.status === 'syncing' ? 'interrupted_or_running'
    : state.error === 'MAIL_QUOTA' ? 'provider_quota'
    : state.error === 'MAIL_COMMAND_FAILED' ? 'legacy_failure_cause_unknown'
    : state.status === 'ok' ? 'periodic_sync' : 'failure_backoff';
  const minutes = reason === 'provider_quota' || reason === 'legacy_failure_cause_unknown' ? 24 * 60
    : reason === 'interrupted_or_running' ? 60
    : reason === 'periodic_sync' ? 10 : Math.min(360, 5 * 2 ** Math.min(7, Math.max(0, (state.failures ?? 1) - 1)));
  return { nextRetryAt: new Date(base + minutes * 60000).toISOString(), reason };
}
export function jobDue(state: SyncStatus | undefined, now = Date.now()) {
  const plan = retryPlan(state, now);
  return plan.nextRetryAt !== null && Date.parse(plan.nextRetryAt) <= now;
}

export function indexRetryPlan(state: IndexStatus | undefined) {
  if (!state || state.status === 'ok') return { nextRetryAt: null, reason: state ? 'indexed' : 'no_index_work' };
  if (state.status === 'pending' && state.retryNotBefore) {
    return { nextRetryAt: state.retryNotBefore, reason: 'pending_index' };
  }
  const minutes = state.status === 'pending' ? 0 : state.status === 'indexing' ? 5
    : Math.min(360, 5 * 2 ** Math.min(7, Math.max(0, (state.failures ?? 1) - 1)));
  return { nextRetryAt: new Date(Date.parse(state.completedAt ?? state.attemptedAt) + minutes * 60000).toISOString(),
    reason: state.status === 'pending' ? 'pending_index' : state.status === 'indexing' ? 'interrupted_or_running' : 'index_failure_backoff' };
}

// Index recovery has priority when both domains are due; a normal sync already
// indexes afterward. Missing legacy index state alone must not index empty accounts.
export function nextMailWork(sync: SyncStatus | undefined, index: IndexStatus | undefined, now = Date.now()): 'index' | 'sync' | undefined {
  const retry = indexRetryPlan(index);
  if (retry.nextRetryAt && Date.parse(retry.nextRetryAt) <= now) return 'index';
  if (jobDue(sync, now)) return 'sync';
  return undefined;
}
