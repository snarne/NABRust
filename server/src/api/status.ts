// ---------------------------------------------------------------------------
// Integration health for one server — what Settings shows.
//
// Every line is read from something that actually happened: the last
// Battlemetrics poll, the last Rust+ team and marker sync, what the log agents
// last sent. Nothing here says "LIVE" because a feature exists; it says so
// because data arrived recently.
// ---------------------------------------------------------------------------

import type { DB } from '../db/index.ts'
import { getServerState } from '../db/index.ts'
import { lastPoll, POLL_GAP_MS } from '../collectors/battlemetrics.ts'

export interface ApiStatus {
  team: { name: string; members: number; self: string | null }
  battlemetrics: { configured: boolean; lastPoll: string | null; fresh: boolean; online: number | null }
  rustplus: { paired: boolean; lastTeamSync: string | null; lastMarkers: string | null }
  steam: { configured: boolean; profiles: number; public: number }
  map: { source: string | null; parsedAt: string | null; monuments: number; terrain: boolean }
  teams: { lastRun: string | null; watchedHours: number | null; population: number | null; rosters: number }
  agents: { reporter: string; name: string | null; last: string; lines: number; rejected: number }[]
  sinks: { discord: boolean; teamspeak: boolean }
  /** Across every tracked server — what the whole install has collected. */
  totals: { players: number; sessions: number; rosters: number; firstPoll: string | null; watchedHours: number }
}

export function statusFor(
  db: DB, serverId: string,
  opts: { teamIds?: string[]; teamName?: string; env?: Record<string, string | undefined>; now?: number } = {},
): ApiStatus | null {
  const env = opts.env ?? process.env
  const now = opts.now ?? Date.now()
  const srv = db.prepare(
    `SELECT battlemetrics_id, rustplus_paired, rustplus_player_id, map_source, map_parsed_at, map_world_path
       FROM servers WHERE id = ?`,
  ).get(serverId) as {
    battlemetrics_id: string | null; rustplus_paired: number; rustplus_player_id: string | null
    map_source: string | null; map_parsed_at: string | null; map_world_path: string | null
  } | undefined
  if (!srv) return null

  const poll = lastPoll(db, serverId)
  const teamRows = db.prepare(`SELECT steam_id FROM team_state WHERE server_id = ?`).all(serverId) as { steam_id: string }[]
  const members = new Set([...(opts.teamIds ?? []), ...teamRows.map((r) => r.steam_id)])
  const profiles = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(profile_public), 0) AS pub FROM players WHERE profile_fetched_at IS NOT NULL`,
  ).get() as { n: number; pub: number }
  const monuments = db.prepare(
    `SELECT COUNT(*) AS n FROM monuments m JOIN wipes w ON w.id = m.wipe_id
      WHERE w.server_id = ? AND w.ended_at IS NULL`,
  ).get(serverId) as { n: number }
  const rosters = db.prepare(`SELECT COUNT(*) AS n FROM clans WHERE server_id = ?`).get(serverId) as { n: number }
  const teams = getServerState<{ population: number; coverageHours: number }>(db, serverId, 'session_evidence')

  // ingest_log has no server column; agent rows are keyed by reporter.
  const agents = (db.prepare(
    `SELECT reporter, MAX(at) AS last, SUM(lines_in) AS lines, SUM(rejected) AS rejected
       FROM ingest_log WHERE reporter IS NOT NULL AND kind <> 'rollover'
      GROUP BY reporter ORDER BY last DESC LIMIT 20`,
  ).all() as { reporter: string; last: string; lines: number; rejected: number }[]).map((a) => {
    const n = db.prepare(`SELECT name FROM player_names WHERE steam_id = ? AND last_seen IS NULL`).get(a.reporter) as { name: string } | undefined
    return { ...a, name: n?.name ?? null }
  })

  const totals = {
    players: (db.prepare(`SELECT COUNT(*) AS n FROM players`).get() as { n: number }).n,
    sessions: (db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n,
    rosters: (db.prepare(`SELECT COUNT(*) AS n FROM clans`).get() as { n: number }).n,
    firstPoll: (db.prepare(`SELECT MIN(joined_at) AS t FROM sessions`).get() as { t: string | null }).t,
    watchedHours: Math.round((db.prepare(
      `SELECT COALESCE(SUM(json_extract(value, '$.coverageHours')), 0) AS h FROM server_state WHERE key = 'session_evidence'`,
    ).get() as { h: number }).h * 10) / 10,
  }

  return {
    totals,
    team: {
      name: opts.teamName ?? env.NABRUST_TEAM_NAME ?? 'my team',
      members: members.size,
      self: srv.rustplus_player_id ?? opts.teamIds?.[0] ?? null,
    },
    battlemetrics: {
      configured: !!env.BATTLEMETRICS_TOKEN && !!srv.battlemetrics_id,
      lastPoll: poll?.at ?? null,
      fresh: !!poll && now - Date.parse(poll.at) <= POLL_GAP_MS,
      online: poll?.online ?? null,
    },
    rustplus: {
      paired: srv.rustplus_paired === 1,
      lastTeamSync: getServerState(db, serverId, 'rustplus_team')?.updatedAt ?? null,
      lastMarkers: getServerState(db, serverId, 'rustplus_markers')?.updatedAt ?? null,
    },
    steam: { configured: !!env.STEAM_API_KEY, profiles: profiles.n, public: profiles.pub },
    map: {
      source: srv.map_source,
      parsedAt: srv.map_parsed_at,
      monuments: monuments.n,
      terrain: !!srv.map_world_path,
    },
    teams: {
      lastRun: teams?.updatedAt ?? null,
      watchedHours: teams?.value.coverageHours ?? null,
      population: teams?.value.population ?? null,
      rosters: rosters.n,
    },
    agents,
    // Output sinks aren't built yet; say so rather than pretend.
    sinks: { discord: false, teamspeak: false },
  }
}
