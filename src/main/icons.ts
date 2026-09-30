import { deflateSync } from 'node:zlib'
import type { Severity } from '@shared/types'

// Harici görsel dosyasına gerek kalmadan tray ikonlarını çalışma anında üreten küçük bir PNG kodlayıcı.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** RGBA piksel dizisini PNG'ye kodlar. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

export const SEVERITY_RGB: Record<Severity, [number, number, number]> = {
  ok: [34, 197, 94],
  warn: [245, 158, 11],
  crit: [239, 68, 68],
  unknown: [148, 163, 184]
}

/** Kenarı yumuşatılmış, ortasında beyaz "nabız" çizgisi olan renkli daire. */
export function trayPng(size: number, sev: Severity): Buffer {
  const [r, g, b] = SEVERITY_RGB[sev]
  const px = new Uint8Array(size * size * 4)
  const c = (size - 1) / 2
  const rad = size / 2 - 0.5
  // Nabız çizgisi noktaları (0..1 koordinat)
  const pts: [number, number][] = [
    [0.18, 0.55],
    [0.38, 0.55],
    [0.46, 0.3],
    [0.56, 0.75],
    [0.64, 0.5],
    [0.82, 0.5]
  ]
  const lineW = Math.max(1, size * 0.09)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c)
      const a = Math.max(0, Math.min(1, rad - d + 0.5))
      if (a <= 0) continue
      let dl = Infinity
      for (let i = 0; i < pts.length - 1; i++) {
        dl = Math.min(dl, distSeg(x / (size - 1), y / (size - 1), pts[i], pts[i + 1]) * (size - 1))
      }
      const la = Math.max(0, Math.min(1, lineW / 2 - dl + 0.5))
      const o = (y * size + x) * 4
      px[o] = Math.round(r + (255 - r) * la)
      px[o + 1] = Math.round(g + (255 - g) * la)
      px[o + 2] = Math.round(b + (255 - b) * la)
      px[o + 3] = Math.round(a * 255)
    }
  }
  return encodePng(size, size, px)
}

function distSeg(px: number, py: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy))
}
