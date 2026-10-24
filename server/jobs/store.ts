import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';

export type Schedule = { kind: 'once'; at: string } | { kind: 'weekly'; time: string; timezone: string; days: number[] };
export interface JobInput { name: string; prompt: string; schedule: Schedule; notify: 'always' | 'attention'; timeoutSeconds: number }
export interface Job extends JobInput { id: string; revision: number; enabled: boolean; createdAt: string; updatedAt: string }
export type RunStatus = 'queued' | 'running' | 'stopping' | 'completed' | 'cancelled' | 'timed_out' | 'failed' | 'uncertain';
export interface JobRun { id: string; job: Job; status: RunStatus; createdAt: string; startedAt?: string; endedAt?: string; threadId?: string; cancelRequested?: boolean; summary?: string }
interface Database { version: 1; jobs: Job[]; runs?: JobRun[] }
export const activeRun = (run: JobRun) => ['queued', 'running', 'stopping', 'uncertain'].includes(run.status);
const keys = ['name', 'prompt', 'schedule', 'notify', 'timeoutSeconds'];
export function validateInput(value: unknown): JobInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a job object');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !keys.includes(k))) throw new Error('Unknown job field');
  for (const key of ['name', 'prompt']) if (typeof v[key] !== 'string' || !(v[key] as string).trim() || (v[key] as string).length > (key === 'name' ? 200 : 20000)) throw new Error(`Invalid ${key}`);
  if (!['always', 'attention'].includes(String(v.notify))) throw new Error('notify must be always or attention');
  if (!Number.isInteger(v.timeoutSeconds) || Number(v.timeoutSeconds) < 10 || Number(v.timeoutSeconds) > 3600) throw new Error('timeoutSeconds must be 10..3600');
  const s = v.schedule as Record<string, unknown> | undefined;
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('Invalid schedule');
  if (s.kind === 'once') {
    if (Object.keys(s).some(k => !['kind', 'at'].includes(k)) || typeof s.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.test(s.at) || !Number.isFinite(Date.parse(s.at))) throw new Error('once requires an ISO datetime with timezone');
    const date = s.at.slice(0, 10);
    if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Invalid calendar date');
  } else if (s.kind === 'weekly') {
    if (Object.keys(s).some(k => !['kind', 'time', 'timezone', 'days'].includes(k)) || typeof s.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) throw new Error('weekly requires HH:MM');
    if (typeof s.timezone !== 'string' || !s.timezone) throw new Error('Explicit timezone required');
    new Intl.DateTimeFormat('en', { timeZone: s.timezone }).format();
    if (!Array.isArray(s.days) || !s.days.length || s.days.some(d => !Number.isInteger(d) || d < 0 || d > 6) || new Set(s.days).size !== s.days.length) throw new Error('days must be unique weekdays 0 (Sunday)..6');
  } else throw new Error('Schedule kind must be once or weekly');
  return structuredClone(v) as unknown as JobInput;
}

