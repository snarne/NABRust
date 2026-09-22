// ---------------------------------------------------------------------------
// Sampling the parsed world.
//
// worldfile.ts hands back raw layer bytes; this turns them into questions worth
// asking: how high is the ground here, is it under water, is it inside a
// monument, could somebody have built here. The localization solver needs all
// four — a shot's logged range is a 3D distance, so elevation converts an
// unknown into a constraint, and a candidate firing position on a road or in
// the ocean is not a candidate at all.
//
// Resolutions are DERIVED from the byte counts, never hard-coded: heightmaps
// are (2^n)+1 while ground layers are 2^n, and both change with world size.
// ---------------------------------------------------------------------------

import { endianness } from 'node:os'
import type { Vec2 } from '../../../shared/types.ts'
import { rawHeightToMetres } from '../../../shared/world.ts'
import type { WorldFile } from './worldfile.ts'

/**
 * TerrainTopology bits.
 *
 * Every constant below was verified against this map's own contents rather
 * than copied from a wiki: Road/Roadside light up on 98.8%/99.5% of road
 * spline nodes, River/Riverside on 99.4%/95.0% of river nodes, Monument on
 * 94.9% of monument prefabs, Ocean/Offshore on 98% of cells below -25 m,
 * Cliff on 89% of cells steeper than 50°, and Forest on 92% of cells whose
 * dominant splat is forest.
 *
 * Bits 19-31 are deliberately absent. Several are set on nearly every land
 * cell, which means the names circulating for them are wrong, and a wrong
 * name here would quietly poison the buildable mask.
 */
export const TOPOLOGY = {
  Field: 1 << 0,
  Cliff: 1 << 1,
  Summit: 1 << 2,
  Beachside: 1 << 3,
  Beach: 1 << 4,
  Forest: 1 << 5,
  Forestside: 1 << 6,
  Ocean: 1 << 7,
  Oceanside: 1 << 8,
  Decor: 1 << 9,
  Monument: 1 << 10,
  Road: 1 << 11,
  Roadside: 1 << 12,
  Swamp: 1 << 13,
  River: 1 << 14,
  Riverside: 1 << 15,
  Lake: 1 << 16,
  Lakeside: 1 << 17,
  Offshore: 1 << 18,
} as const

/** Splat channel order, confirmed by rendering: snow lands in the north, sand in the south. */
export const SPLAT_NAMES = [
  'Dirt', 'Snow', 'Sand', 'Rock', 'Grass', 'Forest', 'Stones', 'Gravel',
] as const

/**
 * Biome channel order, confirmed against this map: channel 0 sits at mean
 * latitude 0.19 (far south) and is 68% sand; channel 3 sits at 0.84 and is 91%
 * snow. Jungle is channel 4 and only exists on post-2025 maps.
 */
export const BIOME_NAMES = ['Arid', 'Temperate', 'Tundra', 'Arctic', 'Jungle'] as const

export type SplatName = (typeof SPLAT_NAMES)[number]
export type BiomeName = (typeof BIOME_NAMES)[number]

function squareRes(bytes: number, bytesPerTexel: number, what: string): number {
  if (bytes % bytesPerTexel !== 0) {
    throw new Error(`map: ${what} is ${bytes} bytes, not a multiple of ${bytesPerTexel}`)
  }
  const n = bytes / bytesPerTexel
  const r = Math.round(Math.sqrt(n))
  if (r * r !== n) throw new Error(`map: ${what} has ${n} texels, not a square`)
  return r
}

/**
 * Typed-array view over layer bytes.
 *
 * The layer is a slice of one big payload buffer, so its byteOffset is
 * arbitrary and usually not 2- or 4-aligned. Copying into a fresh ArrayBuffer
 * is the only way to get a view; Buffer.alloc would not help because pooled
 * buffers carry an arbitrary offset too.
 */
