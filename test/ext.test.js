'use strict';
// The extension host with a stub vscode: activation, opening images, hostile files, edits with Undo and Redo, Save,
// Save As, Revert, hot exit backups, paste, the three Pro tools with their tries and the Pro panel, no network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const B = require('./build');
const H = require('../src/core/header');
const { loadExtension, openInEditor } = require('./support/vscode-stub');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgedit-ext-'));
const file = (name, buf) => { const p = path.join(dir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return p; };
const PNG = file('shot.png', B.png(10, 8));
const JPG = file('photo.jpg', B.jpeg(400, 300, { orientation: 6 }));
const GIF = file('anim.gif', B.gif(12, 9));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const OUT_PNG = B.png(5, 4, '#ff0000');

function trapNetwork() {
  const calls = [];
  const saved = { fetch: global.fetch, hr: http.request, hg: http.get, sr: https.request, sg: https.get, nc: net.connect, ncc: net.createConnection };
  global.fetch = async (u) => { calls.push(String(u)); throw new Error('network blocked in test'); };
  http.request = http.get = https.request = https.get = (...a) => { calls.push(String(a[0] && (a[0].href || a[0].host || a[0]))); throw new Error('network blocked in test'); };
  net.connect = net.createConnection = (...a) => { calls.push('net ' + JSON.stringify(a[0])); throw new Error('network blocked in test'); };
  return { calls, restore: () => { Object.assign(global, { fetch: saved.fetch }); http.request = saved.hr; http.get = saved.hg; https.request = saved.sr; https.get = saved.sg; net.connect = saved.nc; net.createConnection = saved.ncc; } };
}

/** The fake tools panel: answers jobs with OUT_PNG (or a result the test gives) and compares with 1234 changed pixels. */
function panelAnswers(s, o = {}) {
  s.panelHandler = (m, panel) => {
    if (m.type === 'job') {
      if (o.fail && o.fail(m)) { panel.send({ type: 'job-done', jobId: m.jobId, error: 'could not decode the image (cut short or damaged)' }); return; }
      const bytes = o.bytes ? o.bytes(m) : OUT_PNG;
      panel.send({ type: 'chunk', tx: `r${m.jobId}`, seq: 0, last: true, data: bytes });
      panel.send({ type: 'job-done', jobId: m.jobId, tx: `r${m.jobId}`, mime: m.outMime, w: 5, h: 4, q: 0.81, fits: o.fits !== false, scale: 1 });
    }
    if (m.type === 'compare') setImmediate(() => panel.send({ type: 'compared', changed: 1234, total: 5000, boxes: 2 }));
  };
}

test('activation and opening images make no network call and show no message; the webview gets the bytes', async () => {
  const nw = trapNetwork();
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    assert.ok(s.providers.has('imageEditor.edit'));
    for (const c of ['imageEditor.open', 'imageEditor.saveAs', 'imageEditor.pasteAsNewFile', 'imageEditor.batch', 'imageEditor.compress', 'imageEditor.compare', 'imageEditor.getPro', 'imageEditor.enterLicenseKey', 'imageEditor.payByCard']) assert.ok(s.commands.has(c), c);
    const a = await openInEditor(s, PNG);
    const load = a.posted.find((m) => m.type === 'load');
    assert.ok(load, 'load message');
    assert.deepStrictEqual([load.format, load.mime, load.orientation, load.pos, load.ops.length, load.notice], ['png', 'image/png', 1, 0, 0, '']);
    const chunks = a.posted.filter((m) => m.type === 'chunk' && m.tx === load.tx);
    assert.deepStrictEqual(Buffer.concat(chunks.map((c) => Buffer.from(c.data))), fs.readFileSync(PNG));
    for (const c of chunks) assert.strictEqual(Object.getPrototypeOf(c.data), Uint8Array.prototype, 'chunks are posted as plain Uint8Array, never Buffer (toJSON)');
    assert.deepStrictEqual(load.pro.tries, { batch: 3, compress: 3, compare: 3 });
    const j = await openInEditor(s, JPG);
    const lj = j.posted.find((m) => m.type === 'load');
    assert.strictEqual(lj.orientation, 6);
    const sent = Buffer.concat(j.posted.filter((m) => m.type === 'chunk' && m.tx === lj.tx).map((c) => Buffer.from(c.data)));
    assert.strictEqual(H.sniff(sent).orientation, 1, 'the bytes go with orientation 1; the webview turns the image');
    const g = await openInEditor(s, GIF);
    assert.match(g.posted.find((m) => m.type === 'load').notice, /first frame.*Save writes a PNG/);
    assert.match(a.panel.webview.html, /Content-Security-Policy/);
    assert.deepStrictEqual(nw.calls, []);
    assert.deepStrictEqual([s.log.info.length, s.log.warn.length, s.log.error.length, s.log.status.length], [0, 0, 0, 0], 'no message on open');
    assert.deepStrictEqual(s.log.external, []);
  } finally { nw.restore(); s.restore(); }
});

