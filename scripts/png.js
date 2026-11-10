'use strict';
// A tiny PNG writer (RGBA, 8 bit, zlib from Node) for the bundled sample and the test fixtures.
const zlib = require('zlib');

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** rgba: Uint8Array of w*h*4. */
function encodePng(rgba, w, h, opts = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (opts.text) parts.push(chunk('tEXt', Buffer.from(opts.text, 'latin1')));
  parts.push(chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
/** A canvas-like helper: fill rectangles on an RGBA buffer. */
function raster(w, h, bg) {
  const px = new Uint8Array(w * h * 4);
  const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 255];
  const rect = (x, y, rw, rh, c) => {
    const [r, g, b, a] = hex(c);
    for (let j = Math.max(0, y); j < Math.min(h, y + rh); j++) for (let i = Math.max(0, x); i < Math.min(w, x + rw); i++) { const p = (j * w + i) * 4; px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = a; }
  };
  const circle = (cx, cy, rad, c) => {
    const [r, g, b, a] = hex(c);
    for (let j = cy - rad; j <= cy + rad; j++) for (let i = cx - rad; i <= cx + rad; i++) if ((i - cx) ** 2 + (j - cy) ** 2 <= rad * rad && i >= 0 && j >= 0 && i < w && j < h) { const p = (j * w + i) * 4; px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = a; }
  };
  rect(0, 0, w, h, bg);
  return { px, w, h, rect, circle, png: (o) => encodePng(px, w, h, o) };
}
module.exports = { encodePng, raster, crc32 };
