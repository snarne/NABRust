// ---------------------------------------------------------------------------
// Battlemetrics session collector.
//
// This is the one source whose history CANNOT be backfilled — if the collector
// wasn't running, that week of sessions is simply gone. Turn it on first,
// before the rest of the app is even finished.
//
// Published limits: 45 requests/second and 300/minute authenticated (60/minute
// unauthenticated). The limiter below stays well inside those and backs off on
// 429 using the X-Rate-Limit-Remaining header when the response provides it.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DB } from '../db/index.ts'
import { nowIso, tx } from '../db/index.ts'
import { ensurePlayer, observeName } from '../identity.ts'

export interface OnlinePlayer {
  steamId: string
  name: string
  /** false when only Battlemetrics' internal id was available. */
  steamIdKnown: boolean
}

export interface CollectorConfig {
  token: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** Requests per minute cap; stays under the published 300. */
  perMinute?: number
}

/** Simple token bucket so bursts can't trip the published limits. */
class RateLimiter {
  private times: number[] = []
  private perMinute: number
  constructor(perMinute: number) {
    this.perMinute = perMinute
  }

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now()
      this.times = this.times.filter((t) => now - t < 60_000)
      if (this.times.length < this.perMinute) {
        this.times.push(now)
        return
      }
      const wait = 60_000 - (now - this.times[0]) + 50
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

const limiters = new Map<string, RateLimiter>()

async function call<T>(path: string, cfg: CollectorConfig): Promise<T> {
  const base = cfg.baseUrl ?? 'https://api.battlemetrics.com'
  const doFetch = cfg.fetchImpl ?? fetch
  const perMinute = cfg.perMinute ?? 120

  let limiter = limiters.get(base)
  if (!limiter) {
    limiter = new RateLimiter(perMinute)
    limiters.set(base, limiter)
  }

  let delay = 1000
  for (let attempt = 0; attempt < 5; attempt++) {
    await limiter.take()
    const res = await doFetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    })

    if (res.ok) return (await res.json()) as T

    // 429 and 5xx are transient; anything else is a real error.
    if (res.status !== 429 && res.status < 500) {
      throw new Error(`battlemetrics ${res.status} ${res.statusText} on ${path}`)
    }
    const retryAfter = Number(res.headers.get('retry-after')) * 1000
    await new Promise((r) => setTimeout(r, retryAfter || delay))
    delay = Math.min(delay * 2, 30_000)
  }
  throw new Error(`battlemetrics: gave up on ${path} after 5 attempts`)
}

// --- server info ------------------------------------------------------------

export interface ServerInfo {
  name: string
  players: number
  maxPlayers: number
  status: string
  /** Rust-specific, when the API exposes them. Null when absent. */
  seed: number | null
  worldSize: number | null
  lastWipe: string | null
  official: boolean | null
  /**
   * From `details.rust_maps`. Battlemetrics publishes a rendered map for the
   * server's seed AND a link to the actual .map world file — both without
   * Rust+ pairing, which makes this the fastest route out of placeholder mode.
   */
  map: {
    pageUrl: string | null
    imageUrl: string | null
    /** The .map world file: heightmap, biomes, topology, prefabs, ore. */
    fileUrl: string | null
    monumentCount: number | null
  }
  /** Wipe schedule, so a wipe can be anticipated rather than only detected. */
  nextWipe: string | null
  lastSeedChange: string | null
  /** Raw details, kept so unknown keys can be inspected on first run. */
  detailKeys: string[]
}

/**
 * Battlemetrics nests Rust specifics under attributes.details, and the exact
 * key names have changed over time. Rather than hard-code one spelling we try
 * the known variants and report which keys were actually present, so a rename
 * upstream shows up as a log line instead of a silently null seed.
 */
function pick<T>(details: Record<string, unknown>, keys: string[]): T | null {
  for (const k of keys) {
    const v = details[k]
    if (v !== undefined && v !== null && v !== '') return v as T
  }
  return null
}

