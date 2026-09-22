// ---------------------------------------------------------------------------
// Rust `.map` world file reader.
//
// This is the actual world the server generated: heightmap, biomes, terrain
// splats, topology, every monument, every road. It is a public download — the
// same file RustMaps serves — so reading it is no different from looking at a
// map website, except we get the numbers instead of a picture.
//
// LAYOUT (reverse-engineered from a live server's world file and verified end to end
// against 8,112 road spline nodes; see test/worldfile.test.ts):
//
//   uint32   version          little-endian; 10 on current files
//   uint64   stamp            8 bytes; reads as a ms timestamp. Not used.
//   chunk[]  lz4net stream    repeats until EOF
//
// Each chunk is an lz4net `LZ4Stream` block:
//
//   varint   flags            bit0 = compressed, bit1 = high compression
//   varint   originalLength   1 MiB for every chunk but the last
//   varint   compressedLength present only when bit0 is set
//   byte[]   data             raw LZ4 block, or stored bytes when bit0 is clear
//
// Concatenating the decompressed chunks yields one protobuf message:
//
//   WorldData { uint32 size = 1; MapData maps = 2; PrefabData prefabs = 3;
//               PathData paths = 4 }
//   MapData   { string name = 1; bytes data = 2 }
//   PrefabData{ string category = 1; uint32 id = 2; VectorData position = 3;
//               VectorData rotation = 4; VectorData scale = 5 }
//   PathData  { string name = 1; ...scalars...; VectorData nodes = 15 }
//
// The layer payloads are plain little-endian arrays in PLANAR order — all of
// channel 0, then all of channel 1, and so on. Getting that wrong produces a
// tidy mosaic of the island repeated 64 times, which is how it was caught.
// ---------------------------------------------------------------------------

import { Reader, asNumber, asString } from '../rustplus/protobuf.ts'
import type { Vec3 } from '../../../shared/types.ts'

export interface WorldLayer {
  name: string
  /** View into the decompressed payload — not a copy. */
  data: Buffer
}

export interface WorldPrefab {
  category: string
  /** StringPool id. Stable across maps, but only resolvable with a game manifest. */
  id: number
  position: Vec3
  rotation: Vec3
  scale: Vec3
}

export interface WorldPath {
  name: string
  /** "Road" | "Rail" | "River" | "Powerline" — the leading word of `name`. */
  kind: string
  nodes: Vec3[]
  width: number
}

export interface WorldFile {
  version: number
  stamp: bigint
  /** World size in metres. A 3750 map runs -1875..+1875 on both axes. */
  size: number
  layers: Map<string, WorldLayer>
  prefabs: WorldPrefab[]
  paths: WorldPath[]
}

// --- LZ4 -------------------------------------------------------------------

/**
 * Decode one raw LZ4 block from `src[start,end)` into `out` at `outPos`.
 *
 * The match copy has to be byte-by-byte: LZ4 encodes runs as a match that
 * overlaps its own output (offset 2, length 30000 is how a flat ocean floor is
 * stored), so a bulk copy would read bytes that have not been written yet.
 */
function decodeLz4Block(
  src: Buffer, start: number, end: number, out: Buffer, outPos: number,
): number {
  let i = start
  let o = outPos
  while (i < end) {
    const token = src[i++]

    let literals = token >> 4
    if (literals === 15) {
      let b = 255
      while (b === 255) {
        if (i >= end) throw new Error('lz4: truncated literal length')
        b = src[i++]
        literals += b
      }
    }
    if (i + literals > end) throw new Error('lz4: truncated literals')
    src.copy(out, o, i, i + literals)
    i += literals
    o += literals

    // A block legally ends on a literal run, with no match after it.
    if (i >= end) break

    if (i + 2 > end) throw new Error('lz4: truncated match offset')
    const offset = src[i] | (src[i + 1] << 8)
    i += 2
    // Blocks are independent in this stream: a match never reaches back past
    // the start of its own chunk. Checking against `outPos` rather than 0
    // turns a misread chunk boundary into an error instead of silent garbage.
    if (offset === 0 || offset > o - outPos) {
      throw new Error(`lz4: bad match offset ${offset} at output ${o - outPos}`)
    }

    let matchLen = token & 0x0f
    if (matchLen === 15) {
      let b = 255
      while (b === 255) {
        if (i >= end) throw new Error('lz4: truncated match length')
        b = src[i++]
        matchLen += b
      }
    }
    matchLen += 4

    let p = o - offset
    for (let k = 0; k < matchLen; k++) out[o++] = out[p++]
  }
  return o
}

function readVarint(buf: Buffer, pos: number): [number, number] {
  let value = 0
  let shift = 0
  for (;;) {
    if (pos >= buf.length) throw new Error('lz4: truncated varint')
    const b = buf[pos++]
    value += (b & 0x7f) * 2 ** shift
    if ((b & 0x80) === 0) return [value, pos]
    shift += 7
    if (shift > 49) throw new Error('lz4: varint too long')
  }
}

interface ChunkHeader {
  compressed: boolean
  originalLength: number
  dataStart: number
  dataEnd: number
  next: number
}

