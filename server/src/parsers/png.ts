// ---------------------------------------------------------------------------
// Minimal PNG encoder.
//
// The map render has to become a file the browser can show, and PNG is four
// chunks around a zlib stream — which node ships. Taking a dependency for this
// would mean taking one for something that runs on a machine holding the
// team's data, so it gets written out instead.
//
// Layout: 8-byte signature, IHDR, IDAT, IEND. Every chunk is
// length | type | data | crc32(type + data).
// ---------------------------------------------------------------------------

import { deflateSync } from 'node:zlib'

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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(data.length + 12)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * Filter one scanline, picking whichever of the five filters leaves the
 * smallest total absolute value — the heuristic the PNG spec itself suggests,
 * and the difference between a 3 MB map and an 8 MB one.
 */
function filterRow(
  raw: Buffer, prev: Buffer | null, bpp: number, out: Buffer, outPos: number,
): number {
  const n = raw.length
  const candidates: Buffer[] = []
  for (let f = 0; f < 5; f++) candidates.push(Buffer.allocUnsafe(n))

  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? raw[i - bpp] : 0
    const b = prev ? prev[i] : 0
    const c = prev && i >= bpp ? prev[i - bpp] : 0
    const x = raw[i]
    candidates[0][i] = x
    candidates[1][i] = (x - a) & 0xff
    candidates[2][i] = (x - b) & 0xff
    candidates[3][i] = (x - ((a + b) >> 1)) & 0xff
    candidates[4][i] = (x - paeth(a, b, c)) & 0xff
  }

  let bestF = 0
  let bestScore = Infinity
  for (let f = 0; f < 5; f++) {
    let s = 0
    const cand = candidates[f]
    for (let i = 0; i < n; i++) {
      const v = cand[i]
      s += v < 128 ? v : 256 - v
    }
    if (s < bestScore) { bestScore = s; bestF = f }
  }

  out[outPos] = bestF
  candidates[bestF].copy(out, outPos + 1)
  return outPos + 1 + n
}

/**
 * Encode 8-bit RGB or RGBA pixels as a PNG.
 *
 * `pixels` is row-major, top row first, `channels` bytes per pixel.
 */
export function encodePng(
  pixels: Uint8Array, width: number, height: number, channels: 3 | 4 = 3,
): Buffer {
  const expect = width * height * channels
  if (pixels.length !== expect) {
    throw new Error(`png: expected ${expect} bytes for ${width}x${height}x${channels}, got ${pixels.length}`)
  }

  const stride = width * channels
  const body = Buffer.allocUnsafe(height * (stride + 1))
  let pos = 0
  let prev: Buffer | null = null
  for (let y = 0; y < height; y++) {
    const row = Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride)
    pos = filterRow(row, prev, channels, body, pos)
    prev = row
  }

  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8                         // bit depth
  ihdr[9] = channels === 4 ? 6 : 2    // colour type: RGBA or RGB
  ihdr[10] = 0                        // deflate
  ihdr[11] = 0                        // adaptive filtering
  ihdr[12] = 0                        // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(body, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
