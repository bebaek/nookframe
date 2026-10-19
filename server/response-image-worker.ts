import sharp from 'sharp';
sharp.cache(false);
sharp.concurrency(1);
const chunks: Buffer[] = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 6 * 1024 * 1024) throw new Error('Image too large');
  chunks.push(Buffer.from(chunk));
}
const input = Buffer.concat(chunks);
const raster = input.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
  input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
  (input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP');
if (!raster) throw new Error('Unsupported image');
const image = sharp(input, { limitInputPixels: 25_000_000, animated: false });
const metadata = await image.metadata();
if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new Error('Unsupported image');
const output = await image.rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
if (output.length > 6 * 1024 * 1024) throw new Error('Image too large');
process.stdout.write(output);
