// ---------------------------------------------------------------------------
// Wipe detection and retention tiering.
//
// What a wipe clears and what it keeps is the decision that makes this app
// compound in value. Get it wrong and you either drown in dead rows or throw
// away the history that makes the third wipe smarter than the first.
//
//   CLEARED   map state, monuments, ore density, base inference, turret
//             localizations, gear tier, live events, position samples
//   KEPT      identity and name history, lifetime encounters and rivalries,
//             skill estimates, roster memory (decayed), activity patterns,
//             server rotation
//
// Rollover is idempotent and logged, because a bug here destroys data that
// cannot be recovered.
// ---------------------------------------------------------------------------

import type { DB } from './db/index.ts'
import { nowIso, tx } from './db/index.ts'

/** Roster memory halves roughly every 3 wipes — teams do shuffle. */
export const CLAN_MEMORY_DECAY = 0.79

export interface WipeInfo {
  id: number
  serverId: string
  startedAt: string
  seed: number | null
  worldSize: number | null
}

export function currentWipe(db: DB, serverId: string): WipeInfo | null {
  const row = db
    .prepare(
      `SELECT id, server_id, started_at, seed, world_size
         FROM wipes WHERE server_id = ? AND ended_at IS NULL
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(serverId) as
    | { id: number; server_id: string; started_at: string; seed: number | null; world_size: number | null }
    | undefined
  return row
    ? { id: row.id, serverId: row.server_id, startedAt: row.started_at, seed: row.seed, worldSize: row.world_size }
    : null
}

/**
 * Detect a wipe. The seed changing is conclusive; Rust+ `getInfo` time-since-wipe
 * going backwards is the secondary signal for servers that keep the same seed.
 */
export function detectWipe(
  db: DB,
  serverId: string,
  observed: { seed: number | null; worldSize: number | null; secondsSinceWipe?: number },
): { wiped: boolean; reason?: string } {
  const cur = currentWipe(db, serverId)
  if (!cur) return { wiped: true, reason: 'no wipe on record' }

  if (observed.seed !== null && cur.seed !== null && observed.seed !== cur.seed) {
    return { wiped: true, reason: `seed changed ${cur.seed} -> ${observed.seed}` }
  }
  if (observed.worldSize !== null && cur.worldSize !== null && observed.worldSize !== cur.worldSize) {
    return { wiped: true, reason: `world size changed ${cur.worldSize} -> ${observed.worldSize}` }
  }
  if (observed.secondsSinceWipe !== undefined) {
    const elapsed = (Date.now() - Date.parse(cur.startedAt)) / 1000
    // A fresh server reports a much smaller uptime than we've been tracking.
    if (observed.secondsSinceWipe + 3600 < elapsed) {
      return { wiped: true, reason: 'server uptime reset' }
    }
  }
  return { wiped: false }
}

/**
 * Close the current wipe, demote its data, and open a new one.
 * Safe to call twice — the second call finds no open wipe to close.
 */
export function rolloverWipe(
  db: DB,
  serverId: string,
  next: { seed: number | null; worldSize: number | null },
  at = nowIso(),
): { closed: number | null; opened: number } {
  return tx(db, () => {
    const cur = currentWipe(db, serverId)

    if (cur) {
      db.prepare(`UPDATE wipes SET ended_at = ?, tier = 'warm' WHERE id = ?`).run(at, cur.id)
      demoteToWarm(db, cur.id, serverId, at)
    }

    // (server_id, started_at) is unique. Two rollovers inside the same
    // millisecond — a double-fired wipe detection, say — would otherwise
    // collide and abort the transaction, so advance until the slot is free.
    let startedAt = at
    for (let attempt = 0; attempt < 1000; attempt++) {
      const clash = db
        .prepare(`SELECT 1 AS x FROM wipes WHERE server_id = ? AND started_at = ?`)
        .get(serverId, startedAt) as { x: number } | undefined
      if (!clash) break
      startedAt = new Date(Date.parse(startedAt) + 1).toISOString()
    }

    db.prepare(
      `INSERT INTO wipes (server_id, started_at, seed, world_size, tier)
       VALUES (?, ?, ?, ?, 'hot')`,
    ).run(serverId, startedAt, next.seed, next.worldSize)

    const opened = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id

    // The map belongs to the seed, so it has to be re-fetched or re-parsed.
    db.prepare(
      `UPDATE servers SET seed = ?, world_size = ?, map_image_path = NULL,
              map_source = NULL, map_parsed_at = NULL
        WHERE id = ?`,
    ).run(next.seed, next.worldSize, serverId)

    return { closed: cur?.id ?? null, opened }
  })
}

/**
 * Collapse a finished wipe's hot data. Raw combat events become per-player
 * summaries, positions are dropped entirely, and anything that describes the
 * old map goes with it.
 */
export function demoteToWarm(db: DB, wipeId: number, serverId: string, at = nowIso()): void {
  // 1. Lifetime rollups BEFORE we drop the raw rows they're computed from.
  rollUpRivalries(db, wipeId, at)

  // 2. Encounter summaries.
  db.prepare(
    `INSERT INTO encounter_summary (encounter_id, steam_id, hits, damage, headshots, avg_distance, weapons)
     SELECT ce.encounter_id,
            ce.attacker_id,
            COUNT(*),
            SUM(ce.damage),
            SUM(CASE WHEN ce.area = 'head' THEN 1 ELSE 0 END),
            AVG(ce.distance),
            json_group_array(DISTINCT ce.weapon)
       FROM combat_events ce
       JOIN encounters e ON e.id = ce.encounter_id
      WHERE e.wipe_id = ? AND ce.attacker_id IS NOT NULL
      GROUP BY ce.encounter_id, ce.attacker_id
     ON CONFLICT(encounter_id, steam_id) DO NOTHING`,
  ).run(wipeId)

  db.prepare(
    `DELETE FROM combat_events WHERE encounter_id IN
       (SELECT id FROM encounters WHERE wipe_id = ?)`,
  ).run(wipeId)

  // 3. Sessions -> daily aggregate.
  db.prepare(
    `INSERT INTO session_daily (server_id, steam_id, day, minutes, sessions)
     SELECT server_id, steam_id, date(joined_at),
            CAST(SUM((julianday(COALESCE(left_at, joined_at)) - julianday(joined_at)) * 1440) AS INTEGER),
            COUNT(*)
       FROM sessions WHERE wipe_id = ?
      GROUP BY server_id, steam_id, date(joined_at)
     ON CONFLICT(server_id, steam_id, day) DO UPDATE SET
       minutes = minutes + excluded.minutes,
       sessions = sessions + excluded.sessions`,
  ).run(wipeId)
  db.prepare(`DELETE FROM sessions WHERE wipe_id = ?`).run(wipeId)

  // 4. Roster memory: fold this wipe's pair graph into the permanent store,
  //    decayed, so teams that stay together stay linked next wipe.
  db.prepare(
    `INSERT INTO clan_memory (a_steam_id, b_steam_id, log_odds, last_seen)
     SELECT a_steam_id, b_steam_id, log_odds * ?, ?
       FROM pair_state WHERE server_id = ?
     ON CONFLICT(a_steam_id, b_steam_id) DO UPDATE SET
       log_odds = clan_memory.log_odds * ? + excluded.log_odds,
       last_seen = excluded.last_seen`,
  ).run(CLAN_MEMORY_DECAY, at, serverId, CLAN_MEMORY_DECAY)

  // 5. Everything that described the old map or old wipe state.
  db.prepare(`DELETE FROM position_samples WHERE wipe_id = ?`).run(wipeId)
  db.prepare(`DELETE FROM monuments WHERE wipe_id = ?`).run(wipeId)
  db.prepare(`DELETE FROM ore_density WHERE wipe_id = ?`).run(wipeId)
  db.prepare(`DELETE FROM game_events WHERE wipe_id = ?`).run(wipeId)
  db.prepare(`DELETE FROM localizations WHERE wipe_id = ?`).run(wipeId)
  db.prepare(`DELETE FROM bases WHERE wipe_id = ?`).run(wipeId)

  // 6. Server-scoped pair state resets; the decayed memory above carries over.
  db.prepare(`DELETE FROM pair_evidence WHERE server_id = ?`).run(serverId)
  db.prepare(`DELETE FROM pair_state WHERE server_id = ?`).run(serverId)

  db.prepare(
    `INSERT INTO ingest_log (at, kind, note) VALUES (?, 'rollover', ?)`,
  ).run(at, `wipe ${wipeId} demoted to warm`)
}

/**
 * Permanent per-rival record. Computed from raw events while they still exist.
 */
function rollUpRivalries(db: DB, wipeId: number, at: string): void {
  db.prepare(
    `INSERT INTO rival_stats
       (self_id, other_id, encounters, wins, losses, damage_dealt, damage_taken,
        headshots_taken, avg_distance, updated_at)
     SELECT ce.target_id, ce.attacker_id,
            COUNT(DISTINCT ce.encounter_id),
            0,
            SUM(CASE WHEN ce.hp_after <= 0 THEN 1 ELSE 0 END),
            0,
            SUM(ce.damage),
            SUM(CASE WHEN ce.area = 'head' THEN 1 ELSE 0 END),
            AVG(ce.distance),
            ?
       FROM combat_events ce
       JOIN encounters e ON e.id = ce.encounter_id
      WHERE e.wipe_id = ? AND ce.attacker_id IS NOT NULL
      GROUP BY ce.target_id, ce.attacker_id
     ON CONFLICT(self_id, other_id) DO UPDATE SET
       encounters      = rival_stats.encounters + excluded.encounters,
       losses          = rival_stats.losses + excluded.losses,
       damage_taken    = rival_stats.damage_taken + excluded.damage_taken,
       headshots_taken = rival_stats.headshots_taken + excluded.headshots_taken,
       avg_distance    = excluded.avg_distance,
       updated_at      = excluded.updated_at`,
  ).run(at, wipeId)
}

/**
 * Position samples are the table that would otherwise dominate disk. Once a
 * retrace has been computed for an encounter we keep the conclusion, not the
 * inputs.
 */
export function purgeResolvedPositions(db: DB, wipeId: number): number {
  const res = db.prepare(
    `DELETE FROM position_samples
      WHERE wipe_id = ?
        AND t < COALESCE(
              (SELECT MIN(computed_at) FROM localizations WHERE wipe_id = ?),
              t)`,
  ).run(wipeId)
  return Number(res.changes)
}

export function retentionStats(db: DB) {
  const q = (sql: string, ...p: unknown[]) =>
    (db.prepare(sql).get(...(p as never[])) as { n: number }).n

  return {
    hot: {
      combatEvents: q(`SELECT COUNT(*) AS n FROM combat_events`),
      sessions: q(`SELECT COUNT(*) AS n FROM sessions`),
      positions: q(`SELECT COUNT(*) AS n FROM position_samples`),
      bases: q(`SELECT COUNT(*) AS n FROM bases`),
    },
    warm: {
      encounterSummaries: q(`SELECT COUNT(*) AS n FROM encounter_summary`),
      sessionDaily: q(`SELECT COUNT(*) AS n FROM session_daily`),
    },
    cold: {
      players: q(`SELECT COUNT(*) AS n FROM players`),
      names: q(`SELECT COUNT(*) AS n FROM player_names`),
      rivalries: q(`SELECT COUNT(*) AS n FROM rival_stats`),
      clanMemory: q(`SELECT COUNT(*) AS n FROM clan_memory`),
    },
  }
}