// All readers and writers participate in the same shared-directory lock. Atomic
// replacement prevents partially written catalogs; fsync covers process/host loss.
export class JobStore {
  constructor(readonly directory: string) {}
  private async transaction<T>(fn: (db: Database) => T, write = false): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let compromised = false;
    const release = await lockfile.lock(this.directory, { realpath: true, retries: { retries: 20, minTimeout: 25, maxTimeout: 100 }, onCompromised: () => { compromised = true; } });
    try {
      let db: Database;
      try { db = JSON.parse(await readFile(join(this.directory, 'jobs.json'), 'utf8')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; db = { version: 1, jobs: [] }; }
      if (db.version !== 1 || !Array.isArray(db.jobs)) throw new Error('Unsupported jobs database');
      if (db.runs !== undefined && !Array.isArray(db.runs)) throw new Error('Invalid runs database');
      for (const run of db.runs ?? []) {
        if (!run || typeof run.id !== 'string' || !run.job || typeof run.job.id !== 'string' || !['queued', 'running', 'stopping', 'completed', 'cancelled', 'timed_out', 'failed', 'uncertain'].includes(run.status) || !Number.isFinite(Date.parse(run.createdAt)) || (run.cancelRequested !== undefined && typeof run.cancelRequested !== 'boolean') || (run.threadId !== undefined && typeof run.threadId !== 'string')) throw new Error('Invalid stored run');
        const { id, revision, enabled, createdAt, updatedAt, ...input } = run.job;
        validateInput(input);
        if (!Number.isInteger(revision) || revision < 1) throw new Error('Invalid run revision');
      }
      if (new Set((db.runs ?? []).map(r => r.id)).size !== (db.runs ?? []).length) throw new Error('Duplicate run IDs');
      const ids = new Set<string>();
      for (const job of db.jobs) {
        const { id, revision, enabled, createdAt, updatedAt, ...input } = job;
        validateInput(input);
        if (typeof id !== 'string' || !id || ids.has(id) || !Number.isInteger(revision) || revision < 1 || typeof enabled !== 'boolean' || !Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) throw new Error('Invalid stored job');
        ids.add(id);
      }
      const result = fn(db);
      if (write) {
        const temp = join(this.directory, `.jobs-${randomUUID()}.tmp`);
        try {
          const file = await open(temp, 'wx', 0o600);
          try { await file.writeFile(JSON.stringify(db, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
          if (compromised) throw new Error('Job store ownership lost');
          await rename(temp, join(this.directory, 'jobs.json'));
          const dir = await open(this.directory, 'r');
          try { await dir.sync(); } finally { await dir.close(); }
        } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
      }
      return result;
    } finally { await release(); }
  }
  list() { return this.transaction(db => db.jobs); }
  async get(id: string) { const job = (await this.list()).find(j => j.id === id); if (!job) throw new Error('Job not found'); return job; }
  create(input: unknown) {
    const data = validateInput(input);
    return this.transaction(db => {
      const now = new Date().toISOString();
      const job: Job = { ...data, id: randomUUID(), revision: 1, enabled: false, createdAt: now, updatedAt: now };
      db.jobs.push(job); return job;
    }, true);
  }
  update(id: string, revision: number, patch: unknown) {
    return this.transaction(db => {
      const job = db.jobs.find(j => j.id === id);
      if (!job) throw new Error('Job not found');
      if (job.revision !== revision) throw new Error('Job changed; read it again before updating');
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !keys.includes(k))) throw new Error('Invalid patch');
      const { id: _, revision: __, enabled: ___, createdAt: ____, updatedAt: _____, ...input } = job;
      Object.assign(job, validateInput({ ...input, ...patch }), { revision: revision + 1, updatedAt: new Date().toISOString() });
      return job;
    }, true);
  }
  runs(jobId?: string) { return this.transaction(db => (db.runs ?? []).filter(r => !jobId || r.job.id === jobId)); }
  requestRun(jobId: string, revision: number, requestId: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId)) throw new Error('A UUID request ID is required');
    return this.transaction(db => {
      db.runs ??= [];
      const existing = db.runs.find(r => r.id === requestId);
      if (existing) {
        if (existing.job.id !== jobId || existing.job.revision !== revision) throw new Error('Request ID already used for another job/revision');
        return existing;
      }
      const job = db.jobs.find(j => j.id === jobId);
      if (!job || job.revision !== revision) throw new Error('Job missing or changed; read it again');
      if (db.runs.some(r => r.job.id === jobId && activeRun(r))) throw new Error('Job already has an active or uncertain run');
      const run: JobRun = { id: requestId, job: structuredClone(job), status: 'queued', createdAt: new Date().toISOString() };
      db.runs.push(run); return run;
    }, true);
  }
  cancelRun(id: string) {
    return this.transaction(db => {
      const run = db.runs?.find(r => r.id === id);
      if (!run) throw new Error('Run not found');
      if (run.status === 'uncertain') throw new Error('Termination is uncertain; inspect the owning server before recovery');
      if (run.status === 'queued') { run.status = 'cancelled'; run.endedAt = new Date().toISOString(); }
      else if (['running', 'stopping'].includes(run.status)) run.cancelRequested = true;
      return run;
    }, true);
  }
  transition(id: string, from: RunStatus[], patch: Partial<Pick<JobRun, 'status' | 'threadId' | 'startedAt' | 'endedAt' | 'summary'>>) {
    return this.transaction(db => {
      const run = db.runs?.find(r => r.id === id);
      if (!run || !from.includes(run.status)) throw new Error('Run state changed');
      Object.assign(run, patch); return run;
    }, true);
  }
  delete(id: string, revision: number) {
    return this.transaction(db => {
      const index = db.jobs.findIndex(j => j.id === id);
      if (index < 0) throw new Error('Job not found');
      if (db.jobs[index].revision !== revision) throw new Error('Job changed; read it again before deleting');
      if (db.runs?.some(r => r.job.id === id && activeRun(r))) throw new Error('Job has an active or uncertain run');
      db.jobs.splice(index, 1); return { deleted: id };
    }, true);
  }
}
