'use strict';
// Writes samples/sample-screenshot.png: a made-up app window (no real data) to try crop, arrows, steps and blur on.
const fs = require('fs');
const path = require('path');
const { raster } = require('./png');

const r = raster(1280, 800, '#eef1f5');
r.rect(0, 0, 1280, 44, '#1f2937'); // title bar
for (const [x, c] of [[18, '#ef4444'], [42, '#f59e0b'], [66, '#22c55e']]) r.circle(x, 22, 7, c);
r.rect(420, 14, 440, 16, '#374151'); // address bar
r.rect(0, 44, 240, 756, '#ffffff'); // sidebar
r.rect(240, 44, 1, 756, '#d1d5db');
for (let i = 0; i < 9; i++) { r.rect(24, 80 + i * 44, 24, 24, i === 2 ? '#3b82f6' : '#cbd5e1'); r.rect(60, 86 + i * 44, 120 - (i * 13) % 50, 12, i === 2 ? '#1d4ed8' : '#94a3b8'); }
r.rect(280, 76, 520, 28, '#111827'); // heading
r.rect(280, 120, 360, 12, '#6b7280');
// cards
for (let i = 0; i < 3; i++) { const x = 280 + i * 320; r.rect(x, 160, 296, 150, '#ffffff'); r.rect(x, 160, 296, 4, ['#3b82f6', '#22c55e', '#f59e0b'][i]); r.rect(x + 20, 190, 120, 12, '#94a3b8'); r.rect(x + 20, 220, 180, 34, '#111827'); r.rect(x + 20, 272, 90, 10, '#cbd5e1'); }
// a form with a "secret" field to blur
r.rect(280, 340, 936, 300, '#ffffff');
for (let i = 0; i < 4; i++) { r.rect(310, 372 + i * 62, 140, 12, '#6b7280'); r.rect(470, 362 + i * 62, 420, 34, '#f3f4f6'); r.rect(484, 374 + i * 62, [220, 160, 300, 120][i], 10, i === 2 ? '#111827' : '#9ca3af'); }
r.rect(470, 610, 0, 0, '#ffffff');
r.rect(930, 362, 250, 34, '#fee2e2'); r.rect(944, 374, 200, 10, '#b91c1c'); // error message
r.rect(310, 590, 140, 36, '#2563eb'); r.rect(336, 604, 88, 8, '#ffffff'); // button
r.rect(280, 670, 936, 90, '#ffffff');
for (let i = 0; i < 3; i++) r.rect(310, 690 + i * 22, 820 - i * 140, 10, '#cbd5e1');
const out = path.join(__dirname, '..', 'samples', 'sample-screenshot.png');
fs.writeFileSync(out, r.png({ text: 'Comment\0Zovo Image Editor sample (made-up app window)' }));
console.log(out, fs.statSync(out).size);
