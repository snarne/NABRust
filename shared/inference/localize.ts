// ---------------------------------------------------------------------------
// Shooter localization (the "death retracer").
//
// The combat log gives the RANGE to each attacker; Rust+ gives our own
// position. One hit therefore constrains the shooter to a ring. Several hits
// from different positions intersect; terrain masking and line-of-sight
// remove most of what geometry leaves over.
//
// This is after-action forensics only. It reconstructs where shots that
// ALREADY hit us came from. It never reveals a live position.
// ---------------------------------------------------------------------------

import type { RangeFix, Localization, Vec2 } from '../types.ts'

export interface Terrain {
  size: number // grid resolution
  /** height[y][x]. Row 0 is north. Units are whatever `heightScale` converts. */
  height: number[][]
  /** false where a base/shooter cannot be (water, cliff, no-build) */
  buildable: boolean[][]
  /**
   * Multiplier taking a `height` value into the same units as horizontal
   * normalised distance. Real terrain stores metres/worldSize and so passes 1;
   * the synthetic placeholder has no true vertical scale and keeps the 0.25
   * that was tuned against it.
   */
  heightScale?: number
  /** Eye/muzzle height above ground, in `height` units. */
  eyeHeight?: number
  /** Clearance a sightline needs, in `height` units. */
  losClearance?: number
}

const DEFAULT_HEIGHT_SCALE = 0.25
const DEFAULT_EYE = 0.02
const DEFAULT_CLEARANCE = 0.015

/** Cheap deterministic terrain so the UI has something to reason about. */
export function syntheticTerrain(size = 64, seed = 1994823): Terrain {
  let s = seed
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296)
  const height: number[][] = []
  const buildable: boolean[][] = []
  const base: number[][] = []
  for (let y = 0; y < size; y++) {
    base.push(Array.from({ length: size }, () => rnd()))
  }
  // box blur a few times for smooth ridges
  let cur = base
  for (let pass = 0; pass < 3; pass++) {
    const next: number[][] = []
    for (let y = 0; y < size; y++) {
      next.push([])
      for (let x = 0; x < size; x++) {
        let sum = 0, n = 0
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx
            if (yy < 0 || xx < 0 || yy >= size || xx >= size) continue
            sum += cur[yy][xx]; n++
          }
        next[y][x] = sum / n
      }
    }
    cur = next
  }
  for (let y = 0; y < size; y++) {
    height.push([])
    buildable.push([])
    for (let x = 0; x < size; x++) {
      const cx = (x / size - 0.5) * 2
      const cy = (y / size - 0.5) * 2
      const island = Math.max(0, 1 - Math.sqrt(cx * cx + cy * cy) * 1.15)
      const h = cur[y][x] * 0.55 + island * 0.75
      height[y][x] = Math.min(1, h)
      buildable[y][x] = h > 0.28 && h < 0.92
    }
  }
  return { size, height, buildable }
}

/**
 * Bilinear height. Nearest-cell sampling on a ~30 m grid turns every slope
 * into a staircase, and a staircase blocks sightlines the real hill doesn't.
 */
function sampleHeight(t: Terrain, p: Vec2): number {
  const u = Math.max(0, Math.min(1, p.x)) * (t.size - 1)
  const v = Math.max(0, Math.min(1, p.y)) * (t.size - 1)
  const x0 = Math.floor(u), y0 = Math.floor(v)
  const x1 = Math.min(x0 + 1, t.size - 1), y1 = Math.min(y0 + 1, t.size - 1)
  const fx = u - x0, fy = v - y0
  const top = t.height[y0][x0] * (1 - fx) + t.height[y0][x1] * fx
  const bot = t.height[y1][x0] * (1 - fx) + t.height[y1][x1] * fx
  return top * (1 - fy) + bot * fy
}

/**
 * Bresenham-ish ray march over the heightmap. A candidate with no sightline
 * to the victim could not have fired the shot.
 */
export function hasLineOfSight(t: Terrain, a: Vec2, b: Vec2, eye?: number): boolean {
  // Everything here is in `height` units, so the comparison is unaffected by
  // heightScale — only localizeShooter, which mixes vertical with horizontal,
  // needs that.
  const e = eye ?? t.eyeHeight ?? DEFAULT_EYE
  const clearance = t.losClearance ?? DEFAULT_CLEARANCE
  const steps = Math.ceil(t.size * Math.hypot(b.x - a.x, b.y - a.y)) || 1
  const ha = sampleHeight(t, a) + e
  const hb = sampleHeight(t, b) + e
  for (let i = 1; i < steps; i++) {
    const f = i / steps
    const p = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
    const terrainH = sampleHeight(t, p)
    const rayH = ha + (hb - ha) * f
    if (terrainH > rayH + clearance) return false
  }
  return true
}

