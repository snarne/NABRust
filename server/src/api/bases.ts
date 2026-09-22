// ---------------------------------------------------------------------------
// Bases the team marks by hand.
//
// Inference will one day place bases from encounter density, but the most
// reliable source is still a teammate who saw one: "stone 2x2, three turrets,
// garage door on the loot room". This is where those land, scoped to the
// current wipe, with every change kept as an observation so the base library
// can say how recently anyone actually looked.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import type { DB } from '../db/index.ts'
import { nowIso, tx } from '../db/index.ts'
import { currentWipe } from '../retention.ts'
import { normToGrid } from '../../../shared/world.ts'
import type { RaidPath } from '../../../shared/types.ts'

const STATUS = new Set(['confirmed', 'inferred', 'weak'])
const TIERS = new Set(['wood', 'stone', 'metal', 'armored'])
const WALLS = new Set(['wood', 'stone', 'metal', 'armored'])
const DOORS = new Set(['wood', 'sheet', 'garage', 'armored'])
const OBSERVATIONS = new Set(['sighting', 'map-note', 'raided', 'destroyed', 'turret-fire'])

export class BaseInputError extends Error {}

export interface BaseInput {
  x?: number
  y?: number
  status?: string
  tier?: string | null
  turrets?: number
  ownerSteamId?: string | null
  ownerClanId?: string | null
  ours?: boolean
  note?: string | null
  raidPath?: RaidPath | null
  reportedBy?: string | null
  /** Record what was seen, and bump the base's last-evidence time. */
  observation?: { kind: string; note?: string | null }
}

function checkRaidPath(p: unknown): RaidPath | null {
  if (p === null || p === undefined) return null
  if (typeof p !== 'object') throw new BaseInputError('raidPath must be an object')
  const r = p as { walls?: Record<string, unknown>; doors?: Record<string, unknown> }
  const clean = (m: Record<string, unknown> | undefined, allowed: Set<string>, what: string) => {
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(m ?? {})) {
      if (!allowed.has(k)) throw new BaseInputError(`unknown ${what} "${k}"`)
      const n = Number(v)
      if (!Number.isInteger(n) || n < 0 || n > 50) throw new BaseInputError(`${what} count for ${k} must be 0-50`)
      if (n > 0) out[k] = n
    }
    return out
  }
  const walls = clean(r.walls, WALLS, 'wall')
  const doors = clean(r.doors, DOORS, 'door')
  // Nothing recorded is "no path", not a free raid.
  return Object.keys(walls).length || Object.keys(doors).length ? { walls, doors } : null
}

function validate(b: BaseInput, creating: boolean): void {
  for (const k of ['x', 'y'] as const) {
    if (b[k] === undefined) { if (creating) throw new BaseInputError(`${k} is required`); continue }
    if (typeof b[k] !== 'number' || !Number.isFinite(b[k]) || b[k]! < 0 || b[k]! > 1) {
      throw new BaseInputError(`${k} must be a normalised 0..1 map position`)
    }
  }
  if (b.status !== undefined && !STATUS.has(b.status)) throw new BaseInputError('status must be confirmed, inferred or weak')
  if (b.tier !== undefined && b.tier !== null && !TIERS.has(b.tier)) throw new BaseInputError('tier must be wood, stone, metal or armored')
  if (b.turrets !== undefined && (!Number.isInteger(b.turrets) || b.turrets < 0 || b.turrets > 99)) {
    throw new BaseInputError('turrets must be a whole number 0-99')
  }
  if (b.note !== undefined && b.note !== null && (typeof b.note !== 'string' || b.note.length > 500)) {
    throw new BaseInputError('note must be text under 500 characters')
  }
  if (b.observation && !OBSERVATIONS.has(b.observation.kind)) throw new BaseInputError('unknown observation kind')
}

