'use strict';
// Zovo Pro for the Image Editor, on top of the shared license module (src/license, copied unchanged from
// factory/sprint/license). Three Pro tools, 3 free tries each on this computer. A try counts only after the tool
// produced its output (files written, a diff on screen); Escape or Cancel never uses one. Nothing about Pro shows on
// open or activation: the panel appears only after a click on a Pro tool with no tries left.
const { createLicense } = require('./license');

const SKU = 'image-editor-pro';
const TRIAL_USES = 3;
const TRIAL_KEY = 'imageEditor.proTrial';

const FEATURES = {
  batch: {
    title: 'Batch resize and convert',
    detail: 'Resizes and converts every image in a folder in one go (largest width and height, or a percent; PNG, JPEG or WebP; quality; a suffix or a subfolder), with progress, Cancel and a summary. Originals are never overwritten.',
  },
  compress: {
    title: 'Compress to a target size',
    detail: 'Finds the best JPEG or WebP quality that fits a size you type (for example 200 KB), strips the metadata, and shows before and after side by side. For one image or a whole folder.',
  },
  compare: {
    title: 'Compare two images',
    detail: 'Shows two images with a slider, an onion skin or a pixel diff with a threshold, counts the changed pixels, draws boxes around the changed areas and saves the diff as a PNG.',
  },
};
const TOOLS = Object.values(FEATURES).map((f) => f.title);

function createPro({ vscode, context, license, prefix = 'imageEditor', productName = 'Image Editor' }) {
  const emitter = new vscode.EventEmitter();
  const lic = license || createLicense({ vscode, context, sku: SKU, name: 'Zovo', product: productName, commandPrefix: prefix, proTools: TOOLS });
  if (lic.onDidChange) lic.onDidChange(() => emitter.fire(lic.isPro(SKU)));

  const used = (f) => Number((context.globalState.get(TRIAL_KEY) || {})[f]) || 0;
  const left = (f) => (FEATURES[f] ? Math.max(0, TRIAL_USES - used(f)) : 0);
  const licensed = () => lic.isPro(SKU);

  /** Before a Pro tool runs: true when it may run (licensed, or a free try left). Otherwise the one panel. */
  async function allowed(f) {
    if (licensed()) { if (lic.refresh) lic.refresh(); return true; }
    if (left(f) > 0) return true;
    const feat = FEATURES[f] || { title: 'This tool', detail: '' };
    return !!(await lic.requirePro(feat.title, { detail: feat.detail, triesUsed: used(f), tools: TOOLS }));
  }

  /** After the tool produced its output: counts one free try (nothing when licensed). */
  async function produced(f) {
    if (licensed() || !FEATURES[f]) return;
    const m = { ...(context.globalState.get(TRIAL_KEY) || {}) };
    m[f] = used(f) + 1;
    await context.globalState.update(TRIAL_KEY, m);
    const l = left(f);
    vscode.window.setStatusBarMessage(`Zovo Pro: free try ${used(f)} of ${TRIAL_USES} of "${FEATURES[f].title}" used${l ? `, ${l} left` : ''} on this computer.`, 8000);
    emitter.fire(false);
  }

  context.subscriptions.push(emitter);
  return {
    SKU, FEATURES, TRIAL_USES,
    get licensed() { return licensed(); },
    ready: lic.ready,
    allowed, produced, left,
    tries: () => Object.fromEntries(Object.keys(FEATURES).map((f) => [f, left(f)])),
    handleUri: (uri) => (lic.handleUri ? lic.handleUri(uri) : undefined),
    onDidChange: emitter.event,
    license: lic,
  };
}

module.exports = { createPro, FEATURES, SKU, TRIAL_USES, TRIAL_KEY, TOOLS };
