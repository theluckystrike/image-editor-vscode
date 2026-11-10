// Pure logic shared by the webviews (loaded as a script) and the extension host and tests (require): geometry of
// crop, resize, rotate and straighten, the edit history, the annotation model, the batch planner, the target-size
// search and the pixel diff. No DOM and no canvas here, so every part runs in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ImgCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_SIDE = 32767;
  const MAX_TEXT = 500;
  const MAX_POINTS = 20000;
  const KINDS = ['crop', 'resize', 'rotate', 'flip', 'straighten', 'adjust', 'redact', 'arrow', 'line', 'rect', 'ellipse', 'text', 'pen', 'hl', 'step'];
  const SHAPES = ['arrow', 'line', 'rect', 'ellipse'];

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

  /** Parse an aspect ratio: 'free' -> 0, '16:9' -> 1.777..., '4x3', '1.5'. */
  function parseRatio(s) {
    const t = String(s == null ? '' : s).trim().toLowerCase();
    if (!t || t === 'free') return 0;
    const m = /^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/.exec(t);
    if (m) { const a = Number(m[1]), b = Number(m[2]); return a > 0 && b > 0 ? a / b : 0; }
    const n = Number(t);
    return n > 0 && Number.isFinite(n) ? n : 0;
  }

  /**
   * Crop rectangle from a drag (image pixels): normalised, held to the ratio (width / height, 0 = free), kept inside
   * the image, whole pixels, at least 1 x 1. The corner where the drag started stays put.
   */
  function cropFromDrag(x0, y0, x1, y1, ratio, imgW, imgH) {
    x0 = clamp(Math.round(num(x0)), 0, imgW); y0 = clamp(Math.round(num(y0)), 0, imgH);
    x1 = clamp(Math.round(num(x1)), 0, imgW); y1 = clamp(Math.round(num(y1)), 0, imgH);
    let w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    const sx = x1 >= x0 ? 1 : -1, sy = y1 >= y0 ? 1 : -1;
    if (ratio > 0) {
      if (w / Math.max(h, 1e-9) > ratio) w = Math.round(h * ratio); else h = Math.round(w / ratio);
      // keep inside the image on the side the drag goes to
      const maxW = sx > 0 ? imgW - x0 : x0, maxH = sy > 0 ? imgH - y0 : y0;
      if (w > maxW) { w = maxW; h = Math.round(w / ratio); }
      if (h > maxH) { h = maxH; w = Math.round(h * ratio); }
    }
    w = Math.max(1, w); h = Math.max(1, h);
    let x = sx > 0 ? x0 : x0 - w, y = sy > 0 ? y0 : y0 - h;
    x = clamp(x, 0, Math.max(0, imgW - 1)); y = clamp(y, 0, Math.max(0, imgH - 1));
    w = Math.min(w, imgW - x); h = Math.min(h, imgH - y);
    return { x, y, w: Math.max(1, w), h: Math.max(1, h) };
  }

  /** The largest centred rectangle with this ratio inside the image (the default crop for a ratio). */
  function centeredCrop(ratio, imgW, imgH) {
    if (!(ratio > 0)) return { x: 0, y: 0, w: imgW, h: imgH };
    let w = imgW, h = Math.round(imgW / ratio);
    if (h > imgH) { h = imgH; w = Math.round(imgH * ratio); }
    w = clamp(w, 1, imgW); h = clamp(h, 1, imgH);
    return { x: Math.floor((imgW - w) / 2), y: Math.floor((imgH - h) / 2), w, h };
  }

  /** Clamp a typed-in crop rectangle to the image. */
  function clampRect(r, imgW, imgH) {
    const x = clamp(Math.round(num(r.x)), 0, imgW - 1), y = clamp(Math.round(num(r.y)), 0, imgH - 1);
    const w = clamp(Math.round(num(r.w, imgW)), 1, imgW - x), h = clamp(Math.round(num(r.h, imgH)), 1, imgH - y);
    return { x, y, w, h };
  }

  /**
   * New size for a resize. o: { unit: 'px'|'%', width, height, keepRatio }. With keepRatio, the side the user typed
   * last (o.from = 'width'|'height') leads; an empty side follows the ratio. Result: whole pixels, 1..MAX_SIDE.
   */
  function resizeDims(w, h, o) {
    let nw, nh;
    if (o.unit === '%') {
      const pw = num(Number(o.width), 0), ph = num(Number(o.height), 0);
      const p1 = pw > 0 ? pw : ph, p2 = o.keepRatio ? p1 : (ph > 0 ? ph : p1);
      if (!(p1 > 0)) throw new Error('Type a percent above 0.');
      nw = Math.round(w * p1 / 100); nh = Math.round(h * p2 / 100);
    } else {
      const tw = Math.round(num(Number(o.width), 0)), th = Math.round(num(Number(o.height), 0));
      if (!(tw > 0) && !(th > 0)) throw new Error('Type a width or a height in pixels.');
      if (o.keepRatio) {
        if (tw > 0 && (o.from !== 'height' || !(th > 0))) { nw = tw; nh = Math.round(h * tw / w); } else { nh = th; nw = Math.round(w * th / h); }
      } else { nw = tw > 0 ? tw : w; nh = th > 0 ? th : h; }
    }
    if (nw > MAX_SIDE || nh > MAX_SIDE) throw new Error(`The new size ${nw} x ${nh} is over ${MAX_SIDE} pixels a side.`);
    return { w: Math.max(1, nw), h: Math.max(1, nh) };
  }

  /** Intermediate sizes for a high-quality downscale: halve until the next step is within 2x of the target. */
  function downscaleSteps(sw, sh, dw, dh) {
    const steps = [];
    let w = sw, h = sh;
    while (w / 2 >= dw && h / 2 >= dh && steps.length < 16) { w = Math.round(w / 2); h = Math.round(h / 2); if (w > dw * 1.0001 || h > dh * 1.0001) steps.push({ w, h }); else break; }
    steps.push({ w: dw, h: dh });
    return steps;
  }

  /** Largest rectangle with the image's ratio that fits inside the image turned by angle degrees (no empty corners). */
  function straightenCrop(w, h, angleDeg) {
    const a = Math.abs(num(angleDeg)) * Math.PI / 180 % Math.PI;
    if (a < 1e-9) return { w, h };
    const sin = Math.abs(Math.sin(a)), cos = Math.abs(Math.cos(a));
    // scale s so that the rectangle (s*w, s*h) turned by -a fits in w x h
    const s = Math.min(w / (w * cos + h * sin), h / (w * sin + h * cos));
    return { w: Math.max(1, Math.floor(w * s)), h: Math.max(1, Math.floor(h * s)) };
  }

  /** Size after one op (width/height of the image the op returns). */
  function sizeAfter(w, h, op) {
    switch (op.kind) {
      case 'crop': return { w: op.w, h: op.h };
      case 'resize': return { w: op.w, h: op.h };
      case 'rotate': return op.deg === 180 ? { w, h } : { w: h, h: w };
      case 'straighten': return straightenCrop(w, h, op.angle);
      default: return { w, h };
    }
  }
  function sizeAfterOps(w, h, ops) { let s = { w, h }; for (const op of ops) s = sizeAfter(s.w, s.h, op); return s; }

  /** EXIF orientation 1-8 as a canvas transform: output size and the matrix [a, b, c, d, e, f] for setTransform. */
  function orientation(o, w, h) {
    switch (o) {
      case 2: return { w, h, m: [-1, 0, 0, 1, w, 0] };
      case 3: return { w, h, m: [-1, 0, 0, -1, w, h] };
      case 4: return { w, h, m: [1, 0, 0, -1, 0, h] };
      case 5: return { w: h, h: w, m: [0, 1, 1, 0, 0, 0] };
      case 6: return { w: h, h: w, m: [0, 1, -1, 0, h, 0] };
      case 7: return { w: h, h: w, m: [0, -1, -1, 0, h, w] };
      case 8: return { w: h, h: w, m: [0, -1, 1, 0, 0, w] };
      default: return { w, h, m: [1, 0, 0, 1, 0, 0] };
    }
  }
  /** Where a source pixel lands after the orientation transform (for tests). */
  function applyMatrix(m, x, y) { return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }; }

  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

  /**
   * Check and normalise one op from the webview or a backup file. Returns a clean copy, or throws. w/h is the size
   * of the image the op applies to (so a crop stays inside it).
   */
  function sanitizeOp(op, w, h) {
    if (!op || typeof op !== 'object' || !KINDS.includes(op.kind)) throw new Error('unknown edit');
    const color = COLOR_RE.test(op.color) ? op.color.toLowerCase() : '#e5484d';
    const width = clamp(Math.round(num(op.width, 4)), 1, 200);
    const P = (v) => clamp(num(v), -MAX_SIDE, 2 * MAX_SIDE);
    switch (op.kind) {
      case 'crop': return { kind: 'crop', ...clampRect(op, w, h) };
      case 'resize': {
        const nw = Math.round(num(op.w)), nh = Math.round(num(op.h));
        if (!(nw >= 1 && nh >= 1 && nw <= MAX_SIDE && nh <= MAX_SIDE)) throw new Error('bad size');
        return { kind: 'resize', w: nw, h: nh };
      }
      case 'rotate': { const d = ((Math.round(num(op.deg) / 90) * 90) % 360 + 360) % 360; if (!d) throw new Error('bad angle'); return { kind: 'rotate', deg: d }; }
      case 'flip': return { kind: 'flip', axis: op.axis === 'v' ? 'v' : 'h' };
      case 'straighten': { const a = clamp(Math.round(num(op.angle) * 10) / 10, -45, 45); if (!a) throw new Error('no angle'); return { kind: 'straighten', angle: a }; }
      case 'adjust': {
        const b = clamp(Math.round(num(op.b, 100)), 0, 300), c = clamp(Math.round(num(op.c, 100)), 0, 300), s = clamp(Math.round(num(op.s, 100)), 0, 300);
        if (b === 100 && c === 100 && s === 100) throw new Error('no change');
        return { kind: 'adjust', b, c, s };
      }
      case 'redact': {
        const r = clampRect(op, w, h);
        return { kind: 'redact', mode: op.mode === 'blur' ? 'blur' : 'pixelate', ...r, size: clamp(Math.round(num(op.size, 12)), 4, 400) };
      }
      case 'text': {
        const text = String(op.text == null ? '' : op.text).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, MAX_TEXT);
        if (!text.trim()) throw new Error('empty text');
        return { kind: 'text', x: P(op.x), y: P(op.y), text, color, size: clamp(Math.round(num(op.size, 32)), 6, 1000) };
      }
      case 'pen': case 'hl': {
        const pts = Array.isArray(op.pts) ? op.pts.slice(0, MAX_POINTS * 2).map((v) => P(Number(v))) : [];
        if (pts.length < 2 || pts.length % 2) throw new Error('bad stroke');
        return { kind: op.kind, pts, color, width: op.kind === 'hl' ? clamp(width, 4, 200) : width };
      }
      case 'step': return { kind: 'step', x: P(op.x), y: P(op.y), n: clamp(Math.round(num(op.n, 1)), 1, 999), color, size: clamp(Math.round(num(op.size, 28)), 8, 400) };
      default: return { kind: op.kind, x1: P(op.x1), y1: P(op.y1), x2: P(op.x2), y2: P(op.y2), color, width };
    }
  }

  /** Check a whole list (backup file): each op against the size the ops before it give. Bad ops are dropped. */
  function sanitizeOps(ops, w, h, max = 2000) {
    const out = [];
    let s = { w, h };
    for (const op of Array.isArray(ops) ? ops.slice(0, max) : []) {
      try { const c = sanitizeOp(op, s.w, s.h); out.push(c); s = sizeAfter(s.w, s.h, c); } catch { /* dropped */ }
    }
    return out;
  }

  /** Short label for the Undo menu and the status line. */
  function opLabel(op) {
    switch (op.kind) {
      case 'crop': return `Crop to ${op.w} x ${op.h}`;
      case 'resize': return `Resize to ${op.w} x ${op.h}`;
      case 'rotate': return op.deg === 180 ? 'Rotate 180°' : op.deg === 90 ? 'Rotate right' : 'Rotate left';
      case 'flip': return op.axis === 'v' ? 'Flip vertical' : 'Flip horizontal';
      case 'straighten': return `Straighten ${op.angle}°`;
      case 'adjust': return 'Brightness, contrast, saturation';
      case 'redact': return op.mode === 'blur' ? 'Blur area' : 'Pixelate area';
      case 'text': return 'Text';
      case 'pen': return 'Pen';
      case 'hl': return 'Highlighter';
      case 'step': return `Step ${op.n}`;
      default: return op.kind[0].toUpperCase() + op.kind.slice(1);
    }
  }

  /** The next number for a step badge: one more than the highest step still applied. */
  function nextStep(ops) { let n = 0; for (const op of ops) if (op.kind === 'step' && op.n > n) n = op.n; return n + 1; }

  /** Arrow head triangle for a line from (x1, y1) to (x2, y2). */
  function arrowHead(x1, y1, x2, y2, width) {
    const len = Math.max(10, width * 4.5);
    const a = Math.atan2(y2 - y1, x2 - x1);
    const spread = Math.PI / 7;
    return [x2, y2, x2 - len * Math.cos(a - spread), y2 - len * Math.sin(a - spread), x2 - len * Math.cos(a + spread), y2 - len * Math.sin(a + spread)];
  }

  /** Bounding box of an annotation in image pixels (to know what an op touches). */
  function opBounds(op) {
    if (SHAPES.includes(op.kind)) { const p = op.width; return { x: Math.min(op.x1, op.x2) - p * 3, y: Math.min(op.y1, op.y2) - p * 3, w: Math.abs(op.x2 - op.x1) + p * 6, h: Math.abs(op.y2 - op.y1) + p * 6 }; }
    if (op.kind === 'pen' || op.kind === 'hl') {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < op.pts.length; i += 2) { x0 = Math.min(x0, op.pts[i]); x1 = Math.max(x1, op.pts[i]); y0 = Math.min(y0, op.pts[i + 1]); y1 = Math.max(y1, op.pts[i + 1]); }
      return { x: x0 - op.width, y: y0 - op.width, w: x1 - x0 + 2 * op.width, h: y1 - y0 + 2 * op.width };
    }
    if (op.kind === 'step') return { x: op.x - op.size, y: op.y - op.size, w: op.size * 2, h: op.size * 2 };
    if (op.kind === 'text') return { x: op.x, y: op.y - op.size, w: op.text.length * op.size * 0.6, h: op.size * 1.3 * (op.text.split('\n').length) };
    if (op.kind === 'redact' || op.kind === 'crop') return { x: op.x, y: op.y, w: op.w, h: op.h };
    return null;
  }

  /** Drop points closer than minDist to the last kept one (pen strokes stay small). */
  function simplifyStroke(pts, minDist) {
    if (pts.length <= 4) return pts.slice();
    const out = [pts[0], pts[1]];
    for (let i = 2; i < pts.length - 2; i += 2) {
      const dx = pts[i] - out[out.length - 2], dy = pts[i + 1] - out[out.length - 1];
      if (dx * dx + dy * dy >= minDist * minDist) out.push(pts[i], pts[i + 1]);
    }
    out.push(pts[pts.length - 2], pts[pts.length - 1]);
    return out;
  }

  /**
   * The edit history: a list of ops and a position (how many are applied). The extension host keeps the same list
   * and moves the position on Undo / Redo, so VS Code's Undo, Redo, Save and Revert stay in step with the canvas.
   */
  class History {
    constructor(ops, pos) { this.ops = Array.isArray(ops) ? ops.slice() : []; this.pos = pos == null ? this.ops.length : clamp(pos, 0, this.ops.length); }
    push(op) { this.ops.length = this.pos; this.ops.push(op); this.pos = this.ops.length; return this.pos; }
    undo() { if (this.pos > 0) this.pos--; return this.pos; }
    redo() { if (this.pos < this.ops.length) this.pos++; return this.pos; }
    goto(p) { this.pos = clamp(Math.round(num(p)), 0, this.ops.length); return this.pos; }
    get canUndo() { return this.pos > 0; }
    get canRedo() { return this.pos < this.ops.length; }
    applied() { return this.ops.slice(0, this.pos); }
    reset() { this.ops = []; this.pos = 0; }
  }

  /** Snapshot plan: which positions to keep rendered, under a pixel budget (newest first, position 0 always). */
  function snapshotKeep(sizes, budgetPixels) {
    const keep = new Set([0]);
    let used = sizes[0] ? sizes[0].w * sizes[0].h : 0;
    for (let p = sizes.length - 1; p > 0; p--) {
      const px = sizes[p].w * sizes[p].h;
      if (used + px > budgetPixels) break;
      keep.add(p); used += px;
    }
    return keep;
  }

  // ---------------- Pro: batch planner ----------------

  const IMAGE_RE = /\.(png|jpe?g|jpe|jfif|webp|bmp|gif)$/i;
  const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp', bmp: 'bmp', gif: 'png' };

  function fmtOfName(n) {
    const m = /\.([a-z0-9]+)$/i.exec(n); const e = m ? m[1].toLowerCase() : '';
    return e === 'png' ? 'png' : (e === 'jpg' || e === 'jpeg' || e === 'jpe' || e === 'jfif') ? 'jpeg' : e === 'webp' ? 'webp' : e === 'bmp' ? 'bmp' : e === 'gif' ? 'gif' : '';
  }

  /** Target size for a batch resize: 'max' fits inside maxW x maxH and never makes an image bigger; 'pct' scales. */
  function batchDims(w, h, o) {
    if (o.mode === 'pct') { const p = num(o.pct, 100) / 100; return { w: Math.max(1, Math.round(w * p)), h: Math.max(1, Math.round(h * p)) }; }
    if (o.mode === 'none') return { w, h };
    const mw = num(o.maxW, 0) > 0 ? o.maxW : Infinity, mh = num(o.maxH, 0) > 0 ? o.maxH : Infinity;
    const s = Math.min(1, mw / w, mh / h);
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  }

  /**
   * Plan a batch: names is the list of file names in one folder; o = { format: 'keep'|'png'|'jpeg'|'webp',
   * suffix: '-small' (next to the originals) or subfolder: 'resized', existing: Set of names already there }.
   * Never plans to overwrite a file (an original or an earlier output): a number is added instead.
   */
  function planBatch(names, o) {
    const taken = new Set([...(o.existing || []), ...names].map((n) => n.toLowerCase()));
    const outTaken = new Set((o.existingOut || []).map((n) => n.toLowerCase()));
    const plan = [];
    for (const name of names) {
      const src = fmtOfName(name);
      if (!IMAGE_RE.test(name) || !src) { plan.push({ name, skip: 'not an image' }); continue; }
      let fmt = o.format && o.format !== 'keep' ? o.format : src;
      if (fmt === 'gif') fmt = 'png'; // GIF is written as PNG (first frame)
      const base = name.replace(/\.[^.]+$/, '');
      const ext = EXT[fmt];
      const inSub = !!o.subfolder;
      const set = inSub ? outTaken : taken;
      let out = `${base}${inSub ? '' : (o.suffix || '-resized')}.${ext}`;
      for (let i = 2; set.has(out.toLowerCase()) && i < 10000; i++) out = `${base}${inSub ? '' : (o.suffix || '-resized')}-${i}.${ext}`;
      set.add(out.toLowerCase());
      plan.push({ name, out, format: fmt, dir: inSub ? o.subfolder : '' });
    }
    return plan;
  }

  /** "200 KB", "1.5 MB", "300k", "80000" (bytes) -> bytes. */
  function parseSize(s) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(b|bytes?|k|kb|kib|m|mb|mib)?\s*$/i.exec(String(s == null ? '' : s));
    if (!m) throw new Error('Type a size like 200 KB or 1.5 MB.');
    const n = Number(m[1]), u = (m[2] || 'kb').toLowerCase();
    const bytes = Math.round(u[0] === 'm' ? n * 1024 * 1024 : u[0] === 'k' ? n * 1024 : n);
    if (bytes < 1024) throw new Error('The target must be at least 1 KB.');
    if (bytes > 512 * 1024 * 1024) throw new Error('The target must be 512 MB or less.');
    return bytes;
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
    return `${(n / 1048576).toFixed(n < 10485760 ? 2 : 1)} MB`;
  }

  /**
   * Find the highest quality whose encoding fits in target bytes. encode(q, scale) -> Promise<{ size, data? }>.
   * Binary search on quality (0.05-0.95, about 7 encodes); when even the lowest quality is too big, scale the image
   * down (up to 4 times) and search again. Returns { q, scale, size, data, fits, tries }.
   */
  async function searchQuality(encode, target, o = {}) {
    const minQ = o.minQ || 0.05, maxQ = o.maxQ || 0.95, steps = o.steps || 7;
    let scale = 1, tries = 0, best = null, smallest = null;
    for (let round = 0; round < 5; round++) {
      let lo = minQ, hi = maxQ, found = null;
      const top = await encode(hi, scale); tries++;
      if (!smallest || top.size < smallest.size) smallest = { q: hi, scale, ...top };
      if (top.size <= target) { found = { q: hi, scale, ...top }; }
      else {
        for (let i = 0; i < steps; i++) {
          const q = Math.round(((lo + hi) / 2) * 1000) / 1000;
          const r = await encode(q, scale); tries++;
          if (!smallest || r.size < smallest.size) smallest = { q, scale, ...r };
          if (r.size <= target) { found = { q, scale, ...r }; lo = q; } else hi = q;
          if (o.cancelled && o.cancelled()) break;
        }
        if (!found) { const r = await encode(minQ, scale); tries++; if (!smallest || r.size < smallest.size) smallest = { q: minQ, scale, ...r }; if (r.size <= target) found = { q: minQ, scale, ...r }; }
      }
      if (found) { best = found; break; }
      if (o.cancelled && o.cancelled()) break;
      // too big even at the lowest quality: shrink the pixels by the square root of the size ratio, with a margin
      const ratio = target / Math.max(1, smallest.size);
      scale = Math.max(0.05, scale * Math.min(0.9, Math.sqrt(ratio) * 0.95));
    }
    const r = best || smallest;
    return { q: r.q, scale: r.scale, size: r.size, data: r.data, fits: !!best, tries };
  }

  // ---------------- Pro: compare ----------------

  /**
   * Pixel diff of two RGBA buffers of the same size. threshold: the largest channel difference (0-255) that still
   * counts as the same. Returns { changed, mask } (mask[i] = 1 for a changed pixel).
   */
  function diffPixels(a, b, w, h, threshold) {
    const n = w * h, mask = new Uint8Array(n);
    let changed = 0;
    const t = clamp(Math.round(num(threshold, 0)), 0, 255);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const d = Math.max(Math.abs(a[p] - b[p]), Math.abs(a[p + 1] - b[p + 1]), Math.abs(a[p + 2] - b[p + 2]), Math.abs(a[p + 3] - b[p + 3]));
      if (d > t) { mask[i] = 1; changed++; }
    }
    return { changed, mask };
  }

  /**
   * Bounding boxes of the changed areas: the mask is reduced to cells of cell x cell pixels, touching cells are
   * joined (4-neighbours), and each group gives one box. At most max boxes (the largest ones).
   */
  function changedBoxes(mask, w, h, o = {}) {
    const cell = Math.max(1, o.cell || 8), max = o.max || 50;
    const cw = Math.ceil(w / cell), ch = Math.ceil(h / cell);
    const grid = new Uint8Array(cw * ch);
    for (let y = 0; y < h; y++) { const row = y * w, gy = ((y / cell) | 0) * cw; for (let x = 0; x < w; x++) if (mask[row + x]) grid[gy + ((x / cell) | 0)] = 1; }
    const seen = new Uint8Array(cw * ch), boxes = [], stack = [];
    for (let i = 0; i < grid.length; i++) {
      if (!grid[i] || seen[i]) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, cells = 0;
      stack.push(i); seen[i] = 1;
      while (stack.length) {
        const k = stack.pop(), gx = k % cw, gy = (k / cw) | 0; cells++;
        if (gx < x0) x0 = gx; if (gx > x1) x1 = gx; if (gy < y0) y0 = gy; if (gy > y1) y1 = gy;
        const nb = [gx > 0 ? k - 1 : -1, gx < cw - 1 ? k + 1 : -1, gy > 0 ? k - cw : -1, gy < ch - 1 ? k + cw : -1];
        for (const q of nb) if (q >= 0 && grid[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
      boxes.push({ x: x0 * cell, y: y0 * cell, w: Math.min(w, (x1 + 1) * cell) - x0 * cell, h: Math.min(h, (y1 + 1) * cell) - y0 * cell, cells });
    }
    boxes.sort((p, q) => q.w * q.h - p.w * p.h);
    return { boxes: boxes.slice(0, max), total: boxes.length };
  }

  /** Encode RGBA pixels as a 32-bit BMP (bottom-up, BI_BITFIELDS with alpha), for "Save" on .bmp files. */
  function encodeBmp(rgba, w, h) {
    const header = 14 + 108, rowBytes = w * 4, size = header + rowBytes * h;
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    out[0] = 0x42; out[1] = 0x4d; dv.setUint32(2, size, true); dv.setUint32(10, header, true);
    dv.setUint32(14, 108, true); dv.setInt32(18, w, true); dv.setInt32(22, h, true); dv.setUint16(26, 1, true); dv.setUint16(28, 32, true);
    dv.setUint32(30, 3, true); dv.setUint32(34, rowBytes * h, true); dv.setInt32(38, 2835, true); dv.setInt32(42, 2835, true);
    dv.setUint32(54, 0x00ff0000, true); dv.setUint32(58, 0x0000ff00, true); dv.setUint32(62, 0x000000ff, true); dv.setUint32(66, 0xff000000, true);
    dv.setUint32(70, 0x57696e20, true); // 'Win ' colour space
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * rowBytes, dst = header + y * rowBytes;
      for (let x = 0; x < rowBytes; x += 4) { out[dst + x] = rgba[src + x + 2]; out[dst + x + 1] = rgba[src + x + 1]; out[dst + x + 2] = rgba[src + x]; out[dst + x + 3] = rgba[src + x + 3]; }
    }
    return out;
  }

  /** Split bytes into chunks for postMessage. */
  function chunks(u8, size) { const out = []; for (let i = 0; i < u8.length; i += size) out.push(u8.subarray(i, Math.min(u8.length, i + size))); if (!out.length) out.push(new Uint8Array(0)); return out; }
  function joinChunks(list) { let n = 0; for (const c of list) n += c.length; const out = new Uint8Array(n); let o = 0; for (const c of list) { out.set(c, o); o += c.length; } return out; }

  return {
    MAX_SIDE, KINDS, SHAPES, clamp, parseRatio, cropFromDrag, centeredCrop, clampRect, resizeDims, downscaleSteps, straightenCrop,
    sizeAfter, sizeAfterOps, orientation, applyMatrix, sanitizeOp, sanitizeOps, opLabel, nextStep, arrowHead, opBounds,
    simplifyStroke, History, snapshotKeep, IMAGE_RE, fmtOfName, batchDims, planBatch, parseSize, formatBytes, searchQuality,
    diffPixels, changedBoxes, encodeBmp, chunks, joinChunks,
  };
}));
