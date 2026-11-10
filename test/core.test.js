'use strict';
// Pure logic of media/imgcore.js: crop and resize maths, straighten, orientation, the edit history, the annotation
// model and its checks, the batch planner, the target-size search and the pixel diff.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../media/imgcore');
const H = require('../src/core/header');

test('ratios and crop from a drag: held to the ratio, inside the image, reversed drags', () => {
  assert.strictEqual(C.parseRatio('free'), 0);
  assert.strictEqual(C.parseRatio('16:9'), 16 / 9);
  assert.strictEqual(C.parseRatio('4x3'), 4 / 3);
  assert.strictEqual(C.parseRatio('1.5'), 1.5);
  assert.strictEqual(C.parseRatio('0:3'), 0);
  assert.strictEqual(C.parseRatio('<b>'), 0);
  assert.deepStrictEqual(C.cropFromDrag(10, 10, 110, 60, 0, 200, 100), { x: 10, y: 10, w: 100, h: 50 });
  assert.deepStrictEqual(C.cropFromDrag(110, 60, 10, 10, 0, 200, 100), { x: 10, y: 10, w: 100, h: 50 }, 'drag up-left');
  const sq = C.cropFromDrag(0, 0, 150, 80, 1, 200, 100);
  assert.strictEqual(sq.w, sq.h);
  const wide = C.cropFromDrag(0, 0, 199, 99, 16 / 9, 200, 100);
  assert.ok(Math.abs(wide.w / wide.h - 16 / 9) < 0.02 && wide.x + wide.w <= 200 && wide.y + wide.h <= 100, JSON.stringify(wide));
  const out = C.cropFromDrag(-50, -50, 5000, 5000, 0, 200, 100);
  assert.deepStrictEqual(out, { x: 0, y: 0, w: 200, h: 100 }, 'clamped to the image');
  assert.deepStrictEqual(C.cropFromDrag(5, 5, 5, 5, 0, 200, 100), { x: 5, y: 5, w: 1, h: 1 }, 'at least 1 x 1');
  assert.deepStrictEqual(C.cropFromDrag(NaN, 'x', 10, 10, 0, 20, 20), { x: 0, y: 0, w: 10, h: 10 });
  assert.deepStrictEqual(C.centeredCrop(16 / 9, 1000, 1000), { x: 0, y: 218, w: 1000, h: 563 });
  assert.deepStrictEqual(C.centeredCrop(0, 30, 20), { x: 0, y: 0, w: 30, h: 20 });
  assert.deepStrictEqual(C.clampRect({ x: 190, y: -4, w: 50, h: 1e9 }, 200, 100), { x: 190, y: 0, w: 10, h: 100 });
});

test('resize: pixels with and without the ratio, percent, errors, the side limit', () => {
  assert.deepStrictEqual(C.resizeDims(1920, 1080, { unit: 'px', width: 960, keepRatio: true }), { w: 960, h: 540 });
  assert.deepStrictEqual(C.resizeDims(1920, 1080, { unit: 'px', width: 960, height: 100, keepRatio: true, from: 'height' }), { w: 178, h: 100 });
  assert.deepStrictEqual(C.resizeDims(1920, 1080, { unit: 'px', width: 100, height: 100, keepRatio: false }), { w: 100, h: 100 });
  assert.deepStrictEqual(C.resizeDims(1920, 1080, { unit: '%', width: 50, keepRatio: true }), { w: 960, h: 540 });
  assert.deepStrictEqual(C.resizeDims(1000, 1000, { unit: '%', width: 50, height: 20, keepRatio: false }), { w: 500, h: 200 });
  assert.deepStrictEqual(C.resizeDims(3, 3, { unit: '%', width: 1, keepRatio: true }), { w: 1, h: 1 }, 'never 0');
  assert.throws(() => C.resizeDims(10, 10, { unit: 'px', keepRatio: true }), /width or a height/);
  assert.throws(() => C.resizeDims(10, 10, { unit: '%', width: -5 }), /percent/);
  assert.throws(() => C.resizeDims(1000, 1000, { unit: 'px', width: 40000, keepRatio: true }), /32767/);
  const steps = C.downscaleSteps(4000, 3000, 500, 375);
  assert.deepStrictEqual(steps, [{ w: 2000, h: 1500 }, { w: 1000, h: 750 }, { w: 500, h: 375 }]);
  assert.deepStrictEqual(C.downscaleSteps(100, 100, 300, 300), [{ w: 300, h: 300 }], 'upscale in one step');
});