export function extractServerInfo(payload: {
  data?: { attributes?: Record<string, unknown> }
}): ServerInfo {
  const attrs = payload.data?.attributes ?? {}
  const details = (attrs.details ?? {}) as Record<string, unknown>

  const seedRaw = pick<string | number>(details, [
    'rust_world_seed', 'rust_seed', 'map_seed', 'worldSeed',
  ])
  const sizeRaw = pick<string | number>(details, [
    'rust_world_size', 'rust_size', 'map_size', 'worldSize',
  ])
  const wipeRaw = pick<string>(details, ['rust_last_wipe', 'rust_wipe', 'lastWipe'])
  const maps = (details.rust_maps ?? {}) as Record<string, unknown>
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v !== '' ? v : null

  return {
    name: String(attrs.name ?? ''),
    players: Number(attrs.players ?? 0),
    maxPlayers: Number(attrs.maxPlayers ?? 0),
    status: String(attrs.status ?? 'unknown'),
    seed: seedRaw === null ? null : Number(seedRaw) || null,
    worldSize: sizeRaw === null ? null : Number(sizeRaw) || null,
    lastWipe: wipeRaw,
    official: pick<boolean>(details, ['official', 'rust_official']),
    map: {
      pageUrl: str(maps.url),
      // thumbnailUrl is a webp render of this exact seed; good enough to drop
      // placeholder mode immediately.
      imageUrl: str(maps.thumbnailUrl) ?? str(maps.imageUrl),
      fileUrl: str(maps.mapUrl),
      monumentCount: typeof maps.monumentCount === 'number' ? maps.monumentCount : null,
    },
    nextWipe: pick<string>(details, ['rust_next_wipe', 'rust_next_wipe_full']),
    lastSeedChange: pick<string>(details, ['rust_last_seed_change']),
    detailKeys: Object.keys(details),
  }
}

/** Download a URL to a local file. Used for the map render. */
export async function downloadTo(
  url: string,
  destPath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: number; contentType: string | null }> {
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`download failed ${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  mkdirSync(dirname(destPath), { recursive: true })
  writeFileSync(destPath, buf)
  return { bytes: buf.length, contentType: res.headers.get('content-type') }
}

export async function fetchServerInfo(
  serverBmId: string,
  cfg: CollectorConfig,
): Promise<ServerInfo> {
  const body = await call<{ data?: { attributes?: Record<string, unknown> } }>(
    `/servers/${serverBmId}`, cfg,
  )
  return extractServerInfo(body)
}

/** Find a server's Battlemetrics id by name, for first-time setup. */
export async function searchServers(
  query: string,
  cfg: CollectorConfig,
): Promise<{ id: string; name: string; players: number; maxPlayers: number }[]> {
  const body = await call<{
    data?: { id: string; attributes?: Record<string, unknown> }[]
  }>(`/servers?filter[game]=rust&filter[search]=${encodeURIComponent(query)}&page[size]=10`, cfg)

  return (body.data ?? []).map((s) => ({
    id: s.id,
    name: String(s.attributes?.name ?? ''),
    players: Number(s.attributes?.players ?? 0),
    maxPlayers: Number(s.attributes?.maxPlayers ?? 0),
  }))
}

// --- online players ---------------------------------------------------------

interface BmPlayerRelation {
  id: string
  attributes?: { name?: string }
  meta?: { metadata?: { key: string; value: string }[] }
}

/**
 * Who is online. Steam ids come through player metadata where the API exposes
 * them; when only Battlemetrics' internal id is available we key on `bm:<id>`
 * rather than guessing, and reconcile later from the combat log, which always
 * carries the real steam id.
 */
export async function fetchOnline(
  serverBmId: string,
  cfg: CollectorConfig,
): Promise<OnlinePlayer[]> {
  const body = await call<{ included?: BmPlayerRelation[] }>(
    `/servers/${serverBmId}?include=player`, cfg,
  )

  return (body.included ?? [])
    .filter((r) => r.attributes?.name)
    .map((r) => {
      const steam = r.meta?.metadata?.find(
        (m) => m.key === 'steamID' || m.key === 'steamId' || m.key === 'steam_id',
      )?.value
      return {
        steamId: steam ?? `bm:${r.id}`,
        name: r.attributes!.name!,
        steamIdKnown: Boolean(steam),
      }
    })
}

// --- persistence ------------------------------------------------------------

/** Longer than this between polls and we treat the stretch as unobserved. */
// One definition, shared with the censoring backfill in db/index.ts.
export { POLL_GAP_MS } from '../db/index.ts'
import { POLL_GAP_MS } from '../db/index.ts'

/** The last successful Battlemetrics poll for a server, if any. */
export function lastPoll(db: DB, serverId: string): { at: string; online: number } | null {
  const row = db.prepare(`SELECT value FROM server_state WHERE server_id = ? AND key = 'bm_poll'`)
    .get(serverId) as { value: string } | undefined
  if (!row) return null
  try { return JSON.parse(row.value) as { at: string; online: number } } catch { return null }
}

export function recordSnapshot(
  db: DB,
  serverId: string,
  wipeId: number | null,
  online: OnlinePlayer[],
  at = nowIso(),
): { opened: number; closed: number } {
  const present = new Set(online.map((p) => p.steamId))

  return tx(db, () => {
    // If the collector was down, nobody watched that stretch. Sessions still
    // open from before the gap end at the last poll we actually made; anyone
    // still online now starts a fresh session. Otherwise a night with the
    // process stopped would read as eight hours of everyone playing together.
    const last = lastPoll(db, serverId)
    const afterGap = !last || Date.parse(at) - Date.parse(last.at) > POLL_GAP_MS
    if (last && afterGap) {
      // Those leaves are the collector stopping, not the players.
      db.prepare(
        `UPDATE sessions SET left_at = ?, leave_censored = 1 WHERE server_id = ? AND left_at IS NULL`,
      ).run(last.at, serverId)
    }

    const open = db
      .prepare(`SELECT id, steam_id FROM sessions WHERE server_id = ? AND left_at IS NULL`)
      .all(serverId) as { id: number; steam_id: string }[]
    const openIds = new Set(open.map((o) => o.steam_id))

    let opened = 0
    for (const p of online) {
      ensurePlayer(db, p.steamId, at)
      observeName(db, p.steamId, p.name, 'battlemetrics', at)
      if (openIds.has(p.steamId)) continue
      // On the first poll after a gap we see who is online, not when they
      // arrived — that join is censored.
      db.prepare(
        `INSERT INTO sessions (server_id, wipe_id, steam_id, joined_at, source, join_censored)
         VALUES (?, ?, ?, ?, 'battlemetrics', ?)
         ON CONFLICT(server_id, steam_id, joined_at) DO NOTHING`,
      ).run(serverId, wipeId, p.steamId, at, afterGap ? 1 : 0)
      opened++
    }

    let closed = 0
    for (const o of open) {
      if (present.has(o.steam_id)) continue
      db.prepare(`UPDATE sessions SET left_at = ? WHERE id = ?`).run(at, o.id)
      closed++
    }

    db.prepare(
      `INSERT INTO collector_polls (server_id, at, online) VALUES (?, ?, ?)
       ON CONFLICT(server_id, at) DO NOTHING`,
    ).run(serverId, at, online.length)
    db.prepare(
      `INSERT INTO server_state (server_id, key, value, updated_at) VALUES (?, 'bm_poll', ?, ?)
       ON CONFLICT(server_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(serverId, JSON.stringify({ at, online: online.length }), at)

    return { opened, closed }
  })
}

