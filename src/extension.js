'use strict';
// Image Editor: an editable custom editor for PNG, JPEG, WebP, GIF (first frame) and BMP files. The webview decodes
// and draws on a canvas; this side reads and writes the files, keeps the edit list for VS Code's Undo, Redo, Save,
// Save As, Revert and hot exit, and runs the Zovo Pro tools (pro.js) in a separate panel. No network: bytes go by
// postMessage in chunks. Nothing about Pro shows on open or activation.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const H = require('./core/header');
const C = require('../media/imgcore');
const { buildHtml } = require('./html');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const EXT_ID = 'zovo.zovo-image-editor';
const PREFIX = 'imageEditor';
const VIEW_TYPE = 'imageEditor.edit';
const CHUNK = 4 * 1024 * 1024;
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' };
const EXT_OF = { png: 'png', jpeg: 'jpg', webp: 'webp', bmp: 'bmp' };
const SAVE_FILTERS = { 'PNG image': ['png'], 'JPEG image': ['jpg', 'jpeg'], 'WebP image': ['webp'], 'BMP image': ['bmp'] };
const OPEN_FILTERS = { Images: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] };
const MAX_BATCH = 2000;

let rating = { success() {}, failure() {} };
let pro;
let ctxRef;
const docs = new Set();
let activeDoc = null;

function setting(key, dflt) { try { return vscode.workspace.getConfiguration(PREFIX).get(key, dflt); } catch { return dflt; } }
const baseName = (uri) => path.posix.basename(uri.path) || uri.toString();
const dirUri = (uri) => uri.with({ path: path.posix.dirname(uri.path) });
const childUri = (dir, name) => vscode.Uri.joinPath(dir, name);
const quality = (fmt) => Math.min(100, Math.max(1, Number(setting(fmt === 'webp' ? 'webpQuality' : 'jpegQuality', fmt === 'webp' ? 90 : 92)) || 90)) / 100;
const toU8 = (d) => (d instanceof Uint8Array ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : Uint8Array.from(Object.values(d || {})));
function proState() { return { show: setting('showProTools', true) !== false, licensed: !!(pro && pro.licensed), tries: pro ? pro.tries() : {} }; }

/** Read and check an image file: { bytes, info } or { error: { code, message } }. */
async function readImage(uri) {
  try {
    const st = await vscode.workspace.fs.stat(uri);
    if (st.size > H.MAX_BYTES) throw new H.ImageError('TOO_LARGE', `This file is ${Math.round(st.size / 1048576)} MB. The editor opens image files up to ${H.MAX_BYTES / 1048576} MB.`);
    const bytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
    const info = H.checkLimits(H.sniff(bytes));
    return { bytes, info };
  } catch (e) {
    const code = e.code || (e.name === 'EntryNotFound (FileSystemError)' ? 'ENOENT' : 'READ');
    return { error: { code, message: e instanceof H.ImageError ? e.message : `The file could not be read: ${e.message || e}` } };
  }
}

/** Display size of an image (after its EXIF orientation). */
const shownSize = (info) => (info.orientation >= 5 ? { w: info.height, h: info.width } : { w: info.width, h: info.height });

class ImageDocument {
  constructor(uri, r) {
    this.uri = uri; this.bytes = r.bytes || null; this.info = r.info || null; this.error = r.error || null;
    this.ops = []; this.pos = 0; this.webview = null; this.rx = new Map(); this.waits = new Map(); this.seq = 0; this.counted = false;
  }
  get name() { return baseName(this.uri); }
  get size() { const s = this.info ? shownSize(this.info) : { w: 0, h: 0 }; return C.sizeAfterOps(s.w, s.h, this.ops.slice(0, this.pos)); }
  post(m) { return this.webview ? this.webview.postMessage(m).then(undefined, () => false) : Promise.resolve(false); }
  sendBytes(u8) {
    const tx = `h${++this.seq}`;
    const parts = C.chunks(u8, CHUNK);
    return Promise.all(parts.map((data, seq) => this.post({ type: 'chunk', tx, seq, last: seq === parts.length - 1, data }))).then(() => tx);
  }
  takeBytes(tx) { const list = this.rx.get(tx) || []; this.rx.delete(tx); return C.joinChunks(list.map(toU8)); }
  dispose() { docs.delete(this); for (const w of this.waits.values()) w.reject(new Error('The editor was closed.')); this.waits.clear(); }
}