test('straighten: no empty corners; rotate and crop sizes follow through a list of edits', () => {
  assert.deepStrictEqual(C.straightenCrop(400, 300, 0), { w: 400, h: 300 });
  assert.deepStrictEqual(C.straightenCrop(100, 100, 45), { w: 70, h: 70 });
  const s = C.straightenCrop(1600, 900, 5);
  assert.ok(s.w < 1600 && s.h < 900 && Math.abs(s.w / s.h - 16 / 9) < 0.01, JSON.stringify(s));
  // the corners of the kept rectangle, turned back, stay inside the original
  const a = 5 * Math.PI / 180;
  for (const [x, y] of [[-s.w / 2, -s.h / 2], [s.w / 2, -s.h / 2], [s.w / 2, s.h / 2], [-s.w / 2, s.h / 2]]) {
    const rx = x * Math.cos(a) - y * Math.sin(a), ry = x * Math.sin(a) + y * Math.cos(a);
    assert.ok(Math.abs(rx) <= 800.01 && Math.abs(ry) <= 450.01, `${rx},${ry}`);
  }
  const ops = [{ kind: 'rotate', deg: 90 }, { kind: 'crop', x: 0, y: 0, w: 50, h: 70 }, { kind: 'resize', w: 25, h: 35 }, { kind: 'rotate', deg: 180 }, { kind: 'flip', axis: 'h' }];
  assert.deepStrictEqual(C.sizeAfterOps(200, 100, ops.slice(0, 1)), { w: 100, h: 200 });
  assert.deepStrictEqual(C.sizeAfterOps(200, 100, ops), { w: 25, h: 35 });
});

test('EXIF orientation: output size and where the corners go for all 8 values', () => {
  const w = 40, h = 30;
  const corner = (o) => { const t = C.orientation(o, w, h); return { size: [t.w, t.h], tl: C.applyMatrix(t.m, 0, 0), tr: C.applyMatrix(t.m, w, 0) }; };
  assert.deepStrictEqual(corner(1), { size: [40, 30], tl: { x: 0, y: 0 }, tr: { x: 40, y: 0 } });
  assert.deepStrictEqual(corner(3).tl, { x: 40, y: 30 });
  assert.deepStrictEqual(corner(6).size, [30, 40]);
  assert.deepStrictEqual(corner(6).tl, { x: 30, y: 0 }, 'orientation 6: the top-left goes to the top-right (90° clockwise)');
  assert.deepStrictEqual(corner(8).tl, { x: 0, y: 40 }, 'orientation 8: 90° counter-clockwise');
  for (let o = 1; o <= 8; o++) {
    const t = C.orientation(o, w, h);
    for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]]) { const p = C.applyMatrix(t.m, x, y); assert.ok(p.x >= 0 && p.y >= 0 && p.x <= t.w && p.y <= t.h, `o=${o} ${x},${y} -> ${p.x},${p.y}`); }
  }
  assert.deepStrictEqual(C.orientation(99, w, h).m, [1, 0, 0, 1, 0, 0]);
});

