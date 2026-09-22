// ---------------------------------------------------------------------------
// Rust+ -> database.
//
// Everything here comes from Facepunch's own companion API: server info, the
// server's real map image, our own team's positions, and team chat. Nothing
// reads the game client.
//
// Note what is NOT here: positions of players outside our team. Rust+ does not
// expose them and we do not try to infer them live — enemy positions are only
// ever reconstructed after the fact from combat-log ranges.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DB } from '../db/index.ts'
import { nowIso, tx } from '../db/index.ts'
import { ensurePlayer, observeName } from '../identity.ts'
import { currentWipe, rolloverWipe } from '../retention.ts'
import { normToGrid, rustPlusToNorm } from '../../../shared/world.ts'
import type { AppInfo, AppMap, AppTeamInfo, MapNote, TeamMember } from './messages.ts'

/**
 * Apply server info. AppInfo.wipeTime is a unix timestamp of the last wipe,
 * which is a far better wipe signal than uptime heuristics — plus the seed is
 * authoritative here, so this is also where the map becomes loadable.
 */
export function syncServerInfo(
  db: DB,
  serverId: string,
  info: AppInfo,
  at = nowIso(),
): { wiped: boolean; reason?: string; wipeId: number } {
  db.prepare(
    `UPDATE servers SET name = ?, seed = ?, world_size = ?, max_pop = ?, rustplus_paired = 1
      WHERE id = ?`,
  ).run(info.name || serverId, info.seed || null, info.mapSize || null, info.maxPlayers || null, serverId)

  const cur = currentWipe(db, serverId)
  const wipeAt = info.wipeTime ? new Date(info.wipeTime * 1000).toISOString() : null

  let wiped = false
  let reason: string | undefined

  if (!cur) {
    wiped = true
    reason = 'no wipe on record'
  } else if (info.seed && cur.seed && info.seed !== cur.seed) {
    wiped = true
    reason = `seed changed ${cur.seed} -> ${info.seed}`
  } else if (wipeAt && Date.parse(wipeAt) > Date.parse(cur.startedAt) + 60_000) {
    wiped = true
    reason = `server reports a newer wipe at ${wipeAt}`
  }

  if (wiped) {
    const r = rolloverWipe(db, serverId, {
      seed: info.seed || null,
      worldSize: info.mapSize || null,
    }, wipeAt ?? at)
    return { wiped: true, reason, wipeId: r.opened }
  }

  // Keep seed/size on the open wipe in case they were unknown at creation.
  db.prepare(
    `UPDATE wipes SET seed = COALESCE(seed, ?), world_size = COALESCE(world_size, ?)
      WHERE id = ?`,
  ).run(info.seed || null, info.mapSize || null, cur!.id)

  return { wiped: false, wipeId: cur!.id }
}

/**
 * Save the server's real map image and its monuments. This is what flips the
 * UI out of placeholder mode — after this the map shown IS the server's map.
 */
