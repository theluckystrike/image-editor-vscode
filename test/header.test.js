'use strict';
// src/core/header.js: format, size and EXIF orientation from the bytes; cut, empty, huge and fake files.
const test = require('node:test');
const assert = require('node:assert');
const H = require('../src/core/header');
const B = require('./build');

test('real headers: PNG, JPEG, WebP (lossy, lossless, extended), GIF, BMP', () => {
  const p = H.sniff(B.png(8, 6));
  assert.deepStrictEqual([p.format, p.width, p.height, p.truncated, p.orientation], ['png', 8, 6, false, 1]);
  const j = H.sniff(B.jpeg(640, 480));
  assert.deepStrictEqual([j.format, j.width, j.height, j.truncated, j.orientation], ['jpeg', 640, 480, false, 1]);
  assert.deepStrictEqual(['webp', 300, 200], [H.sniff(B.webpLossy(300, 200)).format, H.sniff(B.webpLossy(300, 200)).width, H.sniff(B.webpLossy(300, 200)).height]);
  const l = H.sniff(B.webpLossless(16383, 5));
  assert.deepStrictEqual([l.width, l.height], [16383, 5]);
  const x = H.sniff(B.webpExtended(20000, 3, true));
  assert.deepStrictEqual([x.width, x.height, x.animated], [20000, 3, true]);
  const g = H.sniff(B.gif(20, 10));
  assert.deepStrictEqual([g.format, g.width, g.height, g.truncated, g.animated], ['gif', 20, 10, false, false]);
  assert.strictEqual(H.sniff(B.gif(20, 10, false, 3)).animated, true, 'more than one frame is an animation');
  const b = H.sniff(B.bmp(4, 3).bytes);
  assert.deepStrictEqual([b.format, b.width, b.height], ['bmp', 4, 3]);
  assert.strictEqual(H.formatFromName('/a/B.JPEG'), 'jpeg'); assert.strictEqual(H.formatFromName('x.tiff'), '');
});

test('EXIF orientation in little- and big-endian files, and the copy with orientation 1', () => {
  for (const le of [true, false]) {
    const f = B.jpeg(4000, 3000, { orientation: 6, le });
    const i = H.sniff(f);
    assert.deepStrictEqual([i.orientation, i.swapped, i.width, i.height], [6, true, 4000, 3000], `le=${le}`);
    const copy = H.withoutOrientation(f, i);
    assert.notStrictEqual(copy, f);
    assert.strictEqual(H.sniff(copy).orientation, 1, 'the webview gets orientation 1 and turns the image itself');
    assert.strictEqual(H.sniff(f).orientation, 6, 'the original bytes are not changed');
    assert.strictEqual(copy.length, f.length);
  }
  const plain = B.jpeg(10, 10);
  assert.strictEqual(H.withoutOrientation(plain, H.sniff(plain)), plain);
  assert.strictEqual(H.sniff(B.jpeg(10, 10, { orientation: 77 })).orientation, 1, 'out-of-range values read as 1');
});

test('hostile: empty, cut, a .png that is HTML, text, random bytes, zero size, a 30000 x 30000 claim', () => {
  assert.throws(() => H.sniff(Buffer.alloc(0)), (e) => e.code === 'EMPTY' && /empty/.test(e.message));
  assert.throws(() => H.sniff(B.png().subarray(0, 20)), (e) => e.code === 'TRUNCATED');
  const cutPng = H.sniff(B.png(30, 30).subarray(0, 60));
  assert.strictEqual(cutPng.truncated, true, 'a PNG with no IEND is marked as cut');
  assert.strictEqual(H.sniff(B.jpeg(10, 10, { cut: true })).truncated, true);
  assert.strictEqual(H.sniff(B.jpeg(10, 10, { noSos: true, cut: true })).truncated, true);
  assert.throws(() => H.sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1])), (e) => e.code === 'TRUNCATED', 'segment length 1');
  assert.strictEqual(H.sniff(B.gif(5, 5, true)).truncated, true, 'a GIF cut inside its first frame is marked as cut');
  assert.throws(() => H.sniff(B.gif(5, 5).subarray(0, 12)), (e) => e.code === 'TRUNCATED', 'shorter than the GIF header');
  assert.throws(() => H.sniff(B.gifHeaderOnly(64, 64)), (e) => e.code === 'TRUNCATED' && /holds no picture/.test(e.message), 'a GIF with no frame');
  assert.throws(() => H.sniff(B.gif(5, 5).subarray(0, 20)), (e) => e.code === 'TRUNCATED' && /before its first picture/.test(e.message), 'a GIF cut before its first frame');
  { const loop = Buffer.concat([B.gifHeaderOnly(5, 5).subarray(0, 13), Buffer.alloc(200000, 0x21)]); assert.throws(() => H.sniff(loop), (e) => e.code === 'TRUNCATED', 'endless extension blocks end at the data end'); }
  assert.throws(() => H.sniff(Buffer.from('<!DOCTYPE html><html><script>alert(1)</script></html>')), (e) => e.code === 'NOT_IMAGE' && /an HTML page/.test(e.message));
  assert.throws(() => H.sniff(Buffer.from('just some notes\n')), /a text file/);
  assert.throws(() => H.sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), /SVG/);
  assert.throws(() => H.sniff(Buffer.from('II*\0rest')), /TIFF/);
  assert.throws(() => H.sniff(Buffer.from([1, 2, 3, 250, 251, 0, 9])), (e) => e.code === 'NOT_IMAGE');
  assert.throws(() => H.sniff(B.pngClaim(0, 100)), (e) => e.code === 'TRUNCATED' && /0 x 100/.test(e.message));
  const huge = H.sniff(B.pngClaim(30000, 30000));
  assert.deepStrictEqual([huge.width, huge.height], [30000, 30000]);
  assert.throws(() => H.checkLimits(huge), (e) => e.code === 'TOO_LARGE' && /30,000 x 30,000 pixels \(900 MP\)/.test(e.message) && /100 MP/.test(e.message));
  assert.throws(() => H.checkLimits(H.sniff(B.pngClaim(40000, 10))), /32,767 pixels a side/);
  assert.doesNotThrow(() => H.checkLimits(H.sniff(B.pngClaim(10000, 10000))), '100 MP is allowed');
  assert.throws(() => H.checkLimits(H.sniff(B.webpLossy(16383, 16383))), /TOO|268|MP/);
});

test('hostile: loops and huge counts stop at once', () => {
  // a JPEG made of 200,000 empty APP segments and an EXIF IFD that claims 65,535 entries
  const seg = Buffer.from([0xff, 0xe2, 0x00, 0x02]);
  const many = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.concat(new Array(200000).fill(seg)), B.jpeg(5, 5).subarray(2)]);
  let t = Date.now();
  assert.throws(() => H.sniff(many), (e) => e.code === 'TRUNCATED');
  assert.ok(Date.now() - t < 2000);
  const ex = B.jpeg(5, 5, { orientation: 3 });
  ex.writeUInt16LE(65535, 2 + 4 + 6 + 8); // IFD entry count
  t = Date.now();
  assert.doesNotThrow(() => H.sniff(ex));
  assert.ok(Date.now() - t < 500);
  // a PNG whose chunk lengths point past the end
  const p = Buffer.from(B.png(4, 4)); p.writeUInt32BE(0xfffffff0, 33);
  assert.strictEqual(H.sniff(p).truncated, true);
});