async function sendLoad(doc) {
  if (doc.error) return doc.post({ type: 'error', title: doc.error.code === 'TOO_LARGE' ? 'This image is too large' : 'Cannot open this image', message: doc.error.message });
  const info = doc.info;
  const bytes = H.withoutOrientation(doc.bytes, info);
  const notes = [];
  if (info.truncated) notes.push(`This ${H.FORMATS[info.format].label} file ends early; the missing part shows as empty or grey.`);
  if (info.format === 'gif') notes.push(`GIF: the editor shows the first frame${info.animated ? ' of the animation' : ''}. Save writes a PNG next to the GIF.`);
  else if (info.animated) notes.push('Animated image: the editor shows and saves the first frame.');
  const tx = await doc.sendBytes(bytes);
  return doc.post({ type: 'load', tx, name: doc.name, format: info.format, formatLabel: H.FORMATS[info.format].label, mime: MIME[info.format], size: doc.bytes.length, orientation: info.orientation, ops: doc.ops, pos: doc.pos, notice: notes.join(' '), pro: proState() });
}

/** Ask the webview to encode the current image. */
function encodeVia(doc, fmt, token) {
  if (!doc.webview) return Promise.reject(new Error('Open the image in the editor to save it.'));
  const id = `e${++doc.seq}`;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { doc.waits.delete(id); reject(new Error('Encoding the image took too long.')); }, 180000);
    doc.waits.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    if (token) token.onCancellationRequested(() => { const w = doc.waits.get(id); if (w) { doc.waits.delete(id); w.reject(new vscode.CancellationError()); } });
    doc.post({ type: 'encode', id, mime: MIME[fmt], quality: fmt === 'jpeg' || fmt === 'webp' ? quality(fmt) : undefined });
  });
}

async function writeEncoded(doc, target, fmt, token) {
  const r = await encodeVia(doc, fmt, token);
  if (fmt === 'webp' && r.mime !== 'image/webp') throw new Error('This editor build cannot write WebP; save as PNG or JPEG.');
  await vscode.workspace.fs.writeFile(target, r.bytes);
  return r;
}

/** Pick a file name that does not exist yet in dir: base.ext, base-2.ext, ... */
async function freeName(dir, base, ext) {
  for (let i = 1; i < 10000; i++) {
    const name = i === 1 ? `${base}.${ext}` : `${base}-${i}.${ext}`;
    try { await vscode.workspace.fs.stat(childUri(dir, name)); } catch { return childUri(dir, name); }
  }
  throw new Error('No free file name.');
}

