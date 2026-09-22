// ---------------------------------------------------------------------------
// Identity.
//
// A player IS a steam id. A name is something the id was called during a
// window. Renaming appends a record and closes the previous one — nothing is
// rewritten, so encounter history, rivalries and roster membership survive.
//
// Renames are also a signal: frequent renaming correlates with people shedding
// a reputation, and renames that cluster across accounts are weak team
// evidence. Both fall out of having the history rather than a single column.
// ---------------------------------------------------------------------------

import type { DB } from './db/index.ts'
import { nowIso } from './db/index.ts'

export type NameSource = 'combatlog' | 'battlemetrics' | 'steam' | 'manual'

export function ensurePlayer(db: DB, steamId: string, at = nowIso()): void {
  db.prepare(
    `INSERT INTO players (steam_id, first_seen, last_seen)
     VALUES (?, ?, ?)
     ON CONFLICT(steam_id) DO UPDATE SET last_seen = excluded.last_seen`,
  ).run(steamId, at, at)
}

/**
 * Record the name this id is currently using. If it differs from the open
 * record, close that one and open a new one. Idempotent: seeing the same name
 * again just refreshes last_seen on the player.
 */
export function observeName(
  db: DB,
  steamId: string,
  name: string,
  source: NameSource,
  at = nowIso(),
): { changed: boolean; previous?: string } {
  ensurePlayer(db, steamId, at)

  const current = db
    .prepare(`SELECT name FROM player_names WHERE steam_id = ? AND last_seen IS NULL`)
    .get(steamId) as { name: string } | undefined

  if (current?.name === name) return { changed: false }

  if (current) {
    db.prepare(
      `UPDATE player_names SET last_seen = ? WHERE steam_id = ? AND last_seen IS NULL`,
    ).run(at, steamId)
  }

  db.prepare(
    `INSERT INTO player_names (steam_id, name, first_seen, last_seen, source)
     VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT(steam_id, name, first_seen) DO NOTHING`,
  ).run(steamId, name, at, source)

  return { changed: true, previous: current?.name }
}

export function currentName(db: DB, steamId: string): string | null {
  const row = db
    .prepare(`SELECT name FROM player_names WHERE steam_id = ? AND last_seen IS NULL`)
    .get(steamId) as { name: string } | undefined
  return row?.name ?? null
}

export function nameHistory(db: DB, steamId: string) {
  return db
    .prepare(
      `SELECT name, first_seen, last_seen, source
         FROM player_names WHERE steam_id = ?
        ORDER BY first_seen DESC`,
    )
    .all(steamId) as { name: string; first_seen: string; last_seen: string | null; source: string }[]
}

/** Reverse lookup — a name may have belonged to several ids over time. */
export function resolveName(db: DB, name: string): string[] {
  return (
    db
      .prepare(`SELECT DISTINCT steam_id FROM player_names WHERE name = ?`)
      .all(name) as { steam_id: string }[]
  ).map((r) => r.steam_id)
}

export function applySteamProfile(
  db: DB,
  steamId: string,
  p: {
    hoursPlayed: number | null
    accountCreatedAt: string | null
    vacBans: number
    gameBans: number
    public: boolean
    personaName?: string
  },
  at = nowIso(),
): void {
  ensurePlayer(db, steamId, at)
  db.prepare(
    `UPDATE players SET hours_played = ?, account_created_at = ?, vac_bans = ?,
            game_bans = ?, profile_public = ?, profile_fetched_at = ?
      WHERE steam_id = ?`,
  ).run(
    p.hoursPlayed, p.accountCreatedAt, p.vacBans, p.gameBans,
    p.public ? 1 : 0, at, steamId,
  )
  if (p.personaName) observeName(db, steamId, p.personaName, 'steam', at)
}

/** How often this id has changed name — a mild threat signal on its own. */
export function renameCount(db: DB, steamId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM player_names WHERE steam_id = ?`)
    .get(steamId) as { n: number }
  return Math.max(0, row.n - 1)
}