test('hostile files: a message in the editor, the host keeps working', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const cases = [
      ['empty.png', Buffer.alloc(0), /empty \(0 bytes\)/],
      ['page.png', Buffer.from('<!DOCTYPE html><html><body><img src=x onerror=alert(1)></body></html>'), /an HTML page, not a PNG/],
      ['huge.png', B.pngClaim(30000, 30000), /30,000 x 30,000 pixels \(900 MP\)/],
      ['cut.jpg', B.jpeg(10, 10).subarray(0, 8), /cut short or damaged/],
      ['<img src=x onerror=alert(1)>.png', Buffer.from('nope'), /a text file/],
    ];
    for (const [name, bytes, re] of cases) {
      const v = await openInEditor(s, file(name, bytes));
      const e = v.posted.find((m) => m.type === 'error');
      assert.ok(e && re.test(e.message), `${name}: ${e && e.message}`);
      assert.ok(!v.posted.some((m) => m.type === 'load'));
    }
    const ok = await openInEditor(s, PNG);
    assert.ok(ok.posted.some((m) => m.type === 'load'), 'a good file still opens');
    assert.strictEqual(s.log.error.length, 0);
  } finally { s.restore(); }
});

test('edits: VS Code gets one change per edit with a label; Undo and Redo move the webview; bad edits are refused', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const v = await openInEditor(s, PNG);
    const changes = [];
    v.provider.onDidChangeCustomDocument((e) => changes.push(e));
    await v.send({ type: 'edit', op: { kind: 'crop', x: 1, y: 1, w: 50, h: 50 } });
    await v.send({ type: 'edit', op: { kind: 'arrow', x1: 0, y1: 0, x2: 5, y2: 5, color: '#00ff00', width: 3 } });
    await v.send({ type: 'edit', op: { kind: 'script', code: 'x' } });
    assert.deepStrictEqual(changes.map((c) => c.label), ['Crop to 9 x 7', 'Arrow']);
    assert.deepStrictEqual(v.doc.ops[0], { kind: 'crop', x: 1, y: 1, w: 9, h: 7 }, 'the host clamps the crop to the image');
    assert.deepStrictEqual(v.doc.size, { w: 9, h: 7 });
    assert.ok(v.posted.some((m) => m.type === 'goto' && m.pos === 2), 'a refused edit resyncs the webview');
    await changes[1].undo();
    assert.strictEqual(v.doc.pos, 1);
    assert.deepStrictEqual(v.posted.at(-1), { type: 'goto', pos: 1, ops: v.doc.ops });
    await changes[0].undo();
    assert.deepStrictEqual(v.doc.size, { w: 10, h: 8 });
    await changes[0].redo(); await changes[1].redo();
    assert.strictEqual(v.doc.pos, 2);
    await changes[1].undo();
    await v.send({ type: 'edit', op: { kind: 'flip', axis: 'v' } });
    assert.deepStrictEqual(v.doc.ops.map((o) => o.kind), ['crop', 'flip'], 'a new edit after Undo drops the undone one');
  } finally { s.restore(); }
});

