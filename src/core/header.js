'use strict';
// Reads the format, the size and the EXIF orientation of PNG, JPEG, WebP, GIF and BMP files from their headers,
// without decoding pixels. Every read is bounds-checked and every loop has a cap, so a cut or hostile file gives an
// answer (or a plain error) at once. Used before a file is sent to the webview (size cap) and by the tests to check
// what a save wrote.

const MAX_PIXELS = 100 * 1000 * 1000; // 100 MP
const MAX_SIDE = 32767; // the largest canvas side in Chromium
const MAX_BYTES = 256 * 1024 * 1024;

const FORMATS = {
  png: { mime: 'image/png', label: 'PNG', ext: 'png' },
  jpeg: { mime: 'image/jpeg', label: 'JPEG', ext: 'jpg' },
  webp: { mime: 'image/webp', label: 'WebP', ext: 'webp' },
  gif: { mime: 'image/gif', label: 'GIF', ext: 'gif' },
  bmp: { mime: 'image/bmp', label: 'BMP', ext: 'bmp' },
};

class ImageError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const u16be = (b, o) => (o + 2 <= b.length ? (b[o] << 8) | b[o + 1] : -1);
const u32be = (b, o) => (o + 4 <= b.length ? ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3] : -1);
const u16le = (b, o) => (o + 2 <= b.length ? b[o] | (b[o + 1] << 8) : -1);
const u24le = (b, o) => (o + 3 <= b.length ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) : -1);
const u32le = (b, o) => (o + 4 <= b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000 : -1);
const i32le = (b, o) => (o + 4 <= b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) : 0);
const ascii = (b, o, n) => (o + n <= b.length ? String.fromCharCode(...b.subarray(o, o + n)) : '');

/** What a non-image file looks like, for the message. */
function describeOther(b) {
  if (!b.length) return 'an empty file';
  const head = Buffer.from(b.subarray(0, Math.min(b.length, 512))).toString('latin1');
  if (/^\s*(<!doctype html|<html|<head|<body|<script|<div|<meta)/i.test(head) || /<html[\s>]/i.test(head)) return 'an HTML page';
  if (/^\s*<svg[\s>]|^\s*<\?xml[\s\S]*<svg/i.test(head)) return 'an SVG drawing (text, not pixels)';
  if (/^\s*[{[]/.test(head)) return 'JSON text';
  if (head.startsWith('%PDF')) return 'a PDF document';
  if (head.startsWith('PK\x03\x04')) return 'a ZIP archive';
  if (head.startsWith('II*\0') || head.startsWith('MM\0*')) return 'a TIFF image (not supported here)';
  if (/^....ftyp(heic|heix|mif1|avif)/.test(head)) return 'a HEIC or AVIF image (not supported here)';
  let text = 0;
  for (let i = 0; i < head.length; i++) { const c = head.charCodeAt(i); if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) text++; }
  return text / head.length > 0.95 ? 'a text file' : 'not an image this editor reads';
}

/** EXIF orientation from a TIFF block (APP1 payload after "Exif\0\0"). Returns { value, pos } or null. */
function tiffOrientation(b, start, end) {
  if (start + 8 > end) return null;
  const le = b[start] === 0x49 && b[start + 1] === 0x49;
  const be = b[start] === 0x4d && b[start + 1] === 0x4d;
  if (!le && !be) return null;
  const r16 = (o) => (o + 2 <= end ? (le ? u16le(b, o) : u16be(b, o)) : -1);
  const r32 = (o) => (o + 4 <= end ? (le ? u32le(b, o) : u32be(b, o)) : -1);
  if (r16(start + 2) !== 42) return null;
  const ifd = r32(start + 4);
  if (ifd < 8 || start + ifd + 2 > end) return null;
  const n = r16(start + ifd);
  for (let i = 0; i < Math.min(n, 512); i++) {
    const e = start + ifd + 2 + i * 12;
    if (e + 12 > end) break;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return { value: v >= 1 && v <= 8 ? v : 1, pos: e + 8, le };
    }
  }
  return null;
}

function png(b) {
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') throw new ImageError('TRUNCATED', 'This PNG file is cut short: its header is missing.');
  const width = u32be(b, 16), height = u32be(b, 20);
  let off = 8, chunks = 0, ended = false, animated = false;
  while (off + 8 <= b.length && chunks++ < 1000000) {
    const len = u32be(b, off);
    const type = ascii(b, off + 4, 4);
    if (type === 'IEND') { ended = true; break; }
    if (type === 'acTL') animated = true;
    if (len < 0 || len > b.length) break;
    off += 12 + len;
  }
  return { format: 'png', width, height, truncated: !ended, animated };
}

