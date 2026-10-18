// Decode untrusted uploads in a disposable process, never in the web server.
import sharp, { type Sharp } from 'sharp';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const MAX_PIXELS = 50_000_000;
sharp.cache(false);
sharp.concurrency(1);
const input = await readFile(process.argv[2]);
let image: Sharp;
const brand = input.toString('ascii', 8, 12);
if (input.toString('ascii', 4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
  const decode = require('heic-decode');
  const frames = await decode.all({ buffer: input });
  try {
    const frame = frames[0];
    if (!frame || frame.width * frame.height > MAX_PIXELS) throw new Error('Image too large');
    const decoded = await frame.decode();
    image = sharp(Buffer.from(decoded.data), { raw: { width: decoded.width, height: decoded.height, channels: 4 } });
  } finally { frames.dispose(); }
} else {
  const jpeg = input.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const png = input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP';
  if (!jpeg && !png && !webp) throw new Error('Unsupported image');
  image = sharp(input, { limitInputPixels: MAX_PIXELS, animated: false });
  const metadata = await image.metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new Error('Unsupported image');
}
// HEIF transforms are applied by libheif; rotate applies EXIF for other formats.
const output = await image.rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
if (output.length > 4 * 1024 * 1024) throw new Error('Processed image too large');
await writeFile(process.argv[3], output, { mode: 0o600 });
