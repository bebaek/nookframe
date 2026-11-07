import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import type { IncomingMessage } from 'node:http';
import lockfile from 'proper-lockfile';
import { photoId, validPhotoId } from './photos.js';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_STORE_BYTES = 512 * 1024 * 1024;
export interface FileReference { id: string; name: string; size: number; url: string; path: string }

// Durable, explicitly copied files, never a general filesystem download route.
export class FileStore {
  readonly directory: string;
  readonly outputDirectory: string;
  constructor(stateDir: string) {
    this.directory = join(stateDir, 'chat-files');
    this.outputDirectory = join(stateDir, 'file-output');
  }
  threadKey(thread: string) {
    if (!thread || basename(thread) !== thread || !thread.endsWith('.jsonl') || thread.length > 255) throw new Error('Invalid file thread');
    return photoId(Buffer.from(thread));
  }
  async context(thread: string) {
    const directory = join(this.outputDirectory, this.threadKey(thread));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return { thread, directory };
  }
  private reference(key: string, id: string, metadata: { name: string; size: number }): FileReference {
    return { id, ...metadata, url: `/files/${key}/${id}/download`, path: join(this.directory, key, id, metadata.name) };
  }
  async read(key: string, id: string) {
    if (!validPhotoId(key) || !validPhotoId(id)) throw new Error('Invalid file reference');
    const metadata = JSON.parse(await readFile(join(this.directory, key, id, 'metadata.json'), 'utf8')) as { name: string; size: number };
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(metadata.name) || metadata.name === 'metadata.json') throw new Error('Invalid filename');
    const reference = this.reference(key, id, metadata);
    return { ...reference, data: await readFile(reference.path) };
  }
  async resolve(thread: string, id: string) { const { data: _, ...reference } = await this.read(this.threadKey(thread), id); return reference; }
  async copy(sourceThread: string, targetThread: string, id: string) {
    const file = await this.read(this.threadKey(sourceThread), id);
    return this.save(targetThread, file.name, file.data);
  }
  private async save(thread: string, name: string, data: Buffer) {
    const key = this.threadKey(thread);
    if (data.length > MAX_FILE_BYTES) throw new Error('Files must be at most 20 MB');
    name = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 120) || 'file';
    if (name === 'metadata.json') name = 'file-metadata.json';
    const id = photoId(Buffer.concat([Buffer.from(name + '\0'), data]));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.directory, { stale: 60_000, update: 10_000, retries: 0 });
    let temporary: string | undefined;
    try {
      const parent = join(this.directory, key);
      const destination = join(parent, id);
      if (await stat(destination).catch(() => undefined)) return this.resolve(thread, id);
      let bytes = 0, count = 0;
      for (const entry of await readdir(this.directory, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('.staging-')) { await rm(join(this.directory, entry.name), { recursive: true, force: true }); continue; }
        if (!entry.isDirectory() || !validPhotoId(entry.name)) continue;
        for (const item of await readdir(join(this.directory, entry.name), { withFileTypes: true })) {
          if (!item.isDirectory() || !validPhotoId(item.name)) continue;
          count++;
          for (const file of await readdir(join(this.directory, entry.name, item.name))) bytes += (await stat(join(this.directory, entry.name, item.name, file))).size;
        }
      }
      if (count >= 1024 || bytes + data.length + 4096 > MAX_STORE_BYTES) throw new Error('File storage is full; existing files were not deleted');
      temporary = await mkdtemp(join(this.directory, '.staging-'));
      const metadata = { name, size: data.length };
      await writeFile(join(temporary, name), data, { mode: 0o600 });
      await writeFile(join(temporary, 'metadata.json'), JSON.stringify(metadata), { mode: 0o600 });
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await rename(temporary, destination);
      temporary = undefined;
      return this.reference(key, id, metadata);
    } finally { try { if (temporary) await rm(temporary, { recursive: true, force: true }); } finally { await release(); } }
  }
  async upload(thread: string, name: string, req: IncomingMessage) {
    this.threadKey(thread);
    const chunks: Buffer[] = [];
    let size = 0;
    const deadline = setTimeout(() => req.destroy(), 30_000);
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_FILE_BYTES) throw new Error('Files must be at most 20 MB');
        chunks.push(Buffer.from(chunk));
      }
      return await this.save(thread, name, Buffer.concat(chunks));
    } finally { clearTimeout(deadline); }
  }
  async publish(thread: string, input: string) {
    const allowed = resolve(this.outputDirectory, this.threadKey(thread));
    const source = resolve(input);
    if (!source.startsWith(allowed + sep) || await realpath(source) !== source) throw new Error('File must be inside the directory returned by filectl context, without symlinks');
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('Invalid file type or size');
      const data = Buffer.alloc(MAX_FILE_BYTES + 1);
      let size = 0;
      while (size < data.length) {
        const { bytesRead } = await handle.read(data, size, data.length - size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      const reference = await this.save(thread, basename(source), data.subarray(0, size));
      return { ...reference, markdown: `[Download ${reference.name} (${reference.size} bytes)](${reference.url})` };
    } finally { await handle.close(); }
  }
}
