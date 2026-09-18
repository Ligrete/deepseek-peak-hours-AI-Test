/**
 * Генератор PNG-иконок расширения без внешних зависимостей.
 * Рисует логотип-«часы» и цветную полосу статуса внизу иконки:
 *   зелёная — офф-пик (скидка), красная — пик.
 *
 * Запуск: node tools/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // суперсэмплинг для сглаживания

const BG = [15, 23, 42]; // #0F172A
const WHITE = [255, 255, 255];
const ACCENTS = { off: [34, 197, 94], peak: [239, 68, 68] }; // #22C55E / #EF4444

/* ---------- PNG ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- Геометрия ---------- */

function insideRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  return dx * dx + dy * dy <= r * r;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Возвращает цвет [r,g,b,a] для точки в единицах размера N. */
function sample(u, v, N, accent) {
  const radius = 0.22 * N;
  if (!insideRoundRect(u, v, 0, 0, N, N, radius)) return null;

  const barTop = 0.72 * N;
  let color = v >= barTop ? accent : BG;

  const cx = 0.5 * N;
  const cy = 0.375 * N;
  const ringOuter = 0.28 * N;
  const ringInner = ringOuter - Math.max(0.085 * N, 0.9);
  const handW = Math.max(0.06 * N, 1);

  const d = Math.hypot(u - cx, v - cy);
  if (d <= ringOuter && d >= ringInner) color = WHITE;
  if (distToSegment(u, v, cx, cy, cx, cy - 0.19 * N) <= handW / 2) color = WHITE;
  if (distToSegment(u, v, cx, cy, cx + 0.12 * N, cy + 0.07 * N) <= handW / 2) color = WHITE;
  if (d <= 0.05 * N) color = WHITE;

  return color;
}

function renderIcon(N, accent) {
  const W = N * SS;
  const acc = new Float32Array(N * N * 4);
  for (let y = 0; y < W; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const color = sample((x + 0.5) / SS, (y + 0.5) / SS, N, accent);
      if (!color) continue;
      const idx = (Math.floor(y / SS) * N + Math.floor(x / SS)) * 4;
      acc[idx] += color[0];
      acc[idx + 1] += color[1];
      acc[idx + 2] += color[2];
      acc[idx + 3] += 255;
    }
  }

  const total = SS * SS;
  const rgba = new Uint8ClampedArray(N * N * 4);
  for (let i = 0; i < N * N; i += 1) {
    const offset = i * 4;
    const alpha = acc[offset + 3] / total;
    if (alpha === 0) continue;
    const share = acc[offset + 3] / 255; // сколько субпикселей непрозрачны
    rgba[offset] = acc[offset] / share;
    rgba[offset + 1] = acc[offset + 1] / share;
    rgba[offset + 2] = acc[offset + 2] / share;
    rgba[offset + 3] = alpha;
  }
  return rgba;
}

mkdirSync(OUT_DIR, { recursive: true });
const written = [];
for (const [state, accent] of Object.entries(ACCENTS)) {
  for (const size of SIZES) {
    const file = join(OUT_DIR, `icon-${state}-${size}.png`);
    writeFileSync(file, encodePng(size, size, renderIcon(size, accent)));
    written.push(`${file} (${size}×${size})`);
  }
}
console.log(`Готово: ${written.length} иконок\n${written.join('\n')}`);