export function createBase(db: DB, serverId: string, b: BaseInput, now = nowIso()): string {
  validate(b, true)
  const wipe = currentWipe(db, serverId)
  if (!wipe) throw new BaseInputError('no open wipe for this server')
  const size = (db.prepare(`SELECT world_size FROM servers WHERE id = ?`).get(serverId) as { world_size: number | null } | undefined)?.world_size ?? 4250
  const id = randomUUID()
  const raid = checkRaidPath(b.raidPath)
  tx(db, () => {
    if (b.ours) db.prepare(`UPDATE bases SET ours = 0 WHERE wipe_id = ?`).run(wipe.id)
    db.prepare(
      `INSERT INTO bases (id, wipe_id, owner_steam_id, owner_clan_id, x, y, grid, status, layout_confidence,
                          turrets, tier, last_evidence_at, reported_by, created_at, ours, raid_path, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, wipe.id, b.ownerSteamId ?? null, b.ownerClanId ?? null, b.x!, b.y!,
      normToGrid({ x: b.x!, y: b.y! }, size), b.status ?? 'confirmed', b.turrets ?? 0, b.tier ?? null,
      now, b.reportedBy ?? null, now, b.ours ? 1 : 0, raid ? JSON.stringify(raid) : null, b.note ?? null,
    )
    db.prepare(`INSERT INTO base_observations (base_id, kind, at, reporter, note) VALUES (?, ?, ?, ?, ?)`)
      .run(id, b.observation?.kind ?? 'sighting', now, b.reportedBy ?? null, b.observation?.note ?? b.note ?? null)
  })
  return id
}

export function updateBase(db: DB, serverId: string, id: string, b: BaseInput, now = nowIso()): boolean {
  validate(b, false)
  const row = db.prepare(
    `SELECT b.id, b.wipe_id FROM bases b JOIN wipes w ON w.id = b.wipe_id WHERE b.id = ? AND w.server_id = ?`,
  ).get(id, serverId) as { id: string; wipe_id: number } | undefined
  if (!row) return false
  const size = (db.prepare(`SELECT world_size FROM servers WHERE id = ?`).get(serverId) as { world_size: number | null } | undefined)?.world_size ?? 4250

  const sets: string[] = []
  const vals: (string | number | null)[] = []
  const set = (col: string, v: string | number | null) => { sets.push(`${col} = ?`); vals.push(v) }
  if (b.x !== undefined) set('x', b.x)
  if (b.y !== undefined) set('y', b.y)
  if (b.x !== undefined || b.y !== undefined) {
    const cur = db.prepare(`SELECT x, y FROM bases WHERE id = ?`).get(id) as { x: number; y: number }
    set('grid', normToGrid({ x: b.x ?? cur.x, y: b.y ?? cur.y }, size))
  }
  if (b.status !== undefined) set('status', b.status)
  if (b.tier !== undefined) set('tier', b.tier)
  if (b.turrets !== undefined) set('turrets', b.turrets)
  if (b.ownerSteamId !== undefined) set('owner_steam_id', b.ownerSteamId)
  if (b.ownerClanId !== undefined) set('owner_clan_id', b.ownerClanId)
  if (b.ours !== undefined) set('ours', b.ours ? 1 : 0)
  if (b.note !== undefined) set('note', b.note)
  if (b.raidPath !== undefined) {
    const r = checkRaidPath(b.raidPath)
    set('raid_path', r ? JSON.stringify(r) : null)
  }
  if (b.observation) set('last_evidence_at', now)

  tx(db, () => {
    if (b.ours) db.prepare(`UPDATE bases SET ours = 0 WHERE wipe_id = ? AND id <> ?`).run(row.wipe_id, id)
    if (sets.length) db.prepare(`UPDATE bases SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
    if (b.observation) {
      db.prepare(`INSERT INTO base_observations (base_id, kind, at, reporter, note) VALUES (?, ?, ?, ?, ?)`)
        .run(id, b.observation.kind, now, b.reportedBy ?? null, b.observation.note ?? null)
    }
  })
  return true
}

export function deleteBase(db: DB, serverId: string, id: string): boolean {
  const r = db.prepare(
    `DELETE FROM bases WHERE id = ? AND wipe_id IN (SELECT id FROM wipes WHERE server_id = ?)`,
  ).run(id, serverId)
  return Number(r.changes) > 0
}
