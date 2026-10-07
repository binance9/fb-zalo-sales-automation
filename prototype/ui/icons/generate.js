'use strict';
// ui/icons/generate.js — sinh icon PNG 192/512 cho PWA (KHÔNG npm: PNG encoder thuần node
// zlib + CRC32; vẽ pixel: nền HỒNG #db2777 bo góc + túi giấy TRẮNG — đúng theme console).
// Chạy: node ui/icons/generate.js  ->  ghi icon-192.png + icon-512.png cạnh file này.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- PNG (RGBA, 8-bit) ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- vẽ icon: nền hồng bo góc + túi giấy trắng (thân bo góc + quai环形) ----
function drawIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const s = size;
  const inRoundedRect = (x, y, x0, y0, x1, y1, r) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = x < x0 + r ? x0 + r : (x > x1 - r ? x1 - r : x);
    const cy = y < y0 + r ? y0 + r : (y > y1 - r ? y1 - r : y);
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= r * r || (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r);
  };
  // màu theme
  const PINK = [0xdb, 0x27, 0x77];
  const WHITE = [0xff, 0xff, 0xff];
  const radius = Math.round(s * 0.22);
  const bag = {
    x0: Math.round(s * 0.24), x1: Math.round(s * 0.76),
    y0: Math.round(s * 0.42), y1: Math.round(s * 0.78),
    r: Math.round(s * 0.06),
  };
  const handle = { cx: s / 2, cy: Math.round(s * 0.42), rOut: Math.round(s * 0.155), rIn: Math.round(s * 0.095) };
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      let color = null;
      // quai túi (vòng tròn) — phần dưới sẽ bị thân túi che
      const dxh = x - handle.cx, dyh = y - handle.cy;
      const d2 = dxh * dxh + dyh * dyh;
      if (d2 <= handle.rOut * handle.rOut && d2 >= handle.rIn * handle.rIn) color = WHITE;
      // thân túi
      if (inRoundedRect(x, y, bag.x0, bag.y0, bag.x1, bag.y1, bag.r)) color = WHITE;
      // nền
      const bg = inRoundedRect(x, y, 0, 0, s - 1, s - 1, radius);
      px[i] = color ? color[0] : PINK[0];
      px[i + 1] = color ? color[1] : PINK[1];
      px[i + 2] = color ? color[2] : PINK[2];
      px[i + 3] = bg ? 255 : 0; // bo góc trong suốt
    }
  }
  return encodePng(s, s, Buffer.from(px));
}

const dir = __dirname;
for (const size of [192, 512]) {
  const file = path.join(dir, `icon-${size}.png`);
  fs.writeFileSync(file, drawIcon(size));
  console.log(`[icons] wrote ${file} (${fs.statSync(file).size} bytes)`);
}