test('save keeps the format and quality; Save As converts; GIF saves as PNG; WebP fallback is refused; revert', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const seen = [];
    const enc = (mime, q) => { seen.push([mime, q]); return mime === 'image/jpeg' ? B.jpeg(10, 8) : mime === 'image/webp' ? B.webpLossy(10, 8) : OUT_PNG; };
    const p = await openInEditor(s, file('save.png', B.png(10, 8)), { encodeWith: enc });
    await p.send({ type: 'edit', op: { kind: 'rotate', deg: 90 } });
    await p.provider.saveCustomDocument(p.doc, { onCancellationRequested() {} });
    assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'save.png')), OUT_PNG);
    assert.ok(p.posted.some((m) => m.type === 'saved' && m.size === OUT_PNG.length));
    const j = await openInEditor(s, file('save.jpg', B.jpeg(20, 10)), { encodeWith: enc });
    await j.provider.saveCustomDocument(j.doc, null);
    assert.deepStrictEqual(seen.at(-1), ['image/jpeg', 0.92]);
    assert.strictEqual(H.sniff(fs.readFileSync(path.join(dir, 'save.jpg'))).format, 'jpeg');
    const asWebp = s.vscode.Uri.file(path.join(dir, 'converted.webp'));
    await j.provider.saveCustomDocumentAs(j.doc, asWebp, null);
    assert.deepStrictEqual([seen.at(-1)[0], seen.at(-1)[1]], ['image/webp', 0.9]);
    assert.strictEqual(H.sniff(fs.readFileSync(asWebp.fsPath)).format, 'webp');
    await j.provider.saveCustomDocumentAs(j.doc, s.vscode.Uri.file(path.join(dir, 'conv.bmp')), null);
    assert.strictEqual(seen.at(-1)[0], 'image/bmp');
    // GIF: Save asks for a PNG next to it; the GIF itself is not changed
    const gifBytes = fs.readFileSync(GIF);
    const g = await openInEditor(s, GIF, { encodeWith: enc });
    s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'anim.png')));
    await g.provider.saveCustomDocument(g.doc, null);
    assert.match(s.log.lastSave.defaultUri.path, /anim\.png$/);
    assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'anim.png')), OUT_PNG);
    assert.deepStrictEqual(fs.readFileSync(GIF), gifBytes);
    assert.ok(s.log.commands.some((c) => c[0] === 'vscode.openWith' && /anim\.png$/.test(c[1].path)));
    await assert.rejects(g.provider.saveCustomDocument(g.doc, null), (e) => e.name === 'Canceled', 'Escape on the dialog cancels the save');
    // an editor build without a WebP encoder (the canvas gives PNG back): refuse, never write PNG bytes into a .webp
    const w = await openInEditor(s, file('x.webp', B.webpLossy(10, 8)), { encodeWith: () => OUT_PNG, actualMime: 'image/png' });
    await assert.rejects(w.provider.saveCustomDocument(w.doc, null), /cannot write WebP/);
    assert.strictEqual(H.sniff(fs.readFileSync(path.join(dir, 'x.webp'))).format, 'webp');
    // revert reads the file again and clears the edits
    await p.send({ type: 'edit', op: { kind: 'flip', axis: 'h' } });
    await p.provider.revertCustomDocument(p.doc);
    assert.deepStrictEqual([p.doc.ops.length, p.doc.pos], [0, 0]);
    assert.strictEqual(p.posted.filter((m) => m.type === 'load').length, 2);
  } finally { s.restore(); }
});

test('hot exit: the backup holds the edit list; reopening restores it and drops damaged entries', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const v = await openInEditor(s, PNG);
    await v.send({ type: 'edit', op: { kind: 'crop', x: 0, y: 0, w: 5, h: 5 } });
    await v.send({ type: 'edit', op: { kind: 'text', x: 1, y: 4, text: '<b>hi</b>', color: '#112233', size: 12 } });
    const dest = s.vscode.Uri.file(path.join(dir, 'backup-1.json'));
    const bk = await v.provider.backupCustomDocument(v.doc, { destination: dest });
    const saved = JSON.parse(fs.readFileSync(dest.fsPath, 'utf8'));
    assert.strictEqual(saved.ops.length, 2);
    saved.ops.push({ kind: 'crop', x: 0, y: 0, w: 99, h: 99 }, { kind: 'evil', x: 1 });
    fs.writeFileSync(dest.fsPath, JSON.stringify(saved));
    const r = await openInEditor(s, PNG, { openContext: { backupId: bk.id } });
    const load = r.posted.find((m) => m.type === 'load');
    assert.deepStrictEqual(load.ops.map((o) => o.kind), ['crop', 'text', 'crop']);
    assert.deepStrictEqual(load.ops[2], { kind: 'crop', x: 0, y: 0, w: 5, h: 5 }, 'clamped to the size the earlier edits give');
    assert.strictEqual(load.pos, 3);
    await bk.delete();
    assert.ok(!fs.existsSync(dest.fsPath));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
    const b = await openInEditor(s, PNG, { openContext: { backupId: s.vscode.Uri.file(path.join(dir, 'broken.json')).toString() } });
    assert.strictEqual(b.posted.find((m) => m.type === 'load').ops.length, 0, 'a damaged backup opens the file as it is');
  } finally { s.restore(); }
});

