/**
 * Generate build/icon.icns without any image dependencies.
 *
 * Encodes PNGs by hand (zlib is in the stdlib) and hands the iconset to
 * macOS's own iconutil. The design is three stacked panes with status dots —
 * blocked, working, idle — in the same Rose Pine palette as the UI and the tmux
 * theme, so the Dock icon reads as "the state of the fleet".
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const OUT_DIR = join(import.meta.dirname, '..', 'build');
const ICONSET = join(OUT_DIR, 'icon.iconset');

const COLORS = {
  base: [0x19, 0x17, 0x24],
  surface: [0x26, 0x23, 0x3a],
  love: [0xeb, 0x6f, 0x92],
  foam: [0x9c, 0xcf, 0xd8],
  muted: [0x6e, 0x6a, 0x86],
};

// --- minimal PNG writer ----------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha
  // Each scanline is prefixed with its filter type (0 = none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- drawing ---------------------------------------------------------------

function canvas(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b], alpha = 1) => {
    if (x < 0 || y < 0 || x >= size || y >= size || alpha <= 0) return;
    const i = (y * size + x) * 4;
    // Source-over, so anti-aliased edges blend with what's underneath.
    const a = Math.min(1, alpha);
    const existing = pixels[i + 3] / 255;
    const outA = a + existing * (1 - a);
    if (outA === 0) return;
    for (let c = 0; c < 3; c++) {
      const src = [r, g, b][c];
      pixels[i + c] = Math.round((src * a + pixels[i + c] * existing * (1 - a)) / outA);
    }
    pixels[i + 3] = Math.round(outA * 255);
  };
  return { pixels, set };
}

/** Coverage of a pixel by a rounded rect, sampled for smooth edges. */
function roundedRectCoverage(px, py, x, y, w, h, radius) {
  const samples = 4;
  let hits = 0;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const cx = px + (sx + 0.5) / samples;
      const cy = py + (sy + 0.5) / samples;
      if (cx < x || cy < y || cx > x + w || cy > y + h) continue;
      // Distance into the corner arcs.
      const dx = Math.max(x + radius - cx, cx - (x + w - radius), 0);
      const dy = Math.max(y + radius - cy, cy - (y + h - radius), 0);
      if (dx * dx + dy * dy <= radius * radius) hits++;
    }
  }
  return hits / (samples * samples);
}

function fillRounded(c, size, x, y, w, h, radius, color, alpha = 1) {
  const x0 = Math.max(0, Math.floor(x) - 1);
  const y0 = Math.max(0, Math.floor(y) - 1);
  const x1 = Math.min(size, Math.ceil(x + w) + 1);
  const y1 = Math.min(size, Math.ceil(y + h) + 1);
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const coverage = roundedRectCoverage(px, py, x, y, w, h, radius);
      if (coverage > 0) c.set(px, py, color, coverage * alpha);
    }
  }
}

function render(size) {
  const c = canvas(size);
  const u = size / 1024; // design at 1024, scale down

  // macOS icons sit inset in their canvas rather than bleeding to the edge.
  const inset = 80 * u;
  const side = size - inset * 2;
  fillRounded(c, size, inset, inset, side, side, 200 * u, COLORS.base);

  // Three panes, each a status dot plus a bar of decreasing length.
  const rows = [
    { color: COLORS.love, width: 430 },
    { color: COLORS.foam, width: 330 },
    { color: COLORS.muted, width: 220 },
  ];
  const dot = 62 * u;
  const barHeight = 62 * u;
  const gap = 132 * u;
  const dotGap = 44 * u;
  const longestBar = Math.max(...rows.map((r) => r.width)) * u;

  // Centre the whole group, measuring from the dot to the end of the longest bar.
  const groupWidth = dot + dotGap + longestBar;
  const groupHeight = rows.length * barHeight + (rows.length - 1) * (gap - barHeight);
  const dotX = inset + (side - groupWidth) / 2;
  const barX = dotX + dot + dotGap;
  const startY = inset + (side - groupHeight) / 2;

  rows.forEach((row, index) => {
    const y = startY + index * gap;
    fillRounded(c, size, dotX, y, dot, dot, dot / 2, row.color);
    fillRounded(c, size, barX, y + (dot - barHeight) / 2, row.width * u, barHeight, barHeight / 2, COLORS.surface);
    // Carry the status colour well into the bar, or it turns to grey mush at 16px.
    fillRounded(c, size, barX, y + (dot - barHeight) / 2, row.width * u, barHeight, barHeight / 2, row.color, 0.45);
  });

  return encodePng(size, size, c.pixels);
}

// --- emit ------------------------------------------------------------------

rmSync(ICONSET, { recursive: true, force: true });
mkdirSync(ICONSET, { recursive: true });

const VARIANTS = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
];

for (const [size, name] of VARIANTS) {
  const png = render(size);
  writeFileSync(join(ICONSET, name), png);
}
// A standalone PNG too, for the Linux/tray cases and for eyeballing the result.
writeFileSync(join(OUT_DIR, 'icon.png'), render(512));

const icns = join(OUT_DIR, 'icon.icns');
mkdirSync(dirname(icns), { recursive: true });
execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', icns]);
rmSync(ICONSET, { recursive: true, force: true });
console.log(`wrote ${icns}`);
