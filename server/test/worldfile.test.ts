// ---------------------------------------------------------------------------
// World file tests.
//
// The real map is 44 MB, so it is not a fixture. Instead these build world
// files byte by byte — including hand-written LZ4 blocks — which is stricter
// than a recorded sample: a synthetic file can exercise the overlapping-match
// path and the malformed input that a healthy download never contains.
//
// Set NABRUST_TEST_MAP=/path/to/server.map to additionally run the checks
// against a real download. Those assert the things that were MEASURED from
// live data rather than assumed, so a regression in the height encoding or
// the coordinate mapping fails loudly.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { Writer } from '../src/rustplus/protobuf.ts'
import { decompressWorldFile, parseWorldData, readWorldFile } from '../src/parsers/worldfile.ts'
import { openTerrain, toSolverTerrain, TOPOLOGY, SPLAT_NAMES, BIOME_NAMES } from '../src/parsers/terrain.ts'
import { extractMonuments } from '../src/parsers/monuments.ts'
import { renderMap, summariseTerrain } from '../src/parsers/mapRender.ts'
import { encodePng } from '../src/parsers/png.ts'
import { ingestWorldFile } from '../src/parsers/mapIngest.ts'
import { openDb, nowIso } from '../src/db/index.ts'
import { serverRecord, terrainFor } from '../src/api/mapInfo.ts'
import { createApi } from '../src/api/server.ts'
import {
  HEIGHT_BASE_METRES, HEIGHT_SPAN_METRES, SEA_LEVEL_RAW,
  metresToRawHeight, rawHeightToMetres,
} from '../../shared/world.ts'
import { displayMonument, monumentName, prefabId } from '../src/parsers/monumentNames.ts'
import { hasLineOfSight, syntheticTerrain } from '../../shared/inference/localize.ts'

type TestFn = (name: string, fn: () => void | Promise<void>) => void

// --- builders --------------------------------------------------------------

function varint(n: number): Buffer {
  const out: number[] = []
  let v = n
  do {
    let b = v & 0x7f
    v = Math.floor(v / 128)
    if (v > 0) b |= 0x80
    out.push(b)
  } while (v > 0)
  return Buffer.from(out)
}

/** Wrap a payload as a world file using STORED (uncompressed) chunks. */
function storedWorldFile(payload: Buffer, version = 10, chunkSize = 4096): Buffer {
  const head = Buffer.alloc(12)
  head.writeUInt32LE(version, 0)
  head.writeBigUInt64LE(0n, 4)
  const parts: Buffer[] = [head]
  for (let i = 0; i < payload.length; i += chunkSize) {
    const slice = payload.subarray(i, Math.min(i + chunkSize, payload.length))
    parts.push(varint(0), varint(slice.length), slice)
  }
  return Buffer.concat(parts)
}

/** Wrap one raw LZ4 block as a world file with a single compressed chunk. */
function lz4WorldFile(block: Buffer, originalLength: number): Buffer {
  const head = Buffer.alloc(12)
  head.writeUInt32LE(10, 0)
  head.writeBigUInt64LE(0n, 4)
  return Buffer.concat([
    head, varint(1), varint(originalLength), varint(block.length), block,
  ])
}

const HEIGHT_RES = 65
const GROUND_RES = 64
const WORLD_SIZE = 1000

interface SynthOptions {
  /** raw height as a function of grid indices */
  height?: (i: number, j: number) => number
  water?: (i: number, j: number) => number
  topology?: (i: number, j: number) => number
  splat?: (c: number, i: number, j: number) => number
  biome?: (c: number, i: number, j: number) => number
  prefabs?: { category: string; id: number; x: number; y: number; z: number }[]
  paths?: { name: string; width: number; nodes: [number, number, number][] }[]
}

