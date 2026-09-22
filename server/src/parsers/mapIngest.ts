// ---------------------------------------------------------------------------
// World file -> database.
//
// One call takes the .map download and leaves the server in a state where the
// UI can drop placeholder mode: a real render on disk, monuments and terrain
// stats in the database, map_source flipped to 'parsed'.
//
// Monuments are scoped to the wipe because a new seed is a new world. The
// render is written per wipe for the same reason — keeping the old file around
// under a wipe-stamped name makes a mid-wipe seed change obvious instead of
// silently overwriting the map everyone is navigating by.
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DB } from '../db/index.ts'
import { nowIso, tx } from '../db/index.ts'
import { worldXZToNorm } from './terrain.ts'
import { openTerrain } from './terrain.ts'
import { extractMonuments } from './monuments.ts'
import { renderMap, summariseTerrain } from './mapRender.ts'
import { readWorldFile } from './worldfile.ts'
import type { Monument } from './monuments.ts'

export interface MapIngestResult {
  version: number
  worldSize: number
  prefabs: number
  monuments: Monument[]
  renderPath: string
  renderBytes: number
  terrain: ReturnType<typeof summariseTerrain>
  /**
   * The 8-byte header field read as a ms timestamp, when that gives a sane date.
   * It is NOT the wipe or seed-change time: on one live server it read Sept 2 while
   * Battlemetrics records the seed change on Sept 17. Informational only.
   */
  headerStamp: string | null
}

export interface MapIngestOptions {
  resolution?: number
  /** Skip the render — useful when only the monument data is wanted. */
  skipRender?: boolean
}

/**
 * The 8 bytes after the version read as a millisecond timestamp on every file
 * seen so far, but that is an observation rather than a documented field — and
 * it does not match the seed change — so it is never used for wipe detection,
 * and anything outside a sane window is discarded.
 */
function plausibleStamp(stamp: bigint): string | null {
  const ms = Number(stamp)
  if (!Number.isFinite(ms)) return null
  const year = new Date(ms).getUTCFullYear()
  if (year < 2013 || year > 2100) return null
  return new Date(ms).toISOString()
}

export function ingestWorldFile(
  db: DB,
  serverId: string,
  worldFilePath: string,
  renderPath: string,
  wipeId: number | null,
  opts: MapIngestOptions = {},
): MapIngestResult {
  const world = readWorldFile(readFileSync(worldFilePath))
  const terrain = openTerrain(world)
  const monuments = extractMonuments(world, terrain)
  const summary = summariseTerrain(terrain)

  let renderBytes = 0
  if (!opts.skipRender) {
    const r = renderMap(world, terrain, { resolution: opts.resolution ?? 2048 })
    mkdirSync(dirname(renderPath), { recursive: true })
    writeFileSync(renderPath, r.png)
    renderBytes = r.png.length
  }

  tx(db, () => {
    if (wipeId !== null) {
      db.prepare(`DELETE FROM monuments WHERE wipe_id = ?`).run(wipeId)
      const ins = db.prepare(
        `INSERT OR REPLACE INTO monuments
           (wipe_id, name, kind, x, y, prefab_id, height, radius)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const m of monuments) {
        const n = worldXZToNorm(m.x, m.z, world.size)
        ins.run(wipeId, m.label, m.size, n.x, n.y, m.prefabId, m.height, m.radius)
      }
      db.prepare(
        `UPDATE wipes SET world_size = COALESCE(world_size, ?) WHERE id = ?`,
      ).run(world.size, wipeId)
    }

    db.prepare(
      `UPDATE servers
          SET world_size = COALESCE(?, world_size),
              map_image_path = COALESCE(?, map_image_path),
              map_world_path = ?,
              map_source = 'parsed',
              map_parsed_at = ?
        WHERE id = ?`,
    ).run(world.size, opts.skipRender ? null : renderPath, worldFilePath, nowIso(), serverId)
  })

  return {
    version: world.version,
    worldSize: world.size,
    prefabs: world.prefabs.length,
    monuments,
    renderPath,
    renderBytes,
    terrain: summary,
    headerStamp: plausibleStamp(world.stamp),
  }
}
