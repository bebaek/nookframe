// Validate full-resolution raster data in a disposable process, not the server.
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
sharp.cache(false);
sharp.concurrency(1);
const input = await readFile(process.argv[2]);
if (input.length > 20 * 1024 * 1024) throw new Error('Image too large');
const png = input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
const jpeg = input.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
const webp = input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP';
if (!png && !jpeg && !webp) throw new Error('Unsupported image');
// libvips may expose only the first APNG frame; explicitly reject animation.
if (png) {
  for (let offset = 8; offset + 12 <= input.length;) {
    const length = input.readUInt32BE(offset);
    if (input.toString('ascii', offset + 4, offset + 8) === 'acTL') throw new Error('Animated image');
    offset += length + 12;
  }
}
const image = sharp(input, { limitInputPixels: 25_000_000, failOn: 'warning' });
const metadata = await image.metadata();
if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1 || !metadata.width || !metadata.height) throw new Error('Unsupported image');
// Force a complete decode, including pixels not needed by the thumbnail.
await image.clone().raw().toBuffer();
const preview = await image.rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
if (preview.length > 6 * 1024 * 1024) throw new Error('Preview too large');
await writeFile(process.argv[3], preview, { mode: 0o600 });
process.stdout.write(JSON.stringify({ width: metadata.width, height: metadata.height, mimeType: `image/${metadata.format}`, extension: metadata.format === 'jpeg' ? 'jpg' : metadata.format }));
