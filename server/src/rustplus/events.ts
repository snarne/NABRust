// ---------------------------------------------------------------------------
// Server events from Rust+ map markers.
//
// Every paired player receives the same public marker set — cargo ship,
// patrol heli, Chinook, locked crates, explosions. Diffing successive polls
// turns that into events: something appeared, something left, the heli went
// down. This is the same data the in-game map shows everyone; NABRust just
// watches it continuously and remembers.
//
// State lives in the database, not in memory: an event is open while its
// marker is still on the map. Restarting the process mid-event reconciles
// against the open rows instead of announcing everything again.
// ---------------------------------------------------------------------------

import type { DB } from '../db/index.ts'
import { nowIso, tx } from '../db/index.ts'
import { normDistance, normToGrid, rustPlusToNorm } from '../../../shared/world.ts'
import type { Vec2 } from '../../../shared/types.ts'
import { displayMonument } from '../parsers/monumentNames.ts'
import { MARKER_TYPE, type AppMarker } from './messages.ts'

export type EventKind = 'cargo' | 'heli' | 'crate' | 'chinook' | 'explosion' | 'alarm'

/**
 * A hackable locked crate unlocks 15 minutes after hacking starts. The marker
 * appears when the crate spawns, not when someone starts the hack, so the ETA
 * is a lower bound — flagged with lower confidence rather than presented as
 * exact.
 */
export const CRATE_UNLOCK_SECONDS = 15 * 60

/** How recently an explosion must have appeared to explain a vanished heli. */
const HELI_CRASH_WINDOW_MS = 90_000
const HELI_CRASH_RADIUS_M = 350

const KIND_BY_MARKER: Record<number, EventKind | undefined> = {
  [MARKER_TYPE.CargoShip]: 'cargo',
  [MARKER_TYPE.PatrolHelicopter]: 'heli',
  [MARKER_TYPE.CH47]: 'chinook',
  [MARKER_TYPE.Crate]: 'crate',
  [MARKER_TYPE.Explosion]: 'explosion',
}

export interface TrackedEvent {
  id: number
  kind: EventKind
  label: string
  pos: Vec2
  grid: string
}

export interface MarkerDiff {
  started: TrackedEvent[]
  ended: TrackedEvent[]
}

interface OpenRow {
  id: number
  kind: EventKind
  marker_id: number
  x: number
  y: number
  label: string
}

function nearestMonument(
  db: DB, wipeId: number, p: Vec2, worldSize: number,
): { name: string; kind: string; metres: number } | null {
  const rows = db.prepare(`SELECT name, kind, x, y, prefab_id FROM monuments WHERE wipe_id = ?`)
    .all(wipeId) as { name: string; kind: string; x: number; y: number; prefab_id: number | null }[]
  let best: { name: string; kind: string; metres: number } | null = null
  for (const r of rows) {
    const m = normDistance(p, { x: r.x, y: r.y }, worldSize)
    if (!best || m < best.metres) best = { name: displayMonument(r.name, r.prefab_id).name, kind: r.kind, metres: m }
  }
  return best
}

/** Where a crate is, in words: named monument if Rust+ gave us one, else grid. */
function crateLabel(db: DB, wipeId: number, p: Vec2, worldSize: number, grid: string): string {
  const near = nearestMonument(db, wipeId, p, worldSize)
  if (near && near.metres < 250) {
    if (near.kind === 'offshore') return `Locked crate · oil rig (${grid})`
    // A real name when the prefab is known, else its measured size — both
    // more useful than a bare grid.
    return `Locked crate · ${near.name} (${grid})`
  }
  return `Locked crate · ${grid}`
}

function startLabel(kind: EventKind, grid: string): string {
  switch (kind) {
    case 'cargo': return `Cargo Ship on the map (${grid})`
    case 'heli': return `Patrol Heli active (${grid})`
    case 'chinook': return `Chinook inbound (${grid})`
    case 'explosion': return `Explosion at ${grid}`
    case 'crate': return `Locked crate · ${grid}`
    // Alarms come from paired devices, not markers, and carry their own label.
    case 'alarm': return `Alarm (${grid})`
  }
}

/**
 * Apply one marker poll. Returns what started and what ended since the last
 * poll so the caller can alert the team.
 */
