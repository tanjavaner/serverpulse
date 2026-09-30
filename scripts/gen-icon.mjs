// build/icon.png (1024x1024) üretir: koyu yuvarlatılmış kare + yeşil nabız çizgisi.
// electron-builder bundan Windows .ico ve macOS .icns üretir.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 1024
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png')

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

const clamp = (v) => Math.max(0, Math.min(1, v))
const distSeg = (px, py, a, b) => {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const t = clamp(((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy))
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy))
}

// macOS ikon ızgarası: içerik ~%80, köşe yarıçapı ~%22
const pad = SIZE * 0.1
const box = SIZE - 2 * pad
const radius = box * 0.225
const pulse = [
  [0.2, 0.55],
  [0.4, 0.55],
  [0.47, 0.3],
  [0.57, 0.76],
  [0.64, 0.48],
  [0.8, 0.48]
].map(([x, y]) => [pad + x * box, pad + y * box])
const lineW = box * 0.07

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 4 + 1)
  raw[row] = 0
  for (let x = 0; x < SIZE; x++) {
    // Yuvarlatılmış kare SDF
    const qx = Math.abs(x + 0.5 - SIZE / 2) - (box / 2 - radius)
    const qy = Math.abs(y + 0.5 - SIZE / 2) - (box / 2 - radius)
    const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
    const a = clamp(0.5 - sd)
    // Dikey gradyan: #16213a → #0b1220
    const t = (y - pad) / box
    let r = 22 + (11 - 22) * t
    let g = 33 + (18 - 33) * t
    let b = 58 + (32 - 58) * t
    let d = Infinity
    for (let i = 0; i < pulse.length - 1; i++) d = Math.min(d, distSeg(x + 0.5, y + 0.5, pulse[i], pulse[i + 1]))
    const glow = clamp(1 - (d - lineW / 2) / (lineW * 1.6)) * 0.35
    const line = clamp(lineW / 2 - d + 0.5)
    const mix = Math.max(line, glow)
    r = r + (34 - r) * mix
    g = g + (197 - g) * mix
    b = b + (94 - b) * mix
    const o = row + 1 + x * 4
    raw[o] = Math.round(r)
    raw[o + 1] = Math.round(g)
    raw[o + 2] = Math.round(b)
    raw[o + 3] = Math.round(a * 255)
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8
ihdr[9] = 6
mkdirSync(dirname(out), { recursive: true })
writeFileSync(
  out,
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
)
console.log('yazıldı:', out)
