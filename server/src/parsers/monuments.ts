// ---------------------------------------------------------------------------
// Monument extraction.
//
// The world file marks every monument's position, but names them only by a
// StringPool id — an index into the game's asset manifest, not a hash of
// anything, so it cannot be resolved offline. Until that table is in hand we
// measure instead of guess: flood-filling the Monument topology bit outwards
// from each prefab gives a real footprint, and footprint separates Launch Site
// from a roadside gas station perfectly well.
//
// Calling one of these "Airfield" without evidence would be worse than
// labelling it "large monument, 480 m across" — the second is true, and it is
// what actually informs a decision about whether to go there.
// ---------------------------------------------------------------------------

import { TOPOLOGY } from './terrain.ts'
import { monumentName } from './monumentNames.ts'
import type { Terrain } from './terrain.ts'
import type { WorldFile } from './worldfile.ts'

export type MonumentSize = 'large' | 'medium' | 'small' | 'offshore'

export interface Monument {
  /** StringPool id. Same monument has the same id on every map. */
  prefabId: number
  /** World metres, game axes. */
  x: number
  z: number
  /** Ground elevation in metres. */
  height: number
  /** Radius of the equivalent circle over the monument's topology footprint. */
  radius: number
  areaSquareMetres: number
  size: MonumentSize
  /** Real name when the prefab is known (monumentNames.ts), else the measured size. */
  label: string
}

/** Area thresholds in m², chosen so the tiers land where Rust's own do. */
const LARGE_AREA = 120_000
const MEDIUM_AREA = 25_000

/**
 * Flood-fill the Monument topology region containing `x,z`.
 *
 * Bounded two ways: a texel budget, and a hard radius. Without the radius a
 * monument that happens to touch a road's Monument-flagged apron could walk
 * halfway across the map.
 */
function footprintArea(
  terrain: Terrain, x: number, z: number, maxRadiusMetres = 500,
): number {
  const res = terrain.groundRes
  const metresPerTexel = terrain.size / res
  const texelArea = metresPerTexel * metresPerTexel
  const budget = Math.min(400_000, Math.ceil((maxRadiusMetres * 2 / metresPerTexel) ** 2))

  const half = terrain.size / 2
  const toI = (wx: number) => Math.round(((wx + half) / terrain.size) * (res - 1))
  const toJ = (wz: number) => Math.round(((wz + half) / terrain.size) * (res - 1))
  const toX = (i: number) => (i / (res - 1)) * terrain.size - half
  const toZ = (j: number) => (j / (res - 1)) * terrain.size - half

  // A prefab's origin is not guaranteed to land on a flagged texel — six of
  // this map's eighty sit just outside their own footprint. Snap to the
  // nearest flagged texel before filling, or the monument measures zero.
  let startI = toI(x)
  let startJ = toJ(z)
  if (startI < 0 || startJ < 0 || startI >= res || startJ >= res) return 0
  if (!(terrain.topologyAt(toX(startI), toZ(startJ)) & TOPOLOGY.Monument)) {
    const snapTexels = Math.ceil(60 / metresPerTexel)
    let found = false
    for (let r = 1; r <= snapTexels && !found; r++) {
      for (let dj = -r; dj <= r && !found; dj++) {
        for (let di = -r; di <= r && !found; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
          const ni = startI + di
          const nj = startJ + dj
          if (ni < 0 || nj < 0 || ni >= res || nj >= res) continue
          if (terrain.topologyAt(toX(ni), toZ(nj)) & TOPOLOGY.Monument) {
            startI = ni
            startJ = nj
            found = true
          }
        }
      }
    }
    if (!found) return 0
  }

  const seen = new Set<number>()
  const queue: number[] = [startJ * res + startI]
  seen.add(queue[0])
  let count = 0

  while (queue.length && count < budget) {
    const cur = queue.pop() as number
    const j = Math.floor(cur / res)
    const i = cur - j * res
    if (!(terrain.topologyAt(toX(i), toZ(j)) & TOPOLOGY.Monument)) continue
    if (Math.hypot(toX(i) - x, toZ(j) - z) > maxRadiusMetres) continue
    count++
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di
      const nj = j + dj
      if (ni < 0 || nj < 0 || ni >= res || nj >= res) continue
      const key = nj * res + ni
      if (seen.has(key)) continue
      seen.add(key)
      queue.push(key)
    }
  }
  return count * texelArea
}

function classify(area: number, offshore: boolean): MonumentSize {
  if (offshore) return 'offshore'
  if (area >= LARGE_AREA) return 'large'
  if (area >= MEDIUM_AREA) return 'medium'
  return 'small'
}

export function extractMonuments(world: WorldFile, terrain: Terrain): Monument[] {
  const half = world.size / 2
  const out: Monument[] = []

  for (const p of world.prefabs) {
    if (p.category !== 'Monument') continue
    // Oil rigs sit outside the terrain square entirely — there is no heightmap
    // under them, so measuring a footprint is meaningless.
    const offshore = Math.abs(p.position.x) > half || Math.abs(p.position.z) > half
    const area = offshore ? 0 : footprintArea(terrain, p.position.x, p.position.z)
    const size = classify(area, offshore)
    const radius = Math.sqrt(area / Math.PI)

    out.push({
      prefabId: p.id,
      x: p.position.x,
      z: p.position.z,
      height: offshore ? p.position.y : terrain.heightAt(p.position.x, p.position.z),
      radius,
      areaSquareMetres: area,
      size,
      // A known prefab gets its real name. Otherwise the measured size — and
      // no footprint means the measurement failed, not that it is tiny.
      label: monumentName(p.id)
        ?? (offshore ? 'offshore monument' : area > 0 ? `${size} monument` : 'monument'),
    })
  }

  out.sort((a, b) => b.areaSquareMetres - a.areaSquareMetres)
  return out
}
