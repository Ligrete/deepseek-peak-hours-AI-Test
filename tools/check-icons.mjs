/** Проверка иконок: размеры, формат и цвета (зелёная/красная полоса статуса). */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 128];
const ACCENTS = { off: [34, 197, 94], peak: [239, 68, 68] };

function decode(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: это не PNG`);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  let offset = 8;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(buf.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  return {
    width,
    height,
    bitDepth,
    colorType,
    pixel: (x, y) => {
      const i = y * (stride + 1) + 1 + x * 4;
      return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
    },
  };
}

const near = (a, b, tol = 12) => b.every((v, i) => Math.abs(a[i] - v) <= tol);
let failures = 0;

for (const [state, accent] of Object.entries(ACCENTS)) {
  for (const size of SIZES) {
    const name = `icons/icon-${state}-${size}.png`;
    const img = decode(join(ROOT, name));
    const bar = img.pixel(Math.round(size / 2), Math.round(0.88 * size));
    const ring = img.pixel(Math.round(0.5 * size), Math.round(0.375 * size - 0.24 * size));
    const dot = img.pixel(Math.round(0.5 * size), Math.round(0.375 * size));
    const corner = img.pixel(0, 0);

    const checks = {
      'размер': img.width === size && img.height === size,
      'RGBA8': img.bitDepth === 8 && img.colorType === 6,
      'прозрачные углы': corner[3] === 0,
      'цвет полосы статуса': bar[3] === 255 && near(bar, accent),
      'белый циферблат': ring[3] === 255 && ring[0] > 200,
      'белая точка в центре': dot[3] === 255 && dot[0] > 200,
    };
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    if (failed.length) failures += 1;
    console.log(`${failed.length ? 'FAIL' : 'ok  '} ${name}${failed.length ? ` → ${failed.join(', ')}` : ''}`);
  }
}

console.log(failures ? `\n${failures} иконок с проблемами` : '\nВсе иконки корректны');
process.exit(failures ? 1 : 0);