export interface LocalizeOptions {
  terrain: Terrain
  /** Map edge length in metres (Rust world size). */
  worldSize: number
  /**
   * Range noise in metres — desync and the combat log's rounding. Each fix's
   * own position error (RangeFix.errorMetres) is added to this in quadrature.
   */
  sigmaMetres?: number
  requireLineOfSight?: boolean
  requireBuildable?: boolean
  /**
   * Log-likelihood cost of a fix whose sightline the heightmap says is
   * blocked. Soft, not a veto: the solver's grid is ~30 m and the game's
   * terrain is 1 m, so "blocked" here is evidence, not proof. A veto threw
   * out true positions and returned confident wrong answers.
   */
  losPenalty?: number
}

/**
 * Grid-sweep the map and score every cell against all range measurements.
 * Elevation is not noise here: the logged distance is 3D, so the heightmap
 * turns the unknown Z into a constraint rather than a source of error.
 */
export function localizeShooter(
  fixes: RangeFix[],
  opts: LocalizeOptions,
): Localization {
  const { terrain: t, worldSize } = opts
  const sigma = (opts.sigmaMetres ?? 18) / worldSize
  const n = t.size
  const logs = new Float64Array(n * n).fill(-Infinity)
  let best: Vec2 = { x: 0.5, y: 0.5 }
  let bestScore = -Infinity

  for (let yi = 0; yi < n; yi++) {
    for (let xi = 0; xi < n; xi++) {
      const p = { x: xi / (n - 1), y: yi / (n - 1) }
      if (opts.requireBuildable !== false && !t.buildable[yi][xi]) continue

      let logL = 0
      for (const fix of fixes) {
        const dz = sampleHeight(t, p) - sampleHeight(t, fix.from)
        const planar = Math.hypot(p.x - fix.from.x, p.y - fix.from.y)
        // true 3D distance in normalised units
        const d3 = Math.hypot(planar, dz * (t.heightScale ?? DEFAULT_HEIGHT_SCALE))
        const expected = fix.distance / worldSize
        // Where the victim stood is itself uncertain (Rust+ reports every
        // ~15 s); that error adds to the range noise rather than being
        // papered over with a weight.
        const s = fix.errorMetres ? Math.hypot(sigma, fix.errorMetres / worldSize) : sigma
        const err = (d3 - expected) / s
        logL += -0.5 * err * err * fix.weight

        if (opts.requireLineOfSight !== false && !hasLineOfSight(t, fix.from, p)) {
          logL -= (opts.losPenalty ?? 3) * fix.weight
        }
      }
      logs[yi * n + xi] = logL
      if (logL > bestScore) { bestScore = logL; best = p }
    }
  }

  // Normalise relative to the best cell. exp(logL) directly underflows to 0
  // everywhere once there are a few fixes with metres of error each, which
  // would report a spread of 0 m around an arbitrary point.
  const field: number[] = new Array(n * n).fill(0)
  let total = 0
  if (Number.isFinite(bestScore)) {
    for (let i = 0; i < logs.length; i++) {
      const w = Number.isFinite(logs[i]) ? Math.exp(logs[i] - bestScore) : 0
      field[i] = w
      total += w
    }
  }

  let spread = 0
  if (total > 0) {
    for (let i = 0; i < field.length; i++) field[i] /= total
    for (let yi = 0; yi < n; yi++) {
      for (let xi = 0; xi < n; xi++) {
        const w = field[yi * n + xi]
        if (!w) continue
        const d = Math.hypot(xi / (n - 1) - best.x, yi / (n - 1) - best.y)
        spread += w * d * d
      }
    }
  }
  // Never claim more precision than the grid can resolve.
  const cellMetres = worldSize / Math.max(1, n - 1)
  return { best, sigma: Math.max(Math.sqrt(spread) * worldSize, cellMetres * 0.5), field }
}

/** Human-readable Rust grid reference (A0-style) for a normalised point. */
export function toGrid(p: Vec2, cells = 26): string {
  const col = Math.max(0, Math.min(cells - 1, Math.floor(p.x * cells)))
  const row = Math.max(0, Math.min(cells - 1, Math.floor(p.y * cells)))
  return `${String.fromCharCode(65 + col)}${row}`
}
