'use strict';
// Builds small image files byte by byte for the tests (no fixture files): a real PNG, and PNG, JPEG, WebP, GIF and
// BMP headers with options for the hostile variants (cut files, huge sizes, EXIF orientation).
const { raster, encodePng } = require('../scripts/png');
const { encodeBmp } = require('../media/imgcore');

function png(w = 8, h = 6, color = '#3366cc') { const r = raster(w, h, color); return r.png(); }

/** A PNG whose IHDR claims w x h (the pixel data is a 1 x 1 image, so it is small on disk). */
function pngClaim(w, h) {
  const b = Buffer.from(encodePng(new Uint8Array(4), 1, 1));
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}

function exif(orientation, le = true) {
  const t = Buffer.alloc(26);
  if (le) { t.write('II', 0, 'latin1'); t.writeUInt16LE(42, 2); t.writeUInt32LE(8, 4); t.writeUInt16LE(1, 8); t.writeUInt16LE(0x0112, 10); t.writeUInt16LE(3, 12); t.writeUInt32LE(1, 14); t.writeUInt16LE(orientation, 18); t.writeUInt32LE(0, 22); }
  else { t.write('MM', 0, 'latin1'); t.writeUInt16BE(42, 2); t.writeUInt32BE(8, 4); t.writeUInt16BE(1, 8); t.writeUInt16BE(0x0112, 10); t.writeUInt16BE(3, 12); t.writeUInt32BE(1, 14); t.writeUInt16BE(orientation, 18); t.writeUInt32BE(0, 22); }
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]);
  const seg = Buffer.alloc(4); seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([seg, payload]);
}

/** A JPEG skeleton: SOI, (APP1 Exif), SOF0 with the size, SOS, a few bytes, EOI. Not decodable, but the header is real. */
function jpeg(w = 640, h = 480, o = {}) {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (o.orientation) parts.push(exif(o.orientation, o.le !== false));
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  parts.push(sof);
  if (!o.noSos) parts.push(Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]), Buffer.alloc(64, 0x55));
  if (!o.cut) parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function riff(kind, payload) {
  const chunk = Buffer.alloc(8 + payload.length); chunk.write(kind, 0, 'latin1'); chunk.writeUInt32LE(payload.length, 4); payload.copy(chunk, 8);
  const head = Buffer.alloc(12); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(4 + chunk.length, 4); head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, chunk]);
}
function webpLossy(w, h) { const p = Buffer.alloc(20); p[3] = 0x9d; p[4] = 0x01; p[5] = 0x2a; p.writeUInt16LE(w & 0x3fff, 6); p.writeUInt16LE(h & 0x3fff, 8); return riff('VP8 ', p); }
function webpLossless(w, h) { const p = Buffer.alloc(10); p[0] = 0x2f; p.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 1); return riff('VP8L', p); }
function webpExtended(w, h, animated) { const p = Buffer.alloc(10); p[0] = animated ? 0x02 : 0; p.writeUIntLE(w - 1, 4, 3); p.writeUIntLE(h - 1, 7, 3); return riff('VP8X', p); }

function gif(w = 20, h = 10, cut = false) {
  const b = Buffer.alloc(14); b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); b[13] = 0x3b;
  return cut ? b.subarray(0, 12) : b;
}

function bmp(w = 4, h = 3) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i * 4] = i * 10; px[i * 4 + 1] = 100; px[i * 4 + 2] = 200; px[i * 4 + 3] = 255; }
  return { bytes: Buffer.from(encodeBmp(px, w, h)), px };
}

module.exports = { png, pngClaim, jpeg, exif, webpLossy, webpLossless, webpExtended, gif, bmp };