test('edit checks: unknown kinds, NaN, a crop outside the image, huge strokes, text with HTML', () => {
  assert.throws(() => C.sanitizeOp({ kind: 'eval' }, 10, 10), /unknown/);
  assert.throws(() => C.sanitizeOp(null, 10, 10));
  assert.deepStrictEqual(C.sanitizeOp({ kind: 'crop', x: -10, y: 5, w: 999, h: NaN }, 100, 50), { kind: 'crop', x: 0, y: 5, w: 100, h: 45 });
  assert.throws(() => C.sanitizeOp({ kind: 'resize', w: 0, h: 10 }, 10, 10));
  assert.throws(() => C.sanitizeOp({ kind: 'resize', w: 1e9, h: 10 }, 10, 10));
  assert.deepStrictEqual(C.sanitizeOp({ kind: 'rotate', deg: -90 }, 10, 10), { kind: 'rotate', deg: 270 });
  assert.throws(() => C.sanitizeOp({ kind: 'rotate', deg: 360 }, 10, 10));
  assert.deepStrictEqual(C.sanitizeOp({ kind: 'straighten', angle: 90 }, 10, 10), { kind: 'straighten', angle: 45 });
  assert.throws(() => C.sanitizeOp({ kind: 'adjust', b: 100, c: 100, s: 100 }, 10, 10), /no change/);
  const t = C.sanitizeOp({ kind: 'text', x: 5, y: 9, text: '<img src=x onerror=alert(1)>\u0000ok', color: 'red; background:url(x)', size: 1e6 }, 10, 10);
  assert.strictEqual(t.text, '<img src=x onerror=alert(1)>ok', 'text stays text; control characters dropped');
  assert.strictEqual(t.color, '#e5484d', 'only #rrggbb colours');
  assert.strictEqual(t.size, 1000);
  assert.strictEqual(C.sanitizeOp({ kind: 'text', x: 0, y: 0, text: 'x'.repeat(5000) }, 9, 9).text.length, 500);
  assert.throws(() => C.sanitizeOp({ kind: 'text', x: 0, y: 0, text: '   ' }, 9, 9));
  const big = C.sanitizeOp({ kind: 'pen', pts: new Array(100000).fill(3), color: '#00FF00', width: 9999 }, 9, 9);
  assert.strictEqual(big.pts.length, 40000); assert.strictEqual(big.width, 200); assert.strictEqual(big.color, '#00ff00');
  assert.throws(() => C.sanitizeOp({ kind: 'pen', pts: [1, 2, 3] }, 9, 9));
  const r = C.sanitizeOp({ kind: 'redact', mode: 'blur', x: 5, y: 5, w: 100, h: 100, size: 1 }, 20, 20);
  assert.deepStrictEqual(r, { kind: 'redact', mode: 'blur', x: 5, y: 5, w: 15, h: 15, size: 4 });
  assert.strictEqual(C.sanitizeOp({ kind: 'redact', mode: 'x', x: 0, y: 0, w: 5, h: 5 }, 20, 20).mode, 'pixelate');
  const arrow = C.sanitizeOp({ kind: 'arrow', x1: 0, y1: 0, x2: Infinity, y2: '5' }, 10, 10);
  assert.deepStrictEqual([arrow.x2, arrow.y2], [0, 0]);
  // a list from a backup: each op is checked against the size the ops before it give; bad ones dropped
  const list = C.sanitizeOps([{ kind: 'crop', x: 0, y: 0, w: 50, h: 50 }, { kind: 'bogus' }, { kind: 'crop', x: 40, y: 40, w: 100, h: 100 }, 'x'], 200, 100);
  assert.deepStrictEqual(list, [{ kind: 'crop', x: 0, y: 0, w: 50, h: 50 }, { kind: 'crop', x: 40, y: 40, w: 10, h: 10 }]);
  assert.strictEqual(C.sanitizeOps(new Array(5000).fill({ kind: 'flip' }), 5, 5).length, 2000, 'at most 2000 edits');
  assert.deepStrictEqual(C.sanitizeOps('nope', 5, 5), []);
});

test('history: undo, redo, a new edit after undo drops the redo branch; labels and step numbers', () => {
  const hst = new C.History();
  hst.push({ kind: 'flip', axis: 'h' }); hst.push({ kind: 'step', x: 1, y: 1, n: 1 }); hst.push({ kind: 'step', x: 2, y: 2, n: 2 });
  assert.strictEqual(C.nextStep(hst.applied()), 3);
  assert.strictEqual(hst.undo(), 2);
  assert.strictEqual(C.nextStep(hst.applied()), 2, 'an undone step number is used again');
  assert.ok(hst.canRedo);
  hst.push({ kind: 'rotate', deg: 90 });
  assert.strictEqual(hst.ops.length, 3); assert.ok(!hst.canRedo);
  assert.strictEqual(hst.undo(), 2); assert.strictEqual(hst.undo(), 1); assert.strictEqual(hst.undo(), 0); assert.strictEqual(hst.undo(), 0);
  assert.strictEqual(hst.redo(), 1); assert.strictEqual(hst.goto(99), 3); assert.strictEqual(hst.goto(-4), 0);
  assert.strictEqual(C.opLabel({ kind: 'crop', w: 10, h: 20 }), 'Crop to 10 x 20');
  assert.strictEqual(C.opLabel({ kind: 'rotate', deg: 270 }), 'Rotate left');
  assert.strictEqual(C.opLabel({ kind: 'redact', mode: 'blur' }), 'Blur area');
  assert.strictEqual(C.opLabel({ kind: 'ellipse' }), 'Ellipse');
});