test('paste: a clipboard image is saved as a new file and opened; Escape saves nothing', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const v = await openInEditor(s, PNG);
    const img = B.png(3, 3, '#00aa00');
    await v.send({ type: 'chunk', tx: 'w9', seq: 0, last: true, data: img });
    s.ui.save.push(undefined);
    await v.send({ type: 'paste', tx: 'w9', mime: 'image/png' });
    assert.match(s.log.lastSave.defaultUri.path, /pasted-image-\d{8}-\d{6}\.png$/);
    const target = path.join(dir, 'pasted.png');
    await v.send({ type: 'chunk', tx: 'w10', seq: 0, last: true, data: img });
    s.ui.save.push(s.vscode.Uri.file(target));
    await v.send({ type: 'paste', tx: 'w10', mime: 'image/png' });
    assert.deepStrictEqual(fs.readFileSync(target), img);
    assert.ok(s.log.commands.some((c) => c[0] === 'vscode.openWith' && c[1].fsPath === target));
    await v.send({ type: 'chunk', tx: 'w11', seq: 0, last: true, data: Buffer.from('<html>') });
    await v.send({ type: 'paste', tx: 'w11', mime: 'image/png' });
    assert.match(s.log.warn.at(-1).text, /could not be used/);
  } finally { s.restore(); }
});

test('Pro batch: Escape keeps the try; 3 runs write files in a subfolder and use the 3 tries; the 4th shows the card panel', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    panelAnswers(s, { fail: (m) => m.name === 'bad.png' });
    const folder = path.join(dir, 'batch');
    file('batch/a.png', B.png(40, 30)); file('batch/b.jpg', B.jpeg(400, 300)); file('batch/c.gif', B.gif(10, 10)); file('batch/notes.txt', 'x');
    file('batch/bad.png', B.png(4, 4)); file('batch/huge.png', B.pngClaim(30000, 30000));
    const uri = s.vscode.Uri.file(folder);
    // Escape on the size pick: no try
    s.ui.quick.push(undefined);
    await s.commands.get('imageEditor.batch')(uri);
    assert.strictEqual((s.state.get('imageEditor.proTrial') || {}).batch, undefined);
    for (let i = 1; i <= 3; i++) {
      s.ui.quick.push((items) => items[0], (items) => items.find((x) => x.format === 'webp'), (items) => items[0]);
      s.ui.input.push('80');
      await s.commands.get('imageEditor.batch')(uri);
      assert.strictEqual(s.state.get('imageEditor.proTrial').batch, i);
    }
    const out = fs.readdirSync(path.join(folder, 'resized')).sort();
    assert.deepStrictEqual(out, ['a-2.webp', 'a-3.webp', 'a.webp', 'b-2.webp', 'b-3.webp', 'b.webp', 'c-2.webp', 'c-3.webp', 'c.webp'], 'no file is overwritten');
    const panel = s.log.panels[0];
    const jobs = panel.posted.filter((m) => m.type === 'job');
    assert.deepStrictEqual(jobs.slice(0, 4).map((j) => [j.name, j.outMime, j.quality, j.opts.maxW]), [['a.png', 'image/webp', 0.8, 1920], ['b.jpg', 'image/webp', 0.8, 1920], ['bad.png', 'image/webp', 0.8, 1920], ['c.gif', 'image/webp', 0.8, 1920]]);
    const end = panel.posted.filter((m) => m.type === 'list-end').at(-1);
    assert.match(end.summary, /^3 written, 1 skipped, 1 failed/);
    const rows = panel.posted.filter((m) => m.type === 'row');
    assert.ok(rows.some((r) => r.name === 'huge.png' && /skipped: This image is 30,000 x 30,000/.test(r.status)));
    assert.ok(s.log.status.some((t) => /free try 3 of 3 of "Batch resize and convert"/.test(t)));
    assert.strictEqual(s.log.info.length, 0, 'no panel while tries are left');
    s.ui.info.push(undefined);
    await s.commands.get('imageEditor.batch')(uri);
    const d = s.log.info[0];
    assert.strictEqual(d.text, 'Batch resize and convert is part of Zovo Pro.');
    assert.deepStrictEqual(d.buttons, ['Pay by card (USD 19)', 'Get Zovo Pro with GitHub Sponsors', 'Pay with PayPal', 'Enter a key']);
    assert.match(d.opts.detail, /Compress to a target size/);
    assert.match(d.opts.detail, /Compare two images/);
    assert.strictEqual(s.state.get('imageEditor.proTrial').batch, 3);
    // the panel's Pay by card button opens the card page with a client reference
    s.ui.info.push('Pay by card (USD 19)');
    await s.commands.get('imageEditor.batch')(uri);
    assert.match(s.log.external.at(-1), /^https:\/\/license\.zovo\.one\/buy\/zovo-pro\?client_reference_id=[\w-]+$/);
  } finally { s.restore(); }
});