/**
 * Sessions left open by a crash would otherwise run forever and poison the
 * overlap maths that clan detection depends on.
 */
export function closeStaleSessions(db: DB, serverId: string, maxHours = 16, at = nowIso()): number {
  const res = db.prepare(
    // A forced close isn't an observed logout, so it's censored.
    `UPDATE sessions SET left_at = ?, leave_censored = 1
      WHERE server_id = ? AND left_at IS NULL
        AND (julianday(?) - julianday(joined_at)) * 24 > ?`,
  ).run(at, serverId, at, maxHours)
  return Number(res.changes)
}

/**
 * When the combat log reveals the steam id behind a player we were tracking by
 * Battlemetrics id only, fold the two identities together so history isn't
 * split across two keys.
 */
export function reconcileBmIdentity(
  db: DB,
  bmId: string,
  steamId: string,
  at = nowIso(),
): boolean {
  const placeholder = `bm:${bmId}`
  const exists = db
    .prepare(`SELECT 1 AS x FROM players WHERE steam_id = ?`)
    .get(placeholder) as { x: number } | undefined
  if (!exists) return false

  return tx(db, () => {
    ensurePlayer(db, steamId, at)
    db.prepare(`UPDATE sessions SET steam_id = ? WHERE steam_id = ?`).run(steamId, placeholder)
    db.prepare(
      `UPDATE OR IGNORE player_names SET steam_id = ? WHERE steam_id = ?`,
    ).run(steamId, placeholder)
    db.prepare(`DELETE FROM player_names WHERE steam_id = ?`).run(placeholder)
    db.prepare(`DELETE FROM players WHERE steam_id = ?`).run(placeholder)
    return true
  })
}

export interface PollHandle { stop: () => void }

/** Long-running poll loop. Errors are logged and retried, never fatal. */
export function startCollector(
  db: DB,
  opts: {
    serverId: string
    battlemetricsId: string
    cfg: CollectorConfig
    intervalMs?: number
    wipeId: () => number | null
    onError?: (e: unknown) => void
    onTick?: (r: { online: number; opened: number; closed: number }) => void
  },
): PollHandle {
  const interval = Math.max(30_000, opts.intervalMs ?? 60_000)
  let stopped = false

  const tick = async () => {
    if (stopped) return
    try {
      const online = await fetchOnline(opts.battlemetricsId, opts.cfg)
      const r = recordSnapshot(db, opts.serverId, opts.wipeId(), online)
      closeStaleSessions(db, opts.serverId)
      opts.onTick?.({ online: online.length, ...r })
    } catch (e) {
      opts.onError?.(e)
    } finally {
      if (!stopped) setTimeout(tick, interval)
    }
  }

  void tick()
  return { stop: () => { stopped = true } }
}
