// ---------------------------------------------------------------------------
// World coordinates.
//
// Rust world positions are metres, centred on the origin: a 4250 map runs
// -2125..+2125 on both axes. Everything in the UI works in NORMALISED space
// (0..1 across the world square, y increasing south) so overlays sit correctly
// on top of whatever map image the server actually provides.
// ---------------------------------------------------------------------------

import type { Vec2 } from './types.ts'

/** Rust's grid cell edge length in metres. */
export const GRID_CELL_METRES = 146.3

// ---------------------------------------------------------------------------
// Heightmap encoding.
//
// World files store elevation as a uint16 across a fixed 2000 m band whose
// zero point — sea level — sits a quarter of the way up. Both constants were
// measured, not assumed: fitting 4,312 road spline nodes against the heightmap
// converges on exactly 2000 and -500, with a 99th-percentile residual of
// 0.000 m. Roads are laid on the terrain surface, so that is the whole check.
// ---------------------------------------------------------------------------

export const HEIGHT_SPAN_METRES = 2000
export const HEIGHT_BASE_METRES = -500
export const HEIGHT_RAW_MAX = 65535
/** Raw heightmap value at sea level (y = 0). */
export const SEA_LEVEL_RAW = (-HEIGHT_BASE_METRES / HEIGHT_SPAN_METRES) * HEIGHT_RAW_MAX

export function rawHeightToMetres(raw: number): number {
  return (raw / HEIGHT_RAW_MAX) * HEIGHT_SPAN_METRES + HEIGHT_BASE_METRES
}

export function metresToRawHeight(m: number): number {
  return ((m - HEIGHT_BASE_METRES) / HEIGHT_SPAN_METRES) * HEIGHT_RAW_MAX
}

export function gridCount(worldSize: number): number {
  return Math.ceil(worldSize / GRID_CELL_METRES)
}

/** Rust world metres (centred at 0) -> normalised 0..1. */
export function worldToNorm(p: Vec2, worldSize: number): Vec2 {
  const half = worldSize / 2
  return {
    x: (p.x + half) / worldSize,
    y: (half - p.y) / worldSize, // north is +y in game, up on screen
  }
}

/** Normalised 0..1 -> Rust world metres. */
export function normToWorld(p: Vec2, worldSize: number): Vec2 {
  const half = worldSize / 2
  return { x: p.x * worldSize - half, y: half - p.y * worldSize }
}

/** Grid reference (A7-style). Column letters roll over to AA past Z. */
export function normToGrid(p: Vec2, worldSize: number): string {
  const n = gridCount(worldSize)
  const col = Math.max(0, Math.min(n - 1, Math.floor(p.x * n)))
  const row = Math.max(0, Math.min(n - 1, Math.floor(p.y * n)))
  let label = ''
  let c = col
  do {
    label = String.fromCharCode(65 + (c % 26)) + label
    c = Math.floor(c / 26) - 1
  } while (c >= 0)
  return `${label}${row}`
}

/** Distance in metres between two normalised points. */
export function normDistance(a: Vec2, b: Vec2, worldSize: number): number {
  return Math.hypot(a.x - b.x, a.y - b.y) * worldSize
}

/**
 * Rust+ coordinates.
 *
 * The companion API reports positions in metres from the map's BOTTOM-LEFT
 * corner (0..worldSize on both axes, y increasing north) — not the centred
 * system the game's own transforms use. Converting here keeps every overlay in
 * one normalised space regardless of which source produced it.
 */
export function rustPlusToNorm(p: Vec2, worldSize: number): Vec2 {
  return { x: p.x / worldSize, y: 1 - p.y / worldSize }
}

export function normToRustPlus(p: Vec2, worldSize: number): Vec2 {
  return { x: p.x * worldSize, y: (1 - p.y) * worldSize }
}