function alignedView<T>(
  b: Buffer, make: (ab: ArrayBuffer) => T, bytesPer: number,
): T {
  if (b.byteOffset % bytesPer === 0) {
    return make(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
  }
  const ab = new ArrayBuffer(b.byteLength)
  Buffer.from(ab).set(b)
  return make(ab)
}

export interface TerrainSample {
  /** Ground elevation in metres, sea level 0. */
  height: number
  /** Water surface in metres, or null where there is none. */
  water: number | null
  topology: number
  biome: BiomeName | null
  splat: SplatName | null
}

export interface Terrain {
  size: number
  heightRes: number
  groundRes: number
  heightAt(x: number, z: number): number
  waterAt(x: number, z: number): number | null
  topologyAt(x: number, z: number): number
  biomeAt(x: number, z: number): BiomeName | null
  splatAt(x: number, z: number): SplatName | null
  slopeDegreesAt(x: number, z: number): number
  buildableAt(x: number, z: number): boolean
  sample(x: number, z: number): TerrainSample
  /** Min and max ground elevation across the whole map, in metres. */
  extent(): { min: number; max: number }
}

export function openTerrain(world: WorldFile): Terrain {
  if (endianness() !== 'LE') {
    throw new Error('map: world files are little-endian and this host is not')
  }

  const need = (name: string): Buffer => {
    const l = world.layers.get(name)
    if (!l) throw new Error(`map: missing "${name}" layer`)
    return l.data
  }

  const heightBytes = need('terrain')
  const waterBytes = need('water')
  const topoBytes = need('topology')
  const splatBytes = need('splat')
  const biomeBytes = need('biome')

  const heightRes = squareRes(heightBytes.length, 2, 'terrain layer')
  const groundRes = squareRes(topoBytes.length, 4, 'topology layer')

  const heights = alignedView(heightBytes, (ab) => new Uint16Array(ab), 2)
  const waters = alignedView(waterBytes, (ab) => new Uint16Array(ab), 2)
  const topos = alignedView(topoBytes, (ab) => new Uint32Array(ab), 4)
  const splats = new Uint8Array(splatBytes.buffer, splatBytes.byteOffset, splatBytes.byteLength)
  const biomes = new Uint8Array(biomeBytes.buffer, biomeBytes.byteOffset, biomeBytes.byteLength)

  const plane = groundRes * groundRes
  const splatChannels = splatBytes.length / plane
  const biomeChannels = biomeBytes.length / plane
  if (!Number.isInteger(splatChannels) || splatChannels > SPLAT_NAMES.length) {
    throw new Error(`map: splat layer has ${splatChannels} channels`)
  }
  if (!Number.isInteger(biomeChannels) || biomeChannels > BIOME_NAMES.length) {
    throw new Error(`map: biome layer has ${biomeChannels} channels`)
  }

  const size = world.size
  const half = size / 2

  /** World metres -> 0..1 across the map square. */
  const norm = (v: number): number => (v + half) / size

  function bilinear(arr: Uint16Array, res: number, x: number, z: number): number {
    const u = Math.min(1, Math.max(0, norm(x))) * (res - 1)
    const v = Math.min(1, Math.max(0, norm(z))) * (res - 1)
    const i0 = Math.floor(u)
    const j0 = Math.floor(v)
    const i1 = Math.min(i0 + 1, res - 1)
    const j1 = Math.min(j0 + 1, res - 1)
    const fu = u - i0
    const fv = v - j0
    const a = arr[j0 * res + i0]
    const b = arr[j0 * res + i1]
    const c = arr[j1 * res + i0]
    const e = arr[j1 * res + i1]
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + e * fu) * fv
  }

  /** Nearest texel on a ground layer — these are categorical, so no blending. */
  function groundIndex(x: number, z: number): number {
    const i = Math.min(groundRes - 1, Math.max(0, Math.round(norm(x) * (groundRes - 1))))
    const j = Math.min(groundRes - 1, Math.max(0, Math.round(norm(z) * (groundRes - 1))))
    return j * groundRes + i
  }

  function dominant(arr: Uint8Array, channels: number, idx: number): number {
    let best = -1
    let bestV = 0
    for (let c = 0; c < channels; c++) {
      const v = arr[c * plane + idx]
      if (v > bestV) { bestV = v; best = c }
    }
    return best
  }

  const heightAt = (x: number, z: number): number =>
    rawHeightToMetres(bilinear(heights, heightRes, x, z))

  const waterAt = (x: number, z: number): number | null => {
    const raw = bilinear(waters, heightRes, x, z)
    return raw > 0 ? rawHeightToMetres(raw) : null
  }

  const topologyAt = (x: number, z: number): number => topos[groundIndex(x, z)]

  const biomeAt = (x: number, z: number): BiomeName | null => {
    const c = dominant(biomes, biomeChannels, groundIndex(x, z))
    return c < 0 ? null : BIOME_NAMES[c]
  }

  const splatAt = (x: number, z: number): SplatName | null => {
    const c = dominant(splats, splatChannels, groundIndex(x, z))
    return c < 0 ? null : SPLAT_NAMES[c]
  }

  /** Central differences over one heightmap texel. */
  const slopeDegreesAt = (x: number, z: number): number => {
    const step = size / (heightRes - 1)
    const dx = (heightAt(x + step, z) - heightAt(x - step, z)) / (2 * step)
    const dz = (heightAt(x, z + step) - heightAt(x, z - step)) / (2 * step)
    return (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI
  }

  /**
   * Could a base — or a shooter — be here?
   *
   * Rust refuses building placement in monuments and on roads, and nobody is
   * standing on the sea floor. Cliffs are excluded by the topology bit rather
   * than a slope threshold, because that bit is what the game itself used.
   */
  const buildableAt = (x: number, z: number): boolean => {
    const t = topologyAt(x, z)
    if (t & (TOPOLOGY.Ocean | TOPOLOGY.Offshore)) return false
    if (t & (TOPOLOGY.Monument | TOPOLOGY.Road | TOPOLOGY.Cliff)) return false
    const h = heightAt(x, z)
    if (h <= 0) return false
    const w = waterAt(x, z)
    return w === null || w <= h
  }

  let cached: { min: number; max: number } | null = null

  return {
    size,
    heightRes,
    groundRes,
    heightAt,
    waterAt,
    topologyAt,
    biomeAt,
    splatAt,
    slopeDegreesAt,
    buildableAt,
    sample: (x, z) => ({
      height: heightAt(x, z),
      water: waterAt(x, z),
      topology: topologyAt(x, z),
      biome: biomeAt(x, z),
      splat: splatAt(x, z),
    }),
    extent: () => {
      if (cached) return cached
      let lo = 65535
      let hi = 0
      for (let i = 0; i < heights.length; i++) {
        const v = heights[i]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      cached = { min: rawHeightToMetres(lo), max: rawHeightToMetres(hi) }
      return cached
    },
  }
}

/**
 * Downsample into the grid the localization solver sweeps.
 *
 * The solver works in normalised units, so heights come across as
 * metres/worldSize — which makes a vertical metre and a horizontal metre the
 * same number, and lets `heightScale` be exactly 1 instead of the fudge factor
 * the placeholder terrain needed.
 */
export function toSolverTerrain(
  t: Terrain, res = 128,
): {
  size: number
  height: number[][]
  buildable: boolean[][]
  heightScale: number
  eyeHeight: number
  losClearance: number
} {
  const height: number[][] = []
  const buildable: boolean[][] = []
  const half = t.size / 2
  for (let j = 0; j < res; j++) {
    const hr: number[] = []
    const br: boolean[] = []
    // Row 0 is NORTH, matching the normalised screen space the UI uses.
    const z = half - (j / (res - 1)) * t.size
    for (let i = 0; i < res; i++) {
      const x = (i / (res - 1)) * t.size - half
      hr.push(t.heightAt(x, z) / t.size)
      br.push(t.buildableAt(x, z))
    }
    height.push(hr)
    buildable.push(br)
  }
  return {
    size: res,
    height,
    buildable,
    heightScale: 1,
    // A standing player's eye is about 1.6 m up; half a metre of clearance
    // keeps a ray from being blocked by the texel it starts on.
    eyeHeight: 1.6 / t.size,
    losClearance: 0.5 / t.size,
  }
}

/** Normalised 0..1 point (y increasing south) for a world-metre x/z pair. */
export function worldXZToNorm(x: number, z: number, size: number): Vec2 {
  return { x: (x + size / 2) / size, y: (size / 2 - z) / size }
}
