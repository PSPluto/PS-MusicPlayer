const { ipcRenderer } = require('electron');
const canvas = document.getElementById('visualizer-canvas');
const ctx = canvas.getContext('2d');
let width = 0;
let height = 0;
let barColor = 'rgba(255, 255, 255, 0.6)';

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  width = window.innerWidth;
  height = window.innerHeight;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function parseRgb(colorString) {
  const match = colorString.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!match) return [255, 255, 255];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function lightenRgb(colorString, amount = 0.25) {
  const [r, g, b] = parseRgb(colorString);
  const clamp = (value) => Math.min(255, Math.max(0, value));
  return `rgba(${clamp(r + 255 * amount)}, ${clamp(g + 255 * amount)}, ${clamp(b + 255 * amount)}, 0.5)`;
}

function drawVisualizer(data) {
  ctx.clearRect(0, 0, width, height);

  const barCount = 40;
  const barWidth = Math.max(1, 1);
  const spacing = barWidth * 4;
  const maxHeight = height * 0.8;
  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, lightenRgb(barColor, 0.2));
  gradient.addColorStop(0.5, barColor);
  gradient.addColorStop(1, lightenRgb(barColor, 0.15));
  ctx.fillStyle = gradient;

  const totalWidth = barCount * barWidth + (barCount - 1) * spacing;
  const offsetX = (width - totalWidth) / 2;
  const centerY = height / 2;

  for (let i = 0; i < barCount; i++) {
    const value = data[i] / 255;
    const boosted = Math.pow(value, 1.8) * 0.96;
    const barHeight = Math.max(Math.min(boosted, 1) * maxHeight, 4);
    const x = offsetX + i * (barWidth + spacing);
    const y = centerY - barHeight / 2;
    const radius = Math.min(barWidth * 0.35, 4);

    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + barWidth - radius, y);
    ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + radius);
    ctx.lineTo(x + barWidth, y + barHeight - radius);
    ctx.quadraticCurveTo(x + barWidth, y + barHeight, x + barWidth - radius, y + barHeight);
    ctx.lineTo(x + radius, y + barHeight);
    ctx.quadraticCurveTo(x, y + barHeight, x, y + barHeight - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.fill();
  }
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

ipcRenderer.on('visualizer-color', (_event, data) => {
  if (typeof data === 'string') {
    barColor = `rgba(${parseRgb(data).join(', ')}, 0.9)`;
  }
});

ipcRenderer.on('visualizer-data', (_event, data) => {
  if (Array.isArray(data) && data.length > 0) {
    drawVisualizer(data);
  }
});
