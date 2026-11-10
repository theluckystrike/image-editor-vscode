'use strict';
// The webview HTML and scripts (CSP, no remote loads, no HTML from data, no style attributes) and package.json
// (name, phrases, commands, the editor stays optional, what the vsix leaves out).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildHtml } = require('../src/html');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('webview HTML: nonce scripts, no unsafe-inline, no remote origin, blob images only', () => {
  const html = buildHtml({ cspSource: 'vscode-webview://abc', scriptUris: ['vscode-webview://abc/imgcore.js', 'vscode-webview://abc/editor.js'], styleUri: 'vscode-webview://abc/editor.css', title: '<img src=x onerror=alert(1)>.png', nonce: 'N0nce' });
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-N0nce'/);
  assert.match(csp, /img-src vscode-webview:\/\/abc data: blob:/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|connect-src/);
  assert.strictEqual((html.match(/<script nonce="N0nce" src=/g) || []).length, 2);
  assert.ok(!html.includes('<img src=x'), 'the title is escaped');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;\.png/);
});

test('webview scripts: no network APIs, no HTML from data, styles only through the CSSOM', () => {
  for (const f of ['media/editor.js', 'media/tools.js', 'media/imgcore.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|importScripts|sendBeacon/, `${f}: no network`);
    assert.doesNotMatch(src, /https?:\/\//, `${f}: no URLs`);
    assert.doesNotMatch(src, /\.innerHTML\s*=|outerHTML|insertAdjacentHTML|document\.write/, `${f}: no HTML from strings`);
    assert.doesNotMatch(src, /setAttribute\(\s*['"]style|\.style\s*=|\.style\.cssText/, `${f}: CSSOM only`);
    assert.doesNotMatch(src, /\beval\(|new Function/, `${f}: no eval`);
  }
  for (const f of ['src/extension.js', 'src/core/header.js', 'src/pro.js']) assert.doesNotMatch(read(f), /\bfetch\(|https?\.request|net\.connect/, `${f}: no network in the host`);
});

test('package.json: name from the measured phrases, optional editor, commands match the code', () => {
  assert.strictEqual(pkg.name, 'zovo-image-editor');
  assert.strictEqual(pkg.publisher, 'zovo');
  assert.ok(pkg.displayName.startsWith('Image Editor & Image Resizer'), pkg.displayName);
  assert.ok(pkg.description.startsWith('Image editor and image resizer'), pkg.description);
  for (const k of ['image editor', 'image resizer', 'image resize', 'image crop', 'crop image', 'image annotate', 'screenshot editor', 'image converter', 'photo editor']) assert.ok(pkg.keywords.includes(k), k);
  assert.strictEqual(pkg.engines.vscode, '^1.90.0');
  assert.strictEqual(pkg.devDependencies['@types/vscode'], '~1.90.0');
  assert.ok(!pkg.dependencies, 'no runtime dependencies');
  const ed = pkg.contributes.customEditors[0];
  assert.strictEqual(ed.priority, 'option', 'the built-in image preview stays the default');
  assert.deepStrictEqual(ed.selector.map((s) => s.filenamePattern), ['*.png', '*.jpg', '*.jpeg', '*.webp', '*.bmp', '*.gif']);
  assert.ok(pkg.contributes.menus['editor/title'].some((m) => m.command === 'imageEditor.open' && /imagePreview\.previewEditor/.test(m.when)));
  const ext = read('src/extension.js') + read('src/support.js') + read('src/license/index.js');
  for (const c of pkg.contributes.commands) {
    const name = c.command.split('.')[1];
    assert.ok(ext.includes(`\`\${PREFIX}.${name}\``) || ext.includes(`'${c.command}'`) || ext.includes(`.${name}`), `registered: ${c.command}`);
  }
  for (const k of ['showProTools', 'showSupportLinks', 'askForRating', 'jpegQuality', 'webpQuality']) assert.ok(pkg.contributes.configuration.properties[`imageEditor.${k}`], k);
  const steps = pkg.contributes.walkthroughs[0].steps;
  assert.strictEqual(steps.at(-1).id, 'zovo-related', 'the cross-sell step is last');
  assert.ok(steps.length >= 3 && steps.length <= 5);
  for (const s of steps) assert.ok(fs.existsSync(path.join(root, s.media.markdown)), s.media.markdown);
  const ignore = read('.vscodeignore');
  for (const p of ['test/**', 'scripts/**', 'node_modules/**', '*.vsix']) assert.ok(ignore.includes(p), p);
  assert.ok(fs.existsSync(path.join(root, 'samples', 'sample-screenshot.png')));
  assert.ok(read('README.md').split('\n')[2].startsWith('Zovo Pro: USD 19 once, every Zovo tool.'), 'README line after the title');
});
