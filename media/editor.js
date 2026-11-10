// Image Editor webview: decodes the image on a canvas, applies the edit list (crop, resize, rotate, flip,
// straighten, adjust, redact, annotations) and encodes the result for Save. The extension host keeps the same edit
// list, so VS Code's Undo, Redo, Save, Save As, Revert and hot exit work. Styles go through the CSSOM only (the CSP
// has no 'unsafe-inline'), names and messages are set with textContent.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const C = window.ImgCore;
  const app = document.getElementById('app');
  const CHUNK = 4 * 1024 * 1024;
  const SNAP_BUDGET = 160 * 1000 * 1000; // pixels kept as rendered steps (about 640 MB of RGBA at most)

  const st = {
    name: '', format: 'png', bytes: 0, orientation: 1, notice: '',
    hist: new C.History(), snaps: new Map(), cur: null, w: 0, h: 0,
    zoom: 1, fit: true, tool: 'move', color: '#e5484d', width: 6, textSize: 36, redactSize: 16,
    crop: null, ratio: 0, drag: null, straighten: 0, adjust: { b: 100, c: 100, s: 100 },
    pro: { show: true, licensed: false, tries: {} }, rendered: false, rx: new Map(),
  };
  const el = {};
  const post = (m) => vscode.postMessage(m);

  // ---------------- small DOM helpers ----------------
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(e.dataset, v); else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  }
  const css = (e, props) => { for (const [k, v] of Object.entries(props)) { if (v == null) e.style.removeProperty(k); else e.style.setProperty(k, v); } };
  const mkCanvas = (w, h2) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h2)); return c; };
  const ctx2 = (c) => c.getContext('2d');

  // ---------------- bytes in and out (chunked postMessage) ----------------
  function sendBytes(u8) {
    const tx = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const parts = C.chunks(u8, CHUNK);
    parts.forEach((data, seq) => post({ type: 'chunk', tx, seq, last: seq === parts.length - 1, data }));
    return tx;
  }
  function takeBytes(tx) { const list = st.rx.get(tx) || []; st.rx.delete(tx); return C.joinChunks(list.map((d) => (d instanceof Uint8Array ? d : new Uint8Array(d)))); }

  // ---------------- decoding ----------------
  async function decode(u8, mime) {
    const blob = new Blob([u8], { type: mime });
    try { return await createImageBitmap(blob); } catch (e1) {
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('decode')); img.src = url; });
        if (!img.naturalWidth) throw new Error('decode');
        return img;
      } finally { URL.revokeObjectURL(url); }
    }
  }
  function oriented(src, o) {
    const w = src.width || src.naturalWidth, hh = src.height || src.naturalHeight;
    const t = C.orientation(o, w, hh);
    const c = mkCanvas(t.w, t.h);
    const x = ctx2(c);
    x.setTransform(...t.m);
    x.drawImage(src, 0, 0);
    return c;
  }

  // ---------------- applying ops ----------------
  function copyOf(src) { const c = mkCanvas(src.width, src.height); ctx2(c).drawImage(src, 0, 0); return c; }
  function resample(src, w, hh) {
    let cur = src;
    for (const s of C.downscaleSteps(src.width, src.height, w, hh)) {
      const c = mkCanvas(s.w, s.h); const x = ctx2(c);
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
      x.drawImage(cur, 0, 0, s.w, s.h);
      cur = c;
    }
    return cur;
  }
  function strokeStyle(x, op) { x.strokeStyle = op.color; x.fillStyle = op.color; x.lineWidth = op.width; x.lineCap = 'round'; x.lineJoin = 'round'; }
  function drawShape(x, op) {
    x.save();
    if (op.kind === 'arrow' || op.kind === 'line') {
      strokeStyle(x, op);
      let ex = op.x2, ey = op.y2;
      if (op.kind === 'arrow') {
        const head = C.arrowHead(op.x1, op.y1, op.x2, op.y2, op.width);
        const back = Math.max(10, op.width * 4.5) * 0.6, a = Math.atan2(op.y2 - op.y1, op.x2 - op.x1);
        ex = op.x2 - back * Math.cos(a); ey = op.y2 - back * Math.sin(a);
        x.beginPath(); x.moveTo(head[0], head[1]); x.lineTo(head[2], head[3]); x.lineTo(head[4], head[5]); x.closePath(); x.fill();
      }
      x.beginPath(); x.moveTo(op.x1, op.y1); x.lineTo(ex, ey); x.stroke();
    } else if (op.kind === 'rect') {
      strokeStyle(x, op); x.lineJoin = 'miter';
      x.strokeRect(Math.min(op.x1, op.x2), Math.min(op.y1, op.y2), Math.abs(op.x2 - op.x1), Math.abs(op.y2 - op.y1));
    } else if (op.kind === 'ellipse') {
      strokeStyle(x, op);
      x.beginPath(); x.ellipse((op.x1 + op.x2) / 2, (op.y1 + op.y2) / 2, Math.max(0.5, Math.abs(op.x2 - op.x1) / 2), Math.max(0.5, Math.abs(op.y2 - op.y1) / 2), 0, 0, Math.PI * 2); x.stroke();
    } else if (op.kind === 'pen' || op.kind === 'hl') {
      strokeStyle(x, op);
      if (op.kind === 'hl') { x.globalAlpha = 0.35; x.lineCap = 'square'; }
      x.beginPath(); x.moveTo(op.pts[0], op.pts[1]);
      for (let i = 2; i < op.pts.length; i += 2) x.lineTo(op.pts[i], op.pts[i + 1]);
      if (op.pts.length === 2) x.lineTo(op.pts[0] + 0.01, op.pts[1]);
      x.stroke();
    } else if (op.kind === 'text') {
      x.font = `600 ${op.size}px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
      x.textBaseline = 'alphabetic';
      const dark = parseInt(op.color.slice(1, 3), 16) * 0.3 + parseInt(op.color.slice(3, 5), 16) * 0.59 + parseInt(op.color.slice(5, 7), 16) * 0.11 < 128;
      x.lineWidth = Math.max(2, op.size / 7); x.lineJoin = 'round'; x.strokeStyle = dark ? '#ffffff' : '#000000'; x.fillStyle = op.color;
      op.text.split('\n').forEach((line, i) => { const y = op.y + i * op.size * 1.25; x.strokeText(line, op.x, y); x.fillText(line, op.x, y); });
    } else if (op.kind === 'step') {
      const r = op.size;
      x.fillStyle = op.color; x.beginPath(); x.arc(op.x, op.y, r, 0, Math.PI * 2); x.fill();
      x.lineWidth = Math.max(2, r / 8); x.strokeStyle = '#ffffff'; x.stroke();
      x.fillStyle = '#ffffff'; x.font = `700 ${Math.round(r * (op.n > 9 ? 0.95 : 1.15))}px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
      x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(op.n), op.x, op.y + r * 0.06);
    }
    x.restore();
  }
  function applyOp(src, op) {
    const w = src.width, hh = src.height;
    switch (op.kind) {
      case 'crop': { const c = mkCanvas(op.w, op.h); ctx2(c).drawImage(src, -op.x, -op.y); return c; }
      case 'resize': return resample(src, op.w, op.h);
      case 'rotate': {
        const c = op.deg === 180 ? mkCanvas(w, hh) : mkCanvas(hh, w); const x = ctx2(c);
        x.translate(c.width / 2, c.height / 2); x.rotate(op.deg * Math.PI / 180); x.drawImage(src, -w / 2, -hh / 2); return c;
      }
      case 'flip': { const c = mkCanvas(w, hh); const x = ctx2(c); if (op.axis === 'h') x.setTransform(-1, 0, 0, 1, w, 0); else x.setTransform(1, 0, 0, -1, 0, hh); x.drawImage(src, 0, 0); return c; }
      case 'straighten': {
        const s = C.straightenCrop(w, hh, op.angle); const c = mkCanvas(s.w, s.h); const x = ctx2(c);
        x.imageSmoothingQuality = 'high'; x.translate(s.w / 2, s.h / 2); x.rotate(op.angle * Math.PI / 180); x.drawImage(src, -w / 2, -hh / 2); return c;
      }
      case 'adjust': { const c = mkCanvas(w, hh); const x = ctx2(c); x.filter = `brightness(${op.b}%) contrast(${op.c}%) saturate(${op.s}%)`; x.drawImage(src, 0, 0); return c; }
      case 'redact': {
        const c = copyOf(src); const x = ctx2(c);
        if (op.mode === 'pixelate') {
          const tw = Math.max(1, Math.ceil(op.w / op.size)), th = Math.max(1, Math.ceil(op.h / op.size));
          const t = mkCanvas(tw, th); const tx = ctx2(t); tx.imageSmoothingEnabled = true; tx.imageSmoothingQuality = 'high';
          tx.drawImage(src, op.x, op.y, op.w, op.h, 0, 0, tw, th);
          // the last cells may reach past the area: draw them clipped to it
          x.save(); x.beginPath(); x.rect(op.x, op.y, op.w, op.h); x.clip();
          x.imageSmoothingEnabled = false; x.clearRect(op.x, op.y, op.w, op.h); x.drawImage(t, 0, 0, tw, th, op.x, op.y, tw * op.size, th * op.size);
          x.restore();
        } else {
          // blur twice with a large radius, then add a light pixelation so no edge of the original stays readable
          const pad = op.size * 3;
          const t = mkCanvas(op.w + pad * 2, op.h + pad * 2); const tx = ctx2(t);
          tx.drawImage(src, op.x - pad, op.y - pad, op.w + pad * 2, op.h + pad * 2, 0, 0, op.w + pad * 2, op.h + pad * 2);
          const t2 = mkCanvas(t.width, t.height); const t2x = ctx2(t2);
          t2x.filter = `blur(${op.size}px)`; t2x.drawImage(t, 0, 0);
          tx.clearRect(0, 0, t.width, t.height); tx.filter = `blur(${op.size}px)`; tx.drawImage(t2, 0, 0);
          x.save(); x.beginPath(); x.rect(op.x, op.y, op.w, op.h); x.clip(); x.clearRect(op.x, op.y, op.w, op.h);
          x.drawImage(t, pad, pad, op.w, op.h, op.x, op.y, op.w, op.h); x.restore();
        }
        return c;
      }
      default: { const c = copyOf(src); drawShape(ctx2(c), op); return c; }
    }
  }
  function canvasAt(pos) {
    let k = pos;
    while (k > 0 && !st.snaps.has(k)) k--;
    let c = st.snaps.get(k);
    const ops = st.hist.ops;
    for (let i = k; i < pos; i++) { c = applyOp(c, ops[i]); st.snaps.set(i + 1, c); }
    pruneSnaps();
    return c;
  }
  function pruneSnaps() {
    const sizes = [];
    for (let p = 0; p <= st.hist.ops.length; p++) { const c = st.snaps.get(p); sizes.push(c ? { w: c.width, h: c.height } : { w: 0, h: 0 }); }
    const keep = C.snapshotKeep(sizes, SNAP_BUDGET);
    keep.add(st.hist.pos);
    for (const p of [...st.snaps.keys()]) if (!keep.has(p) || p > st.hist.ops.length) st.snaps.delete(p);
  }

  // ---------------- layout ----------------
  const TOOLS = [
    ['move', 'Move', 'Move and scroll the image (V)'], ['crop', 'Crop', 'Crop: drag a box, or type it; Enter applies (C)'],
    ['resize', 'Resize', 'Resize in pixels or percent'], ['straighten', 'Straighten', 'Turn by a free angle; the empty corners are cut off'],
    ['adjust', 'Adjust', 'Brightness, contrast and saturation'],
  ];
  const MARKS = [
    ['arrow', 'Arrow', 'A'], ['line', 'Line', 'L'], ['rect', 'Box', 'R'], ['ellipse', 'Ellipse', 'E'], ['text', 'Text', 'T'],
    ['pen', 'Pen', 'P'], ['hl', 'Highlighter', 'H'], ['step', 'Step', 'N'],
  ];
  const REDACT = [['blur', 'Blur', 'B'], ['pixelate', 'Pixelate', 'X']];
  const KEYS = { v: 'move', c: 'crop', a: 'arrow', l: 'line', r: 'rect', e: 'ellipse', t: 'text', p: 'pen', h: 'hl', n: 'step', b: 'blur', x: 'pixelate' };
  const PRO = [['batch', 'Batch resize', 'Batch resize and convert a folder'], ['compress', 'Compress', 'Compress to a target size'], ['compare', 'Compare', 'Compare two images']];

  function build() {
    const toolBtn = ([id, label, title]) => h('button', { class: 'tb', dataset: { tool: id }, title, text: label, onclick: () => setTool(id) });
    el.bar = h('div', { class: 'bar', role: 'toolbar' },
      h('div', { class: 'grp' }, ...TOOLS.map(toolBtn)),
      h('div', { class: 'grp' },
        h('button', { class: 'tb', title: 'Rotate left (90° counter-clockwise)', text: '⟲ 90°', dataset: { act: 'rotl' }, onclick: () => commit({ kind: 'rotate', deg: 270 }) }),
        h('button', { class: 'tb', title: 'Rotate right (90° clockwise)', text: '⟳ 90°', dataset: { act: 'rotr' }, onclick: () => commit({ kind: 'rotate', deg: 90 }) }),
        h('button', { class: 'tb', title: 'Rotate 180°', text: '180°', dataset: { act: 'rot180' }, onclick: () => commit({ kind: 'rotate', deg: 180 }) }),
        h('button', { class: 'tb', title: 'Flip horizontal (mirror)', text: '⇋ Flip', dataset: { act: 'fliph' }, onclick: () => commit({ kind: 'flip', axis: 'h' }) }),
        h('button', { class: 'tb', title: 'Flip vertical', text: '⇵ Flip', dataset: { act: 'flipv' }, onclick: () => commit({ kind: 'flip', axis: 'v' }) })),
      h('div', { class: 'grp' }, ...MARKS.map(([id, label, k]) => toolBtn([id, label, `${label} (${k})`]))),
      h('div', { class: 'grp' }, ...REDACT.map(([id, label, k]) => toolBtn([id, label, `${label} an area: the pixels in the box are replaced for good when you save (${k})`]))),
      el.proGrp = h('div', { class: 'grp pro' }, ...PRO.map(([id, label, title]) => h('button', { class: 'tb', dataset: { pro: id }, title, text: label, onclick: () => post({ type: 'tool', tool: id }) }))),
    );
    el.opts = h('div', { class: 'opts' });
    el.notice = h('div', { class: 'notice', hidden: true });
    el.stage = h('div', { class: 'stage', tabindex: '0' });
    el.wrap = h('div', { class: 'wrap' });
    el.overlay = h('canvas', { class: 'overlay' });
    el.wrap.append(el.overlay);
    el.stage.append(el.wrap);
    el.status = h('div', { class: 'status' },
      el.info = h('span', { class: 'info' }), el.pos = h('span', { class: 'xy' }),
      h('span', { class: 'zoom' },
        h('button', { class: 'zb', title: 'Zoom out (-)', text: '−', dataset: { zoom: 'out' }, onclick: () => zoomBy(1 / 1.25) }),
        el.zoomLabel = h('span', { class: 'zl' }),
        h('button', { class: 'zb', title: 'Zoom in (+)', text: '+', dataset: { zoom: 'in' }, onclick: () => zoomBy(1.25) }),
        h('button', { class: 'zb', title: 'Fit to the window (0)', text: 'Fit', dataset: { zoom: 'fit' }, onclick: () => setZoom(0) }),
        h('button', { class: 'zb', title: 'Actual size (1)', text: '1:1', dataset: { zoom: '1' }, onclick: () => setZoom(1) })),
    );
    app.replaceChildren(el.bar, el.opts, el.notice, el.stage, el.status);
    const footer = document.getElementById('zovo-footer');
    if (footer && footer.content && footer.content.childElementCount) app.append(footer.content.cloneNode(true));
    wireStage();
    renderOpts();
    renderPro();
  }

  function renderPro() {
    if (!el.proGrp) return;
    el.proGrp.hidden = !st.pro.show;
    for (const b of el.proGrp.querySelectorAll('[data-pro]')) {
      const id = b.dataset.pro, base = PRO.find((p) => p[0] === id)[2];
      const left = st.pro.tries[id];
      b.title = st.pro.licensed ? `${base} (Zovo Pro)` : `${base} (Zovo Pro tool, ${left} free ${left === 1 ? 'try' : 'tries'} left)`;
    }
  }

  // ---------------- tool options ----------------
  function num(label, value, attrs, on) {
    const i = h('input', { type: 'number', value: String(value), ...attrs, oninput: on, onchange: on });
    return h('label', { class: 'f' }, h('span', { text: label }), i);
  }
  function renderOpts() {
    const t = st.tool;
    const kids = [];
    if (t === 'crop') {
      if (!st.crop) st.crop = C.centeredCrop(st.ratio, st.w, st.h);
      const sel = h('select', { class: 'ratio', title: 'Aspect ratio', onchange: () => { st.ratio = sel.value === 'custom' ? C.parseRatio(custom.value) : C.parseRatio(sel.value); custom.hidden = sel.value !== 'custom'; st.crop = C.centeredCrop(st.ratio, st.w, st.h); renderOpts(); drawOverlay(); } },
        ...['free', '1:1', '4:3', '3:2', '16:9', '9:16', 'custom'].map((v) => h('option', { value: v, text: v === 'free' ? 'Free' : v === 'custom' ? 'Custom…' : v })));
      const custom = h('input', { class: 'custom', type: 'text', placeholder: 'W:H', title: 'Custom ratio, for example 5:4', hidden: true, onchange: () => { st.ratio = C.parseRatio(custom.value); st.crop = C.centeredCrop(st.ratio, st.w, st.h); renderOpts(); drawOverlay(); } });
      sel.value = st.ratioSel || 'free';
      sel.addEventListener('change', () => { st.ratioSel = sel.value; });
      if (sel.value === 'custom') { custom.hidden = false; custom.value = st.ratioCustom || ''; }
      custom.addEventListener('change', () => { st.ratioCustom = custom.value; });
      const typed = () => { st.crop = C.clampRect({ x: +fx.querySelector('input').value, y: +fy.querySelector('input').value, w: +fw.querySelector('input').value, h: +fh.querySelector('input').value }, st.w, st.h); drawOverlay(); };
      const fx = num('X', st.crop.x, { min: 0, class: 'cx' }, typed), fy = num('Y', st.crop.y, { min: 0, class: 'cy' }, typed);
      const fw = num('W', st.crop.w, { min: 1, class: 'cw' }, typed), fh = num('H', st.crop.h, { min: 1, class: 'ch' }, typed);
      kids.push(h('span', { class: 'lbl', text: 'Crop' }), sel, custom, fx, fy, fw, fh,
        h('button', { class: 'primary', dataset: { apply: 'crop' }, text: 'Apply crop', onclick: applyCrop }),
        h('button', { text: 'Cancel', onclick: () => setTool('move') }));
    } else if (t === 'resize') {
      let from = 'width';
      const unit = h('select', { class: 'unit', onchange: () => { if (unit.value === '%') { wI.value = '50'; hI.value = '50'; } else { wI.value = String(st.w); hI.value = String(st.h); } } }, h('option', { value: 'px', text: 'px' }), h('option', { value: '%', text: '%' }));
      const keep = h('input', { type: 'checkbox', class: 'keep', checked: true });
      const sync = () => {
        if (!keep.checked) return;
        if (unit.value === '%') { if (from === 'width') hI.value = wI.value; else wI.value = hI.value; return; }
        try { const d = C.resizeDims(st.w, st.h, { unit: 'px', width: from === 'width' ? +wI.value : 0, height: from === 'height' ? +hI.value : 0, keepRatio: true, from }); if (from === 'width') hI.value = String(d.h); else wI.value = String(d.w); } catch { /* typing */ }
      };
      const wI = h('input', { type: 'number', class: 'rw', min: '1', value: String(st.w), oninput: () => { from = 'width'; sync(); } });
      const hI = h('input', { type: 'number', class: 'rh', min: '1', value: String(st.h), oninput: () => { from = 'height'; sync(); } });
      const apply = () => {
        try {
          const d = C.resizeDims(st.w, st.h, { unit: unit.value, width: +wI.value, height: +hI.value, keepRatio: keep.checked, from });
          if (d.w === st.w && d.h === st.h) { flash('The size is the same.'); return; }
          commit({ kind: 'resize', w: d.w, h: d.h });
          setTool('move');
        } catch (e) { flash(e.message); }
      };
      el.applyResize = apply;
      kids.push(h('span', { class: 'lbl', text: `Resize (now ${st.w} x ${st.h})` }), h('label', { class: 'f' }, h('span', { text: 'W' }), wI), h('label', { class: 'f' }, h('span', { text: 'H' }), hI), unit,
        h('label', { class: 'f' }, keep, h('span', { text: 'Keep ratio' })),
        h('button', { class: 'primary', dataset: { apply: 'resize' }, text: 'Apply resize', onclick: apply }), h('button', { text: 'Cancel', onclick: () => setTool('move') }));
    } else if (t === 'straighten') {
      const r = h('input', { type: 'range', class: 'angle', min: '-45', max: '45', step: '0.1', value: String(st.straighten) });
      const n = h('input', { type: 'number', class: 'anglen', min: '-45', max: '45', step: '0.1', value: String(st.straighten) });
      const set = (v) => { st.straighten = C.clamp(Math.round((+v || 0) * 10) / 10, -45, 45); r.value = n.value = String(st.straighten); preview(); drawOverlay(); };
      r.addEventListener('input', () => set(r.value)); n.addEventListener('input', () => set(n.value));
      kids.push(h('span', { class: 'lbl', text: 'Angle' }), r, n, h('span', { text: '°' }),
        h('button', { class: 'primary', dataset: { apply: 'straighten' }, text: 'Apply', onclick: () => { if (st.straighten) commit({ kind: 'straighten', angle: st.straighten }); setTool('move'); } }),
        h('button', { text: 'Cancel', onclick: () => setTool('move') }));
    } else if (t === 'adjust') {
      const mk = (key, label) => {
        const r = h('input', { type: 'range', class: `adj-${key}`, min: '0', max: '200', step: '1', value: String(st.adjust[key]), title: label });
        r.addEventListener('input', () => { st.adjust[key] = +r.value; out.textContent = `${r.value}%`; preview(); });
        const out = h('span', { class: 'pct', text: `${st.adjust[key]}%` });
        return h('label', { class: 'f' }, h('span', { text: label }), r, out);
      };
      kids.push(mk('b', 'Brightness'), mk('c', 'Contrast'), mk('s', 'Saturation'),
        h('button', { class: 'primary', dataset: { apply: 'adjust' }, text: 'Apply', onclick: () => { const a = st.adjust; if (a.b !== 100 || a.c !== 100 || a.s !== 100) commit({ kind: 'adjust', ...a }); setTool('move'); } }),
        h('button', { text: 'Reset', onclick: () => { st.adjust = { b: 100, c: 100, s: 100 }; renderOpts(); preview(); } }));
    } else if (MARKS.some((m) => m[0] === t)) {
      const color = h('input', { type: 'color', class: 'color', value: st.color, title: 'Colour', oninput: () => { st.color = color.value; } });
      const swatches = ['#e5484d', '#f5a524', '#30a46c', '#0090ff', '#8e4ec6', '#000000', '#ffffff'].map((c) => {
        const b = h('button', { class: 'sw', title: c, dataset: { color: c }, onclick: () => { st.color = c; color.value = c; } }); css(b, { background: c }); return b;
      });
      kids.push(h('span', { class: 'lbl', text: MARKS.find((m) => m[0] === t)[1] }), color, ...swatches);
      if (t === 'text' || t === 'step') {
        const sz = h('select', { class: 'tsize', title: 'Size', onchange: () => { st.textSize = +sz.value; } }, ...[16, 20, 24, 28, 36, 48, 64, 96, 128].map((v) => h('option', { value: String(v), text: `${v} px` })));
        sz.value = String(st.textSize);
        kids.push(sz);
      } else {
        const wd = h('select', { class: 'width', title: 'Line width', onchange: () => { st.width = +wd.value; } }, ...[2, 3, 4, 6, 8, 12, 16, 24, 32].map((v) => h('option', { value: String(v), text: `${v} px` })));
        wd.value = String(st.width);
        kids.push(wd);
      }
      kids.push(h('span', { class: 'hint', text: t === 'text' ? 'Click where the text goes.' : t === 'step' ? `Click to place step ${C.nextStep(st.hist.applied())}.` : 'Drag on the image.' }));
    } else if (t === 'blur' || t === 'pixelate') {
      const sz = h('select', { class: 'rsize', title: 'Strength', onchange: () => { st.redactSize = +sz.value; } }, ...[8, 12, 16, 24, 32, 48].map((v) => h('option', { value: String(v), text: `${t === 'blur' ? 'radius' : 'block'} ${v} px` })));
      sz.value = String(st.redactSize);
      kids.push(h('span', { class: 'lbl', text: t === 'blur' ? 'Blur' : 'Pixelate' }), sz, h('span', { class: 'hint', text: 'Drag a box over what to hide. Saving replaces those pixels in the file.' }));
    } else {
      kids.push(h('span', { class: 'hint', text: 'Drag to scroll. Ctrl or Cmd + wheel zooms. Undo and Redo work as in any editor; Save keeps the format, Save As can convert.' }));
    }
    el.opts.replaceChildren(...kids);
  }

  function setTool(t) {
    if (st.textBox) { st.textBox.remove(); st.textBox = null; }
    st.tool = t; st.drag = null;
    if (t !== 'crop') st.crop = null;
    if (t !== 'straighten') st.straighten = 0;
    if (t !== 'adjust') st.adjust = { b: 100, c: 100, s: 100 };
    for (const b of el.bar.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
    el.stage.dataset.tool = t;
    renderOpts(); preview(); drawOverlay();
  }

  function preview() {
    if (!st.cur) return;
    const a = st.adjust;
    css(st.cur, { filter: st.tool === 'adjust' && (a.b !== 100 || a.c !== 100 || a.s !== 100) ? `brightness(${a.b}%) contrast(${a.c}%) saturate(${a.s}%)` : null, transform: st.tool === 'straighten' && st.straighten ? `rotate(${st.straighten}deg)` : null });
  }

  let flashTimer = 0;
  function flash(text) {
    el.notice.hidden = false; el.notice.textContent = text; el.notice.classList.add('warn');
    clearTimeout(flashTimer); flashTimer = setTimeout(() => { el.notice.classList.remove('warn'); showNotice(); }, 5000);
  }
  function showNotice() { el.notice.textContent = st.notice || ''; el.notice.hidden = !st.notice; }

  // ---------------- edits ----------------
  function commit(op) {
    let clean;
    try { clean = C.sanitizeOp(op, st.w, st.h); } catch (e) { return; }
    st.hist.push(clean);
    for (const k of [...st.snaps.keys()]) if (k >= st.hist.pos) st.snaps.delete(k);
    post({ type: 'edit', op: clean, label: C.opLabel(clean) });
    show(st.hist.pos);
    if (st.tool === 'step') renderOpts();
  }
  function applyCrop() {
    if (!st.crop) return;
    const r = C.clampRect(st.crop, st.w, st.h);
    if (r.x === 0 && r.y === 0 && r.w === st.w && r.h === st.h) { flash('The crop box covers the whole image. Drag a smaller box first.'); return; }
    commit({ kind: 'crop', ...r });
    setTool('move');
  }

  function show(pos) {
    const c = canvasAt(pos);
    if (st.cur && st.cur !== c) st.cur.remove();
    st.cur = c; st.cur.className = 'img';
    css(st.cur, { filter: null, transform: null });
    if (st.cur.parentNode !== el.wrap) el.wrap.insertBefore(st.cur, el.overlay);
    const sizeChanged = st.w !== c.width || st.h !== c.height;
    st.w = c.width; st.h = c.height;
    if (st.fit || sizeChanged) setZoom(st.fit ? 0 : st.zoom); else layout();
    updateInfo();
    if (st.tool !== 'move' && st.tool !== 'crop' && !MARKS.some((m) => m[0] === st.tool) && st.tool !== 'blur' && st.tool !== 'pixelate') setTool('move');
    else if (st.tool === 'crop') { st.crop = C.centeredCrop(st.ratio, st.w, st.h); renderOpts(); }
    preview(); drawOverlay();
  }

  // ---------------- zoom and layout ----------------
  function fitZoom() {
    const r = el.stage.getBoundingClientRect();
    const aw = Math.max(50, r.width - 32), ah = Math.max(50, r.height - 32);
    return Math.min(1, aw / st.w, ah / st.h);
  }
  function setZoom(z) {
    st.fit = z === 0;
    st.zoom = C.clamp(z === 0 ? fitZoom() : z, 0.01, 32);
    layout();
  }
  function zoomBy(f, cx, cy) {
    const s = el.stage, old = st.zoom;
    const r = s.getBoundingClientRect();
    const px = cx == null ? r.width / 2 : cx - r.left, py = cy == null ? r.height / 2 : cy - r.top;
    const ix = (s.scrollLeft + px - el.wrap.offsetLeft) / old, iy = (s.scrollTop + py - el.wrap.offsetTop) / old;
    st.fit = false; st.zoom = C.clamp(old * f, 0.01, 32); layout();
    s.scrollLeft = ix * st.zoom + el.wrap.offsetLeft - px; s.scrollTop = iy * st.zoom + el.wrap.offsetTop - py;
  }
  function layout() {
    if (!st.cur) return;
    const dw = Math.max(1, Math.round(st.w * st.zoom)), dh = Math.max(1, Math.round(st.h * st.zoom));
    css(el.wrap, { width: `${dw}px`, height: `${dh}px` });
    css(st.cur, { width: `${dw}px`, height: `${dh}px`, 'image-rendering': st.zoom >= 2 ? 'pixelated' : 'auto' });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const ow = Math.min(8192, Math.round(dw * dpr)), oh = Math.min(8192, Math.round(dh * dpr));
    if (el.overlay.width !== ow || el.overlay.height !== oh) { el.overlay.width = ow; el.overlay.height = oh; }
    css(el.overlay, { width: `${dw}px`, height: `${dh}px` });
    el.zoomLabel.textContent = `${Math.round(st.zoom * 100)}%`;
    drawOverlay();
  }
  function updateInfo() {
    const fmt = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP', gif: 'GIF (first frame)', bmp: 'BMP' }[st.format] || st.format;
    const n = st.hist.pos;
    el.info.textContent = `${st.w} x ${st.h} px · ${fmt} · ${C.formatBytes(st.bytes)}${n ? ` · ${n} edit${n === 1 ? '' : 's'}` : ''}`;
  }

  // ---------------- overlay ----------------
  function overlayCtx() {
    const x = ctx2(el.overlay);
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, el.overlay.width, el.overlay.height);
    const s = el.overlay.width / Math.max(1, st.w);
    x.setTransform(s, 0, 0, s, 0, 0);
    return { x, s };
  }
  function drawOverlay() {
    if (!st.cur) return;
    const { x, s } = overlayCtx();
    if (st.tool === 'crop' && st.crop) {
      const r = st.crop;
      x.fillStyle = 'rgba(0,0,0,0.5)';
      x.beginPath(); x.rect(0, 0, st.w, st.h); x.rect(r.x, r.y, r.w, r.h); x.fill('evenodd');
      x.lineWidth = 1.5 / s; x.strokeStyle = '#ffffff'; x.strokeRect(r.x, r.y, r.w, r.h);
      x.lineWidth = 0.75 / s; x.strokeStyle = 'rgba(255,255,255,0.6)';
      x.beginPath();
      for (const f of [1 / 3, 2 / 3]) { x.moveTo(r.x + r.w * f, r.y); x.lineTo(r.x + r.w * f, r.y + r.h); x.moveTo(r.x, r.y + r.h * f); x.lineTo(r.x + r.w, r.y + r.h * f); }
      x.stroke();
      x.fillStyle = '#ffffff';
      const k = 6 / s;
      for (const [px, py] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) x.fillRect(px - k / 2, py - k / 2, k, k);
    } else if (st.tool === 'straighten' && st.straighten) {
      const c = C.straightenCrop(st.w, st.h, st.straighten);
      const r = { x: (st.w - c.w) / 2, y: (st.h - c.h) / 2, w: c.w, h: c.h };
      x.lineWidth = 1.5 / s; x.strokeStyle = '#ffffff'; x.setLineDash([6 / s, 4 / s]); x.strokeRect(r.x, r.y, r.w, r.h); x.setLineDash([]);
      x.lineWidth = 0.5 / s; x.strokeStyle = 'rgba(255,255,255,0.5)'; x.beginPath();
      for (let i = 1; i < 8; i++) { x.moveTo(r.x, r.y + r.h * i / 8); x.lineTo(r.x + r.w, r.y + r.h * i / 8); }
      x.stroke();
    } else if (st.drag && st.drag.preview) {
      const op = st.drag.preview;
      if (op.kind === 'redact') {
        x.fillStyle = 'rgba(128,128,128,0.45)'; x.fillRect(op.x, op.y, op.w, op.h);
        x.lineWidth = 1.5 / s; x.strokeStyle = '#ffffff'; x.setLineDash([5 / s, 3 / s]); x.strokeRect(op.x, op.y, op.w, op.h); x.setLineDash([]);
      } else drawShape(x, op);
    }
  }

  // ---------------- pointer input ----------------
  function imgPoint(e) {
    const r = el.overlay.getBoundingClientRect();
    return { x: (e.clientX - r.left) / st.zoom, y: (e.clientY - r.top) / st.zoom };
  }
  function capture(e) { try { el.overlay.setPointerCapture(e.pointerId); } catch { /* synthetic events have no active pointer */ } }
  function wireStage() {
    let space = false;
    el.stage.addEventListener('wheel', (e) => { if (!st.cur || !(e.ctrlKey || e.metaKey)) return; e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY); }, { passive: false });
    el.overlay.addEventListener('pointermove', (e) => {
      if (!st.cur) return;
      const p = imgPoint(e);
      el.pos.textContent = p.x >= 0 && p.y >= 0 && p.x < st.w && p.y < st.h ? `${Math.floor(p.x)}, ${Math.floor(p.y)}` : '';
    });
    el.overlay.addEventListener('pointerdown', (e) => {
      if (!st.cur || e.button > 1) return;
      el.stage.focus({ preventScroll: true });
      const p = imgPoint(e);
      const t = st.tool;
      if (t === 'move' || space || e.button === 1) { st.drag = { pan: true, sx: e.clientX, sy: e.clientY, l: el.stage.scrollLeft, t: el.stage.scrollTop }; capture(e); return; }
      if (t === 'text') { e.preventDefault(); openTextBox(p); return; }
      if (t === 'step') { commit({ kind: 'step', x: p.x, y: p.y, n: C.nextStep(st.hist.applied()), color: st.color, size: Math.round(st.textSize * 0.6) }); return; }
      if (t === 'crop') {
        const r = st.crop;
        const inside = r && p.x > r.x && p.y > r.y && p.x < r.x + r.w && p.y < r.y + r.h && !(r.w === st.w && r.h === st.h);
        st.drag = inside ? { move: true, ox: p.x - r.x, oy: p.y - r.y } : { x0: p.x, y0: p.y };
        capture(e); return;
      }
      if (t === 'straighten' || t === 'adjust' || t === 'resize') return;
      st.drag = { x0: p.x, y0: p.y, pts: [p.x, p.y] };
      capture(e);
    });
    el.overlay.addEventListener('pointermove', (e) => {
      const d = st.drag;
      if (!d) return;
      if (d.pan) { el.stage.scrollLeft = d.l - (e.clientX - d.sx); el.stage.scrollTop = d.t - (e.clientY - d.sy); return; }
      const p = imgPoint(e);
      const t = st.tool;
      if (t === 'crop') {
        if (d.move) { const r = st.crop; st.crop = { ...r, x: C.clamp(Math.round(p.x - d.ox), 0, st.w - r.w), y: C.clamp(Math.round(p.y - d.oy), 0, st.h - r.h) }; } else st.crop = C.cropFromDrag(d.x0, d.y0, p.x, p.y, st.ratio, st.w, st.h);
        syncCropInputs(); drawOverlay(); return;
      }
      if (t === 'pen' || t === 'hl') { d.pts.push(p.x, p.y); d.preview = { kind: t, pts: d.pts, color: st.color, width: t === 'hl' ? Math.max(st.width * 3, 12) : st.width }; }
      else if (t === 'blur' || t === 'pixelate') { const r = C.cropFromDrag(d.x0, d.y0, p.x, p.y, 0, st.w, st.h); d.preview = { kind: 'redact', mode: t, ...r, size: st.redactSize }; }
      else {
        let x2 = p.x, y2 = p.y;
        if (e.shiftKey && (t === 'line' || t === 'arrow')) { const a = Math.round(Math.atan2(y2 - d.y0, x2 - d.x0) / (Math.PI / 4)) * (Math.PI / 4), L = Math.hypot(x2 - d.x0, y2 - d.y0); x2 = d.x0 + L * Math.cos(a); y2 = d.y0 + L * Math.sin(a); }
        if (e.shiftKey && (t === 'rect' || t === 'ellipse')) { const m = Math.max(Math.abs(x2 - d.x0), Math.abs(y2 - d.y0)); x2 = d.x0 + Math.sign(x2 - d.x0 || 1) * m; y2 = d.y0 + Math.sign(y2 - d.y0 || 1) * m; }
        d.preview = { kind: t, x1: d.x0, y1: d.y0, x2, y2, color: st.color, width: st.width };
      }
      drawOverlay();
    });
    const end = () => {
      const d = st.drag;
      if (!d) return;
      st.drag = null;
      if (d.pan || st.tool === 'crop') { drawOverlay(); return; }
      const op = d.preview;
      if (!op) { drawOverlay(); return; }
      if (op.kind === 'pen' || op.kind === 'hl') op.pts = C.simplifyStroke(op.pts, 0.75 / st.zoom);
      if (op.kind === 'redact' && (op.w < 2 || op.h < 2)) { drawOverlay(); return; }
      if (C.SHAPES.includes(op.kind) && Math.hypot(op.x2 - op.x1, op.y2 - op.y1) < 3) { drawOverlay(); return; }
      commit(op);
    };
    el.overlay.addEventListener('pointerup', end);
    el.overlay.addEventListener('pointercancel', () => { st.drag = null; drawOverlay(); });
    window.addEventListener('keydown', (e) => {
      const typing = e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
      if (e.key === ' ' && !typing) space = true;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') { if (st.drag) { st.drag = null; drawOverlay(); } else if (st.tool !== 'move') setTool('move'); return; }
      if (e.key === 'Enter') { if (st.tool === 'crop') applyCrop(); else if (st.tool === 'resize' && el.applyResize) el.applyResize(); return; }
      if (e.key === '+' || e.key === '=') { zoomBy(1.25); return; }
      if (e.key === '-') { zoomBy(1 / 1.25); return; }
      if (e.key === '0') { setZoom(0); return; }
      if (e.key === '1') { setZoom(1); return; }
      const t = KEYS[e.key.toLowerCase()];
      if (t && st.cur) setTool(t);
    });
    window.addEventListener('keyup', (e) => { if (e.key === ' ') space = false; });
    window.addEventListener('resize', () => { if (st.fit) setZoom(0); });
  }
  function syncCropInputs() {
    const r = st.crop; if (!r) return;
    for (const [cls, v] of [['cx', r.x], ['cy', r.y], ['cw', r.w], ['ch', r.h]]) { const i = el.opts.querySelector(`input.${cls}`); if (i && document.activeElement !== i) i.value = String(v); }
  }
  function openTextBox(p) {
    if (st.textBox) st.textBox.remove();
    const box = h('textarea', { class: 'textbox', rows: '1', placeholder: 'Type, then Enter', title: 'Enter adds the text, Shift+Enter a new line, Escape cancels' });
    css(box, { left: `${Math.round(p.x * st.zoom)}px`, top: `${Math.round(p.y * st.zoom - st.textSize * st.zoom)}px`, 'font-size': `${Math.max(12, Math.round(st.textSize * st.zoom))}px`, color: st.color });
    el.wrap.append(box);
    st.textBox = box;
    const done = (ok) => {
      if (st.textBox !== box) return;
      st.textBox = null; box.remove();
      if (ok && box.value.trim()) commit({ kind: 'text', x: p.x, y: p.y, text: box.value, color: st.color, size: st.textSize });
    };
    box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(true); } else if (e.key === 'Escape') { e.preventDefault(); done(false); } });
    box.addEventListener('blur', () => done(true));
    setTimeout(() => box.focus(), 0);
  }

  // ---------------- paste an image as a new file ----------------
  window.addEventListener('paste', async (e) => {
    const items = e.clipboardData ? [...e.clipboardData.items] : [];
    const item = items.find((i) => i.kind === 'file' && /^image\/(png|jpeg|webp|gif|bmp)$/.test(i.type));
    if (!item) return;
    e.preventDefault();
    const f = item.getAsFile();
    if (!f) return;
    const u8 = new Uint8Array(await f.arrayBuffer());
    post({ type: 'paste', tx: sendBytes(u8), mime: item.type });
  });

  // ---------------- encode for Save ----------------
  async function encode(mime, quality) {
    let c = st.cur;
    if (mime === 'image/bmp') {
      const d = ctx2(c).getImageData(0, 0, c.width, c.height);
      return { bytes: C.encodeBmp(d.data, c.width, c.height), mime };
    }
    if (mime === 'image/jpeg') { const w = mkCanvas(c.width, c.height); const x = ctx2(w); x.fillStyle = '#ffffff'; x.fillRect(0, 0, w.width, w.height); x.drawImage(c, 0, 0); c = w; }
    const blob = await new Promise((res) => c.toBlob(res, mime, quality));
    if (!blob) throw new Error('The image could not be encoded.');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || mime };
  }

  // ---------------- messages from the extension host ----------------
  async function load(m) {
    st.name = m.name; st.format = m.format; st.bytes = m.size; st.orientation = m.orientation || 1; st.notice = m.notice || '';
    st.pro = m.pro || st.pro;
    const u8 = takeBytes(m.tx);
    let bmp;
    try { bmp = await decode(u8, m.mime); } catch (e) {
      post({ type: 'decodeError' });
      return showError('Cannot open this image', `The ${m.formatLabel || 'image'} data could not be decoded. The file may be cut short or damaged.`);
    }
    const base = oriented(bmp, st.orientation);
    if (bmp.close) bmp.close();
    st.snaps = new Map([[0, base]]);
    st.hist = new C.History(m.ops || [], m.pos);
    st.cur = null; st.w = 0; st.h = 0; st.fit = true;
    if (!el.bar) build(); else { renderPro(); }
    for (const c of el.wrap.querySelectorAll('canvas.img')) c.remove();
    showNotice();
    show(st.hist.pos);
    setTool('move');
    if (!st.rendered) { st.rendered = true; post({ type: 'rendered', w: st.w, h: st.h }); }
  }
  function showError(title, text) {
    app.replaceChildren(h('div', { class: 'err' }, h('h2', { text: title }), h('p', { text })));
    el.bar = null;
    const footer = document.getElementById('zovo-footer');
    if (footer && footer.content && footer.content.childElementCount) app.append(footer.content.cloneNode(true));
  }

  window.addEventListener('message', async (ev) => {
    const m = ev.data;
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'chunk': { if (!st.rx.has(m.tx)) st.rx.set(m.tx, []); st.rx.get(m.tx)[m.seq] = m.data; return; }
      case 'load': return load(m);
      case 'error': st.rx.clear(); return showError(m.title || 'Cannot open this image', m.message);
      case 'goto': {
        if (!st.cur) return;
        // the host sends its list; when it matches ours (the usual case) only the position moves
        if (Array.isArray(m.ops) && (m.ops.length !== st.hist.ops.length || JSON.stringify(m.ops) !== JSON.stringify(st.hist.ops))) { st.hist = new C.History(m.ops, m.pos); for (const k of [...st.snaps.keys()]) if (k > 0) st.snaps.delete(k); } else st.hist.goto(m.pos);
        show(st.hist.pos);
        if (st.tool === 'step') renderOpts();
        return;
      }
      case 'encode': {
        try {
          const r = await encode(m.mime, m.quality);
          post({ type: 'encoded', id: m.id, tx: sendBytes(r.bytes), mime: r.mime, w: st.cur.width, h: st.cur.height });
        } catch (e) { post({ type: 'encoded', id: m.id, error: String(e && e.message || e) }); }
        return;
      }
      case 'saved': st.bytes = m.size; st.format = m.format || st.format; updateInfo(); return;
      case 'pro': st.pro = m.pro; renderPro(); return;
      case 'state': // for tests and the gate: a summary of what the webview shows
        post({ type: 'state', id: m.id, w: st.w, h: st.h, pos: st.hist.pos, ops: st.hist.ops.length, tool: st.tool, zoom: st.zoom });
        return;
      default:
    }
  });

  post({ type: 'ready' });
}());
