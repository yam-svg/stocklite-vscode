/* StockLite VSCode 扩展图标生成器（128×128 PNG，零依赖：zlib + 手写 PNG chunk）
 * 设计：深藏青圆角底 + 4 根红涨蜡烛 + 白灰折线（L 形走势），与插件深色主题协调。 */
const zlib = require('zlib');
const fs = require('fs');

const W = 128, H = 128;
const buf = Buffer.alloc(W * H * 4); // RGBA

function set(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  if (a >= 255) { buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = 255; return; }
  const af = a / 255, da = buf[i+3];
  const out = af + da * (1 - af);
  buf[i]   = Math.round((r * af + buf[i]   * da * (1 - af)) / out);
  buf[i+1] = Math.round((g * af + buf[i+1] * da * (1 - af)) / out);
  buf[i+2] = Math.round((b * af + buf[i+2] * da * (1 - af)) / out);
  buf[i+3] = Math.round(out * 255);
}

// 圆角方形底（半径 24），深藏青渐变到略浅（纵向 +18）
const R = 24;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const dx = Math.max(R - x, x - (W - 1 - R), 0);
  const dy = Math.max(R - y, y - (H - 1 - R), 0);
  if (dx * dx + dy * dy > R * R) continue;
  const t = y / (H - 1);
  set(x, y, Math.round(30 + 14 * t), Math.round(41 + 16 * t), Math.round(59 + 22 * t), 255);
}

// 蜡烛：[中心x, 影线顶y, 影线底y, 实体顶y, 实体底y]，红涨（#e04b4b，A股红涨语义）
const candles = [
  [30, 54, 96, 62, 86],
  [52, 40, 80, 46, 70],
  [74, 58, 100, 66, 92],
  [96, 28, 74, 34, 58],
];
for (const [cx, wickTop, wickBot, bodyTop, bodyBot] of candles) {
  for (let y = wickTop; y <= wickBot; y++) { set(cx, y, 224, 75, 75, 255); set(cx + 1, y, 224, 75, 75, 255); }
  for (let x = cx - 7; x <= cx + 8; x++) for (let y = bodyTop; y <= bodyBot; y++) {
    const edge = x === cx - 7 || x === cx + 8 || y === bodyTop || y === bodyBot;
    set(x, y, edge ? 178 : 224, edge ? 50 : 75, edge ? 50 : 75, 255); // 深色描边
  }
}

// 走势折线（浅白），压在蜡烛上方：先跌后拉升
const pts = [[10, 40], [26, 46], [40, 42], [56, 52], [68, 44], [84, 26], [110, 18]];
function line(x0, y0, x1, y1, color) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps, y = y0 + ((y1 - y0) * i) / steps;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) set(Math.round(x) + ox, Math.round(y) + oy, ...color, 235);
  }
}
for (let i = 0; i < pts.length - 1; i++) line(pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1], [232, 236, 240]);
for (const [x, y] of pts) for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++)
  if (ox * ox + oy * oy <= 4) set(x + ox, y + oy, 232, 236, 240, 255);

// ---- PNG 编码 ----
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crcTable = chunk.t || (chunk.t = Array.from({ length: 256 }, (_, n) => {
    let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
  }));
  let c = 0xffffffff;
  for (const b of body) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) { raw[y * (1 + W * 4)] = 0; buf.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4); }
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const out = process.argv[2];
fs.writeFileSync(out, png);
console.log(`✓ ${out}（${png.length} 字节，${W}×${H} RGBA）`);