export function trackMarkers(
  db: DB,
  opts: { wipeId: number; worldSize: number; markers: AppMarker[]; at?: string },
): MarkerDiff {
  const at = opts.at ?? nowIso()
  const now = Date.parse(at)
  const { wipeId, worldSize } = opts
  const out: MarkerDiff = { started: [], ended: [] }

  const live = new Map<number, AppMarker>()
  for (const m of opts.markers) if (KIND_BY_MARKER[m.type]) live.set(m.id, m)

  return tx(db, () => {
    const open = db.prepare(
      `SELECT id, kind, marker_id, x, y, label FROM game_events
        WHERE wipe_id = ? AND ended_at IS NULL AND marker_id IS NOT NULL`,
    ).all(wipeId) as unknown as OpenRow[]
    const openByMarker = new Map(open.map((r) => [r.marker_id, r]))

    // --- new markers -> events started ---
    for (const m of live.values()) {
      const existing = openByMarker.get(m.id)
      const pos = rustPlusToNorm({ x: m.x, y: m.y }, worldSize)
      const grid = normToGrid(pos, worldSize)
      if (existing) {
        // Still here — keep the position current so the map follows it.
        db.prepare(`UPDATE game_events SET x = ?, y = ? WHERE id = ?`).run(pos.x, pos.y, existing.id)
        continue
      }
      const kind = KIND_BY_MARKER[m.type] as EventKind
      const label = kind === 'crate' ? crateLabel(db, wipeId, pos, worldSize, grid) : startLabel(kind, grid)
      const eta = kind === 'crate' ? new Date(now + CRATE_UNLOCK_SECONDS * 1000).toISOString() : null
      const confidence = kind === 'crate' ? 0.6 : 1
      const r = db.prepare(
        `INSERT INTO game_events (wipe_id, kind, observed_at, eta_at, confidence, source,
                                  label, marker_id, x, y)
         VALUES (?, ?, ?, ?, ?, 'observed', ?, ?, ?, ?)`,
      ).run(wipeId, kind, at, eta, confidence, label, m.id, pos.x, pos.y)
      out.started.push({ id: Number(r.lastInsertRowid), kind, label, pos, grid })
    }

    // --- vanished markers -> events ended ---
    for (const row of open) {
      if (live.has(row.marker_id)) continue
      const pos = { x: row.x, y: row.y }
      const grid = normToGrid(pos, worldSize)
      let label: string
      switch (row.kind) {
        case 'heli': {
          // A heli that vanishes next to a fresh explosion was shot down.
          const since = new Date(now - HELI_CRASH_WINDOW_MS).toISOString()
          const booms = db.prepare(
            `SELECT x, y FROM game_events
              WHERE wipe_id = ? AND kind = 'explosion' AND observed_at >= ?`,
          ).all(wipeId, since) as { x: number; y: number }[]
          const crash = booms.find((b) => normDistance(b, pos, worldSize) <= HELI_CRASH_RADIUS_M)
          label = crash
            ? `Patrol Heli downed (${normToGrid(crash, worldSize)})`
            : `Patrol Heli left the map`
          break
        }
        case 'cargo': label = 'Cargo Ship left the map'; break
        case 'chinook': label = 'Chinook left'; break
        case 'crate': label = `${row.label.replace(/^Locked crate/, 'Crate gone')}`; break
        default: label = row.label
      }
      db.prepare(`UPDATE game_events SET ended_at = ?, end_label = ? WHERE id = ?`)
        .run(at, label, row.id)
      out.ended.push({ id: row.id, kind: row.kind, label, pos, grid })
    }

    return out
  })
}


/**
 * A device event — a smart alarm going off. Unlike marker events these have
 * no position and no end: the alarm fires, and that is the whole story.
 */
export function recordDeviceEvent(
  db: DB,
  wipeId: number,
  ev: { kind: EventKind; label: string; markerId?: number },
  at = nowIso(),
): number {
  const r = db.prepare(
    `INSERT INTO game_events (wipe_id, kind, observed_at, confidence, source, label, marker_id, ended_at)
     VALUES (?, ?, ?, 1.0, 'rustplus-entity', ?, ?, ?)`,
  ).run(wipeId, ev.kind, at, ev.label, ev.markerId ?? null, at)
  return Number(r.lastInsertRowid)
}