function readChunkHeader(buf: Buffer, pos: number): ChunkHeader {
  let flags: number
  let originalLength: number
  let compressedLength: number
  ;[flags, pos] = readVarint(buf, pos)
  ;[originalLength, pos] = readVarint(buf, pos)
  const compressed = (flags & 1) !== 0
  if (compressed) {
    ;[compressedLength, pos] = readVarint(buf, pos)
  } else {
    compressedLength = originalLength
  }
  const dataEnd = pos + compressedLength
  if (dataEnd > buf.length) {
    throw new Error(
      `lz4: chunk at ${pos} claims ${compressedLength} bytes, only ${buf.length - pos} left`,
    )
  }
  return { compressed, originalLength, dataStart: pos, dataEnd, next: dataEnd }
}

const HEADER_BYTES = 12 // uint32 version + uint64 stamp

/**
 * Decompress a `.map` file to its raw protobuf payload.
 *
 * Walks the chunk headers twice: once to total the output size so the result
 * can be a single allocation, then again to decode. A 44 MB file expands to
 * about 178 MB, so appending would mean repeatedly copying that.
 */
export function decompressWorldFile(file: Buffer): {
  version: number; stamp: bigint; payload: Buffer
} {
  if (file.length < HEADER_BYTES) throw new Error('map: file too short to be a world file')
  const version = file.readUInt32LE(0)
  const stamp = file.readBigUInt64LE(4)

  let total = 0
  let pos = HEADER_BYTES
  let chunks = 0
  while (pos < file.length) {
    const h = readChunkHeader(file, pos)
    total += h.originalLength
    pos = h.next
    chunks++
  }
  if (chunks === 0) throw new Error('map: no chunks — not a Rust world file?')

  const payload = Buffer.allocUnsafe(total)
  let out = 0
  pos = HEADER_BYTES
  while (pos < file.length) {
    const h = readChunkHeader(file, pos)
    if (h.compressed) {
      const wrote = decodeLz4Block(file, h.dataStart, h.dataEnd, payload, out) - out
      if (wrote !== h.originalLength) {
        throw new Error(
          `lz4: chunk at ${pos} produced ${wrote} bytes, header said ${h.originalLength}`,
        )
      }
    } else {
      file.copy(payload, out, h.dataStart, h.dataEnd)
    }
    out += h.originalLength
    pos = h.next
  }
  if (out !== total) throw new Error(`lz4: wrote ${out} of ${total} bytes`)
  return { version, stamp, payload }
}

// --- protobuf --------------------------------------------------------------

function readVec3(bytes: Uint8Array): Vec3 {
  const v: Vec3 = { x: 0, y: 0, z: 0 }
  new Reader(bytes).each((f) => {
    if (f.float === undefined) return
    if (f.field === 1) v.x = f.float
    else if (f.field === 2) v.y = f.float
    else if (f.field === 3) v.z = f.float
  })
  return v
}

/** A node is a message whose every field is a 32-bit float — nothing else is. */
function looksLikeVec3(bytes: Uint8Array): boolean {
  try {
    let any = false
    const r = new Reader(bytes)
    while (!r.done) {
      const f = r.next()
      if (f.wire !== 5) return false
      any = true
    }
    return any
  } catch {
    return false
  }
}

export function parseWorldData(payload: Buffer): Omit<WorldFile, 'version' | 'stamp'> {
  let size = 0
  const layers = new Map<string, WorldLayer>()
  const prefabs: WorldPrefab[] = []
  const paths: WorldPath[] = []

  new Reader(payload).each((f) => {
    switch (f.field) {
      case 1:
        size = asNumber(f)
        break

      case 2: {
        if (!f.bytes) break
        let name = ''
        let data: Buffer | null = null
        new Reader(f.bytes).each((g) => {
          if (g.field === 1) name = asString(g)
          else if (g.field === 2 && g.bytes) {
            data = Buffer.from(g.bytes.buffer, g.bytes.byteOffset, g.bytes.byteLength)
          }
        })
        if (name && data) layers.set(name, { name, data })
        break
      }

      case 3: {
        if (!f.bytes) break
        const p: WorldPrefab = {
          category: '', id: 0,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        }
        new Reader(f.bytes).each((g) => {
          if (g.field === 1) p.category = asString(g)
          else if (g.field === 2) p.id = asNumber(g)
          else if (g.field === 3 && g.bytes) p.position = readVec3(g.bytes)
          else if (g.field === 4 && g.bytes) p.rotation = readVec3(g.bytes)
          else if (g.field === 5 && g.bytes) p.scale = readVec3(g.bytes)
        })
        prefabs.push(p)
        break
      }

      case 4: {
        if (!f.bytes) break
        let name = ''
        let width = 0
        const nodes: Vec3[] = []
        new Reader(f.bytes).each((g) => {
          if (g.field === 1 && g.bytes) name = asString(g)
          else if (g.field === 5 && g.float !== undefined) width = g.float
          // The node field number has moved between map versions, so take any
          // repeated submessage that is three floats and nothing else.
          else if (g.wire === 2 && g.field !== 1 && g.bytes && looksLikeVec3(g.bytes)) {
            nodes.push(readVec3(g.bytes))
          }
        })
        paths.push({ name, kind: name.split(' ')[0] ?? '', nodes, width })
        break
      }
    }
  })

  if (!size) throw new Error('map: world size missing — payload is not WorldData')
  return { size, layers, prefabs, paths }
}

export function readWorldFile(file: Buffer): WorldFile {
  const { version, stamp, payload } = decompressWorldFile(file)
  return { version, stamp, ...parseWorldData(payload) }
}
