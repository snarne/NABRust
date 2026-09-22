// ---------------------------------------------------------------------------
// Drawing the real map.
//
// This replaces the 250x250 thumbnail the server listing hands out with the
// actual world at whatever resolution we ask for, built from the same layers
// the game uses. It matters beyond looking right: overlays — death markers,
// localization heat, base guesses — are positioned in normalised space, so the
// image underneath has to be the true world square, not a picture of it that
// has been cropped or letterboxed somewhere along the way.
//
// Ground colour comes from the splat weights rather than the dominant channel,
// which keeps biome transitions smooth instead of banded. Relief comes from a
// hillshade of the heightmap; water and roads are drawn over the top.
// ---------------------------------------------------------------------------

import { rawHeightToMetres } from '../../../shared/world.ts'
import { encodePng } from './png.ts'
import { SPLAT_NAMES } from './terrain.ts'
import type { Terrain } from './terrain.ts'
import type { WorldFile } from './worldfile.ts'

type RGB = [number, number, number]

/** Indexed to match SPLAT_NAMES: Dirt, Snow, Sand, Rock, Grass, Forest, Stones, Gravel. */
const SPLAT_COLOURS: RGB[] = [
  [134, 110, 78],   // Dirt
  [242, 246, 250],  // Snow
  [223, 205, 152],  // Sand
  [124, 122, 118],  // Rock
  [126, 152, 84],   // Grass
  [74, 104, 58],    // Forest
  [150, 146, 136],  // Stones
  [163, 152, 130],  // Gravel
]

const OCEAN_DEEP: RGB = [14, 40, 74]
const OCEAN_SHALLOW: RGB = [46, 106, 154]
const FRESH_WATER: RGB = [58, 118, 162]
const ROAD_COLOUR: RGB = [196, 188, 170]
const RAIL_COLOUR: RGB = [112, 104, 96]

export interface RenderOptions {
  /** Output edge length in pixels. */
  resolution?: number
  /** Strength of the relief shading, 0 disables it. */
  hillshade?: number
  drawRoads?: boolean
}

export interface RenderResult {
  png: Buffer
  width: number
  height: number
}

function mix(a: RGB, b: RGB, f: number): RGB {
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ]
}

/**
 * Render the world to a square PNG, north up.
 *
 * Pixel (0,0) is the north-west corner of the world square, so normalised
 * overlay coordinates map straight onto it with no offset.
 */
export function renderMap(
  world: WorldFile, terrain: Terrain, opts: RenderOptions = {},
): RenderResult {
  const res = opts.resolution ?? 2048
  const shadeAmount = opts.hillshade ?? 0.45
  const size = world.size
  const half = size / 2

  const splatLayer = world.layers.get('splat')
  const waterLayer = world.layers.get('water')
  if (!splatLayer || !waterLayer) throw new Error('map: splat and water layers are required')

  const groundRes = terrain.groundRes
  const plane = groundRes * groundRes
  const splatChannels = splatLayer.data.length / plane
  const splat = splatLayer.data

  const px = new Uint8Array(res * res * 3)

  // Sun from the north-west, the convention every map reader expects.
  const sun = { x: -0.6, y: 0.6, z: 0.53 }
  const sunLen = Math.hypot(sun.x, sun.y, sun.z)
  const step = size / res

  for (let row = 0; row < res; row++) {
    // Row 0 is north, so z counts DOWN from +half.
    const z = half - ((row + 0.5) / res) * size
    for (let col = 0; col < res; col++) {
      const x = ((col + 0.5) / res) * size - half

      const height = terrain.heightAt(x, z)
      const water = terrain.waterAt(x, z)

      let colour: RGB
      if (height < 0) {
        // Ocean: shade by depth so the shelf reads against deep water.
        const t = Math.min(1, -height / 50)
        colour = mix(OCEAN_SHALLOW, OCEAN_DEEP, t)
      } else {
        // Blend the splat channels by weight.
        const gi =
          Math.min(groundRes - 1, Math.max(0, Math.round(((z + half) / size) * (groundRes - 1)))) * groundRes +
          Math.min(groundRes - 1, Math.max(0, Math.round(((x + half) / size) * (groundRes - 1))))
        let r = 0, g = 0, b = 0, total = 0
        for (let c = 0; c < splatChannels && c < SPLAT_COLOURS.length; c++) {
          const wgt = splat[c * plane + gi]
          if (!wgt) continue
          const col = SPLAT_COLOURS[c]
          r += col[0] * wgt; g += col[1] * wgt; b += col[2] * wgt
          total += wgt
        }
        colour = total > 0 ? [r / total, g / total, b / total] : [96, 108, 80]

        if (shadeAmount > 0) {
          // Surface normal from central differences, in metres.
          const dx = (terrain.heightAt(x + step, z) - terrain.heightAt(x - step, z)) / (2 * step)
          const dz = (terrain.heightAt(x, z + step) - terrain.heightAt(x, z - step)) / (2 * step)
          const nLen = Math.hypot(dx, dz, 1)
          const lambert = (-dx * sun.x + -dz * sun.y + 1 * sun.z) / (nLen * sunLen)
          const shade = 1 + (Math.max(0, Math.min(1, lambert)) - 0.62) * shadeAmount * 2
          colour = [colour[0] * shade, colour[1] * shade, colour[2] * shade]
        }

        // Rivers and lakes sit above sea level, so they come from the water
        // layer rather than the sign of the height.
        if (water !== null && water > height - 0.2) {
          const depth = Math.min(1, Math.max(0, (water - height) / 6))
          colour = mix(colour, FRESH_WATER, 0.35 + 0.6 * depth)
        }
      }

      const o = (row * res + col) * 3
      px[o] = Math.max(0, Math.min(255, Math.round(colour[0])))
      px[o + 1] = Math.max(0, Math.min(255, Math.round(colour[1])))
      px[o + 2] = Math.max(0, Math.min(255, Math.round(colour[2])))
    }
  }

  if (opts.drawRoads !== false) {
    for (const path of world.paths) {
      const colour = path.kind === 'Rail' ? RAIL_COLOUR : ROAD_COLOUR
      if (path.kind !== 'Road' && path.kind !== 'Rail') continue
      const widthPx = Math.max(1, ((path.width || 8) / size) * res)
      for (let i = 1; i < path.nodes.length; i++) {
        drawSegment(px, res, size, path.nodes[i - 1], path.nodes[i], colour, widthPx)
      }
    }
  }

  return { png: encodePng(px, res, res, 3), width: res, height: res }
}

