// Run with: node generate-icons.js
// Requires: npm install canvas
// Or use the SVG directly in the manifest if your Edge version supports it.

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const sizes = [16, 32, 48, 128];

function drawIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const r = size * 0.12; // corner radius

  // Background: Microsoft blue
  ctx.fillStyle = '#0f6cbd';
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.quadraticCurveTo(size, 0, size, r);
  ctx.lineTo(size, size - r);
  ctx.quadraticCurveTo(size, size, size - r, size);
  ctx.lineTo(r, size);
  ctx.quadraticCurveTo(0, size, 0, size - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fill();

  // White downward arrow (export symbol)
  ctx.fillStyle = '#ffffff';
  const cx = size / 2;
  const cy = size / 2;
  const arrowW = size * 0.28;
  const arrowH = size * 0.22;
  const stemW = size * 0.14;
  const stemH = size * 0.22;
  const top = cy - (stemH + arrowH) / 2 - size * 0.04;

  // Stem
  ctx.fillRect(cx - stemW / 2, top, stemW, stemH);

  // Arrow head
  ctx.beginPath();
  ctx.moveTo(cx - arrowW / 2, top + stemH);
  ctx.lineTo(cx + arrowW / 2, top + stemH);
  ctx.lineTo(cx, top + stemH + arrowH);
  ctx.closePath();
  ctx.fill();

  // Underline bar
  const barH = Math.max(2, size * 0.08);
  const barY = top + stemH + arrowH + size * 0.04;
  ctx.fillRect(cx - arrowW / 2, barY, arrowW, barH);

  return canvas.toBuffer('image/png');
}

for (const size of sizes) {
  const buf = drawIcon(size);
  const out = path.join(__dirname, 'icons', `icon${size}.png`);
  fs.writeFileSync(out, buf);
  console.log(`Written: ${out}`);
}