test('Pro batch: a run that writes nothing uses no try; Cancel stops it', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    panelAnswers(s, { fail: () => true });
    const folder = path.join(dir, 'batch2');
    file('batch2/a.png', B.png(4, 4));
    s.ui.quick.push((items) => items[3], (items) => items.find((x) => x.format === 'png'), (items) => items[1]);
    await s.commands.get('imageEditor.batch')(s.vscode.Uri.file(folder));
    assert.strictEqual((s.state.get('imageEditor.proTrial') || {}).batch, undefined);
    assert.deepStrictEqual(fs.readdirSync(folder), ['a.png']);
    // an empty folder: a message, no try
    fs.mkdirSync(path.join(dir, 'empty'), { recursive: true });
    await s.commands.get('imageEditor.batch')(s.vscode.Uri.file(path.join(dir, 'empty')));
    assert.match(s.log.info.at(-1).text, /No PNG, JPEG, WebP, GIF or BMP images/);
    // Cancel from the panel stops before the next file
    panelAnswers(s);
    for (let i = 0; i < 5; i++) file(`batch3/p${i}.png`, B.png(4, 4));
    const orig = s.panelHandler;
    s.panelHandler = (m, panel) => { if (m.type === 'job' && m.name === 'p1.png') panel.send({ type: 'cancel' }); orig(m, panel); };
    s.ui.quick.push((items) => items[5], (items) => items.find((x) => x.format === 'png'), (items) => items[1]);
    await s.commands.get('imageEditor.batch')(s.vscode.Uri.file(path.join(dir, 'batch3')));
    const outs = fs.readdirSync(path.join(dir, 'batch3')).filter((n) => /-resized/.test(n));
    assert.deepStrictEqual(outs.sort(), ['p0-resized.png', 'p1-resized.png']);
    assert.match(s.log.panels.at(-1).posted.filter((m) => m.type === 'list-end').at(-1).summary, /Stopped by Cancel/);
    assert.strictEqual(s.state.get('imageEditor.proTrial').batch, 1);
  } finally { s.restore(); }
});

