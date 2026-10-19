import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { photoId } from './photos.js';
import type { ResponseImage } from '../shared/protocol.js';

const MAX_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;

// Session content is durable; this bounded projection holds only the active
// transcript. Decode in a disposable worker only when a browser requests it.
export class ResponseImages {
  private images = new Map<string, Buffer>();
  private processing = new Map<string, Promise<Buffer>>();
  clear() { this.images.clear(); }
  retain(ids: Set<string>) {
    for (const id of this.images.keys()) if (!ids.has(id)) this.images.delete(id);
  }
  collect(content: unknown): ResponseImage[] {
    if (!Array.isArray(content)) return [];
    const result: ResponseImage[] = [];
    let total = [...this.images.values()].reduce((sum, data) => sum + data.length, 0);
    for (const block of content) {
      if (result.length >= 4) break;
      if (!block || block.type !== 'image' || !['image/png', 'image/jpeg', 'image/webp'].includes(block.mimeType) || typeof block.data !== 'string') continue;
      if (!block.data.length || block.data.length > MAX_BYTES * 4 / 3 || block.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) continue;
      const data = Buffer.from(block.data, 'base64');
      const id = photoId(data);
      if (result.some(image => image.id === id)) continue;
      if (!this.images.has(id)) {
        if (total + data.length > MAX_TOTAL) continue;
        this.images.set(id, data); total += data.length;
      }
      result.push({ id, url: `/response-images/${id}` });
    }
    return result;
  }
  async read(id: string): Promise<Buffer> {
    const data = this.images.get(id);
    if (!data) throw new Error('Image unavailable');
    // Queue distinct images rather than failing ordinary four-image messages.
    while (!this.processing.has(id) && this.processing.size >= 2) {
      await Promise.race([...this.processing.values()].map(task => task.catch(() => undefined)));
      if (this.images.get(id) !== data) throw new Error('Image unavailable');
    }
    let pending = this.processing.get(id);
    if (!pending) {
      pending = new Promise<Buffer>((resolve, reject) => {
        const source = import.meta.url.endsWith('.ts');
        const child = execFile(process.execPath, ['--max-old-space-size=128', ...(source ? ['--import', 'tsx'] : []), fileURLToPath(new URL(source ? './response-image-worker.ts' : './response-image-worker.js', import.meta.url))],
          { encoding: 'buffer', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: MAX_BYTES, env: { PATH: process.env.PATH } },
          (error, stdout) => error ? reject(new Error('Image unavailable')) : resolve(stdout));
        child.stdin?.on('error', () => {});
        child.stdin?.end(data);
      });
      this.processing.set(id, pending);
    }
    try {
      const output = await pending;
      if (this.images.get(id) !== data) throw new Error('Image unavailable');
      return output;
    } finally { if (this.processing.get(id) === pending) this.processing.delete(id); }
  }
}
