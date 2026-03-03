const { createCanvas, registerFont } = require('canvas');
const fs = require('fs');
const path = require('path');

// Register Inter font faces before creating the canvas
registerFont(path.join(__dirname, 'fonts', 'Inter-Black.ttf'), { family: 'Inter', weight: '900' });
registerFont(path.join(__dirname, 'fonts', 'Inter-Medium.ttf'), { family: 'Inter', weight: '500' });

const WIDTH = 1200;
const HEIGHT = 630;
const canvas = createCanvas(WIDTH, HEIGHT);
const ctx = canvas.getContext('2d');

// Black background
ctx.fillStyle = '#000000';
ctx.fillRect(0, 0, WIDTH, HEIGHT);

// Draw Triad triangle logo (centered, scaled up)
const cx = WIDTH / 2;
const cy = HEIGHT / 2 - 40;
const scale = 0.7;

// Triangle geometry (from SVG favicon)
// Three bars forming a triangle + three circles at vertices
ctx.save();
ctx.translate(cx, cy);
ctx.scale(scale, scale);

// Helper: draw rotated rectangle
function drawBar(x, y, w, h, angle) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.restore();
}

// White bars (the three sides of the triangle)
ctx.fillStyle = '#FFFFFF';
drawBar(0, 82.7, 191, 32, 0);       // Bottom bar
drawBar(-47.75, 0, 190.2, 31.7, -60); // Left bar
drawBar(47.75, 0, 190.2, 31.7, -120); // Right bar

// Black inner bars (gaps in the middle of each side)
ctx.fillStyle = '#000000';
drawBar(0, 82.7, 127, 8, 0);
drawBar(-47.75, 0, 126.8, 7.92, -60);
drawBar(47.75, 0, 126.8, 7.92, -120);

// White circles at vertices
ctx.fillStyle = '#FFFFFF';
function drawCircle(x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
drawCircle(0, -82.7, 31.5);    // Top vertex
drawCircle(-95.5, 82.7, 31.5); // Bottom-left vertex
drawCircle(95.5, 82.7, 32.5);  // Bottom-right vertex

ctx.restore();

// Green accent line below logo
ctx.fillStyle = '#30D158';
ctx.fillRect(cx - 60, cy + 100 * scale + 30, 120, 3);

// Tagline text
ctx.fillStyle = '#FFFFFF';
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';

ctx.font = '900 48px Inter, system-ui, -apple-system, sans-serif';
ctx.fillText('Discipline, Installed.', cx, cy + 100 * scale + 70);

// Subtitle
ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
ctx.font = '500 20px Inter, system-ui, -apple-system, sans-serif';
ctx.fillText('3 Goals. Every Single Day.', cx, cy + 100 * scale + 110);

// Save
const buffer = canvas.toBuffer('image/png');
fs.writeFileSync('og-image.png', buffer);
console.log('Generated og-image.png (1200x630)');
