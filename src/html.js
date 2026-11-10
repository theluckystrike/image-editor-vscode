'use strict';
// Builds the webview HTML. Kept free of the vscode module so tests can check the CSP.
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** p: { cspSource, scriptUris: [], styleUri, title, nonce?, showSupportLinks?, footer? } */
function buildHtml(p) {
  const n = p.nonce || crypto.randomBytes(24).toString('base64url');
  const footer = p.footer === false ? '' : footerHtml('imageEditor', p.showSupportLinks !== false, '');
  // No connect-src and no remote origin: every byte comes from the extension host by postMessage. blob: is for the
  // decoded and encoded images this page makes itself.
  const csp = [
    "default-src 'none'", `style-src ${p.cspSource} 'nonce-${n}'`, `script-src 'nonce-${n}'`,
    `img-src ${p.cspSource} data: blob:`, `font-src ${p.cspSource}`,
  ].join('; ');
  const scripts = (p.scriptUris || []).map((u) => `<script nonce="${n}" src="${escapeAttr(u)}"></script>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeAttr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
<title>${escapeAttr(p.title)}</title>
</head>
<body>
<div id="app"><p class="loading">Reading the image...</p></div>
<template id="zovo-footer">${footer}</template>
${scripts}
</body>
</html>`;
}

module.exports = { buildHtml, escapeAttr };