/** World-metre line segment onto the pixel grid, with a soft edge. */
function drawSegment(
  px: Uint8Array, res: number, size: number,
  a: { x: number; z: number }, b: { x: number; z: number },
  colour: RGB, widthPx: number,
): void {
  const half = size / 2
  const toPx = (p: { x: number; z: number }) => ({
    u: ((p.x + half) / size) * res,
    v: ((half - p.z) / size) * res,
  })
  const p0 = toPx(a)
  const p1 = toPx(b)
  const dx = p1.u - p0.u
  const dy = p1.v - p0.v
  const len = Math.hypot(dx, dy)
  if (len === 0) return

  const r = widthPx / 2 + 0.75
  const minU = Math.max(0, Math.floor(Math.min(p0.u, p1.u) - r))
  const maxU = Math.min(res - 1, Math.ceil(Math.max(p0.u, p1.u) + r))
  const minV = Math.max(0, Math.floor(Math.min(p0.v, p1.v) - r))
  const maxV = Math.min(res - 1, Math.ceil(Math.max(p0.v, p1.v) + r))

  for (let v = minV; v <= maxV; v++) {
    for (let u = minU; u <= maxU; u++) {
      const cu = u + 0.5
      const cv = v + 0.5
      // Distance from the pixel centre to the segment.
      let t = ((cu - p0.u) * dx + (cv - p0.v) * dy) / (len * len)
      t = Math.max(0, Math.min(1, t))
      const d = Math.hypot(cu - (p0.u + dx * t), cv - (p0.v + dy * t))
      const alpha = Math.max(0, Math.min(1, (widthPx / 2 + 0.5 - d) / 1.0))
      if (alpha <= 0) continue
      const o = (v * res + u) * 3
      px[o] = px[o] + (colour[0] - px[o]) * alpha
      px[o + 1] = px[o + 1] + (colour[1] - px[o + 1]) * alpha
      px[o + 2] = px[o + 2] + (colour[2] - px[o + 2]) * alpha
    }
  }
}

/** Coarse ore-and-terrain summary worth keeping in the database per wipe. */
export function summariseTerrain(terrain: Terrain): {
  minHeight: number; maxHeight: number; landFraction: number; buildableFraction: number
} {
  const n = 256
  const half = terrain.size / 2
  let land = 0
  let buildable = 0
  for (let j = 0; j < n; j++) {
    const z = half - (j / (n - 1)) * terrain.size
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * terrain.size - half
      if (terrain.heightAt(x, z) > 0) land++
      if (terrain.buildableAt(x, z)) buildable++
    }
  }
  const ext = terrain.extent()
  return {
    minHeight: ext.min,
    maxHeight: ext.max,
    landFraction: land / (n * n),
    buildableFraction: buildable / (n * n),
  }
}

export { rawHeightToMetres }