export function syncMap(
  db: DB,
  serverId: string,
  map: AppMap,
  opts: { dataDir: string; worldSize: number; wipeId: number; at?: string },
): { imagePath: string; monuments: number } {
  const at = opts.at ?? nowIso()
  const imagePath = join(opts.dataDir, 'maps', `${serverId}-${opts.wipeId}.jpg`)
  mkdirSync(dirname(imagePath), { recursive: true })
  writeFileSync(imagePath, Buffer.from(map.jpgImage))

  return tx(db, () => {
    db.prepare(
      `UPDATE servers SET map_image_path = ?, map_source = 'rustplus', map_parsed_at = ?
        WHERE id = ?`,
    ).run(imagePath, at, serverId)

    // Rust+ bakes monument icons into the image, but the positions are useful
    // as data for base scoring and route planning.
    const stmt = db.prepare(
      `INSERT INTO monuments (wipe_id, name, kind, x, y) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    let n = 0
    for (const m of map.monuments) {
      const p = rustPlusToNorm({ x: m.x, y: m.y }, opts.worldSize)
      stmt.run(opts.wipeId, prettyMonument(m.token), monumentKind(m.token), p.x, p.y)
      n++
    }
    return { imagePath, monuments: n }
  })
}

const SAFE_ZONES = ['outpost', 'bandit', 'compound', 'stables', 'ranch']

function monumentKind(token: string): string {
  const t = token.toLowerCase()
  if (SAFE_ZONES.some((s) => t.includes(s))) return 'safezone'
  if (t.includes('harbor') || t.includes('oil') || t.includes('lighthouse')) return 'water'
  if (t.includes('cave') || t.includes('swamp') || t.includes('supermarket')) return 'small'
  return 'tier3'
}

function prettyMonument(token: string): string {
  return token
    .replace(/_?display_?name$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || token
}

export interface TeamSyncResult {
  positions: number
  deaths: { steamId: string; name: string; grid: string; x: number; y: number }[]
  notes: number
}

/**
 * Record our own team's positions and detect teammate deaths.
 *
 * Positions matter because the death retracer needs OUR position at the moment
 * each hit landed — that is what turns a logged range into a ring on the map.
 * Deaths are detected from the isAlive transition, so nobody has to report
 * anything by hand.
 */
export function syncTeam(
  db: DB,
  serverId: string,
  wipeId: number,
  team: AppTeamInfo,
  opts: { worldSize: number; at?: string },
): TeamSyncResult {
  const at = opts.at ?? nowIso()
  const out: TeamSyncResult = { positions: 0, deaths: [], notes: 0 }

  return tx(db, () => {
    for (const m of team.members) {
      if (!m.steamId || m.steamId === '0') continue
      ensurePlayer(db, m.steamId, at)
      if (m.name) observeName(db, m.steamId, m.name, 'battlemetrics', at)

      if (m.isOnline) {
        const p = rustPlusToNorm({ x: m.x, y: m.y }, opts.worldSize)
        db.prepare(
          `INSERT INTO position_samples (wipe_id, steam_id, t, x, y) VALUES (?, ?, ?, ?, ?)`,
        ).run(wipeId, m.steamId, at, p.x, p.y)
        out.positions++
      }

      // Latest known state per teammate, for the team panel. Position is only
      // overwritten while online, so an offline teammate stays where they
      // logged off instead of snapping to 0,0.
      const pNow = rustPlusToNorm({ x: m.x, y: m.y }, opts.worldSize)
      db.prepare(
        `INSERT INTO team_state (server_id, steam_id, name, x, y, alive, online, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(server_id, steam_id) DO UPDATE SET
           name = excluded.name,
           x = CASE WHEN excluded.online = 1 THEN excluded.x ELSE team_state.x END,
           y = CASE WHEN excluded.online = 1 THEN excluded.y ELSE team_state.y END,
           alive = excluded.alive, online = excluded.online, updated_at = excluded.updated_at`,
      ).run(serverId, m.steamId, m.name || null,
        m.isOnline ? pNow.x : null, m.isOnline ? pNow.y : null,
        m.isAlive ? 1 : 0, m.isOnline ? 1 : 0, at)

      if (wasAliveNowDead(db, wipeId, m)) {
        const p = rustPlusToNorm({ x: m.x, y: m.y }, opts.worldSize)
        out.deaths.push({
          steamId: m.steamId,
          name: m.name,
          grid: normToGrid(p, opts.worldSize),
          x: p.x, y: p.y,
        })
      }
      rememberAlive(db, wipeId, m, at)
    }

    out.notes += syncMapNotes(db, wipeId, [...team.mapNotes, ...team.leaderMapNotes], opts.worldSize, at)
    return out
  })
}

// Liveness is tracked in schema_meta so a restart doesn't replay old deaths.
function aliveKey(wipeId: number, steamId: string): string {
  return `alive:${wipeId}:${steamId}`
}

function wasAliveNowDead(db: DB, wipeId: number, m: TeamMember): boolean {
  const row = db
    .prepare(`SELECT value FROM schema_meta WHERE key = ?`)
    .get(aliveKey(wipeId, m.steamId)) as { value: string } | undefined
  return row?.value === '1' && !m.isAlive
}

function rememberAlive(db: DB, wipeId: number, m: TeamMember, at: string): void {
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(aliveKey(wipeId, m.steamId), m.isAlive ? '1' : '0')
}

/**
 * In-game map notes become base observations.
 *
 * This is the zero-friction path for marking an enemy base: your team already
 * drops markers on the in-game map while playing, and Rust+ exposes them. No
 * command to type, no alt-tab.
 */
export function syncMapNotes(
  db: DB,
  wipeId: number,
  notes: MapNote[],
  worldSize: number,
  at = nowIso(),
): number {
  let n = 0
  for (const note of notes) {
    if (!note.label) continue
    const p = rustPlusToNorm({ x: note.x, y: note.y }, worldSize)
    const grid = normToGrid(p, worldSize)
    const id = `note:${wipeId}:${grid}:${note.label.slice(0, 24)}`

    db.prepare(
      `INSERT INTO bases (id, wipe_id, x, y, grid, status, layout_confidence,
                          last_evidence_at, reported_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'weak', 0.3, ?, 'map-note', ?)
       ON CONFLICT(id) DO UPDATE SET last_evidence_at = excluded.last_evidence_at`,
    ).run(id, wipeId, p.x, p.y, grid, at, at)

    db.prepare(
      `INSERT INTO base_observations (base_id, kind, at, reporter, note)
       VALUES (?, 'map-note', ?, 'rustplus', ?)`,
    ).run(id, at, note.label)
    n++
  }
  return n
}

/**
 * Teammate deaths open an encounter shell immediately, so the combat log that
 * arrives moments later from the agent has something to attach to.
 */
export function recordTeammateDeath(
  db: DB,
  serverId: string,
  wipeId: number,
  death: { steamId: string; grid: string; x?: number; y?: number },
  at = nowIso(),
): string {
  const id = `death:${wipeId}:${death.steamId}:${Date.parse(at)}`
  db.prepare(
    `INSERT INTO encounters (id, server_id, wipe_id, started_at, label, outcome, parties_detected,
                             victim_id, death_x, death_y)
     VALUES (?, ?, ?, ?, ?, 'died', 1, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(id, serverId, wipeId, at, `death in ${death.grid}`,
    death.steamId, death.x ?? null, death.y ?? null)
  return id
}