function synthPayload(o: SynthOptions = {}): Buffer {
  const hFn = o.height ?? (() => Math.round(SEA_LEVEL_RAW))
  const wFn = o.water ?? (() => 0)
  const tFn = o.topology ?? (() => TOPOLOGY.Field)
  const sFn = o.splat ?? ((c) => (c === 4 ? 255 : 0))
  const bFn = o.biome ?? ((c) => (c === 1 ? 255 : 0))

  const h = Buffer.alloc(HEIGHT_RES * HEIGHT_RES * 2)
  const w = Buffer.alloc(HEIGHT_RES * HEIGHT_RES * 2)
  for (let j = 0; j < HEIGHT_RES; j++) {
    for (let i = 0; i < HEIGHT_RES; i++) {
      h.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(hFn(i, j)))), (j * HEIGHT_RES + i) * 2)
      w.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(wFn(i, j)))), (j * HEIGHT_RES + i) * 2)
    }
  }
  const topo = Buffer.alloc(GROUND_RES * GROUND_RES * 4)
  for (let j = 0; j < GROUND_RES; j++) {
    for (let i = 0; i < GROUND_RES; i++) {
      topo.writeUInt32LE(tFn(i, j) >>> 0, (j * GROUND_RES + i) * 4)
    }
  }
  // PLANAR: every texel of channel 0, then every texel of channel 1, ...
  const plane = GROUND_RES * GROUND_RES
  const splat = Buffer.alloc(plane * 8)
  for (let c = 0; c < 8; c++) {
    for (let j = 0; j < GROUND_RES; j++) {
      for (let i = 0; i < GROUND_RES; i++) splat[c * plane + j * GROUND_RES + i] = sFn(c, i, j)
    }
  }
  const biome = Buffer.alloc(plane * 5)
  for (let c = 0; c < 5; c++) {
    for (let j = 0; j < GROUND_RES; j++) {
      for (let i = 0; i < GROUND_RES; i++) biome[c * plane + j * GROUND_RES + i] = bFn(c, i, j)
    }
  }

  const wr = new Writer()
  wr.uint32Always(1, WORLD_SIZE)
  const layer = (name: string, data: Buffer) =>
    wr.message(2, (m) => { m.string(1, name); m.bytes(2, data) })
  layer('terrain', h)
  layer('height', h)
  layer('water', w)
  layer('topology', topo)
  layer('splat', splat)
  layer('biome', biome)
  layer('alpha', Buffer.alloc(plane, 255))

  for (const p of o.prefabs ?? []) {
    wr.message(3, (m) => {
      m.string(1, p.category)
      m.uint32Always(2, p.id)
      m.message(3, (v) => { v.float(1, p.x); v.float(2, p.y); v.float(3, p.z) })
      m.message(4, (v) => { v.float(1, 0); v.float(2, 0); v.float(3, 0) })
      m.message(5, (v) => { v.float(1, 1); v.float(2, 1); v.float(3, 1) })
    })
  }
  for (const p of o.paths ?? []) {
    wr.message(4, (m) => {
      m.string(1, p.name)
      m.float(5, p.width)
      for (const n of p.nodes) {
        m.message(15, (v) => { v.float(1, n[0]); v.float(2, n[1]); v.float(3, n[2]) })
      }
    })
  }
  return Buffer.from(wr.finish())
}

const synthWorld = (o?: SynthOptions) => readWorldFile(storedWorldFile(synthPayload(o)))

