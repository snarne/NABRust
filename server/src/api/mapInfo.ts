// ---------------------------------------------------------------------------
// Database rows -> the shapes the web app renders.
//
// The UI was built against shared/types.ts before any of this data existed, so
// this is the seam: every field here is either computed from something we
// actually collected or left explicitly empty/unknown. Nothing is filled in to
// make a screen look finished — an empty panel says "no data yet", a made-up
// one says something false.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, statSync } from 'node:fs'
import type { DB } from '../db/index.ts'
import { currentWipe } from '../retention.ts'
import { getServerState } from '../db/index.ts'
import { teamLimit } from '../pairs.ts'
import { lastPoll, POLL_GAP_MS } from '../collectors/battlemetrics.ts'
import { readWorldFile } from '../parsers/worldfile.ts'
import { openTerrain, toSolverTerrain } from '../parsers/terrain.ts'
import { displayMonument } from '../parsers/monumentNames.ts'
import type { Monument, MonumentKind, ServerRecord } from '../../../shared/types.ts'

interface ServerRow {
  id: string
  name: string
  seed: number | null
  world_size: number | null
  max_pop: number | null
  rustplus_paired: number
  map_image_path: string | null
  map_world_path: string | null
  map_source: string | null
  map_parsed_at: string | null
  last_seed_change: string | null
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

const MONUMENT_KINDS: ReadonlySet<string> = new Set<MonumentKind>([
  'tier3', 'safezone', 'water', 'small', 'large', 'medium', 'offshore',
])

/** Concurrent players at each of the last `hours` hour marks, oldest first. */
function populationCurve(db: DB, serverId: string, now: number, openEnd: number, hours = 24): number[] {
  const from = new Date(now - (hours - 1) * HOUR).toISOString()
  const rows = db.prepare(
    `SELECT joined_at, left_at FROM sessions
      WHERE server_id = ? AND (left_at IS NULL OR left_at >= ?)`,
  ).all(serverId, from) as { joined_at: string; left_at: string | null }[]

  const spans = rows.map((r) => [
    Date.parse(r.joined_at),
    r.left_at ? Date.parse(r.left_at) : openEnd,
  ])
  const out: number[] = []
  for (let h = hours - 1; h >= 0; h--) {
    const t = now - h * HOUR
    let n = 0
    for (const [a, b] of spans) if (a <= t && b > t) n++
    out.push(n)
  }
  return out
}

/**
 * The map image URL the browser should load, or null when there is no image
 * worth showing. Battlemetrics' 250x250 thumbnail is deliberately excluded:
 * stretched over the full canvas it would misplace every overlay by up to a
 * grid square while looking like the real thing.
 */
function mapUrl(row: ServerRow, want: 'parsed' | 'rustplus'): string | null {
  if (row.map_source !== want || !row.map_image_path) return null
  if (!existsSync(row.map_image_path)) return null
  const v = encodeURIComponent(row.map_parsed_at ?? '')
  return `/api/map/${encodeURIComponent(row.id)}?v=${v}`
}

export function monumentsFor(db: DB, wipeId: number | null, worldSize: number): Monument[] {
  if (wipeId === null) return []
  const rows = db.prepare(
    `SELECT name, kind, x, y, prefab_id, height, radius FROM monuments WHERE wipe_id = ?
      ORDER BY radius DESC`,
  ).all(wipeId) as {
    name: string; kind: string; x: number; y: number
    prefab_id: number | null; height: number | null; radius: number | null
  }[]
  return rows.map((r) => ({
    ...displayMonument(r.name, r.prefab_id),
    pos: { x: r.x, y: r.y },
    kind: (MONUMENT_KINDS.has(r.kind) ? r.kind : 'small') as MonumentKind,
    ...(r.radius !== null && worldSize > 0 ? { radius: r.radius / worldSize } : {}),
    ...(r.prefab_id !== null ? { prefabId: r.prefab_id } : {}),
    ...(r.height !== null ? { height: r.height } : {}),
  }))
}

export function serverRecord(db: DB, serverId: string, now = Date.now()): ServerRecord | null {
  const row = db.prepare(`SELECT * FROM servers WHERE id = ?`).get(serverId) as ServerRow | undefined
  if (!row) return null

  const wipe = currentWipe(db, serverId)
  const worldSize = row.world_size ?? wipe?.worldSize ?? 0
  // Open sessions only mean "online" while the collector is actually polling.
  const poll = lastPoll(db, serverId)
  const fresh = !!poll && now - Date.parse(poll.at) <= POLL_GAP_MS
  const openEnd = fresh || !poll ? now + 1 : Date.parse(poll.at)
  const curve = populationCurve(db, serverId, now, openEnd)
  const open = fresh || !poll
    ? db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE server_id = ? AND left_at IS NULL`)
      .get(serverId) as { n: number }
    // Collector stopped: the last count it saw, flagged stale by the UI.
    : { n: poll.online }

  // The seed change is the real wipe moment; our wipe row only records when
  // NABRust first saw the server, which can be days later.
  const wipeStarts = [row.last_seed_change, wipe?.startedAt]
    .filter((s): s is string => !!s)
    .map((s) => Date.parse(s))
    .filter((t) => Number.isFinite(t) && t <= now)
  const wipeStart = wipeStarts.length ? Math.min(...wipeStarts) : null

  const terrainAvailable = !!row.map_world_path && existsSync(row.map_world_path)

  return {
    id: row.id,
    name: row.name,
    pop: open.n,
    // Never 0: the UI divides by it.
    maxPop: Math.max(1, row.max_pop ?? 0, ...curve),
    wipeDay: wipeStart === null ? 0 : Math.floor((now - wipeStart) / DAY) + 1,
    heat: 'unknown',
    ...(getServerState(db, serverId, 'simulated') ? { simulated: true } : {}),
    teamLimit: teamLimit(db, serverId),
    seed: row.seed,
    worldSize,
    populationCurve: curve,
    map: {
      rustPlusImageUrl: mapUrl(row, 'rustplus'),
      parsedRenderUrl: mapUrl(row, 'parsed'),
      terrainAvailable,
      pairedWithRustPlus: row.rustplus_paired === 1,
      monuments: monumentsFor(db, wipe?.id ?? null, worldSize),
      // Not computed yet. Ore nodes spawn at runtime, so the world file alone
      // can't place them; showing blobs here would be invention.
      oreDensity: [],
      parsedAt: row.map_parsed_at,
    },
  }
}

export function serverRecords(db: DB): ServerRecord[] {
  const ids = db.prepare(`SELECT id FROM servers ORDER BY name`).all() as { id: string }[]
  return ids.map((r) => serverRecord(db, r.id)).filter((r): r is ServerRecord => r !== null)
}

// --- solver terrain --------------------------------------------------------

/**
 * Compact wire form of the solver grid. Heights in metres to 0.1 m, buildable
 * as a 0/1 string — a 128² grid is ~110 KB instead of ~700 KB of JSON floats.
 */
export interface TerrainPayload {
  worldSize: number
  res: number
  /** Row-major, row 0 = north, metres. */
  heights: number[]
  buildable: string
  eyeMetres: number
  clearanceMetres: number
}

const terrainCache = new Map<string, TerrainPayload>()

/**
 * Downsample the parsed heightmap for the browser-side shooter solver.
 *
 * Parsing the world file takes a second or two and blocks the event loop while
 * it does, so the result is cached per (file, mtime, resolution): the first
 * request after a wipe pays, every later one is a map lookup.
 */
export function terrainFor(db: DB, serverId: string, res: number): TerrainPayload | null {
  const row = db.prepare(`SELECT map_world_path FROM servers WHERE id = ?`).get(serverId) as
    { map_world_path: string | null } | undefined
  const path = row?.map_world_path
  if (!path || !existsSync(path)) return null

  const key = `${path}:${statSync(path).mtimeMs}:${res}`
  const hit = terrainCache.get(key)
  if (hit) return hit

  const world = readWorldFile(readFileSync(path))
  const solver = toSolverTerrain(openTerrain(world), res)
  const heights: number[] = []
  let buildable = ''
  for (let j = 0; j < solver.size; j++) {
    for (let i = 0; i < solver.size; i++) {
      heights.push(Math.round(solver.height[j][i] * world.size * 10) / 10)
      buildable += solver.buildable[j][i] ? '1' : '0'
    }
  }
  const payload: TerrainPayload = {
    worldSize: world.size,
    res: solver.size,
    heights,
    buildable,
    eyeMetres: solver.eyeHeight * world.size,
    clearanceMetres: solver.losClearance * world.size,
  }
  // One entry per server is plenty; drop stale wipes.
  for (const k of terrainCache.keys()) if (k.startsWith(`${path}:`)) terrainCache.delete(k)
  terrainCache.set(key, payload)
  return payload
}
