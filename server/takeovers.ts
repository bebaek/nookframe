import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import type { Takeover } from '../shared/protocol.js';

type Owner = { instance: string; slot: string; generation: string };
type Record = { threadId: string; owner?: Owner; request?: Takeover & { requester: string; generation: string; reservedUntil: number } };

// Separate from advisory agent presence. Every mutation uses a short control lock;
// the session-file lock remains the sole authority to start a writer.
export class Takeovers {
  readonly instance = randomUUID();
  private directory: string;
  private origin?: string;
  configureOrigin(origin: string) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid takeover origin');
    this.origin = url.origin;
  }
  constructor(directory: string, readonly slot: string, private now = Date.now) {
    this.directory = join(directory, '.nookframe-takeovers');
  }
  private path(threadId: string) { return join(this.directory, `${createHash('sha256').update(threadId).digest('hex')}.json`); }
  private async read(threadId: string): Promise<Record> {
    try { return JSON.parse(await readFile(this.path(threadId), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { threadId }; throw error; }
  }
  private async mutate<T>(threadId: string, fn: (record: Record) => T): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.directory, { retries: { retries: 20, minTimeout: 10, maxTimeout: 50 } });
    try {
      const record = await this.read(threadId);
      const result = fn(record);
      const temp = `${this.path(threadId)}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
      await rename(temp, this.path(threadId));
      return result;
    } finally { await release(); }
  }
  private reserved(record: Record) {
    const r = record.request;
    return r && ['approved', 'stopping', 'released'].includes(r.status) && r.reservedUntil > this.now();
  }
  async checkOpen(threadId: string) {
    const record = await this.read(threadId);
    if (this.reserved(record) && record.request!.requester !== this.instance) throw new Error('Thread takeover is in progress. Try again shortly.');
  }
  async acquired(threadId: string) {
    return this.mutate(threadId, record => {
      if (this.reserved(record) && record.request!.requester !== this.instance) throw new Error('Thread takeover is in progress. Try again shortly.');
      record.owner = { instance: this.instance, slot: this.slot, generation: randomUUID() };
      if (record.request) record.request.status = 'completed';
    });
  }
  async relinquished(threadId: string) {
    await this.mutate(threadId, record => {
      if (record.owner?.instance === this.instance) {
        delete record.owner;
        if (record.request && ['pending', 'approved'].includes(record.request.status)) record.request.status = 'cancelled';
      }
    });
  }
  async request(threadId: string): Promise<Takeover> {
    return this.mutate(threadId, record => {
      if (!record.owner || record.owner.instance === this.instance) throw new Error('No other owner is available. Try opening the thread again.');
      const old = record.request;
      if (old && (old.status === 'stopping' || old.status === 'pending' && old.deadline > this.now() || this.reserved(record))) throw new Error('Another takeover request is already pending.');
      const request = { id: randomUUID(), threadId, ownerSlot: record.owner.slot, requesterSlot: this.slot,
        requester: this.instance, requesterUrl: this.origin ? `${this.origin}/#thread=${encodeURIComponent(threadId)}` : undefined,
        generation: record.owner.generation, deadline: this.now() + 30_000,
        reservedUntil: this.now() + 90_000, status: 'pending' as const };
      record.request = request;
      return this.public(request);
    });
  }
  private public(request: NonNullable<Record['request']>): Takeover {
    const { id, threadId, ownerSlot, requesterSlot, requesterUrl, deadline, status } = request;
    return { id, threadId, ownerSlot, requesterSlot, requesterUrl, deadline, status: status === 'approved' && request.reservedUntil <= this.now() ? 'failed' : status === 'pending' && deadline <= this.now() ? 'expired' : status };
  }
  async status(threadId: string, id: string): Promise<Takeover> {
    const r = (await this.read(threadId)).request;
    if (!r || r.id !== id || r.requester !== this.instance) throw new Error('Takeover request is no longer current.');
    return this.public(r);
  }
  async decide(threadId: string, id: string, decision: 'allow' | 'keep' | 'force' | 'cancel') {
    return this.mutate(threadId, record => {
      const r = record.request;
      if (!r || r.id !== id || !record.owner || record.owner.generation !== r.generation) throw new Error('Thread owner changed. Request takeover again.');
      if (decision === 'allow' || decision === 'keep') {
        if (record.owner.instance !== this.instance || r.status !== 'pending' || r.deadline <= this.now()) throw new Error('Takeover request expired or already answered.');
        r.status = decision === 'allow' ? 'approved' : 'rejected';
      } else {
        if (r.requester !== this.instance || r.status !== 'pending') throw new Error('Takeover request already answered.');
        if (decision === 'force' && (r.deadline > this.now() || this.now() > r.deadline + 60_000)) throw new Error('Wait for the response deadline, or request takeover again.');
        r.status = decision === 'force' ? 'approved' : 'cancelled';
      }
      r.reservedUntil = this.now() + 60_000;
      return this.public(r);
    });
  }
  async incoming(): Promise<Takeover[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const results: Takeover[] = [];
    for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const record: Record = JSON.parse(await readFile(join(this.directory, name), 'utf8'));
      if (record.owner?.instance === this.instance && record.request && record.request.generation === record.owner.generation && ['pending', 'approved', 'stopping'].includes(record.request.status)) results.push(this.public(record.request));
    }
    return results;
  }
  async assertStopping(request: Takeover) {
    const record = await this.read(request.threadId);
    const r = record.request;
    if (!r || r.id !== request.id || r.status !== 'stopping' || r.reservedUntil <= this.now() || record.owner?.instance !== this.instance || record.owner.generation !== r.generation) throw new Error('Takeover ownership changed');
  }
  async handoff(request: Takeover, stop: () => Promise<void>) {
    const claimed = await this.mutate(request.threadId, record => {
      const r = record.request;
      if (!r || r.id !== request.id || r.status !== 'approved' || record.owner?.instance !== this.instance || record.owner.generation !== r.generation) return false;
      if (r.reservedUntil <= this.now()) { r.status = 'failed'; return false; }
      r.status = 'stopping'; return true;
    });
    if (!claimed) return;
    let status: 'released' | 'failed' = 'released';
    try { await stop(); } catch { status = 'failed'; }
    await this.mutate(request.threadId, record => {
      if (record.request?.id === request.id && record.request.status === 'stopping') {
        record.request.status = status;
        record.request.reservedUntil = this.now() + 60_000;
      }
    });
  }
}
