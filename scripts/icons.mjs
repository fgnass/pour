// Render the app icons from the source images. Run: npm run icons
//   icons/icon.jpg     -> favicon.ico, pwa-*.png, apple-touch-icon (full bleed)
//   icons/maskable.jpg -> maskable icon (P inside the 80 % safe circle)
//   icons/banner.jpg   -> start.jpg, the banner of the start dialog (smaller P, wide crop)
// All are crops of a P poured with the app itself (white over the demo).
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';

const ANY = 'icons/icon.jpg';
const MASKABLE = 'icons/maskable.jpg';
const BANNER = 'icons/banner.jpg';

async function png(src, size) {
  return sharp(src).resize(size, size, { kernel: 'lanczos3' }).png({ palette: true, quality: 95, effort: 10 }).toBuffer();
}

async function jpg(src) {
  return sharp(src).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
}

/** ICO file with embedded PNG images */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); // colour planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.data)]);
}

const out = {
  'public/pwa-64x64.png': await png(ANY, 64),
  'public/pwa-192x192.png': await png(ANY, 192),
  'public/pwa-512x512.png': await png(ANY, 512),
  'public/apple-touch-icon-180x180.png': await png(ANY, 180),
  'public/maskable-icon-512x512.png': await png(MASKABLE, 512),
  'public/start.jpg': await jpg(BANNER),
  'public/favicon.ico': ico([
    { size: 32, data: await png(ANY, 32) },
    { size: 48, data: await png(ANY, 48) },
  ]),
};
for (const [file, data] of Object.entries(out)) {
  await writeFile(file, data);
  console.log(file, data.length);
}
