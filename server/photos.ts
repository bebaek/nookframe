import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';

export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
export const photoId = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export const validPhotoId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
export type PhotoContent = { type: 'image'; data: string; mimeType: string };

// Uploads are an expiring cache. Pi's session remains the durable source of
// sent images; history exposes authenticated URLs rather than base64 snapshots.
export class PhotoStore {
  private busy = false;
  private cleanupTimer: ReturnType<typeof setInterval>;
  constructor(private directory: string) {
    void this.cleanup().catch(() => {});
    this.cleanupTimer = setInterval(() => { void this.cleanup().catch(() => {}); }, 3600_000);
    this.cleanupTimer.unref();
  }
  close() { clearInterval(this.cleanupTimer); }
  private async cleanup() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let total = 0;
    for (const name of await readdir(this.directory)) {
      if (!/^(?:[a-f0-9]{64}\.jpg|processing-[a-zA-Z0-9]+)$/.test(name)) continue;
      const path = join(this.directory, name);
      const info = await stat(path).catch(() => undefined);
      if (!info) continue;
      const ttl = name.startsWith('processing-') ? 60_000 : 24 * 3600_000;
      if (Date.now() - info.mtimeMs > ttl) await rm(path, { recursive: true, force: true });
      else total += info.size;
    }
    return total;
  }
  async read(id: string) {
    if (!validPhotoId(id)) throw new Error('Invalid photo ID');
    const path = join(this.directory, `${id}.jpg`);
    if (Date.now() - (await stat(path)).mtimeMs > 24 * 3600_000) throw new Error('Photo expired; attach it again');
    return readFile(path);
  }
  async upload(req: IncomingMessage) {
    if (this.busy) throw new Error('Another photo is processing; try again');
    this.busy = true;
    let temporary: string | undefined;
    const deadline = setTimeout(() => req.destroy(), 30_000);
    try {
      const total = await this.cleanup();
      if (total > 256 * 1024 * 1024) throw new Error('Photo upload cache is full; try again later');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_PHOTO_BYTES) throw new Error('Photos must be at most 20 MB');
        chunks.push(Buffer.from(chunk));
      }
      clearTimeout(deadline);
      if (!size) throw new Error('Empty photo');
      temporary = await mkdtemp(join(this.directory, 'processing-'));
      const source = join(temporary, 'source');
      const result = join(temporary, 'result.jpg');
      await writeFile(source, Buffer.concat(chunks), { mode: 0o600 });
      await new Promise<void>((resolve, reject) => {
        const sourceMode = import.meta.url.endsWith('.ts');
        execFile(process.execPath, ['--max-old-space-size=256', ...(sourceMode ? ['--import', 'tsx'] : []), fileURLToPath(new URL(sourceMode ? './photo-worker.ts' : './photo-worker.js', import.meta.url)), source, result],
          { timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024, env: { PATH: process.env.PATH } },
          error => error ? reject(new Error('Cannot process photo. Use a valid JPEG, PNG, WebP, or HEIC/HEIF image (up to 50 megapixels).')) : resolve());
      });
      const data = await readFile(result);
      const id = photoId(data);
      await rename(result, join(this.directory, `${id}.jpg`));
      return { id, url: `/photos/${id}` };
    } finally {
      clearTimeout(deadline);
      try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
      finally { this.busy = false; }
    }
  }
}
