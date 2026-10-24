import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type { AgentPresence, PresenceView, ResourceClaim } from '../shared/agent-presence.js';

export const PRESENCE_STALE_MS = 30_000;
const RETENTION_MS = 24 * 60 * 60_000;
const ID = /^[a-f0-9-]{36}$/;
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid presence text');
  return value.trim();
}
// Resolve symlinked ancestors even when the claimed file does not exist yet.
export function canonicalPath(value: string, cwd: string): string {
  let path = resolve(cwd, text(value, 2048));
  const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync(path), ...tail); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
      tail.unshift(basename(path)); path = dirname(path);
    }
  }
}
function parseClaims(value: unknown): ResourceClaim[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error('At most 16 claims are allowed');
  return value.map(claim => {
    if (!claim || !['path', 'resource'].includes(claim.kind)) throw new Error('Invalid claim kind');
    const key = text(claim.value, 2048);
    if (!key || (claim.kind === 'path' && (!isAbsolute(key) || normalize(key) !== key))) throw new Error('Invalid resource claim');
    return { kind: claim.kind, value: key };
  });
}
function overlaps(a: ResourceClaim, b: ResourceClaim) {
  if (a.kind !== b.kind) return false;
  if (a.value === b.value) return true;
  if (a.kind !== 'path') return false;
  const prefix = (path: string) => path.endsWith(sep) ? path : path + sep;
  return a.value.startsWith(prefix(b.value)) || b.value.startsWith(prefix(a.value));
}

// One atomic file per run, one writer per file. Claims are advisory, NOT locks:
// publishing and observing another run is deliberately not an atomic acquisition.
export class PresenceStore {
  constructor(readonly directory: string, private now = Date.now) {}
  list(): PresenceView {
    const view: PresenceView = { runs: [], conflicts: [], partial: false };
    let files: string[];
    try { files = readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return view; throw error; }
    view.partial = files.length > 200;
    const now = this.now();
    let runBytes = 0;
    for (const file of files.slice(0, 200)) {
      try {
        const path = join(this.directory, file);
        if (statSync(path).size > 48_000) throw new Error('Oversized presence record');
        const data = JSON.parse(readFileSync(path, 'utf8'));
        if (!ID.test(data.id) || file !== `${data.id}.json` || !Number.isFinite(data.startedAt) || !Number.isFinite(data.updatedAt) || data.startedAt > data.updatedAt || data.updatedAt > now + PRESENCE_STALE_MS) throw new Error('Invalid presence record');
        if (now - data.updatedAt > RETENTION_MS) continue;
        const run: AgentPresence = { id: data.id, threadId: text(data.threadId, 256), slot: text(data.slot, 80), cwd: text(data.cwd, 2048), summary: text(data.summary, 300), claims: parseClaims(data.claims), startedAt: data.startedAt, updatedAt: data.updatedAt, stale: now - data.updatedAt >= PRESENCE_STALE_MS };
        const size = Buffer.byteLength(JSON.stringify(run));
        if (runBytes + size > 40_000) { view.partial = true; continue; }
        runBytes += size; view.runs.push(run);
      } catch (error) {
        // Settlement can remove a file between readdir and read. Other failures
        // must never masquerade as an empty, safe-to-write workspace.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') view.partial = true;
      }
    }
    view.runs.sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
    let conflictBytes = 0;
    for (let i = 0; i < view.runs.length; i++) for (const b of view.runs.slice(i + 1)) {
      const a = view.runs[i];
      // One warning per pair bounds the payload even with many shared claims.
      const match = a.claims.flatMap(x => b.claims.filter(y => overlaps(x, y)).map(y => [x, y] as [ResourceClaim, ResourceClaim]))[0];
      if (match) {
        const conflict: PresenceView['conflicts'][number] = { runIds: [a.id, b.id], claims: match, stale: a.stale || b.stale };
        const size = Buffer.byteLength(JSON.stringify(conflict));
        if (conflictBytes + size > 16_000) { view.partial = true; continue; }
        conflictBytes += size; view.conflicts.push(conflict);
      }
    }
    return view;
  }
  start(identity: { threadId: string; slot: string; cwd: string }) {
    const now = this.now();
    const run: AgentPresence = { id: randomUUID(), threadId: text(identity.threadId, 256), slot: text(identity.slot, 80), cwd: canonicalPath(identity.cwd, process.cwd()), summary: '', claims: [], startedAt: now, updatedAt: now, stale: false };
    let closed = false;
    const path = join(this.directory, `${run.id}.json`);
    const save = () => {
      if (closed) return;
      run.updatedAt = this.now();
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const temp = `${path}.tmp`;
      try { writeFileSync(temp, JSON.stringify(run), { mode: 0o600 }); renameSync(temp, path); }
      finally { rmSync(temp, { force: true }); }
    };
    save();
    return {
      id: run.id,
      heartbeat: save,
      publish: (summary: string, claims: ResourceClaim[]) => {
        if (closed) throw new Error('Run has settled');
        const nextSummary = text(summary, 300);
        if (!nextSummary) throw new Error('Provide a short, non-sensitive task summary');
        const nextClaims = parseClaims(claims.map(claim => ({ ...claim, value: claim.kind === 'path' ? canonicalPath(claim.value, run.cwd) : claim.value })));
        run.summary = nextSummary; run.claims = nextClaims; save();
      },
      close: () => { closed = true; rmSync(path, { force: true }); },
    };
  }
}
