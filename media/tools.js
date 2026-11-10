// Zovo Pro tools panel: batch resize and convert, compress to a target size, compare two images. The extension host
// reads and writes the files and sends the bytes here in chunks; this page decodes and encodes them with a canvas
// (no network). Styles go through the CSSOM only; names are set with textContent.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const C = window.ImgCore;
  const app = document.getElementById('app');
  const CHUNK = 4 * 1024 * 1024;
  const DIFF_MAX_PIXELS = 40 * 1000 * 1000;
  const rx = new Map();
  const post = (m) => vscode.postMessage(m);
  let view = null;
  let cancelled = false;

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
  const mkCanvas = (w, hh) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(hh)); return c; };
  const ctx2 = (c) => c.getContext('2d', { willReadFrequently: true });

  function sendBytes(u8) {
    const tx = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const parts = C.chunks(u8, CHUNK);
    parts.forEach((data, seq) => post({ type: 'chunk', tx, seq, last: seq === parts.length - 1, data }));
    return tx;
  }
  function takeBytes(tx) { const list = rx.get(tx) || []; rx.delete(tx); return C.joinChunks(list.map((d) => (d instanceof Uint8Array ? d : new Uint8Array(d)))); }

  async function decode(u8, mime, orientation) {
    const blob = new Blob([u8], { type: mime });
    let bmp;
    try { bmp = await createImageBitmap(blob); } catch {
      const url = URL.createObjectURL(blob);
      try {
        bmp = new Image();
        await new Promise((res, rej) => { bmp.onload = res; bmp.onerror = () => rej(new Error('decode')); bmp.src = url; });
      } catch { throw new Error('could not decode the image (cut short or damaged)'); } finally { URL.revokeObjectURL(url); }
    }
    const w = bmp.width || bmp.naturalWidth, hh = bmp.height || bmp.naturalHeight;
    const t = C.orientation(orientation || 1, w, hh);
    const c = mkCanvas(t.w, t.h);
    const x = ctx2(c); x.setTransform(...t.m); x.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    return c;
  }
  function resample(src, w, hh) {
    let cur = src;
    for (const s of C.downscaleSteps(src.width, src.height, w, hh)) {
      const c = mkCanvas(s.w, s.h); const x = ctx2(c);
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; x.drawImage(cur, 0, 0, s.w, s.h); cur = c;
    }
    return cur;
  }
  async function encode(c, mime, q) {
    if (mime === 'image/bmp') { const d = ctx2(c).getImageData(0, 0, c.width, c.height); return { bytes: C.encodeBmp(d.data, c.width, c.height), mime }; }
    if (mime === 'image/jpeg') { const w = mkCanvas(c.width, c.height); const x = ctx2(w); x.fillStyle = '#ffffff'; x.fillRect(0, 0, w.width, w.height); x.drawImage(c, 0, 0); c = w; }
    const blob = await new Promise((res) => c.toBlob(res, mime, q));
    if (!blob) throw new Error('could not encode the image');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || mime };
  }

  // ---------------- batch and compress ----------------
  function startList(m) {
    cancelled = false;
    const bar = h('progress', { max: String(Math.max(1, m.total)), value: '0' });
    const count = h('span', { class: 'count', text: `0 of ${m.total}` });
    const cancel = h('button', { class: 'cancel', text: 'Cancel', onclick: () => { cancelled = true; cancel.disabled = true; post({ type: 'cancel' }); } });
    const tbody = h('tbody');
    const table = h('table', { class: 'rows' }, h('thead', {}, h('tr', {}, ...['File', 'Saved as', 'Size', 'Before', 'After', m.mode === 'compress' ? 'Quality' : 'Result'].map((t) => h('th', { text: t })))), tbody);
    const side = h('div', { class: 'side', hidden: true });
    const summary = h('p', { class: 'summary' });
    app.replaceChildren(h('h2', { text: m.title }), h('p', { class: 'muted', text: m.desc }), h('div', { class: 'prog' }, bar, count, cancel), summary, side, table);
    view = { kind: m.mode, bar, count, cancel, tbody, side, summary, rows: new Map(), done: 0, total: m.total, single: !!m.single };
  }
  function rowFor(id, name) {
    let r = view.rows.get(id);
    if (!r) {
      const cells = [h('td', { text: name }), h('td'), h('td'), h('td'), h('td'), h('td')];
      r = { tr: h('tr', {}, ...cells), cells };
      view.rows.set(id, r); view.tbody.append(r.tr);
    }
    return r;
  }
  async function runJob(m) {
    const u8 = takeBytes(m.tx);
    if (cancelled) { post({ type: 'job-done', jobId: m.jobId, error: 'cancelled' }); return; }
    rowFor(m.jobId, m.name).cells[5].textContent = 'working…';
    try {
      const src = await decode(u8, m.mime, m.orientation);
      let out, w, hh, q = m.quality, fits = true, scale = 1;
      if (m.kind === 'compress') {
        const r = await C.searchQuality(async (qq, sc) => {
          const c = sc < 1 ? resample(src, Math.max(1, Math.round(src.width * sc)), Math.max(1, Math.round(src.height * sc))) : src;
          const e = await encode(c, m.outMime, qq);
          return { size: e.bytes.length, data: e, w: c.width, h: c.height };
        }, m.target, { cancelled: () => cancelled });
        out = r.data; q = r.q; fits = r.fits; scale = r.scale;
        w = Math.round(src.width * scale); hh = Math.round(src.height * scale);
        if (view && view.single) showSide(src, out, m, r);
      } else {
        const d = C.batchDims(src.width, src.height, m.opts);
        const c = d.w === src.width && d.h === src.height ? src : resample(src, d.w, d.h);
        out = await encode(c, m.outMime, m.quality); w = c.width; hh = c.height;
      }
      post({ type: 'job-done', jobId: m.jobId, tx: sendBytes(out.bytes), mime: out.mime, w, h: hh, q, fits, scale, srcW: src.width, srcH: src.height });
    } catch (e) {
      post({ type: 'job-done', jobId: m.jobId, error: String(e && e.message || e) });
    }
  }
  function showSide(src, out, m, r) {
    const url = URL.createObjectURL(new Blob([out.bytes], { type: out.mime }));
    const a = mkCanvas(src.width, src.height); ctx2(a).drawImage(src, 0, 0);
    const b = h('img', { class: 'after', alt: 'compressed', src: url });
    view.side.replaceChildren(
      h('figure', {}, a, h('figcaption', { text: `Before: ${C.formatBytes(m.size)} · ${src.width} x ${src.height}` })),
      h('figure', {}, b, h('figcaption', { text: `After: ${C.formatBytes(out.bytes.length)} · quality ${Math.round(r.q * 100)}${r.scale < 1 ? ` · scaled to ${Math.round(src.width * r.scale)} x ${Math.round(src.height * r.scale)}` : ''}` })));
    view.side.hidden = false;
  }
  function onRow(m) {
    if (!view) return;
    const r = rowFor(m.jobId, m.name);
    r.cells[1].textContent = m.out || '';
    r.cells[2].textContent = m.dims || '';
    r.cells[3].textContent = m.before != null ? C.formatBytes(m.before) : '';
    r.cells[4].textContent = m.after != null ? C.formatBytes(m.after) : '';
    r.cells[5].textContent = m.status || '';
    r.tr.classList.toggle('bad', !!m.bad);
    view.done++;
    view.bar.value = view.done; view.count.textContent = `${view.done} of ${view.total}`;
  }
  function onEnd(m) {
    if (!view) return;
    view.cancel.disabled = true;
    view.summary.textContent = m.summary;
    view.bar.value = view.bar.max;
  }

  // ---------------- compare ----------------
  async function startCompare(m) {
    app.replaceChildren(h('h2', { text: 'Compare two images' }), h('p', { class: 'muted', text: 'Reading both images…' }));
    let A, B;
    try { A = await decode(takeBytes(m.txA), m.mimeA, m.orientA); } catch (e) { return fail(`${m.nameA}: ${e.message}`); }
    try { B = await decode(takeBytes(m.txB), m.mimeB, m.orientB); } catch (e) { return fail(`${m.nameB}: ${e.message}`); }
    let w = Math.min(A.width, B.width), hh = Math.min(A.height, B.height);
    const notes = [];
    if (A.width !== B.width || A.height !== B.height) notes.push(`The sizes differ (${A.width} x ${A.height} and ${B.width} x ${B.height}); the shared ${w} x ${hh} area at the top left is compared.`);
    let s = 1;
    if (w * hh > DIFF_MAX_PIXELS) { s = Math.sqrt(DIFF_MAX_PIXELS / (w * hh)); notes.push(`Compared at ${Math.round(s * 100)}% size (the shared area is over 40 MP).`); }
    const cw = Math.max(1, Math.floor(w * s)), ch = Math.max(1, Math.floor(hh * s));
    const ca = mkCanvas(cw, ch), cb = mkCanvas(cw, ch);
    ctx2(ca).drawImage(A, 0, 0, w, hh, 0, 0, cw, ch); ctx2(cb).drawImage(B, 0, 0, w, hh, 0, 0, cw, ch);
    const da = ctx2(ca).getImageData(0, 0, cw, ch).data, db = ctx2(cb).getImageData(0, 0, cw, ch).data;
    const cmp = { A: ca, B: cb, da, db, w: cw, h: ch, nameA: m.nameA, nameB: m.nameB, threshold: 16, mode: 'diff', split: 0.5, opacity: 0.5, notes, counted: false };
    view = { kind: 'compare', cmp };
    renderCompare();
  }
  function fail(text) { app.replaceChildren(h('h2', { text: 'Compare two images' }), h('p', { class: 'error', text })); post({ type: 'compare-failed', message: text }); }
  function computeDiff(cmp) {
    const r = C.diffPixels(cmp.da, cmp.db, cmp.w, cmp.h, cmp.threshold);
    const b = C.changedBoxes(r.mask, cmp.w, cmp.h, { cell: Math.max(4, Math.round(Math.max(cmp.w, cmp.h) / 200)), max: 50 });
    cmp.mask = r.mask; cmp.changed = r.changed; cmp.boxes = b.boxes; cmp.boxTotal = b.total;
  }
  function diffCanvas(cmp) {
    const c = mkCanvas(cmp.w, cmp.h); const x = ctx2(c);
    x.filter = 'grayscale(1) opacity(0.35)'; x.drawImage(cmp.A, 0, 0); x.filter = 'none';
    const img = x.getImageData(0, 0, cmp.w, cmp.h); const d = img.data;
    for (let i = 0, p = 0; i < cmp.mask.length; i++, p += 4) if (cmp.mask[i]) { d[p] = 255; d[p + 1] = 0; d[p + 2] = 200; d[p + 3] = 255; }
    x.putImageData(img, 0, 0);
    x.lineWidth = Math.max(1, Math.round(Math.max(cmp.w, cmp.h) / 600)); x.strokeStyle = '#00d0ff';
    for (const b of cmp.boxes) x.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    return c;
  }
  function renderCompare() {
    const cmp = view.cmp;
    computeDiff(cmp);
    const total = cmp.w * cmp.h;
    const stats = h('p', { class: 'stats', text: `${cmp.changed.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} pixels changed (${(cmp.changed / total * 100).toFixed(cmp.changed && cmp.changed / total < 0.001 ? 4 : 2)}%) in ${cmp.boxTotal} area${cmp.boxTotal === 1 ? '' : 's'}, threshold ${cmp.threshold}.` });
    const modeBtn = (id, label) => h('button', { class: cmp.mode === id ? 'on' : '', dataset: { mode: id }, text: label, onclick: () => { cmp.mode = id; renderCompare(); } });
    const thr = h('input', { type: 'range', class: 'threshold', min: '0', max: '255', value: String(cmp.threshold), title: 'Largest colour difference that still counts as the same (0-255)' });
    let t = 0;
    thr.addEventListener('input', () => { thrOut.textContent = thr.value; clearTimeout(t); t = setTimeout(() => { cmp.threshold = +thr.value; renderCompare(); }, 120); });
    const thrOut = h('span', { class: 'pct', text: String(cmp.threshold) });
    const controls = [modeBtn('slider', 'Slider'), modeBtn('onion', 'Onion skin'), modeBtn('diff', 'Difference'), h('label', { class: 'f' }, h('span', { text: 'Threshold' }), thr, thrOut),
      h('button', { class: 'primary', dataset: { act: 'savediff' }, text: 'Save diff PNG', onclick: saveDiff })];
    let stage;
    if (cmp.mode === 'diff') {
      stage = h('div', { class: 'cstage' }, diffCanvas(cmp));
    } else if (cmp.mode === 'onion') {
      const top = copy(cmp.B); top.className = 'top'; css(top, { opacity: String(cmp.opacity) });
      const op = h('input', { type: 'range', class: 'opacity', min: '0', max: '100', value: String(Math.round(cmp.opacity * 100)) });
      op.addEventListener('input', () => { cmp.opacity = +op.value / 100; css(top, { opacity: String(cmp.opacity) }); });
      controls.splice(3, 0, h('label', { class: 'f' }, h('span', { text: `${cmp.nameB} opacity` }), op));
      stage = h('div', { class: 'cstage stack' }, copy(cmp.A), top);
    } else {
      const top = copy(cmp.A); top.className = 'top';
      const clip = () => css(top, { 'clip-path': `inset(0 ${Math.round((1 - cmp.split) * 100)}% 0 0)` });
      clip();
      const sl = h('input', { type: 'range', class: 'split', min: '0', max: '100', value: String(Math.round(cmp.split * 100)) });
      sl.addEventListener('input', () => { cmp.split = +sl.value / 100; clip(); });
      controls.splice(3, 0, h('label', { class: 'f' }, h('span', { text: `${cmp.nameA} | ${cmp.nameB}` }), sl));
      stage = h('div', { class: 'cstage stack' }, copy(cmp.B), top);
    }
    const boxes = h('ol', { class: 'boxes' }, ...cmp.boxes.slice(0, 20).map((b) => h('li', { text: `x ${b.x}, y ${b.y}, ${b.w} x ${b.h}` })));
    app.replaceChildren(h('h2', { text: `Compare: ${cmp.nameA} and ${cmp.nameB}` }), ...cmp.notes.map((n) => h('p', { class: 'muted', text: n })), h('div', { class: 'ctl' }, ...controls), stats, stage,
      cmp.boxes.length ? h('details', {}, h('summary', { text: `Changed areas (largest first${cmp.boxTotal > 20 ? `, 20 of ${cmp.boxTotal}` : ''})` }), boxes) : null);
    if (!cmp.counted) { cmp.counted = true; post({ type: 'compared', changed: cmp.changed, total, boxes: cmp.boxTotal }); }
  }
  function copy(src) { const c = mkCanvas(src.width, src.height); ctx2(c).drawImage(src, 0, 0); return c; }
  async function saveDiff() {
    const cmp = view && view.cmp; if (!cmp) return;
    const e = await encode(diffCanvas(cmp), 'image/png');
    post({ type: 'save-diff', tx: sendBytes(e.bytes), changed: cmp.changed });
  }

  window.addEventListener('paste', async (e) => {
    if (!view || view.kind !== 'paste') return;
    const items = e.clipboardData ? [...e.clipboardData.items] : [];
    const item = items.find((i) => i.kind === 'file' && /^image\/(png|jpeg|webp|gif|bmp)$/.test(i.type));
    if (!item) { app.append(h('p', { class: 'error', text: 'The clipboard has no PNG, JPEG, WebP, GIF or BMP image.' })); return; }
    e.preventDefault();
    const f = item.getAsFile();
    if (!f) return;
    post({ type: 'paste', tx: sendBytes(new Uint8Array(await f.arrayBuffer())), mime: item.type });
  });

  window.addEventListener('message', async (ev) => {
    const m = ev.data;
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'chunk': if (!rx.has(m.tx)) rx.set(m.tx, []); rx.get(m.tx)[m.seq] = m.data; return;
      case 'list-start': return startList(m);
      case 'job': return runJob(m);
      case 'row': return onRow(m);
      case 'list-end': return onEnd(m);
      case 'compare': return startCompare(m);
      case 'paste-mode':
        view = { kind: 'paste' };
        app.replaceChildren(h('h2', { text: 'Paste an image as a new file' }), h('p', { text: 'Press Cmd+V (Ctrl+V on Windows and Linux) in this tab to paste the image on the clipboard. You then choose where to save it.' }));
        return;
      case 'state': post({ type: 'state', id: m.id, kind: view && view.kind, rows: view && view.rows ? view.rows.size : 0, changed: view && view.cmp ? view.cmp.changed : null }); return;
      default:
    }
  });
  post({ type: 'ready' });
}());
