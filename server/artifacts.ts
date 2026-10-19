import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { photoId, validPhotoId } from './photos.js';

const MAX_INPUT = 20 * 1024 * 1024;
const MAX_STORE = 512 * 1024 * 1024;
interface Metadata { width: number; height: number; mimeType: string; extension: string }
export interface PublishedImage extends Metadata { id: string; previewUrl: string; fullUrl: string; downloadUrl: string; markdown: string }

// No remote fetching and no arbitrary filesystem serving. Only explicitly
// published, validated copies are served. Original bytes (including metadata)
// are retained for the full-resolution download.
export class ArtifactStore {
  readonly directory: string;
  readonly outputDirectory: string;
  constructor(private stateDir: string) {
    this.directory = join(stateDir, 'image-artifacts');
    this.outputDirectory = join(stateDir, 'image-output');
  }
  private async activeThread() {
    const value = JSON.parse(await readFile(join(this.stateDir, 'active-thread.json'), 'utf8'));
    if (typeof value.file !== 'string' || basename(value.file) !== value.file || !value.file.endsWith('.jsonl')) throw new Error('No active thread');
    return value.file as string;
  }
  private threadKey(thread: string) { return photoId(Buffer.from(thread)); }
  async context() {
    const thread = await this.activeThread();
    const directory = join(this.outputDirectory, this.threadKey(thread));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return { thread, directory };
  }
  private async assertThread(thread: string) {
    if (thread !== await this.activeThread()) throw new Error('Active thread changed; request imagectl context again');
  }
  private async boundedRead(path: string, limit: number) {
    if (await realpath(path) !== resolve(path)) throw new Error('Symlinks are not allowed');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size <= 0 || info.size > limit) throw new Error('Invalid image size or file type');
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
        const { bytesRead } = await file.read(buffer);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > limit) throw new Error('Image too large');
        chunks.push(buffer.subarray(0, bytesRead));
      }
      return Buffer.concat(chunks);
    } finally { await file.close(); }
  }
  private reference(thread: string, id: string, metadata: Metadata, description: string): PublishedImage {
    const base = `/artifacts/${this.threadKey(thread)}/${id}`;
    // Escape Markdown syntax and collapse line breaks in untrusted descriptions.
    const alt = description.replace(/[\r\n]/g, ' ').replace(/[\\`*_[\]<>]/g, '\\$&');
    return { ...metadata, id, previewUrl: `${base}/preview`, fullUrl: `${base}/full`, downloadUrl: `${base}/download`,
      markdown: `![${alt}](${base}/preview)\n\n[Download full-resolution image (${metadata.width} × ${metadata.height})](${base}/download)` };
  }
  async publish(thread: string, input: string, description: string): Promise<PublishedImage> {
    if (!description.trim() || description.length > 500) throw new Error('Provide a description of 1–500 characters');
    await this.assertThread(thread);
    const allowed = resolve(this.outputDirectory, this.threadKey(thread));
    const source = resolve(input);
    if (!source.startsWith(allowed + sep)) throw new Error('File must be inside the directory returned by imagectl context');
    // Snapshot bytes before validation; a later edit of the source cannot alter
    // the validated artifact or its content-addressed identity.
    const data = await this.boundedRead(source, MAX_INPUT);
    const id = photoId(data);
    const parent = join(this.directory, this.threadKey(thread));
    const destination = join(parent, id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.directory, { stale: 60_000, update: 10_000, retries: 0 });
    let temporary: string | undefined;
    try {
      await this.assertThread(thread);
      const existing = await readFile(join(destination, 'metadata.json'), 'utf8').catch(() => undefined);
      if (existing) return this.reference(thread, id, JSON.parse(existing), description);
      // Under the publisher lock, abandoned staging directories are safe to
      // remove. Durable artifacts never expire automatically.
      let bytes = 0, count = 0;
      for (const entry of await readdir(this.directory, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('.publishing-')) {
          await rm(join(this.directory, entry.name), { recursive: true, force: true }); continue;
        }
        if (!entry.isDirectory() || !validPhotoId(entry.name)) continue;
        for (const artifact of await readdir(join(this.directory, entry.name), { withFileTypes: true })) {
          if (!artifact.isDirectory() || !validPhotoId(artifact.name)) continue;
          count++;
          for (const name of await readdir(join(this.directory, entry.name, artifact.name))) bytes += (await stat(join(this.directory, entry.name, artifact.name, name))).size;
        }
      }
      // Reserve worst-case preview and metadata bytes before doing any work.
      if (count >= 256 || bytes + data.length + 6 * 1024 * 1024 + 4096 > MAX_STORE) throw new Error('Image artifact store is full; existing images were not deleted');
      temporary = await mkdtemp(join(this.directory, '.publishing-'));
      await writeFile(join(temporary, 'source'), data, { mode: 0o600 });
      const sourceMode = import.meta.url.endsWith('.ts');
      const metadata = await new Promise<Metadata>((resolve, reject) => {
        execFile(process.execPath, ['--max-old-space-size=128', ...(sourceMode ? ['--import', 'tsx'] : []), fileURLToPath(new URL(sourceMode ? './artifact-worker.ts' : './artifact-worker.js', import.meta.url)), join(temporary!, 'source'), join(temporary!, 'preview.webp')],
          { timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 4096, env: { PATH: process.env.PATH } },
          (error, stdout) => {
            if (error) { reject(new Error('Cannot publish image: use a valid, non-animated PNG, JPEG or WebP up to 20 MiB and 25 megapixels')); return; }
            try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Image validation failed')); }
          });
      });
      await rename(join(temporary, 'source'), join(temporary, `original.${metadata.extension}`));
      await writeFile(join(temporary, 'metadata.json'), JSON.stringify(metadata), { mode: 0o600 });
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await this.assertThread(thread);
      await rename(temporary, destination);
      temporary = undefined;
      return this.reference(thread, id, metadata, description);
    } finally {
      try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
      finally { await release(); }
    }
  }
  async read(threadKey: string, id: string, variant: string) {
    if (!validPhotoId(threadKey) || !validPhotoId(id) || !['preview', 'full', 'download'].includes(variant)) throw new Error('Image unavailable');
    const directory = join(this.directory, threadKey, id);
    const metadata: Metadata = JSON.parse((await this.boundedRead(join(directory, 'metadata.json'), 4096)).toString());
    if (!['jpg', 'png', 'webp'].includes(metadata.extension) || metadata.mimeType !== ({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as Record<string, string>)[metadata.extension]) throw new Error('Image unavailable');
    const preview = variant === 'preview';
    const data = await this.boundedRead(join(directory, preview ? 'preview.webp' : `original.${metadata.extension}`), preview ? 6 * 1024 * 1024 : MAX_INPUT);
    return { data, mimeType: preview ? 'image/webp' : metadata.mimeType, filename: `image-${id}.${metadata.extension}` };
  }
}