test('annotation geometry: arrow head, bounds, stroke simplification, snapshot budget', () => {
  const head = C.arrowHead(0, 0, 100, 0, 4);
  assert.deepStrictEqual(head.slice(0, 2), [100, 0]);
  assert.ok(head[2] < 100 && head[4] < 100 && head[3] * head[5] < 0, 'two wings behind the tip');
  assert.deepStrictEqual(C.opBounds({ kind: 'rect', x1: 10, y1: 10, x2: 0, y2: 0, width: 1 }), { x: -3, y: -3, w: 16, h: 16 });
  const pts = []; for (let i = 0; i < 1000; i++) pts.push(i * 0.1, 0);
  const s = C.simplifyStroke(pts, 1);
  assert.ok(s.length < 250 && s[0] === 0 && s[s.length - 2] === pts[pts.length - 2]);
  const sizes = [{ w: 1000, h: 1000 }, { w: 1000, h: 1000 }, { w: 1000, h: 1000 }, { w: 1000, h: 1000 }];
  assert.deepStrictEqual([...C.snapshotKeep(sizes, 2.5e6)].sort(), [0, 3]);
  assert.deepStrictEqual([...C.snapshotKeep(sizes, 1e9)].sort(), [0, 1, 2, 3]);
});

test('batch planner: suffix or subfolder, GIF becomes PNG, never overwrites, skips non-images', () => {
  const names = ['a.png', 'b.JPG', 'c.gif', 'notes.txt', 'a-resized.png', 'd.webp'];
  const p = C.planBatch(names, { format: 'keep', suffix: '-resized', existing: names });
  const by = Object.fromEntries(p.map((x) => [x.name, x]));
  assert.strictEqual(by['a.png'].out, 'a-resized-2.png', 'a-resized.png exists, so a number is added');
  assert.strictEqual(by['b.JPG'].out, 'b-resized.jpg');
  assert.strictEqual(by['c.gif'].out, 'c-resized.png'); assert.strictEqual(by['c.gif'].format, 'png');
  assert.strictEqual(by['notes.txt'].skip, 'not an image');
  assert.strictEqual(by['a-resized.png'].out, 'a-resized-resized.png');
  const outs = p.filter((x) => x.out).map((x) => x.out.toLowerCase());
  assert.strictEqual(new Set(outs).size, outs.length, 'no two outputs share a name');
  for (const o of outs) assert.ok(!names.map((n) => n.toLowerCase()).includes(o), `never an existing name: ${o}`);
  const q = C.planBatch(['x.png', 'x.jpg'], { format: 'webp', subfolder: 'resized', existingOut: ['x.webp'] });
  assert.deepStrictEqual(q.map((x) => [x.out, x.dir]), [['x-2.webp', 'resized'], ['x-3.webp', 'resized']]);
  assert.deepStrictEqual(C.batchDims(4000, 3000, { mode: 'max', maxW: 1920, maxH: 1920 }), { w: 1920, h: 1440 });
  assert.deepStrictEqual(C.batchDims(800, 600, { mode: 'max', maxW: 1920, maxH: 1920 }), { w: 800, h: 600 }, 'never bigger');
  assert.deepStrictEqual(C.batchDims(800, 600, { mode: 'max', maxW: 0, maxH: 300 }), { w: 400, h: 300 });
  assert.deepStrictEqual(C.batchDims(801, 601, { mode: 'pct', pct: 50 }), { w: 401, h: 301 });
  assert.deepStrictEqual(C.batchDims(5, 5, { mode: 'none' }), { w: 5, h: 5 });
});

test('target size: parse sizes; the search keeps the highest quality that fits, scales down when it must', async () => {
  assert.strictEqual(C.parseSize('200 KB'), 204800);
  assert.strictEqual(C.parseSize('1.5 MB'), 1572864);
  assert.strictEqual(C.parseSize('300k'), 307200);
  assert.strictEqual(C.parseSize('80'), 81920, 'a bare number is KB');
  assert.throws(() => C.parseSize('lots'), /200 KB/);
  assert.throws(() => C.parseSize('0.5 KB'), /at least 1 KB/);
  assert.strictEqual(C.formatBytes(1536), '1.5 KB'); assert.strictEqual(C.formatBytes(5 * 1048576), '5.00 MB');
  // size grows with quality: 100 KB at q=0, 1100 KB at q=1, times the pixel area
  const calls = [];
  const enc = async (q, scale) => { calls.push([q, scale]); return { size: Math.round((100 + 1000 * q) * 1024 * scale * scale), data: { q, scale } }; };
  const r = await C.searchQuality(enc, 600 * 1024);
  assert.ok(r.fits && r.scale === 1 && r.size <= 600 * 1024 && r.q > 0.45 && r.q <= 0.5, JSON.stringify(r));
  assert.ok(r.tries <= 9, `encodes: ${r.tries}`);
  const r2 = await C.searchQuality(enc, 50 * 1024);
  assert.ok(r2.fits && r2.scale < 1 && r2.size <= 50 * 1024, `scaled down: ${JSON.stringify(r2)}`);
  const r3 = await C.searchQuality(async () => ({ size: 1e9 }), 1024);
  assert.strictEqual(r3.fits, false, 'an encoder that never fits returns the smallest result');
  const r4 = await C.searchQuality(enc, 5000 * 1024);
  assert.strictEqual(r4.q, 0.95, 'already small enough at the top quality');
});