function jpeg(b) {
  let off = 2, segs = 0, width = 0, height = 0, orientation = 1, orientationPos = -1, orientationLe = true, sos = false;
  while (off + 4 <= b.length && segs++ < 100000) {
    if (b[off] !== 0xff) { off++; continue; }
    const m = b[off + 1];
    if (m === 0xff) { off++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { off += 2; continue; }
    if (m === 0xd9) break;
    const len = u16be(b, off + 2);
    if (len < 2) break;
    if (m === 0xe1 && ascii(b, off + 4, 6) === 'Exif\0\0' && orientationPos < 0) {
      const t = tiffOrientation(b, off + 10, Math.min(b.length, off + 2 + len));
      if (t) { orientation = t.value; orientationPos = t.pos; orientationLe = t.le; }
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc && !width) {
      height = u16be(b, off + 5); width = u16be(b, off + 7);
    }
    if (m === 0xda) { sos = true; break; }
    off += 2 + len;
  }
  if (!width || !height || width < 0 || height < 0) throw new ImageError('TRUNCATED', 'This JPEG file is cut short or damaged: its size is missing.');
  // A whole JPEG ends with FFD9 (some cameras add data after it, so look at the last 1 MB).
  const tailStart = Math.max(0, b.length - (1 << 20));
  let ended = false;
  for (let i = b.length - 2; i >= tailStart; i--) if (b[i] === 0xff && b[i + 1] === 0xd9) { ended = true; break; }
  return { format: 'jpeg', width, height, truncated: !sos || !ended, orientation, orientationPos, orientationLe };
}

function webp(b) {
  const riff = u32le(b, 4);
  const kind = ascii(b, 12, 4);
  let width = 0, height = 0, animated = false;
  if (kind === 'VP8 ') {
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) throw new ImageError('TRUNCATED', 'This WebP file is cut short or damaged.');
    width = u16le(b, 26) & 0x3fff; height = u16le(b, 28) & 0x3fff;
  } else if (kind === 'VP8L') {
    if (b.length < 25 || b[20] !== 0x2f) throw new ImageError('TRUNCATED', 'This WebP file is cut short or damaged.');
    const v = u32le(b, 21);
    width = (v & 0x3fff) + 1; height = ((v >>> 14) & 0x3fff) + 1;
  } else if (kind === 'VP8X') {
    if (b.length < 30) throw new ImageError('TRUNCATED', 'This WebP file is cut short or damaged.');
    animated = !!(b[20] & 0x02);
    width = u24le(b, 24) + 1; height = u24le(b, 27) + 1;
  } else throw new ImageError('TRUNCATED', 'This WebP file is cut short or damaged.');
  return { format: 'webp', width, height, truncated: riff + 8 > b.length, animated };
}

function gif(b) {
  if (b.length < 10) throw new ImageError('TRUNCATED', 'This GIF file is cut short.');
  return { format: 'gif', width: u16le(b, 6), height: u16le(b, 8), truncated: b[b.length - 1] !== 0x3b, animated: true };
}

function bmp(b) {
  if (b.length < 26) throw new ImageError('TRUNCATED', 'This BMP file is cut short.');
  const dib = u32le(b, 14);
  let width, height;
  if (dib === 12) { width = u16le(b, 18); height = u16le(b, 20); } else { width = i32le(b, 18); height = Math.abs(i32le(b, 22)); }
  const size = u32le(b, 2);
  return { format: 'bmp', width, height, truncated: size > b.length };
}

/** Sniff the format from the bytes (never from the file name). Throws ImageError NOT_IMAGE / TRUNCATED. */
function sniff(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length === 0) throw new ImageError('EMPTY', 'This file is empty (0 bytes), so there is no image to show.');
  let info;
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a) info = png(b);
  else if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) info = jpeg(b);
  else if (b.length >= 16 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') info = webp(b);
  else if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) info = gif(b);
  else if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) info = bmp(b);
  else throw new ImageError('NOT_IMAGE', `This file is ${describeOther(b)}, not a PNG, JPEG, WebP, GIF or BMP image.`);
  if (!(info.width > 0 && info.height > 0)) throw new ImageError('TRUNCATED', `This ${FORMATS[info.format].label} file says its size is ${info.width} x ${info.height}, so it is damaged.`);
  info.orientation = info.orientation || 1;
  info.swapped = info.orientation >= 5;
  info.megapixels = (info.width * info.height) / 1e6;
  info.bytes = b.length;
  return info;
}

/** Throws when the image is over the caps; returns the info otherwise. */
function checkLimits(info, maxPixels = MAX_PIXELS) {
  const mp = (n) => (n / 1e6).toFixed(n >= 1e7 ? 0 : 1);
  if (info.width > MAX_SIDE || info.height > MAX_SIDE || info.width * info.height > maxPixels) {
    throw new ImageError('TOO_LARGE', `This image is ${info.width.toLocaleString('en-US')} x ${info.height.toLocaleString('en-US')} pixels (${mp(info.width * info.height)} MP). The editor opens images up to ${mp(maxPixels)} MP and ${MAX_SIDE.toLocaleString('en-US')} pixels a side.`);
  }
  return info;
}

/** A copy of a JPEG with its EXIF orientation set to 1 (the webview then applies the real one itself). */
function withoutOrientation(bytes, info) {
  if (!info || info.format !== 'jpeg' || info.orientationPos < 0 || info.orientation === 1) return bytes;
  const copy = Buffer.from(bytes);
  // The value is a SHORT in the entry's value field, in the byte order of the TIFF block.
  if (info.orientationLe) { copy[info.orientationPos] = 1; copy[info.orientationPos + 1] = 0; } else { copy[info.orientationPos] = 0; copy[info.orientationPos + 1] = 1; }
  return copy;
}

function formatFromName(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  const e = m ? m[1].toLowerCase() : '';
  if (e === 'png') return 'png';
  if (e === 'jpg' || e === 'jpeg' || e === 'jpe' || e === 'jfif') return 'jpeg';
  if (e === 'webp') return 'webp';
  if (e === 'gif') return 'gif';
  if (e === 'bmp' || e === 'dib') return 'bmp';
  return '';
}

module.exports = { sniff, checkLimits, withoutOrientation, formatFromName, describeOther, ImageError, FORMATS, MAX_PIXELS, MAX_SIDE, MAX_BYTES };
