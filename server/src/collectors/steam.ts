// ---------------------------------------------------------------------------
// Steam profiles, via the official Web API (needs a free STEAM_API_KEY).
//
// Only for real 64-bit Steam ids — which is who matters: combat logs and Rust+
// give real ids for the people who shot you and for your own team.
// Battlemetrics' public data only gives its own player ids, so the wider
// server population can't be looked up this way.
//
// Three calls, all public data: summaries (visibility, account age, name),
// bans (VAC and game bans), and owned games filtered to Rust for playtime —
// which Steam only returns when the player has made game details public.
// ---------------------------------------------------------------------------

import type { DB } from '../db/index.ts'
import { nowIso } from '../db/index.ts'
import { applySteamProfile } from '../identity.ts'

export const RUST_APP_ID = 252490
const API = 'https://api.steampowered.com'
const STEAM_ID = /^\d{17}$/

export interface SteamConfig {
  key: string
  fetchImpl?: typeof fetch
  /** Refetch a profile after this many days. */
  maxAgeDays?: number
  /** Profiles per run. Summaries and bans take 100 ids per call. */
  batch?: number
  /** Pause between owned-games calls, ms. */
  pauseMs?: number
}

async function getJson(f: typeof fetch, url: string): Promise<unknown> {
  const res = await f(url)
  if (res.status === 403 || res.status === 401) throw new Error('Steam rejected the API key')
  if (res.status === 429) throw new Error('Steam rate limit — will retry next run')
  if (!res.ok) throw new Error(`Steam HTTP ${res.status}`)
  return res.json()
}

/**
 * Fetch profiles that are missing or stale. Returns how many were updated.
 * A failure part-way leaves already-written profiles in place; the rest are
 * picked up next run because their fetched-at is still old.
 */
export async function refreshSteamProfiles(db: DB, cfg: SteamConfig, now = nowIso()): Promise<number> {
  const f = cfg.fetchImpl ?? fetch
  const cutoff = new Date(Date.parse(now) - (cfg.maxAgeDays ?? 7) * 86_400_000).toISOString()
  const ids = (db.prepare(
    `SELECT steam_id FROM players
      WHERE (profile_fetched_at IS NULL OR profile_fetched_at < ?)
      ORDER BY profile_fetched_at IS NOT NULL, first_seen DESC LIMIT ?`,
  ).all(cutoff, 5 * (cfg.batch ?? 100)) as { steam_id: string }[])
    .map((r) => r.steam_id).filter((id) => STEAM_ID.test(id)).slice(0, cfg.batch ?? 100)
  if (!ids.length) return 0

  const key = encodeURIComponent(cfg.key)
  const list = ids.join(',')
  const summaries = await getJson(f, `${API}/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${list}`) as
    { response?: { players?: { steamid: string; personaname?: string; communityvisibilitystate?: number; timecreated?: number }[] } }
  const bans = await getJson(f, `${API}/ISteamUser/GetPlayerBans/v1/?key=${key}&steamids=${list}`) as
    { players?: { SteamId: string; NumberOfVACBans?: number; NumberOfGameBans?: number }[] }

  const sum = new Map((summaries.response?.players ?? []).map((p) => [p.steamid, p]))
  const ban = new Map((bans.players ?? []).map((p) => [p.SteamId, p]))

  let n = 0
  for (const id of ids) {
    const s = sum.get(id)
    const b = ban.get(id)
    const isPublic = s?.communityvisibilitystate === 3
    let hours: number | null = null
    if (isPublic) {
      try {
        const games = await getJson(
          f,
          `${API}/IPlayerService/GetOwnedGames/v1/?key=${key}&steamid=${id}&include_played_free_games=1&appids_filter%5B0%5D=${RUST_APP_ID}`,
        ) as { response?: { games?: { appid: number; playtime_forever?: number }[] } }
        const rust = games.response?.games?.find((g) => g.appid === RUST_APP_ID)
        // Minutes -> hours. Absent means game details are private, not zero.
        hours = rust?.playtime_forever !== undefined ? Math.round(rust.playtime_forever / 60) : null
      } catch (e) {
        if (/rate limit|rejected/.test((e as Error).message)) throw e
      }
      if (cfg.pauseMs) await new Promise((r) => setTimeout(r, cfg.pauseMs))
    }
    applySteamProfile(db, id, {
      hoursPlayed: hours,
      accountCreatedAt: s?.timecreated ? new Date(s.timecreated * 1000).toISOString() : null,
      vacBans: b?.NumberOfVACBans ?? 0,
      gameBans: b?.NumberOfGameBans ?? 0,
      public: isPublic,
      personaName: s?.personaname,
    }, now)
    n++
  }
  return n
}