class Provider {
  constructor(context) {
    this.context = context;
    this.changes = new vscode.EventEmitter();
    this.onDidChangeCustomDocument = this.changes.event;
  }
  async openCustomDocument(uri, openContext) {
    const doc = new ImageDocument(uri, await readImage(uri));
    if (openContext && openContext.backupId && doc.info) {
      try {
        const raw = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse(openContext.backupId))).toString('utf8'));
        const s = shownSize(doc.info);
        doc.ops = C.sanitizeOps(raw && raw.v === 1 ? raw.ops : [], s.w, s.h);
        doc.pos = doc.ops.length;
      } catch { /* a damaged backup: open the file as it is on disk */ }
    }
    docs.add(doc);
    return doc;
  }
  resolveCustomEditor(doc, panel) {
    const ctx = this.context;
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, enableCommandUris: commandUris(PREFIX), localResourceRoots: [media] };
    const u = (f) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
    panel.webview.html = buildHtml({ cspSource: panel.webview.cspSource, scriptUris: [u('imgcore.js'), u('editor.js')], styleUri: u('editor.css'), title: doc.name, showSupportLinks: showLinks(vscode, PREFIX) });
    doc.webview = panel.webview;
    if (panel.active) activeDoc = doc;
    panel.onDidChangeViewState(() => { if (panel.active) activeDoc = doc; else if (activeDoc === doc && !panel.visible) activeDoc = null; });
    panel.onDidDispose(() => { if (doc.webview === panel.webview) doc.webview = null; if (activeDoc === doc) activeDoc = null; });
    panel.webview.onDidReceiveMessage((m) => this.onMessage(doc, m).then(undefined, (e) => vscode.window.showWarningMessage(String(e && e.message || e))));
  }
  async onMessage(doc, m) {
    if (!m || typeof m.type !== 'string') return undefined;
    switch (m.type) {
      case 'ready': return sendLoad(doc).then(() => { if (doc.error && !['NOT_IMAGE', 'EMPTY', 'TOO_LARGE', 'ENOENT'].includes(doc.error.code)) rating.failure(); });
      case 'chunk': { if (!doc.rx.has(m.tx)) doc.rx.set(m.tx, []); doc.rx.get(m.tx)[m.seq] = m.data; return undefined; }
      case 'rendered': if (!doc.counted) { doc.counted = true; rating.success(doc.uri); } return undefined;
      case 'decodeError': rating.failure(); return undefined;
      case 'edit': return this.edit(doc, m.op);
      case 'encoded': {
        const w = doc.waits.get(m.id);
        if (!w) return undefined;
        doc.waits.delete(m.id);
        if (m.error) w.reject(new Error(m.error)); else w.resolve({ bytes: doc.takeBytes(m.tx), mime: m.mime, w: m.w, h: m.h });
        return undefined;
      }
      case 'paste': return savePasted(doc.takeBytes(m.tx), m.mime, dirUri(doc.uri));
      case 'tool': return runTool(String(m.tool), doc);
      case 'settings': return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXT_ID}`);
      default: return undefined;
    }
  }
  edit(doc, op) {
    if (!doc.info) return;
    const s = doc.size;
    let clean;
    try { clean = C.sanitizeOp(op, s.w, s.h); } catch { doc.post({ type: 'goto', pos: doc.pos, ops: doc.ops }); return; }
    doc.ops.length = doc.pos;
    doc.ops.push(clean);
    doc.pos = doc.ops.length;
    const at = doc.pos;
    this.changes.fire({
      document: doc, label: C.opLabel(clean),
      undo: () => { doc.pos = at - 1; return doc.post({ type: 'goto', pos: doc.pos, ops: doc.ops }); },
      redo: () => { doc.pos = at; return doc.post({ type: 'goto', pos: doc.pos, ops: doc.ops }); },
    });
  }
  async saveCustomDocument(doc, token) {
    if (!doc.info) return;
    if (doc.info.format === 'gif') {
      const base = doc.name.replace(/\.[^.]+$/, '');
      const target = await vscode.window.showSaveDialog({ defaultUri: await freeName(dirUri(doc.uri), base, 'png'), filters: { 'PNG image': ['png'] }, title: 'GIF files are saved as PNG (first frame): choose the PNG file' });
      if (!target) throw new vscode.CancellationError();
      const r = await writeEncoded(doc, target, 'png', token);
      vscode.window.setStatusBarMessage(`Saved ${baseName(target)} (${r.w} x ${r.h} PNG). The GIF is unchanged.`, 8000);
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
      return;
    }
    const r = await writeEncoded(doc, doc.uri, doc.info.format, token);
    doc.post({ type: 'saved', size: r.bytes.length, format: doc.info.format });
  }
  async saveCustomDocumentAs(doc, destination, token) {
    if (!doc.info) return;
    const fmt = H.formatFromName(destination.path);
    const out = fmt && fmt !== 'gif' ? fmt : 'png';
    if (fmt === 'gif') destination = destination.with({ path: destination.path.replace(/\.gif$/i, '.png') });
    await writeEncoded(doc, destination, out, token);
  }
  async revertCustomDocument(doc) {
    const r = await readImage(doc.uri);
    doc.bytes = r.bytes || null; doc.info = r.info || null; doc.error = r.error || null;
    doc.ops = []; doc.pos = 0;
    await sendLoad(doc);
  }
  async backupCustomDocument(doc, context) {
    await vscode.workspace.fs.writeFile(context.destination, Buffer.from(JSON.stringify({ v: 1, ops: doc.ops.slice(0, doc.pos) }), 'utf8'));
    return { id: context.destination.toString(), delete: async () => { try { await vscode.workspace.fs.delete(context.destination); } catch { /* gone */ } } };
  }
}

// ---------------- paste an image as a new file ----------------

async function savePasted(bytes, mime, dir) {
  let info;
  try { info = H.checkLimits(H.sniff(bytes)); } catch (e) { vscode.window.showWarningMessage(`The clipboard image could not be used: ${e.message}`); return; }
  const ext = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif', bmp: 'bmp' }[info.format];
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  const target = await vscode.window.showSaveDialog({ defaultUri: await freeName(dir, `pasted-image-${stamp}`, ext), filters: { Image: [ext] }, title: `Save the pasted image (${info.width} x ${info.height} ${H.FORMATS[info.format].label})` });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, bytes);
  await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
}

// ---------------- Pro tools panel ----------------

let tools = null; // { panel, ready, rx, waits, cancelled }

function toolsPanel(title) {
  if (tools) { tools.panel.title = title; tools.panel.reveal(vscode.ViewColumn.Active); return tools.ready.then(() => tools); }
  const media = vscode.Uri.joinPath(ctxRef.extensionUri, 'media');
  const panel = vscode.window.createWebviewPanel('imageEditor.tools', title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
  const u = (f) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
  panel.webview.html = buildHtml({ cspSource: panel.webview.cspSource, scriptUris: [u('imgcore.js'), u('tools.js')], styleUri: u('tools.css'), title, footer: false });
  const t = { panel, rx: new Map(), waits: new Map(), cancelled: false, seq: 0, onCompared: null, onSaveDiff: null };
  t.ready = new Promise((res) => { t.markReady = res; });
  t.post = (m) => panel.webview.postMessage(m).then(undefined, () => false);
  t.sendBytes = async (u8) => { const tx = `p${++t.seq}`; const parts = C.chunks(u8, CHUNK); for (let i = 0; i < parts.length; i++) await t.post({ type: 'chunk', tx, seq: i, last: i === parts.length - 1, data: parts[i] }); return tx; };
  t.takeBytes = (tx) => { const list = t.rx.get(tx) || []; t.rx.delete(tx); return C.joinChunks(list.map(toU8)); };
  panel.webview.onDidReceiveMessage((m) => {
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'ready') t.markReady();
    else if (m.type === 'chunk') { if (!t.rx.has(m.tx)) t.rx.set(m.tx, []); t.rx.get(m.tx)[m.seq] = m.data; }
    else if (m.type === 'cancel') t.cancelled = true;
    else if (m.type === 'job-done') { const w = t.waits.get(m.jobId); if (w) { t.waits.delete(m.jobId); w({ ...m, bytes: m.tx ? t.takeBytes(m.tx) : null }); } }
    else if (m.type === 'compared' && t.onCompared) t.onCompared(m);
    else if (m.type === 'compare-failed') vscode.window.showWarningMessage(m.message);
    else if (m.type === 'paste' && t.onPaste) t.onPaste(t.takeBytes(m.tx), m.mime).then(undefined, (e) => vscode.window.showWarningMessage(String(e.message || e)));
    else if (m.type === 'save-diff' && t.onSaveDiff) t.onSaveDiff(t.takeBytes(m.tx), m).then(undefined, (e) => vscode.window.showWarningMessage(String(e.message || e)));
  });
  panel.onDidDispose(() => { t.cancelled = true; for (const w of t.waits.values()) w({ error: 'closed' }); t.waits.clear(); if (tools === t) tools = null; });
  tools = t;
  return t.ready.then(() => t);
}

function runJob(t, job, bytes) {
  return new Promise((resolve) => {
    t.waits.set(job.jobId, resolve);
    t.sendBytes(bytes).then((tx) => t.post({ type: 'job', ...job, tx }));
  });
}

async function targetFor(arg) {
  if (arg && arg.scheme) return arg;
  if (activeDoc) return activeDoc.uri;
  const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup.activeTab;
  const u = tab && tab.input && tab.input.uri;
  if (u && C.IMAGE_RE.test(u.path)) return u;
  return null;
}
async function isFolder(uri) { try { return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0; } catch { return false; } }
async function listImages(dir) {
  const entries = await vscode.workspace.fs.readDirectory(dir);
  return entries.filter(([n, t]) => (t & vscode.FileType.File) && C.IMAGE_RE.test(n)).map(([n]) => n).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).slice(0, MAX_BATCH);
}
const pick = (items, o) => vscode.window.showQuickPick(items, { ignoreFocusOut: true, ...o });

async function runTool(tool, from) {
  if (tool === 'batch') return batch(from && from.uri);
  if (tool === 'compress') return compress(from && from.uri);
  if (tool === 'compare') return compare(from && from.uri);
  return undefined;
}

async function batch(arg) {
  if (!(await pro.allowed('batch'))) return;
  let dir = null;
  const t0 = await targetFor(arg);
  if (t0) dir = (await isFolder(t0)) ? t0 : dirUri(t0);
  if (!dir) {
    const p = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: 'Use this folder', title: 'Batch resize and convert: pick a folder of images' });
    if (!p || !p[0]) return;
    dir = p[0];
  }
  const names = await listImages(dir);
  if (!names.length) { vscode.window.showInformationMessage(`No PNG, JPEG, WebP, GIF or BMP images in ${baseName(dir)}.`); return; }
  const size = await pick([
    { label: 'Fit in 1920 x 1920', opts: { mode: 'max', maxW: 1920, maxH: 1920 } },
    { label: 'Fit in 1280 x 1280', opts: { mode: 'max', maxW: 1280, maxH: 1280 } },
    { label: 'Fit in 800 x 800', opts: { mode: 'max', maxW: 800, maxH: 800 } },
    { label: '50 %', opts: { mode: 'pct', pct: 50 } },
    { label: '25 %', opts: { mode: 'pct', pct: 25 } },
    { label: 'Keep the size (convert only)', opts: { mode: 'none' } },
    { label: 'Largest width x height…', custom: 'max' },
    { label: 'Percent…', custom: 'pct' },
  ], { title: `Batch resize ${names.length} image${names.length === 1 ? '' : 's'} in ${baseName(dir)}: new size`, placeHolder: 'Images are made smaller, never bigger, with "Fit in"' });
  if (!size) return;
  let opts = size.opts;
  if (size.custom === 'max') {
    const v = await vscode.window.showInputBox({ title: 'Largest width x height in pixels', value: '1600x1200', ignoreFocusOut: true, validateInput: (s) => (/^\s*\d{1,5}\s*(x\s*\d{1,5})?\s*$/i.test(s) ? null : 'Type 1600x1200 or 1600') });
    if (!v) return;
    const [w, h] = v.toLowerCase().split('x').map((n) => Number(n.trim()));
    opts = { mode: 'max', maxW: w, maxH: h || w };
  } else if (size.custom === 'pct') {
    const v = await vscode.window.showInputBox({ title: 'Percent of the current size', value: '50', ignoreFocusOut: true, validateInput: (s) => (Number(s) > 0 && Number(s) <= 1000 ? null : 'Type a number from 1 to 1000') });
    if (!v) return;
    opts = { mode: 'pct', pct: Number(v) };
  }
  const fmtPick = await pick([
    { label: 'Keep each format', format: 'keep', description: 'GIF becomes PNG' },
    { label: 'PNG', format: 'png' }, { label: 'JPEG', format: 'jpeg' }, { label: 'WebP', format: 'webp' },
  ], { title: 'Output format' });
  if (!fmtPick) return;
  let q = 0.85;
  if (fmtPick.format === 'jpeg' || fmtPick.format === 'webp' || fmtPick.format === 'keep') {
    const v = await vscode.window.showInputBox({ title: 'JPEG and WebP quality (1-100)', value: '85', ignoreFocusOut: true, validateInput: (s) => (Number(s) >= 1 && Number(s) <= 100 ? null : 'Type a number from 1 to 100') });
    if (!v) return;
    q = Number(v) / 100;
  }
  const where = await pick([
    { label: 'Into the subfolder "resized"', sub: 'resized' },
    { label: 'Next to the originals, with "-resized" in the name', suffix: '-resized' },
  ], { title: 'Where to write the new files (originals are never overwritten)' });
  if (!where) return;
  let existingOut = [];
  const outDir = where.sub ? childUri(dir, where.sub) : dir;
  if (where.sub) { try { existingOut = (await vscode.workspace.fs.readDirectory(outDir)).map(([n]) => n); } catch { /* new folder */ } }
  const allNames = (await vscode.workspace.fs.readDirectory(dir)).map(([n]) => n);
  const plan = C.planBatch(names, { format: fmtPick.format, subfolder: where.sub, suffix: where.suffix, existing: allNames, existingOut });
  if (where.sub) await vscode.workspace.fs.createDirectory(outDir);
  await runList({ kind: 'batch', title: 'Batch resize and convert', desc: `${plan.length} image${plan.length === 1 ? '' : 's'} in ${dir.fsPath || dir.path} → ${outDir.fsPath || outDir.path}`, dir, outDir, plan, opts, q });
}

async function compress(arg) {
  if (!(await pro.allowed('compress'))) return;
  let target = await targetFor(arg);
  if (!target) {
    const p = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: false, filters: OPEN_FILTERS, openLabel: 'Compress', title: 'Compress to a target size: pick an image or a folder' });
    if (!p || !p[0]) return;
    target = p[0];
  }
  const folder = await isFolder(target);
  const dir = folder ? target : dirUri(target);
  const names = folder ? await listImages(dir) : [baseName(target)];
  if (!names.length) { vscode.window.showInformationMessage(`No PNG, JPEG, WebP, GIF or BMP images in ${baseName(dir)}.`); return; }
  const sizeText = await vscode.window.showInputBox({ title: `Compress ${folder ? `${names.length} images in ${baseName(dir)}` : names[0]}: target size`, prompt: 'The largest file size you want, for example 200 KB or 1.5 MB', value: '200 KB', ignoreFocusOut: true, validateInput: (s) => { try { C.parseSize(s); return null; } catch (e) { return e.message; } } });
  if (!sizeText) return;
  const targetBytes = C.parseSize(sizeText);
  const src0 = C.fmtOfName(names[0]);
  const items = [{ label: 'WebP', format: 'webp', description: 'smallest files; all current browsers' }, { label: 'JPEG', format: 'jpeg', description: 'opens everywhere' }];
  if (src0 === 'jpeg') items.reverse();
  const fmtPick = await pick(items, { title: 'Format of the compressed files' });
  if (!fmtPick) return;
  const kb = Math.round(targetBytes / 1024);
  const plan = names.map((name) => ({ name, out: null, format: fmtPick.format, base: `${name.replace(/\.[^.]+$/, '')}-${kb}kb` }));
  await runList({ kind: 'compress', title: 'Compress to a target size', desc: `Target ${C.formatBytes(targetBytes)} as ${fmtPick.label}. Metadata (EXIF, GPS, comments) is not copied. New files go next to the originals.`, dir, outDir: dir, plan, targetBytes, single: !folder });
}

async function runList(o) {
  const t = await toolsPanel(o.kind === 'batch' ? 'Batch resize' : 'Compress');
  t.cancelled = false;
  await t.post({ type: 'list-start', mode: o.kind, title: o.title, desc: o.desc, total: o.plan.length, single: !!o.single });
  const started = Date.now();
  let written = 0, skipped = 0, failed = 0, before = 0, after = 0, i = 0;
  for (const item of o.plan) {
    const jobId = `j${++i}`;
    const row = (x) => t.post({ type: 'row', jobId, name: item.name, ...x });
    if (t.cancelled) break;
    if (item.skip) { skipped++; await row({ status: `skipped: ${item.skip}`, bad: true }); continue; }
    const src = childUri(o.dir, item.name);
    const r = await readImage(src);
    if (r.error) { skipped++; await row({ status: `skipped: ${r.error.message}`, bad: true }); continue; }
    const bytes = H.withoutOrientation(r.bytes, r.info);
    const job = o.kind === 'batch'
      ? { jobId, kind: 'resize', name: item.name, mime: MIME[r.info.format], orientation: r.info.orientation, outMime: MIME[item.format], quality: item.format === 'jpeg' || item.format === 'webp' ? o.q : undefined, opts: o.opts, size: r.bytes.length }
      : { jobId, kind: 'compress', name: item.name, mime: MIME[r.info.format], orientation: r.info.orientation, outMime: MIME[item.format], target: o.targetBytes, size: r.bytes.length };
    const res = await runJob(t, job, bytes);
    if (res.error) { if (res.error === 'cancelled' || res.error === 'closed') break; failed++; await row({ status: `failed: ${res.error}`, bad: true, before: r.bytes.length }); continue; }
    if (item.format === 'webp' && res.mime !== 'image/webp') { failed++; await row({ status: 'failed: WebP encoding is not available here', bad: true }); continue; }
    let dst;
    try {
      if (o.kind === 'batch') dst = childUri(item.dir ? o.outDir : o.dir, item.out);
      else dst = await freeName(o.dir, item.base, EXT_OF[item.format]);
      // never overwrite: the planner picked a free name; check once more right before writing
      let exists = false; try { await vscode.workspace.fs.stat(dst); exists = true; } catch { /* free */ }
      if (exists) dst = await freeName(dirUri(dst), baseName(dst).replace(/\.[^.]+$/, ''), EXT_OF[item.format]);
      await vscode.workspace.fs.writeFile(dst, res.bytes);
    } catch (e) { failed++; await row({ status: `failed: ${e.message}`, bad: true }); continue; }
    written++; before += r.bytes.length; after += res.bytes.length;
    const status = o.kind === 'compress' ? (res.fits ? `${Math.round(res.q * 100)}${res.scale < 1 ? `, scaled ${Math.round(res.scale * 100)}%` : ''}` : `${Math.round(res.q * 100)}, still over the target`) : 'written';
    await row({ out: baseName(dst), dims: `${res.w} x ${res.h}`, before: r.bytes.length, after: res.bytes.length, status, bad: o.kind === 'compress' && !res.fits });
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const stopped = t.cancelled ? ' Stopped by Cancel.' : '';
  const saved = before ? ` ${C.formatBytes(before)} → ${C.formatBytes(after)} (${Math.round((1 - after / before) * 100)}% smaller).` : '';
  await t.post({ type: 'list-end', summary: `${written} written, ${skipped} skipped, ${failed} failed in ${secs} s.${saved}${stopped}` });
  if (written > 0) { await pro.produced(o.kind); refreshPro(); }
}

async function compare(arg) {
  if (!(await pro.allowed('compare'))) return;
  let a = await targetFor(arg);
  if (a && (await isFolder(a))) a = null;
  if (!a) {
    const p = await vscode.window.showOpenDialog({ canSelectMany: false, filters: OPEN_FILTERS, openLabel: 'Compare', title: 'Compare two images: pick the first image' });
    if (!p || !p[0]) return;
    a = p[0];
  }
  const p2 = await vscode.window.showOpenDialog({ canSelectMany: false, filters: OPEN_FILTERS, openLabel: 'Compare', title: `Compare ${baseName(a)} with...`, defaultUri: dirUri(a) });
  if (!p2 || !p2[0]) return; // cancelled: no try used
  const b = p2[0];
  const ra = await readImage(a), rb = await readImage(b);
  if (ra.error) { vscode.window.showWarningMessage(`${baseName(a)}: ${ra.error.message}`); return; }
  if (rb.error) { vscode.window.showWarningMessage(`${baseName(b)}: ${rb.error.message}`); return; }
  const t = await toolsPanel('Compare');
  let counted = false;
  t.onCompared = async () => { if (counted) return; counted = true; await pro.produced('compare'); refreshPro(); };
  t.onSaveDiff = async (bytes) => {
    const base = `${baseName(a).replace(/\.[^.]+$/, '')}-vs-${baseName(b).replace(/\.[^.]+$/, '')}.diff`;
    const target = await vscode.window.showSaveDialog({ defaultUri: await freeName(dirUri(a), base, 'png'), filters: { 'PNG image': ['png'] }, title: 'Save the diff image' });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, bytes);
    vscode.window.setStatusBarMessage(`Saved the diff as ${baseName(target)}.`, 6000);
  };
  const txA = await t.sendBytes(H.withoutOrientation(ra.bytes, ra.info));
  const txB = await t.sendBytes(H.withoutOrientation(rb.bytes, rb.info));
  await t.post({ type: 'compare', txA, txB, nameA: baseName(a), nameB: baseName(b), mimeA: MIME[ra.info.format], mimeB: MIME[rb.info.format], orientA: ra.info.orientation, orientB: rb.info.orientation });
}

function refreshPro() { for (const d of docs) d.post({ type: 'pro', pro: proState() }); }

// ---------------- activation ----------------

async function openWithEditor(uri) {
  let target = uri && uri.scheme ? uri : await targetFor(null);
  if (!target) {
    const p = await vscode.window.showOpenDialog({ canSelectMany: false, filters: OPEN_FILTERS, openLabel: 'Edit', title: 'Edit an image' });
    if (!p || !p[0]) return;
    target = p[0];
  }
  await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
}

async function saveAsCommand() {
  const doc = activeDoc;
  if (!doc || !doc.info) { vscode.window.showInformationMessage('Open an image in the Image Editor first.'); return; }
  const base = doc.name.replace(/\.[^.]+$/, '');
  const target = await vscode.window.showSaveDialog({ defaultUri: childUri(dirUri(doc.uri), `${base}.png`), filters: SAVE_FILTERS, title: 'Save a copy as PNG, JPEG, WebP or BMP' });
  if (!target) return;
  const fmt = H.formatFromName(target.path) || 'png';
  const r = await writeEncoded(doc, target, fmt === 'gif' ? 'png' : fmt);
  vscode.window.setStatusBarMessage(`Saved ${baseName(target)} (${r.w} x ${r.h} ${H.FORMATS[fmt === 'gif' ? 'png' : fmt].label}).`, 8000);
  await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
}

async function pasteCommand() {
  const folders = (vscode.workspace.workspaceFolders || []);
  const dir = activeDoc ? dirUri(activeDoc.uri) : folders[0] ? folders[0].uri : null;
  const t = await toolsPanel('Paste an image');
  await t.post({ type: 'paste-mode' });
  t.onPaste = async (bytes) => {
    let d = dir;
    if (!d) { const p = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: 'Save here', title: 'Folder for the pasted image' }); if (!p || !p[0]) return; d = p[0]; }
    await savePasted(bytes, '', d);
    if (tools) tools.panel.dispose();
  };
}

function activate(context) {
  ctxRef = context;
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'Image Editor' });
  registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  pro = createPro({ vscode, context });
  context.subscriptions.push(pro.onDidChange(() => refreshPro()));
  const provider = new Provider(context);
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, { supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true } }));
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg(`${PREFIX}.open`, openWithEditor);
  reg(`${PREFIX}.openSample`, async () => {
    // a copy in the extension's storage, so Save never changes the bundled file
    const src = vscode.Uri.joinPath(context.extensionUri, 'samples', 'sample-screenshot.png');
    const dir = context.globalStorageUri;
    await vscode.workspace.fs.createDirectory(dir);
    const dst = vscode.Uri.joinPath(dir, 'sample-screenshot.png');
    await vscode.workspace.fs.writeFile(dst, await vscode.workspace.fs.readFile(src));
    await vscode.commands.executeCommand('vscode.openWith', dst, VIEW_TYPE);
  });
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#imageEditor.start`, false));
  reg(`${PREFIX}.saveAs`, saveAsCommand);
  reg(`${PREFIX}.pasteAsNewFile`, pasteCommand);
  reg(`${PREFIX}.batch`, (uri) => batch(uri && uri.scheme ? uri : null));
  reg(`${PREFIX}.compress`, (uri) => compress(uri && uri.scheme ? uri : null));
  reg(`${PREFIX}.compare`, (uri) => compare(uri && uri.scheme ? uri : null));
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${PREFIX}.showProTools`)) refreshPro(); }));
}

function deactivate() {}

module.exports = { activate, deactivate, readImage, ImageDocument, Provider, _state: () => ({ docs, tools }) };