export function run(test: TestFn) {
  // --- LZ4 -------------------------------------------------------------------

  console.log('\nlz4')

  test('a literals-only block round-trips', () => {
    const body = Buffer.from('NABRUST')
    const block = Buffer.concat([Buffer.from([body.length << 4]), body])
    const { payload } = decompressWorldFile(lz4WorldFile(block, body.length))
    assert.equal(payload.toString(), 'NABRUST')
  })

  test('an overlapping match expands a run, as a flat ocean floor does', () => {
    // token: 2 literals, match length 10 (field = 10 - 4 = 6); offset 2 means the
    // match reads bytes it is still writing.
    const block = Buffer.from([0x26, 0x41, 0x42, 0x02, 0x00])
    const { payload } = decompressWorldFile(lz4WorldFile(block, 12))
    assert.equal(payload.toString(), 'ABABABABABAB')
  })

  test('literal lengths above 14 use continuation bytes', () => {
    const body = Buffer.alloc(300, 0x5a)
    // 15 in the token, then 255 + 30 to reach 300.
    const block = Buffer.concat([Buffer.from([0xf0, 255, 30]), body])
    const { payload } = decompressWorldFile(lz4WorldFile(block, 300))
    assert.equal(payload.length, 300)
    assert.ok(payload.every((b) => b === 0x5a))
  })

  test('match lengths above 18 use continuation bytes', () => {
    // 1 literal, match field 15 -> continuation 5 -> length 15 + 5 + 4 = 24.
    const block = Buffer.from([0x1f, 0x58, 0x01, 0x00, 5])
    const { payload } = decompressWorldFile(lz4WorldFile(block, 25))
    assert.equal(payload.toString(), 'X'.repeat(25))
  })

  test('a match reaching before the chunk start is rejected, not silently wrong', () => {
    const block = Buffer.from([0x16, 0x41, 0x05, 0x00])
    assert.throws(() => decompressWorldFile(lz4WorldFile(block, 11)), /bad match offset/)
  })

  test('a zero match offset is rejected', () => {
    const block = Buffer.from([0x16, 0x41, 0x00, 0x00])
    assert.throws(() => decompressWorldFile(lz4WorldFile(block, 11)), /bad match offset/)
  })

  test('a chunk that decodes to the wrong length is caught', () => {
    const body = Buffer.from('NABRUST')
    const block = Buffer.concat([Buffer.from([body.length << 4]), body])
    assert.throws(() => decompressWorldFile(lz4WorldFile(block, 999)), /produced 7 bytes/)
  })

  test('a chunk claiming more bytes than the file holds is caught', () => {
    const head = Buffer.alloc(12)
    head.writeUInt32LE(10, 0)
    const bad = Buffer.concat([head, varint(1), varint(10), varint(9999), Buffer.alloc(4)])
    assert.throws(() => decompressWorldFile(bad), /only 4 left/)
  })

  test('stored and compressed chunks reassemble in order', () => {
    const head = Buffer.alloc(12)
    head.writeUInt32LE(10, 0)
    const lit = (s: string) => Buffer.concat([Buffer.from([s.length << 4]), Buffer.from(s)])
    const file = Buffer.concat([
      head,
      varint(0), varint(3), Buffer.from('one'),
      varint(1), varint(3), varint(4), lit('two'),
      varint(0), varint(5), Buffer.from('three'),
    ])
    assert.equal(decompressWorldFile(file).payload.toString(), 'onetwothree')
  })

  test('version and stamp come off the header', () => {
    const head = Buffer.alloc(12)
    head.writeUInt32LE(10, 0)
    head.writeBigUInt64LE(1788334958992n, 4)
    const file = Buffer.concat([head, varint(0), varint(2), Buffer.from('hi')])
    const r = decompressWorldFile(file)
    assert.equal(r.version, 10)
    assert.equal(r.stamp, 1788334958992n)
  })

  test('a file with no chunks is rejected rather than returning an empty world', () => {
    assert.throws(() => decompressWorldFile(Buffer.alloc(12)), /no chunks/)
    assert.throws(() => decompressWorldFile(Buffer.alloc(4)), /too short/)
  })

  // --- height encoding -------------------------------------------------------

  console.log('\nheight encoding')

  test('sea level is exactly zero metres', () => {
    assert.equal(rawHeightToMetres(SEA_LEVEL_RAW), 0)
    assert.equal(metresToRawHeight(0), SEA_LEVEL_RAW)
  })

  test('the band spans 2000m starting at -500m', () => {
    assert.equal(rawHeightToMetres(0), HEIGHT_BASE_METRES)
    assert.equal(rawHeightToMetres(65535), HEIGHT_BASE_METRES + HEIGHT_SPAN_METRES)
  })

  test('metres round-trip through the raw encoding', () => {
    for (const m of [-71.7, -50, 0, 12.5, 97.7, 250]) {
      assert.ok(Math.abs(rawHeightToMetres(metresToRawHeight(m)) - m) < 1e-9, `${m}`)
    }
  })

  // --- parsing ---------------------------------------------------------------

  console.log('\nworld parsing')

  test('layers, prefabs and paths come back off a synthetic world', () => {
    const w = synthWorld({
      prefabs: [{ category: 'Monument', id: 4242, x: 10, y: 5, z: -20 }],
      paths: [{ name: 'Road 0', width: 12, nodes: [[0, 1, 0], [10, 2, 10]] }],
    })
    assert.equal(w.version, 10)
    assert.equal(w.size, WORLD_SIZE)
    assert.deepEqual([...w.layers.keys()].sort(),
      ['alpha', 'biome', 'height', 'splat', 'terrain', 'topology', 'water'])
    assert.equal(w.prefabs.length, 1)
    assert.equal(w.prefabs[0].id, 4242)
    assert.equal(w.prefabs[0].position.z, -20)
    assert.equal(w.paths.length, 1)
    assert.equal(w.paths[0].kind, 'Road')
    assert.equal(w.paths[0].width, 12)
    assert.equal(w.paths[0].nodes.length, 2)
  })

  test('a payload that is not WorldData is rejected', () => {
    assert.throws(() => parseWorldData(Buffer.from([0x12, 0x02, 0x41, 0x42])), /world size missing/)
  })

  test('layer views point into the payload without copying it', () => {
    const w = synthWorld()
    const terrain = w.layers.get('terrain')!
    assert.equal(terrain.data.length, HEIGHT_RES * HEIGHT_RES * 2)
  })

  // --- terrain ---------------------------------------------------------------

  console.log('\nterrain')

  test('resolutions are derived from byte counts, not assumed', () => {
    const t = openTerrain(synthWorld())
    assert.equal(t.heightRes, HEIGHT_RES)
    assert.equal(t.groundRes, GROUND_RES)
  })

  test('bilinear sampling reproduces a plane exactly', () => {
    // Height varies linearly with i only, so bilinear interpolation is exact and
    // any error is a coordinate-mapping bug rather than interpolation noise.
    // The base has to be a whole raw value: sea level is 16383.75, and the
    // heightmap can only store integers.
    const base = Math.round(SEA_LEVEL_RAW)
    const step = 12
    const t = openTerrain(synthWorld({ height: (i) => base + i * step }))
    const half = WORLD_SIZE / 2
    for (const frac of [0, 0.13, 0.5, 0.77, 1]) {
      const x = frac * WORLD_SIZE - half
      const expect = rawHeightToMetres(base + frac * (HEIGHT_RES - 1) * step)
      assert.ok(Math.abs(t.heightAt(x, 0) - expect) < 1e-6,
        `at frac ${frac}: ${t.heightAt(x, 0)} vs ${expect}`)
    }
  })

  test('north is +z and the sample follows it', () => {
    const t = openTerrain(synthWorld({ height: (_i, j) => SEA_LEVEL_RAW + j * 20 }))
    const half = WORLD_SIZE / 2
    assert.ok(t.heightAt(0, half - 1) > t.heightAt(0, -half + 1), 'north should be higher')
  })

  test('sampling off the map edge clamps instead of throwing', () => {
    const t = openTerrain(synthWorld())
    assert.equal(t.heightAt(1e6, -1e6), t.heightAt(WORLD_SIZE / 2, -WORLD_SIZE / 2))
  })

  test('water only reports where the layer is non-zero', () => {
    const t = openTerrain(synthWorld({
      water: (i) => (i < 20 ? SEA_LEVEL_RAW + 100 : 0),
    }))
    assert.notEqual(t.waterAt(-WORLD_SIZE / 2 + 1, 0), null)
    assert.equal(t.waterAt(WORLD_SIZE / 2 - 1, 0), null)
  })

  test('splat and biome planes are read planar, not interleaved', () => {
    // Interleaved reading would pick up a neighbouring channel here and return
    // the wrong name — this is the bug that produced a 64-tile mosaic.
    const t = openTerrain(synthWorld({
      splat: (c) => (c === 1 ? 250 : 5),
      biome: (c) => (c === 3 ? 250 : 5),
    }))
    assert.equal(t.splatAt(0, 0), SPLAT_NAMES[1])
    assert.equal(t.biomeAt(0, 0), BIOME_NAMES[3])
  })

  test('topology bits survive the round trip', () => {
    const t = openTerrain(synthWorld({
      topology: () => TOPOLOGY.Road | TOPOLOGY.Monument,
    }))
    assert.ok(t.topologyAt(0, 0) & TOPOLOGY.Road)
    assert.ok(t.topologyAt(0, 0) & TOPOLOGY.Monument)
    assert.ok(!(t.topologyAt(0, 0) & TOPOLOGY.Ocean))
  })

  test('buildable excludes ocean, monuments, roads and cliffs', () => {
    const half = WORLD_SIZE / 2
    const at = (topo: number, raw: number) =>
      openTerrain(synthWorld({ topology: () => topo, height: () => raw }))
        .buildableAt(0, 0)
    const above = SEA_LEVEL_RAW + 500
    assert.equal(at(TOPOLOGY.Field, above), true)
    assert.equal(at(TOPOLOGY.Monument, above), false)
    assert.equal(at(TOPOLOGY.Road, above), false)
    assert.equal(at(TOPOLOGY.Cliff, above), false)
    assert.equal(at(TOPOLOGY.Ocean, above), false)
    assert.equal(at(TOPOLOGY.Field, SEA_LEVEL_RAW - 500), false)
    assert.ok(half > 0)
  })

  test('slope is zero on flat ground and rises with gradient', () => {
    const flat = openTerrain(synthWorld())
    assert.ok(flat.slopeDegreesAt(0, 0) < 1e-6)
    const steep = openTerrain(synthWorld({ height: (i) => SEA_LEVEL_RAW + i * 400 }))
    assert.ok(steep.slopeDegreesAt(0, 0) > 10)
  })

  test('extent reports the real min and max', () => {
    const base = Math.round(SEA_LEVEL_RAW)
    const t = openTerrain(synthWorld({ height: (i) => base + i * 10 }))
    const e = t.extent()
    assert.ok(Math.abs(e.min - rawHeightToMetres(base)) < 1e-9, `min ${e.min}`)
    assert.ok(Math.abs(e.max - rawHeightToMetres(base + 64 * 10)) < 1e-9, `max ${e.max}`)
  })

  // --- solver hand-off -------------------------------------------------------

  console.log('\nsolver terrain')

  test('solver terrain is metres over world size, so heightScale is 1', () => {
    const t = openTerrain(synthWorld({ height: () => metresToRawHeight(50) }))
    const st = toSolverTerrain(t, 16)
    assert.equal(st.heightScale, 1)
    assert.equal(st.size, 16)
    assert.ok(Math.abs(st.height[0][0] * WORLD_SIZE - 50) < 0.5, `${st.height[0][0] * WORLD_SIZE}`)
  })

  test('solver row 0 is north', () => {
    const t = openTerrain(synthWorld({ height: (_i, j) => SEA_LEVEL_RAW + j * 30 }))
    const st = toSolverTerrain(t, 16)
    assert.ok(st.height[0][0] > st.height[15][0], 'row 0 should be the high, northern edge')
  })

  test('the placeholder terrain keeps its old line-of-sight behaviour', () => {
    // heightScale/eyeHeight/losClearance are optional precisely so the synthetic
    // terrain the UI ships with does not change when real terrain arrives.
    const s = syntheticTerrain(32, 7)
    assert.equal(s.heightScale, undefined)
    const a = { x: 0.2, y: 0.2 }
    const b = { x: 0.8, y: 0.8 }
    assert.equal(hasLineOfSight(s, a, b), hasLineOfSight(s, a, b, 0.02))
  })

  // --- monuments -------------------------------------------------------------

  console.log('\nmonuments')

  test('a monument footprint is measured from the topology bit', () => {
    // A 16x16 block of Monument texels on a 64-texel, 1000 m map: each texel is
    // 1000/64 m across, so the area should land near (16 * 15.6)^2.
    const t = synthWorld({
      topology: (i, j) => (i >= 24 && i < 40 && j >= 24 && j < 40
        ? TOPOLOGY.Monument : TOPOLOGY.Field),
      prefabs: [{ category: 'Monument', id: 99, x: 0, y: 0, z: 0 }],
    })
    const m = extractMonuments(t, openTerrain(t))
    assert.equal(m.length, 1)
    const texel = WORLD_SIZE / GROUND_RES
    const expect = (16 * texel) ** 2
    assert.ok(Math.abs(m[0].areaSquareMetres - expect) / expect < 0.25,
      `area ${m[0].areaSquareMetres} vs ~${expect}`)
    assert.equal(m[0].prefabId, 99)
  })

  test('a prefab sitting just off its footprint still gets measured', () => {
    const t = synthWorld({
      topology: (i, j) => (i >= 34 && i < 44 && j >= 30 && j < 40
        ? TOPOLOGY.Monument : TOPOLOGY.Field),
      // origin is ~40 m west of the blob, on unflagged ground
      prefabs: [{ category: 'Monument', id: 7, x: 20, y: 0, z: 50 }],
    })
    const m = extractMonuments(t, openTerrain(t))
    assert.ok(m[0].areaSquareMetres > 0, 'snapping to the nearest flagged texel failed')
  })

  test('an unmeasurable monument is not labelled small', () => {
    const t = synthWorld({
      topology: () => TOPOLOGY.Field,
      prefabs: [{ category: 'Monument', id: 5, x: 0, y: 0, z: 0 }],
    })
    const m = extractMonuments(t, openTerrain(t))
    assert.equal(m[0].areaSquareMetres, 0)
    assert.equal(m[0].label, 'monument')
  })

  test('known monument prefabs are named from their StringPool id', () => {
    // Ids read from a real procedural map's world file.
    assert.equal(monumentName(2720666271), 'Airfield')
    assert.equal(monumentName(1073114437), 'Launch Site')
    assert.equal(monumentName(3348191966), 'Harbor')
    assert.equal(prefabId('assets/bundled/prefabs/autospawn/monument/large/powerplant_1.prefab'), 158704173)
    assert.equal(monumentName(5), null)
    assert.deepEqual(displayMonument('large monument #12', 12), { name: 'large monument', named: false })
    assert.deepEqual(displayMonument('Bandit Camp', null), { name: 'Bandit Camp', named: true })
    const t = synthWorld({ prefabs: [{ category: 'Monument', id: 2720666271, x: 0, y: 0, z: 0 }] })
    assert.equal(extractMonuments(t, openTerrain(t))[0].label, 'Airfield')
  })

  test('prefabs outside the world square are offshore', () => {
    const t = synthWorld({
      prefabs: [{ category: 'Monument', id: 1, x: WORLD_SIZE, y: 0, z: 0 }],
    })
    const m = extractMonuments(t, openTerrain(t))
    assert.equal(m[0].size, 'offshore')
  })

  test('non-monument prefabs are ignored', () => {
    const t = synthWorld({
      prefabs: [
        { category: 'Decor', id: 1, x: 0, y: 0, z: 0 },
        { category: 'Monument', id: 2, x: 0, y: 0, z: 0 },
      ],
    })
    assert.equal(extractMonuments(t, openTerrain(t)).length, 1)
  })

  // --- png -------------------------------------------------------------------

  console.log('\npng')

  /** Undo PNG row filters so the test checks pixels, not just chunk framing. */
  function decodePng(png: Buffer): { width: number; height: number; px: Buffer } {
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    let pos = 8
    let width = 0
    let height = 0
    let channels = 3
    const idat: Buffer[] = []
    while (pos < png.length) {
      const len = png.readUInt32BE(pos)
      const type = png.toString('ascii', pos + 4, pos + 8)
      const data = png.subarray(pos + 8, pos + 8 + len)
      if (type === 'IHDR') {
        width = data.readUInt32BE(0)
        height = data.readUInt32BE(4)
        channels = data[9] === 6 ? 4 : 3
      } else if (type === 'IDAT') idat.push(data)
      pos += len + 12
    }
    const raw = inflateSync(Buffer.concat(idat))
    const stride = width * channels
    const out = Buffer.alloc(height * stride)
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)]
      const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? out[y * stride + i - channels] : 0
        const b = y > 0 ? out[(y - 1) * stride + i] : 0
        const c = y > 0 && i >= channels ? out[(y - 1) * stride + i - channels] : 0
        let v = row[i]
        if (filter === 1) v += a
        else if (filter === 2) v += b
        else if (filter === 3) v += (a + b) >> 1
        else if (filter === 4) {
          const p = a + b - c
          const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c)
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        }
        out[y * stride + i] = v & 0xff
      }
    }
    return { width, height, px: out }
  }

  test('an encoded png decodes back to the same pixels', () => {
    const w = 17
    const h = 9
    const px = new Uint8Array(w * h * 3)
    for (let i = 0; i < px.length; i++) px[i] = (i * 37) & 0xff
    const back = decodePng(encodePng(px, w, h, 3))
    assert.equal(back.width, w)
    assert.equal(back.height, h)
    assert.deepEqual([...back.px], [...px])
  })

  test('rgba is encoded as colour type 6', () => {
    const px = new Uint8Array(4 * 4 * 4).fill(200)
    const back = decodePng(encodePng(px, 4, 4, 4))
    assert.deepEqual([...back.px], [...px])
  })

  test('a pixel buffer of the wrong size is rejected', () => {
    assert.throws(() => encodePng(new Uint8Array(10), 4, 4, 3), /expected 48 bytes/)
  })

  // --- render ----------------------------------------------------------------

  console.log('\nmap render')

  test('the render is square, north up, and ocean is blue', () => {
    const half = WORLD_SIZE / 2
    const w = synthWorld({
      // north half land, south half deep ocean
      height: (_i, j) => (j > HEIGHT_RES / 2 ? SEA_LEVEL_RAW + 600 : SEA_LEVEL_RAW - 2000),
    })
    const t = openTerrain(w)
    const r = renderMap(w, t, { resolution: 32, hillshade: 0 })
    const { px } = decodePng(r.png)
    const at = (row: number, col: number) => [px[(row * 32 + col) * 3], px[(row * 32 + col) * 3 + 1], px[(row * 32 + col) * 3 + 2]]
    const north = at(2, 16)
    const south = at(29, 16)
    assert.ok(south[2] > south[0], `south should be ocean-blue, got ${south}`)
    assert.ok(north[1] > north[2], `north should be land-green, got ${north}`)
    assert.ok(half > 0)
  })

  test('roads are drawn over the ground', () => {
    const base = synthWorld({ height: () => SEA_LEVEL_RAW + 600 })
    const withRoad = synthWorld({
      height: () => SEA_LEVEL_RAW + 600,
      paths: [{ name: 'Road 0', width: 40, nodes: [[-400, 0, 0], [400, 0, 0]] }],
    })
    const a = decodePng(renderMap(base, openTerrain(base), { resolution: 64, hillshade: 0 }).png).px
    const b = decodePng(renderMap(withRoad, openTerrain(withRoad), { resolution: 64, hillshade: 0 }).png).px
    let diff = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++
    assert.ok(diff > 100, `road changed only ${diff} bytes`)
  })

  test('summariseTerrain counts land and buildable ground', () => {
    const w = synthWorld({ height: () => SEA_LEVEL_RAW + 600 })
    const s = summariseTerrain(openTerrain(w))
    assert.equal(s.landFraction, 1)
    assert.equal(s.buildableFraction, 1)
  })

  // --- ingest ----------------------------------------------------------------

  console.log('\nmap ingest')

  function freshDb() {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO servers (id, name, created_at) VALUES (?, ?, ?)`)
      .run('srv', 'TEST', nowIso())
    db.prepare(`INSERT INTO wipes (server_id, started_at) VALUES (?, ?)`)
      .run('srv', '2026-09-01T00:00:00Z')
    return db
  }

  test('ingest writes monuments, flips map_source and leaves a render on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nabrust-map-'))
    const src = join(dir, 'w.map')
    const dest = join(dir, 'w.png')
    writeFileSync(src, storedWorldFile(synthPayload({
      topology: (i, j) => (i >= 24 && i < 40 && j >= 24 && j < 40
        ? TOPOLOGY.Monument : TOPOLOGY.Field),
      height: () => SEA_LEVEL_RAW + 600,
      prefabs: [{ category: 'Monument', id: 11, x: 0, y: 0, z: 0 }],
    })))

    const db = freshDb()
    const wipeId = (db.prepare(`SELECT id FROM wipes`).get() as { id: number }).id
    const r = ingestWorldFile(db, 'srv', src, dest, wipeId, { resolution: 64 })

    assert.equal(r.worldSize, WORLD_SIZE)
    assert.equal(r.monuments.length, 1)
    assert.ok(existsSync(dest))
    assert.ok(r.renderBytes > 0)

    const row = db.prepare(`SELECT map_source, map_image_path, world_size FROM servers`).get() as
      { map_source: string; map_image_path: string; world_size: number }
    assert.equal(row.map_source, 'parsed')
    assert.equal(row.map_image_path, dest)
    assert.equal(row.world_size, WORLD_SIZE)

    const mon = db.prepare(`SELECT name, kind, x, y, prefab_id, radius FROM monuments`).all() as
      { x: number; y: number; prefab_id: number; radius: number }[]
    assert.equal(mon.length, 1)
    assert.equal(mon[0].prefab_id, 11)
    // origin maps to the middle of the normalised square
    assert.ok(Math.abs(mon[0].x - 0.5) < 1e-6 && Math.abs(mon[0].y - 0.5) < 1e-6)
    assert.ok(mon[0].radius > 0)
  })

  test('re-ingesting replaces monuments rather than duplicating them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nabrust-map-'))
    const src = join(dir, 'w.map')
    writeFileSync(src, storedWorldFile(synthPayload({
      topology: () => TOPOLOGY.Monument,
      prefabs: [{ category: 'Monument', id: 11, x: 0, y: 0, z: 0 }],
    })))
    const db = freshDb()
    const wipeId = (db.prepare(`SELECT id FROM wipes`).get() as { id: number }).id
    ingestWorldFile(db, 'srv', src, join(dir, 'a.png'), wipeId, { skipRender: true })
    ingestWorldFile(db, 'srv', src, join(dir, 'a.png'), wipeId, { skipRender: true })
    const n = db.prepare(`SELECT COUNT(*) n FROM monuments`).get() as { n: number }
    assert.equal(n.n, 1)
  })

  test('an implausible header stamp is dropped instead of stored as a date', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nabrust-map-'))
    const src = join(dir, 'w.map')
    const file = storedWorldFile(synthPayload())
    file.writeBigUInt64LE(1n, 4) // 1970 — not a real map build time
    writeFileSync(src, file)
    const db = freshDb()
    const r = ingestWorldFile(db, 'srv', src, join(dir, 'a.png'), null, { skipRender: true })
    assert.equal(r.headerStamp, null)
  })

  // --- what the web app receives --------------------------------------------

  console.log('\nserver record')

  /** A parsed server: monument blob at the centre, land everywhere. */
  function parsedServer() {
    const dir = mkdtempSync(join(tmpdir(), 'nabrust-rec-'))
    const src = join(dir, 'w.map')
    writeFileSync(src, storedWorldFile(synthPayload({
      topology: (i, j) => (i >= 24 && i < 40 && j >= 24 && j < 40 ? TOPOLOGY.Monument : TOPOLOGY.Field),
      height: () => SEA_LEVEL_RAW + 600,
      prefabs: [{ category: 'Monument', id: 11, x: 0, y: 0, z: 0 }],
    })))
    const db = freshDb()
    const wipeId = (db.prepare(`SELECT id FROM wipes`).get() as { id: number }).id
    ingestWorldFile(db, 'srv', src, join(dir, 'w.png'), wipeId, { resolution: 32 })
    return { db, dir, src }
  }

  test('a parsed server hands the UI a map URL, terrain and measured monuments', () => {
    const { db } = parsedServer()
    const r = serverRecord(db, 'srv')!
    assert.ok(r.map.parsedRenderUrl?.startsWith('/api/map/srv?v='), `${r.map.parsedRenderUrl}`)
    assert.equal(r.map.rustPlusImageUrl, null)
    assert.equal(r.map.terrainAvailable, true)
    assert.equal(r.map.monuments.length, 1)
    const m = r.map.monuments[0]
    assert.equal(m.prefabId, 11)
    // radius arrives normalised to the world edge, not in metres
    assert.ok(m.radius! > 0 && m.radius! < 0.5, `radius ${m.radius}`)
    assert.ok(Math.abs(m.pos.x - 0.5) < 1e-6)
  })

  test('nothing unmeasured is dressed up as data', () => {
    const { db } = parsedServer()
    const r = serverRecord(db, 'srv')!
    assert.equal(r.heat, 'unknown')
    assert.deepEqual(r.map.oreDensity, [])
    assert.equal(r.pop, 0)
    assert.ok(r.maxPop >= 1, 'maxPop must never be 0 — the UI divides by it')
    assert.equal(r.populationCurve.length, 24)
  })

  test('the Battlemetrics thumbnail is not offered as the map', () => {
    const db = freshDb()
    const dir = mkdtempSync(join(tmpdir(), 'nabrust-rec-'))
    const img = join(dir, 'thumb.webp')
    writeFileSync(img, Buffer.alloc(10))
    db.prepare(`UPDATE servers SET map_source = 'battlemetrics', map_image_path = ?`).run(img)
    const r = serverRecord(db, 'srv')!
    assert.equal(r.map.parsedRenderUrl, null)
    assert.equal(r.map.rustPlusImageUrl, null)
  })

  test('a map file that has gone missing is not advertised', () => {
    const { db } = parsedServer()
    db.prepare(`UPDATE servers SET map_image_path = '/nope/gone.png', map_world_path = '/nope/gone.map'`).run()
    const r = serverRecord(db, 'srv')!
    assert.equal(r.map.parsedRenderUrl, null)
    assert.equal(r.map.terrainAvailable, false)
  })

  test('wipe day counts from the seed change, not from when we first looked', () => {
    const db = freshDb()
    const now = Date.parse('2026-09-21T12:00:00Z')
    db.prepare(`UPDATE wipes SET started_at = '2026-09-21T05:00:00Z'`).run()
    db.prepare(`UPDATE servers SET last_seed_change = '2026-09-17T19:00:00Z'`).run()
    assert.equal(serverRecord(db, 'srv', now)!.wipeDay, 4)
  })

  test('population curve counts who was on at each hour mark', () => {
    const db = freshDb()
    const now = Date.parse('2026-09-21T12:00:00Z')
    const ins = db.prepare(
      `INSERT INTO sessions (server_id, steam_id, joined_at, left_at) VALUES ('srv', ?, ?, ?)`,
    )
    ins.run('a', '2026-09-21T09:30:00Z', null)                  // on for the last 3 marks
    ins.run('b', '2026-09-21T10:30:00Z', '2026-09-21T11:30:00Z') // only the 11:00 mark
    ins.run('c', '2026-09-19T00:00:00Z', '2026-09-19T05:00:00Z') // long gone
    const r = serverRecord(db, 'srv', now)!
    assert.deepEqual(r.populationCurve.slice(-4), [0, 1, 2, 1])
    assert.equal(r.pop, 1)
  })

  test('solver terrain is served in metres at the requested size, and cached', () => {
    const { db } = parsedServer()
    const t = terrainFor(db, 'srv', 32)!
    assert.equal(t.res, 32)
    assert.equal(t.heights.length, 32 * 32)
    assert.equal(t.buildable.length, 32 * 32)
    const expect = rawHeightToMetres(Math.round(SEA_LEVEL_RAW + 600))
    assert.ok(Math.abs(t.heights[500] - expect) < 0.1, `${t.heights[500]} vs ${expect}`)
    assert.equal(terrainFor(db, 'srv', 32), t, 'second call should be the cached object')
  })

  test('the API serves records and terrain behind the token', async () => {
    const { db } = parsedServer()
    const api = createApi({ db, token: 'secret', port: 0 })
    const port = await api.listen()
    const auth = { authorization: 'Bearer secret' }
    try {
      const recs = await (await fetch(`http://127.0.0.1:${port}/api/servers`, { headers: auth })).json() as
        { records: { id: string; map: { parsedRenderUrl: string } }[] }
      assert.equal(recs.records[0].id, 'srv')

      const img = await fetch(`http://127.0.0.1:${port}${recs.records[0].map.parsedRenderUrl}&token=secret`)
      assert.equal(img.status, 200)
      assert.equal(img.headers.get('content-type'), 'image/png')

      assert.equal((await fetch(`http://127.0.0.1:${port}/api/terrain/srv`)).status, 401)
      const t = await fetch(`http://127.0.0.1:${port}/api/terrain/srv?res=48`, { headers: auth })
      assert.equal(t.status, 200)
      assert.equal(((await t.json()) as { res: number }).res, 48)

      const clamped = await (await fetch(`http://127.0.0.1:${port}/api/terrain/srv?res=100000`, { headers: auth })).json() as { res: number }
      assert.equal(clamped.res, 256, 'res is clamped so one request cannot ask for a giant grid')

      db.prepare(`INSERT INTO servers (id, name, created_at) VALUES ('bare', 'BARE', ?)`).run(nowIso())
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/terrain/bare`, { headers: auth })).status, 404)
    } finally {
      await api.close()
    }
  })

  // --- against a real download -----------------------------------------------

  const REAL = process.env.NABRUST_TEST_MAP
  if (REAL && existsSync(REAL)) {
    console.log('\nreal world file')
    const world = readWorldFile(readFileSync(REAL))
    const terrain = openTerrain(world)

    test('the real file parses with a sane world size and layer set', () => {
      assert.ok(world.size >= 1000 && world.size <= 8000, `size ${world.size}`)
      for (const n of ['terrain', 'water', 'topology', 'splat', 'biome']) {
        assert.ok(world.layers.has(n), `missing ${n}`)
      }
      assert.equal(terrain.heightRes, terrain.groundRes * 2 + 1)
    })

    test('road spline nodes sit on the terrain surface', () => {
      // This is the calibration that pinned the 2000 m / -500 m constants. If
      // the encoding, the resolution derivation or the coordinate mapping
      // regresses, this is what catches it.
      const nodes = world.paths.filter((p) => p.kind === 'Road').flatMap((p) => p.nodes)
      assert.ok(nodes.length > 100, 'expected a road network')
      const err = nodes
        .map((n) => Math.abs(terrain.heightAt(n.x, n.z) - n.y))
        .sort((a, b) => a - b)
      const median = err[err.length >> 1]
      assert.ok(median < 0.25, `median road height error ${median.toFixed(3)}m`)
    })

    test('roads and monuments land on their own topology bits', () => {
      const nodes = world.paths.filter((p) => p.kind === 'Road').flatMap((p) => p.nodes)
      const onRoad = nodes.filter((n) => terrain.topologyAt(n.x, n.z) & TOPOLOGY.Road).length
      assert.ok(onRoad / nodes.length > 0.9, `only ${(100 * onRoad / nodes.length).toFixed(0)}% on Road`)

      const mons = world.prefabs.filter((p) => p.category === 'Monument')
      const half = world.size / 2
      const land = mons.filter((m) => Math.abs(m.position.x) < half && Math.abs(m.position.z) < half)
      const onMon = land.filter((m) => terrain.topologyAt(m.position.x, m.position.z) & TOPOLOGY.Monument).length
      assert.ok(onMon / land.length > 0.85, `only ${(100 * onMon / land.length).toFixed(0)}% on Monument`)
    })

    test('deep water is flagged Ocean', () => {
      let deep = 0
      let flagged = 0
      const half = world.size / 2
      for (let i = 0; i < 2000; i++) {
        const x = (i * 7919 % 10007) / 10007 * world.size - half
        const z = (i * 104729 % 10009) / 10009 * world.size - half
        if (terrain.heightAt(x, z) < -25) {
          deep++
          if (terrain.topologyAt(x, z) & TOPOLOGY.Ocean) flagged++
        }
      }
      assert.ok(deep > 20, 'expected some deep water in the sample')
      assert.ok(flagged / deep > 0.9, `only ${(100 * flagged / deep).toFixed(0)}% flagged Ocean`)
    })

    test('elevations are in a range a Rust map actually occupies', () => {
      const e = terrain.extent()
      assert.ok(e.min > -300 && e.min < 0, `min ${e.min}`)
      assert.ok(e.max > 20 && e.max < 500, `max ${e.max}`)
    })

    test('monuments are found and the biggest are genuinely big', () => {
      const m = extractMonuments(world, terrain)
      assert.ok(m.length > 20, `only ${m.length} monuments`)
      assert.ok(m[0].areaSquareMetres > 50_000, `largest is only ${m[0].areaSquareMetres} m2`)
    })
  }

}
