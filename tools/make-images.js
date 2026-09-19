/**
 * 生成五种情绪的竖版颗粒图像（纯 Node，无外部依赖）。
 * 输出 PNG：竖向渐变 + 暗角 + 烘焙颗粒，供前端 <img> 与卡片 Canvas 使用。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 640;
const H = 960;
const OUT_DIR = path.join(__dirname, '..', 'public', 'assets', 'moods');

/* ---------- CRC32 ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 伪随机（可复现） ---------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- 情绪配色 ---------- */
const MOODS = {
  anxious: { top: [38, 44, 66], bottom: [22, 18, 34], glow: [96, 88, 130], seed: 11 },
  lucid:   { top: [58, 84, 96], bottom: [16, 26, 34], glow: [150, 180, 188], seed: 23 },
  lonely:  { top: [34, 40, 78], bottom: [10, 12, 26], glow: [88, 96, 150], seed: 37 },
  brave:   { top: [110, 58, 40], bottom: [34, 20, 16], glow: [190, 130, 70], seed: 51 },
  calm:    { top: [84, 104, 92], bottom: [30, 40, 36], glow: [168, 186, 168], seed: 67 },
};

function lerp(a, b, t) { return a + (b - a) * t; }

function renderMood({ top, bottom, glow, seed }) {
  const rand = mulberry32(seed);
  const img = Buffer.alloc(W * H * 4);
  const cx = W * (0.35 + rand() * 0.3);
  const cy = H * (0.3 + rand() * 0.25);
  const maxD = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));

  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    // 轻微的非线性让渐变更像暗房相纸
    const tt = t * t * (3 - 2 * t);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const d = Math.hypot(x - cx, y - cy) / maxD; // 0..1
      const glowAmt = Math.max(0, 1 - d * 1.6) * 0.55;
      const vignette = 1 - Math.pow(d, 2.2) * 0.45;
      // 烘焙颗粒：2x2 块共享噪声，幅度克制
      const g = ((Math.sin(x * 12.9898 + y * 78.233 + seed) * 43758.5453) % 1) * 22 - 11;
      for (let c = 0; c < 3; c++) {
        let v = lerp(top[c], bottom[c], tt);
        v = lerp(v, glow[c], glowAmt * (1 - tt * 0.6));
        v *= vignette;
        v += g;
        img[i + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
      img[i + 3] = 255;
    }
  }
  return img;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, cfg] of Object.entries(MOODS)) {
  const png = encodePNG(W, H, renderMood(cfg));
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, png);
  console.log(`${name}.png  ${(png.length / 1024).toFixed(1)} KB`);
}
console.log('done ->', OUT_DIR);