test('pixel diff: threshold, changed count, boxes around two changed areas', () => {
  const w = 64, h = 32;
  const a = new Uint8Array(w * h * 4).fill(200), b = new Uint8Array(a);
  const paint = (x0, y0, x1, y1, v) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) b[(y * w + x) * 4] = v; };
  paint(2, 2, 10, 6, 0);
  paint(40, 20, 50, 30, 190); // a small change: below threshold 16
  paint(56, 0, 60, 4, 255);
  const d = C.diffPixels(a, b, w, h, 16);
  assert.strictEqual(d.changed, 8 * 4 + 4 * 4);
  const bx = C.changedBoxes(d.mask, w, h, { cell: 4 });
  assert.strictEqual(bx.total, 2);
  assert.deepStrictEqual(bx.boxes.map((q) => [q.x, q.y, q.w, q.h]), [[0, 0, 12, 8], [56, 0, 4, 4]]);
  assert.strictEqual(C.diffPixels(a, b, w, h, 0).changed, 8 * 4 + 4 * 4 + 100, 'threshold 0 sees the small change');
  assert.strictEqual(C.diffPixels(a, a, w, h, 0).changed, 0);
  const many = new Uint8Array(w * h); for (let i = 0; i < many.length; i += 2 * w + 2) many[i] = 1;
  assert.ok(C.changedBoxes(many, w, h, { cell: 1, max: 5 }).boxes.length <= 5);
});

test('BMP encoder: a header this reader accepts, pixels bottom-up in BGRA', () => {
  const w = 3, h = 2, px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([i * 40, 7, 9, 255], i * 4);
  const out = C.encodeBmp(px, w, h);
  const info = H.sniff(out);
  assert.deepStrictEqual([info.format, info.width, info.height, info.truncated], ['bmp', 3, 2, false]);
  const off = out[10] | (out[11] << 8);
  assert.deepStrictEqual([...out.subarray(off, off + 4)], [9, 7, 120, 255], 'first stored pixel = bottom-left (pixel 3) as BGRA');
  const parts = C.chunks(new Uint8Array(10), 4);
  assert.deepStrictEqual(parts.map((p) => p.length), [4, 4, 2]);
  assert.strictEqual(C.joinChunks(parts).length, 10);
  assert.strictEqual(C.chunks(new Uint8Array(0), 4).length, 1);
});

test('chunks of a Node Buffer are plain Uint8Array views that survive VS Code message serialization', () => {
  // a pooled Buffer with a non-zero byteOffset, as fs and workspace.fs give for small files
  const pool = Buffer.from('xxxxABCDEFGHIJ', 'latin1');
  const buf = pool.subarray(4);
  assert.ok(buf.byteOffset > 0 || buf.buffer.byteLength > buf.length);
  const parts = C.chunks(buf, 4);
  for (const p of parts) {
    assert.strictEqual(Object.getPrototypeOf(p), Uint8Array.prototype, 'not a Buffer');
    assert.strictEqual(typeof p.toJSON, 'undefined');
  }
  // VS Code: JSON.stringify(message, replacer) where the replacer swaps ArrayBuffer views for buffer references
  const views = [];
  const json = JSON.stringify({ type: 'chunk', data: parts[0] }, (k, v) => (ArrayBuffer.isView(v) ? { $ref: views.push(v) - 1 } : v));
  assert.match(json, /"\$ref":0/, 'the chunk reaches the replacer as a view, not as a toJSON object');
  assert.strictEqual(Buffer.from(C.joinChunks(parts)).toString('latin1'), 'ABCDEFGHIJ');
  // a Buffer itself would be turned into an object by toJSON before the replacer sees it (the 0.1.0 gate defect)
  const bad = JSON.stringify({ data: buf }, (k, v) => (ArrayBuffer.isView(v) ? { $ref: 0 } : v));
  assert.match(bad, /"type":"Buffer"/);
});