test('Pro compress: target size, format, a new file next to the original; the try counts after the write', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    panelAnswers(s, { bytes: () => B.webpLossy(5, 4) });
    const src = file('cmp/photo.png', B.png(30, 20));
    s.ui.input.push(undefined);
    await s.commands.get('imageEditor.compress')(s.vscode.Uri.file(src));
    assert.strictEqual((s.state.get('imageEditor.proTrial') || {}).compress, undefined, 'Escape keeps the try');
    s.ui.input.push('150 KB');
    s.ui.quick.push((items) => items.find((x) => x.format === 'webp'));
    await s.commands.get('imageEditor.compress')(s.vscode.Uri.file(src));
    assert.ok(fs.existsSync(path.join(dir, 'cmp', 'photo-150kb.webp')));
    const job = s.log.panels[0].posted.find((m) => m.type === 'job');
    assert.deepStrictEqual([job.kind, job.target, job.outMime], ['compress', 153600, 'image/webp']);
    assert.strictEqual(s.log.panels[0].posted.find((m) => m.type === 'list-start').single, true);
    assert.strictEqual(s.state.get('imageEditor.proTrial').compress, 1);
    s.ui.input.push('150 KB'); s.ui.quick.push((items) => items[0]);
    await s.commands.get('imageEditor.compress')(s.vscode.Uri.file(src));
    assert.ok(fs.existsSync(path.join(dir, 'cmp', 'photo-150kb-2.webp')), 'never overwrites an earlier result');
    assert.throws(() => require('../media/imgcore').parseSize('big'));
  } finally { s.restore(); }
});

test('Pro compare: Escape keeps the try; a comparison on screen uses one; the diff PNG is saved', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    panelAnswers(s);
    const a = file('cmp2/before.png', B.png(10, 10, '#000000')), b = file('cmp2/after.png', B.png(10, 10, '#ffffff'));
    s.ui.open.push(undefined);
    await s.commands.get('imageEditor.compare')(s.vscode.Uri.file(a));
    assert.strictEqual((s.state.get('imageEditor.proTrial') || {}).compare, undefined);
    s.ui.open.push([s.vscode.Uri.file(b)]);
    await s.commands.get('imageEditor.compare')(s.vscode.Uri.file(a));
    await tick(50);
    const panel = s.log.panels[0];
    const m = panel.posted.find((x) => x.type === 'compare');
    assert.deepStrictEqual([m.nameA, m.nameB, m.mimeA], ['before.png', 'after.png', 'image/png']);
    assert.strictEqual(s.state.get('imageEditor.proTrial').compare, 1);
    // a second 'compared' from the same run (threshold moved) does not count again
    panel.send({ type: 'compared', changed: 1, total: 100, boxes: 1 });
    await tick(20);
    assert.strictEqual(s.state.get('imageEditor.proTrial').compare, 1);
    const diff = B.png(10, 10, '#ff00cc');
    s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'cmp2', 'diff.png')));
    panel.send({ type: 'chunk', tx: 'd1', seq: 0, last: true, data: diff });
    panel.send({ type: 'save-diff', tx: 'd1', changed: 100 });
    await tick(50);
    assert.match(s.log.lastSave.defaultUri.path, /before-vs-after\.diff\.png$/);
    assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'cmp2', 'diff.png')), diff);
    // a non-image as the second file: a message, no try
    s.ui.open.push([s.vscode.Uri.file(file('cmp2/fake.png', '<html>'))]);
    await s.commands.get('imageEditor.compare')(s.vscode.Uri.file(a));
    assert.match(s.log.warn.at(-1).text, /fake\.png: This file is an HTML page/);
    assert.strictEqual(s.state.get('imageEditor.proTrial').compare, 1);
  } finally { s.restore(); }
});

test('showProTools off: the webview hides the buttons (state sent); the sample opens from a copy', async () => {
  const s = loadExtension();
  try {
    s.config.showProTools = false;
    s.ext.activate(s.context);
    const v = await openInEditor(s, PNG);
    assert.strictEqual(v.posted.find((m) => m.type === 'load').pro.show, false);
    await s.commands.get('imageEditor.openSample')();
    const open = s.log.commands.find((c) => c[0] === 'vscode.openWith');
    assert.ok(open[1].fsPath.startsWith(s.context.globalStorageUri.fsPath), 'the sample is copied to storage first');
    assert.strictEqual(open[2], 'imageEditor.edit');
    assert.deepStrictEqual(fs.readFileSync(open[1].fsPath), fs.readFileSync(path.join(__dirname, '..', 'samples', 'sample-screenshot.png')));
  } finally { s.restore(); }
});
